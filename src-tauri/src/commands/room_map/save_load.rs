//! Room-map side commands: background image copy and Hue channel position
//! write-back. The room-map config itself never crosses this boundary — it is
//! persisted frontend-side through the shellStore.

use std::collections::HashMap;
use std::net::Ipv4Addr;
use std::str::FromStr;

use reqwest::blocking::Client as BlockingClient;
use serde_json::json;
use tauri::Manager;
use tauri_plugin_fs::FsExt;

use crate::commands::hue::credential_store::effective_hue_app_key;
use crate::commands::hue_http::{classify_hue_response_blocking, HueHttpFault};
use crate::commands::hue_onboarding::CommandStatus;
use crate::models::room_map::HueChannelPlacement;

/// Copy a user-picked background image into the app data directory under a
/// random UUID filename, so the room-map editor can reference a stable
/// in-scope path instead of the original (possibly transient) source path.
#[tauri::command]
pub async fn copy_background_image(
    app_handle: tauri::AppHandle,
    src_path: String,
) -> Result<String, String> {
    use std::path::PathBuf;
    let src = PathBuf::from(&src_path);

    // SECURITY: Validate that the frontend is actually allowed to read this file
    // according to the tauri-plugin-fs scope configurations.
    if !app_handle.fs_scope().is_allowed(&src) {
        return Err("File path is not within the allowed filesystem scope".to_string());
    }

    let app_data_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data dir: {}", e))?;
    let bg_dir = app_data_dir.join("room-map-backgrounds");
    std::fs::create_dir_all(&bg_dir)
        .map_err(|e| format!("Failed to create background dir: {}", e))?;

    // SECURITY: Use a random UUID for the destination filename to prevent
    // path traversal bypasses and accidental overwriting of other background files.
    let mut filename = uuid::Uuid::new_v4().to_string();
    if let Some(ext) = src.extension() {
        if let Some(ext_str) = ext.to_str() {
            filename.push('.');
            filename.push_str(ext_str);
        }
    }

    let dest = bg_dir.join(filename);
    std::fs::copy(&src, &dest).map_err(|e| format!("Failed to copy background image: {}", e))?;
    Ok(dest.to_string_lossy().to_string())
}

/// Bridge payload for a placement list, plus how many were skipped for want of
/// a bridge channel id.
///
/// `channel_index` is our ordinal and is NOT a `channel_id` — sending it
/// addressed the wrong channel on any area whose ids are gapped. Skipping
/// rather than guessing is the fix; split out from the command so the refusal
/// is testable without a bridge.
///
/// A height of unknown origin is replaced by the bridge's own: legacy records
/// carry a placeholder `z = 0`, and pushing it reset every light's height on
/// the bridge. The bridge's position object is `x`, `y` and `z` together, so
/// the height cannot simply be left out.
pub(crate) fn build_channel_positions(
    channels: &[HueChannelPlacement],
    bridge_heights: &HashMap<u8, f64>,
) -> (Vec<serde_json::Value>, usize) {
    let unresolved = channels.iter().filter(|ch| ch.channel_id.is_none()).count();
    let positions = channels
        .iter()
        .filter_map(|ch| {
            ch.channel_id.map(|channel_id| {
                let z = match ch.z_origin {
                    Some(_) => ch.z,
                    None => bridge_heights.get(&channel_id).copied().unwrap_or(ch.z),
                };
                json!({
                    "channel_id": channel_id,
                    "position": { "x": ch.x, "y": ch.y, "z": z }
                })
            })
        })
        .collect();
    (positions, unresolved)
}

/// Only a height we cannot vouch for needs the bridge's current one, so the
/// extra read is skipped once every placement knows where its `z` came from.
fn needs_bridge_heights(channels: &[HueChannelPlacement]) -> bool {
    channels
        .iter()
        .any(|ch| ch.channel_id.is_some() && ch.z_origin.is_none())
}

/// `channel_id → z` from an `entertainment_configuration/{id}` GET body. A
/// channel whose position carries no `z` is left out.
pub(crate) fn parse_bridge_heights(body: &serde_json::Value) -> HashMap<u8, f64> {
    body.get("data")
        .and_then(|data| data.as_array())
        .and_then(|data| data.first())
        .and_then(|area| area.get("channels"))
        .and_then(|channels| channels.as_array())
        .map(|channels| {
            channels
                .iter()
                .filter_map(|ch| {
                    let id = u8::try_from(ch.get("channel_id")?.as_u64()?).ok()?;
                    let z = ch.get("position")?.get("z")?.as_f64()?;
                    Some((id, z.clamp(-1.0, 1.0)))
                })
                .collect()
        })
        .unwrap_or_default()
}

/// A failed read aborts the push: writing without the bridge's heights is
/// exactly the clobber this read exists to prevent.
fn fetch_bridge_heights(
    client: &BlockingClient,
    endpoint: &str,
    username: &str,
) -> Result<HashMap<u8, f64>, CommandStatus> {
    let not_read = |details: String| CommandStatus {
        code: "CHAN_WB_NETWORK_ERROR".to_string(),
        message: "Could not read the bridge's current light heights, so nothing was written."
            .to_string(),
        details: Some(details),
    };
    let response = client
        .get(endpoint)
        .header("hue-application-key", username)
        .send()
        .map_err(|e| not_read(e.to_string()))?;
    let response = classify_hue_response_blocking(response).map_err(|fault| match fault {
        HueHttpFault::AuthInvalid => CommandStatus {
            code: "AUTH_INVALID_RE_PAIR_REQUIRED".to_string(),
            message: "Hue bridge rejected our credentials. Re-pair the bridge to continue."
                .to_string(),
            details: None,
        },
        other => not_read(format!("{other:?}")),
    })?;
    let body: serde_json::Value = response.json().map_err(|e| not_read(e.to_string()))?;
    Ok(parse_bridge_heights(&body))
}

/// Push room-map channel positions to the bridge's entertainment
/// configuration via a CLIP v2 PUT.
#[tauri::command]
pub fn update_hue_channel_positions(
    channels: Vec<HueChannelPlacement>,
    bridge_ip: String,
    username: String,
    area_id: String,
) -> CommandStatus {
    // SECURITY: Validate bridge IP to prevent SSRF
    if let Ok(ip) = Ipv4Addr::from_str(&bridge_ip) {
        if ip.is_loopback() || ip.is_unspecified() || ip.is_multicast() || ip.is_broadcast() {
            return CommandStatus {
                code: "HUE_IP_INVALID".to_string(),
                message: "Invalid bridge IP address format.".to_string(),
                details: None,
            };
        }
    } else {
        return CommandStatus {
            code: "HUE_IP_INVALID".to_string(),
            message: "Invalid bridge IP address format.".to_string(),
            details: None,
        };
    }

    // SECURITY: Validate area ID to prevent path traversal in the REST endpoint
    if !area_id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-')
    {
        return CommandStatus {
            code: "HUE_AREA_INVALID".to_string(),
            message: "Invalid area ID format.".to_string(),
            details: None,
        };
    }

    // An empty `username` means "resolve from the OS keychain".
    let username = effective_hue_app_key(&username);
    if username.is_empty() {
        return CommandStatus {
            code: "AUTH_INVALID_RE_PAIR_REQUIRED".to_string(),
            message: "Hue bridge rejected our credentials. Re-pair the bridge to continue."
                .to_string(),
            details: Some(
                "No Hue application key in the OS keychain or the request payload.".to_string(),
            ),
        };
    }

    // Build TLS-skip HTTP client (Hue bridges use self-signed certificates)
    let client = match BlockingClient::builder()
        .danger_accept_invalid_certs(true)
        .timeout(std::time::Duration::from_millis(5_000))
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            return CommandStatus {
                code: "CHAN_WB_NETWORK_ERROR".to_string(),
                message: format!("Failed to build HTTP client: {e}"),
                details: None,
            };
        }
    };

    let endpoint = format!(
        "https://{}/clip/v2/resource/entertainment_configuration/{}",
        bridge_ip, area_id
    );

    let bridge_heights = if needs_bridge_heights(&channels) {
        match fetch_bridge_heights(&client, &endpoint, &username) {
            Ok(heights) => heights,
            Err(status) => return status,
        }
    } else {
        HashMap::new()
    };

    let (channel_positions, unresolved) = build_channel_positions(&channels, &bridge_heights);

    if channel_positions.is_empty() {
        return CommandStatus {
            code: "CHAN_WB_UNRESOLVED_CHANNEL".to_string(),
            message:
                "No channel is matched to the bridge yet. Refresh the channel list and try again."
                    .to_string(),
            details: Some(format!(
                "{unresolved} placement(s) carry no bridge channel id."
            )),
        };
    }

    let body = json!({ "channels": channel_positions });

    let response = match client
        .put(&endpoint)
        .header("hue-application-key", &username)
        .json(&body)
        .send()
    {
        Ok(r) => r,
        Err(e) => {
            return CommandStatus {
                code: "CHAN_WB_NETWORK_ERROR".to_string(),
                message: format!("Could not reach the bridge: {e}"),
                details: None,
            };
        }
    };

    let status = response.status();
    if status.is_success() {
        CommandStatus {
            code: "HUE_CHANNEL_POSITIONS_UPDATED".to_string(),
            message: "Positions saved to bridge.".to_string(),
            details: None,
        }
    } else {
        let body_text = response.text().unwrap_or_default();
        CommandStatus {
            code: "CHAN_WB_SCHEMA_REJECTED".to_string(),
            message: format!("Bridge rejected: {status}"),
            details: Some(body_text),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::room_map::HueChannelHeightOrigin;

    fn placement(channel_index: u8, channel_id: Option<u8>) -> HueChannelPlacement {
        HueChannelPlacement {
            channel_index,
            x: f64::from(channel_index) / 10.0,
            y: 0.0,
            z: 0.0,
            z_origin: None,
            label: None,
            locked: None,
            entertainment_area_id: Some("area-1".to_string()),
            channel_id,
            zone_id: None,
            zone_relative_position: None,
        }
    }

    #[test]
    fn payload_addresses_the_bridge_id_not_our_ordinal() {
        // Gapped on purpose: ordinals 0,1,2 against bridge ids 0,2,5. A
        // contiguous fixture makes the two coincide and passes either way,
        // which is how the ordinal reached the bridge unnoticed.
        let channels = vec![
            placement(0, Some(0)),
            placement(1, Some(2)),
            placement(2, Some(5)),
        ];

        let (positions, unresolved) = build_channel_positions(&channels, &HashMap::new());

        assert_eq!(unresolved, 0);
        let ids: Vec<u64> = positions
            .iter()
            .map(|p| p["channel_id"].as_u64().unwrap())
            .collect();
        assert_eq!(ids, vec![0, 2, 5]);
        assert_ne!(ids, vec![0, 1, 2], "ordinals must not reach the bridge");
    }

    #[test]
    fn an_unresolved_placement_is_skipped_rather_than_guessed() {
        let channels = vec![placement(0, Some(4)), placement(1, None)];

        let (positions, unresolved) = build_channel_positions(&channels, &HashMap::new());

        assert_eq!(unresolved, 1);
        assert_eq!(positions.len(), 1, "the resolved channel is still written");
        assert_eq!(positions[0]["channel_id"].as_u64(), Some(4));
    }

    fn pushed_z(positions: &[serde_json::Value]) -> Vec<f64> {
        positions
            .iter()
            .map(|p| p["position"]["z"].as_f64().unwrap())
            .collect()
    }

    #[test]
    fn a_placeholder_height_does_not_overwrite_the_bridges() {
        // The legacy record's z = 0 was never measured; the bridge's 0.8 was.
        let channels = vec![placement(0, Some(3))];
        let bridge = HashMap::from([(3u8, 0.8)]);

        let (positions, _) = build_channel_positions(&channels, &bridge);

        assert_eq!(pushed_z(&positions), vec![0.8]);
        assert!(needs_bridge_heights(&channels));
    }

    #[test]
    fn a_height_of_known_origin_is_pushed_as_is() {
        let mut user = placement(0, Some(3));
        user.z = -0.4;
        user.z_origin = Some(HueChannelHeightOrigin::User);
        let mut bridge_seeded = placement(1, Some(4));
        bridge_seeded.z = 0.2;
        bridge_seeded.z_origin = Some(HueChannelHeightOrigin::Bridge);
        let channels = vec![user, bridge_seeded];
        let bridge = HashMap::from([(3u8, 0.8), (4u8, 0.9)]);

        let (positions, _) = build_channel_positions(&channels, &bridge);

        assert_eq!(pushed_z(&positions), vec![-0.4, 0.2]);
        assert!(
            !needs_bridge_heights(&channels),
            "no read when every height is vouched for"
        );
    }

    #[test]
    fn an_unknown_height_the_bridge_has_none_for_keeps_the_local_value() {
        let mut ch = placement(0, Some(3));
        ch.z = 0.1;

        let (positions, _) = build_channel_positions(&[ch], &HashMap::new());

        assert_eq!(pushed_z(&positions), vec![0.1]);
    }

    #[test]
    fn an_unresolved_placement_does_not_force_a_bridge_read() {
        assert!(!needs_bridge_heights(&[placement(0, None)]));
    }

    #[test]
    fn bridge_heights_are_read_by_channel_id_and_a_missing_z_is_skipped() {
        let body = serde_json::json!({
            "errors": [],
            "data": [{
                "channels": [
                    { "channel_id": 0, "position": { "x": 0.0, "y": 0.0, "z": 0.5 } },
                    { "channel_id": 2, "position": { "x": 0.0, "y": 0.0 } },
                    { "channel_id": 5, "position": { "x": 0.0, "y": 0.0, "z": 7.0 } }
                ]
            }]
        });

        let heights = parse_bridge_heights(&body);

        assert_eq!(heights.get(&0), Some(&0.5));
        assert_eq!(heights.get(&2), None);
        assert_eq!(heights.get(&5), Some(&1.0));
        assert!(parse_bridge_heights(&serde_json::json!({})).is_empty());
    }

    #[test]
    fn a_record_without_z_origin_deserializes_as_unknown() {
        let legacy: HueChannelPlacement =
            serde_json::from_str(r#"{"channelIndex":0,"x":0.1,"y":0.2,"z":0}"#).unwrap();
        assert_eq!(legacy.z_origin, None);
        let stamped: HueChannelPlacement =
            serde_json::from_str(r#"{"channelIndex":0,"x":0,"y":0,"z":0.3,"zOrigin":"user"}"#)
                .unwrap();
        assert_eq!(stamped.z_origin, Some(HueChannelHeightOrigin::User));
    }
}
