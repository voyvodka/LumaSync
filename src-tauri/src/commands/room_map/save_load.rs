//! Room-map side commands: background image copy and Hue channel position
//! write-back. The room-map config itself never crosses this boundary — it is
//! persisted frontend-side through the shellStore.

use std::net::Ipv4Addr;
use std::str::FromStr;

use reqwest::blocking::Client as BlockingClient;
use serde_json::json;
use tauri::Manager;
use tauri_plugin_fs::FsExt;

use crate::commands::hue::credential_store::effective_hue_app_key;
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
pub(crate) fn build_channel_positions(
    channels: &[HueChannelPlacement],
) -> (Vec<serde_json::Value>, usize) {
    let unresolved = channels.iter().filter(|ch| ch.channel_id.is_none()).count();
    let positions = channels
        .iter()
        .filter_map(|ch| {
            ch.channel_id.map(|channel_id| {
                json!({
                    "channel_id": channel_id,
                    "position": { "x": ch.x, "y": ch.y, "z": ch.z }
                })
            })
        })
        .collect();
    (positions, unresolved)
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

    let (channel_positions, unresolved) = build_channel_positions(&channels);

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

    let endpoint = format!(
        "https://{}/clip/v2/resource/entertainment_configuration/{}",
        bridge_ip, area_id
    );

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

    fn placement(channel_index: u8, channel_id: Option<u8>) -> HueChannelPlacement {
        HueChannelPlacement {
            channel_index,
            x: f64::from(channel_index) / 10.0,
            y: 0.0,
            z: 0.0,
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

        let (positions, unresolved) = build_channel_positions(&channels);

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

        let (positions, unresolved) = build_channel_positions(&channels);

        assert_eq!(unresolved, 1);
        assert_eq!(positions.len(), 1, "the resolved channel is still written");
        assert_eq!(positions[0]["channel_id"].as_u64(), Some(4));
    }
}
