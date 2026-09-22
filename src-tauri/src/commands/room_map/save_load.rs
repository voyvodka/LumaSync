//! Room-map side commands: background image copy and Hue channel position
//! write-back. The room-map config itself never crosses this boundary — it is
//! persisted frontend-side through the shellStore.

use std::collections::HashMap;
use std::net::Ipv4Addr;
use std::str::FromStr;

use log::warn;
use reqwest::blocking::Client as BlockingClient;
use serde_json::{json, Value};
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

/// What folding a placement list into the area's `service_locations` produced.
#[derive(Debug)]
pub(crate) struct ServiceLocationMerge {
    /// The PUT body: every `service_locations` entry from the GET, with only the
    /// mapped positions replaced.
    pub body: Value,
    /// Bridge channel ids whose position the body writes.
    pub written: Vec<u8>,
    /// Placements with no bridge channel id — never addressed by their ordinal.
    pub unresolved: usize,
    /// Channel ids that do not map onto exactly one service position.
    pub unmappable: Vec<u8>,
}

fn service_rid(value: &Value) -> Option<&str> {
    value.get("service")?.get("rid")?.as_str()
}

fn channel_members(channel: &Value) -> &[Value] {
    channel
        .get("members")
        .and_then(Value::as_array)
        .map_or(&[], Vec::as_slice)
}

/// Index of the `service_locations` entry that holds this channel's position,
/// or `None` unless that is one position no other channel shares. A channel's
/// position is the bridge's average of its members' segments, so a gradient
/// service (two positions, several segment channels) or a grouped channel has
/// no single position to write. See docs/architecture/hue.md.
fn locate_channel(area: &Value, channel_id: u8) -> Option<usize> {
    let channels = area.get("channels")?.as_array()?;
    let mut matching = channels
        .iter()
        .filter(|ch| ch.get("channel_id").and_then(Value::as_u64) == Some(u64::from(channel_id)));
    let channel = matching.next()?;
    if matching.next().is_some() {
        return None;
    }

    let [member] = channel_members(channel) else {
        return None;
    };
    if member.get("index").and_then(Value::as_u64) != Some(0) {
        return None;
    }
    let rid = service_rid(member)?;
    let sharing = channels
        .iter()
        .flat_map(channel_members)
        .filter(|m| service_rid(m) == Some(rid))
        .count();
    if sharing != 1 {
        return None;
    }

    let locations = area
        .get("locations")?
        .get("service_locations")?
        .as_array()?;
    let mut hits = locations
        .iter()
        .enumerate()
        .filter(|(_, loc)| service_rid(loc) == Some(rid));
    let (index, location) = hits.next()?;
    if hits.next().is_some() {
        return None;
    }
    (location.get("positions")?.as_array()?.len() == 1).then_some(index)
}

/// Fold placements into the `service_locations` list of a GET
/// `entertainment_configuration/{id}` response. The bridge refuses `channels`
/// on a PUT; `locations` is the writable form. See docs/architecture/hue.md.
pub(crate) fn merge_service_locations(
    get_body: &Value,
    placements: &[HueChannelPlacement],
) -> Result<ServiceLocationMerge, String> {
    let area = get_body
        .get("data")
        .and_then(Value::as_array)
        .and_then(|data| data.first())
        .ok_or("The bridge returned no entertainment configuration.")?;
    let mut locations = area
        .get("locations")
        .and_then(|l| l.get("service_locations"))
        .and_then(Value::as_array)
        .cloned()
        .ok_or("The entertainment configuration carries no service locations.")?;

    let mut claims: HashMap<u8, usize> = HashMap::new();
    for id in placements.iter().filter_map(|p| p.channel_id) {
        *claims.entry(id).or_default() += 1;
    }

    let unresolved = placements.iter().filter(|p| p.channel_id.is_none()).count();
    let mut written = Vec::new();
    let mut unmappable = Vec::new();

    for placement in placements {
        let Some(channel_id) = placement.channel_id else {
            continue;
        };
        // Two placements for one channel: either would be a guess.
        let target = (claims[&channel_id] == 1)
            .then(|| locate_channel(area, channel_id))
            .flatten();
        let Some(index) = target else {
            if !unmappable.contains(&channel_id) {
                unmappable.push(channel_id);
            }
            continue;
        };

        let entry = &mut locations[index];
        // Unknown provenance means the local `z` may be a seeding placeholder;
        // the bridge's own height is the better answer. See room-map.md.
        let bridge_z = entry["positions"][0].get("z").and_then(Value::as_f64);
        let z = match (placement.z_origin, bridge_z) {
            (None, Some(bridge_z)) => bridge_z,
            _ => placement.z,
        };
        let position = json!({
            "x": placement.x.clamp(-1.0, 1.0),
            "y": placement.y.clamp(-1.0, 1.0),
            "z": z.clamp(-1.0, 1.0),
        });
        entry["positions"] = json!([position.clone()]);
        // Deprecated mirror of `positions[0]`; kept in step rather than left
        // disagreeing with it.
        if entry.get("position").is_some() {
            entry["position"] = position;
        }
        written.push(channel_id);
    }

    Ok(ServiceLocationMerge {
        body: json!({ "locations": { "service_locations": locations } }),
        written,
        unresolved,
        unmappable,
    })
}

/// A CLIP v2 body's `errors[]`, joined, or `None` when it is empty. A 2xx can
/// still carry a rejection, and a body that is not JSON proves nothing either
/// way, so it counts as one.
fn clip_v2_errors(body: &str) -> Option<String> {
    let Ok(value) = serde_json::from_str::<Value>(body) else {
        return Some(format!("Unreadable bridge response: {body}"));
    };
    let errors = value.get("errors").and_then(Value::as_array)?;
    if errors.is_empty() {
        return None;
    }
    Some(
        errors
            .iter()
            .map(|e| {
                e.get("description")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown error")
            })
            .collect::<Vec<_>>()
            .join("; "),
    )
}

fn status(code: &str, message: impl Into<String>, details: Option<String>) -> CommandStatus {
    CommandStatus {
        code: code.to_string(),
        message: message.into(),
        details,
    }
}

fn re_pair_status(details: &str) -> CommandStatus {
    status(
        "AUTH_INVALID_RE_PAIR_REQUIRED",
        "Hue bridge rejected our credentials. Re-pair the bridge to continue.",
        Some(details.to_string()),
    )
}

/// `AuthInvalid` is the sole re-pair trigger and a 404 is the area itself
/// gone (deleted in the Hue app, or the id belongs to another bridge); every
/// other fault keeps the stage's own code.
fn fault_status(fault: HueHttpFault, code: &str, message: &str) -> CommandStatus {
    match fault {
        HueHttpFault::AuthInvalid => re_pair_status("The bridge rejected the application key."),
        HueHttpFault::NotFound => status(
            "CHAN_WB_AREA_NOT_FOUND",
            "The entertainment area no longer exists on the bridge. Select an area again.",
            None,
        ),
        other => status(code, message, Some(other.to_string())),
    }
}

fn skipped_details(unresolved: usize, unmappable: &[u8]) -> Option<String> {
    let mut parts = Vec::new();
    if unresolved > 0 {
        parts.push(format!(
            "{unresolved} placement(s) carry no bridge channel id."
        ));
    }
    if !unmappable.is_empty() {
        let ids: Vec<String> = unmappable.iter().map(u8::to_string).collect();
        parts.push(format!(
            "Channel(s) {} have no single bridge position to write (gradient, grouped or unknown).",
            ids.join(", ")
        ));
    }
    (!parts.is_empty()).then(|| parts.join(" "))
}

/// GET the area, fold the placements into its `service_locations`, PUT the
/// whole list back. Split from the command so a test can point it at a local
/// server; the command itself only adds the input guards and the `https` URL.
fn write_channel_positions(
    client: &BlockingClient,
    endpoint: &str,
    app_key: &str,
    placements: &[HueChannelPlacement],
) -> CommandStatus {
    if placements.iter().all(|p| p.channel_id.is_none()) {
        return status(
            "CHAN_WB_UNRESOLVED_CHANNEL",
            "No channel is matched to the bridge yet. Refresh the channel list and try again.",
            skipped_details(placements.len(), &[]),
        );
    }

    let read_failed = "Could not read the entertainment area from the bridge.";
    let response = match client
        .get(endpoint)
        .header("hue-application-key", app_key)
        .send()
    {
        Ok(r) => r,
        Err(e) => {
            return status(
                "CHAN_WB_NETWORK_ERROR",
                format!("Could not reach the bridge: {e}"),
                None,
            )
        }
    };
    let response = match classify_hue_response_blocking(response) {
        Ok(r) => r,
        Err(fault) => return fault_status(fault, "CHAN_WB_NETWORK_ERROR", read_failed),
    };
    let body = response.text().unwrap_or_default();
    if let Some(errors) = clip_v2_errors(&body) {
        return status("CHAN_WB_NETWORK_ERROR", read_failed, Some(errors));
    }
    let area: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
    let merge = match merge_service_locations(&area, placements) {
        Ok(merge) => merge,
        Err(e) => return status("CHAN_WB_NETWORK_ERROR", read_failed, Some(e)),
    };

    if !merge.unmappable.is_empty() {
        warn!(
            "[hue-writeback] skipped channel(s) {:?}: no single bridge position",
            merge.unmappable
        );
    }
    let skipped = skipped_details(merge.unresolved, &merge.unmappable);
    if merge.written.is_empty() {
        return status(
            "CHAN_WB_UNRESOLVED_CHANNEL",
            "No channel could be matched to a single position on the bridge.",
            skipped,
        );
    }

    let rejected = "The bridge rejected the positions.";
    let response = match client
        .put(endpoint)
        .header("hue-application-key", app_key)
        .json(&merge.body)
        .send()
    {
        Ok(r) => r,
        Err(e) => {
            return status(
                "CHAN_WB_NETWORK_ERROR",
                format!("Could not reach the bridge: {e}"),
                None,
            )
        }
    };
    let response = match classify_hue_response_blocking(response) {
        Ok(r) => r,
        Err(fault) => {
            warn!("[hue-writeback] PUT rejected: {fault}");
            return fault_status(fault, "CHAN_WB_SCHEMA_REJECTED", rejected);
        }
    };
    if let Some(errors) = clip_v2_errors(&response.text().unwrap_or_default()) {
        warn!("[hue-writeback] PUT answered 2xx with errors: {errors}");
        return status("CHAN_WB_SCHEMA_REJECTED", rejected, Some(errors));
    }

    status(
        "HUE_CHANNEL_POSITIONS_UPDATED",
        "Positions saved to bridge.",
        skipped,
    )
}

/// Push room-map channel positions to the bridge's entertainment
/// configuration: GET, replace the mapped `service_locations` positions, PUT.
///
/// Async so Tauri does not run it on the main thread: the body is a keychain
/// read and two blocking HTTP calls of up to 5 s each, which froze the UI.
#[tauri::command]
pub async fn update_hue_channel_positions(
    channels: Vec<HueChannelPlacement>,
    bridge_ip: String,
    username: String,
    area_id: String,
) -> CommandStatus {
    run_writeback_off_thread(move || {
        update_hue_channel_positions_blocking(channels, bridge_ip, username, area_id)
    })
    .await
}

/// Run a blocking write-back job on the blocking pool. A panicked job still
/// answers with a coded status: this command never rejects.
async fn run_writeback_off_thread<F>(job: F) -> CommandStatus
where
    F: FnOnce() -> CommandStatus + Send + 'static,
{
    match tokio::task::spawn_blocking(job).await {
        Ok(status) => status,
        Err(error) => status(
            "CHAN_WB_NETWORK_ERROR",
            "The bridge write-back task stopped unexpectedly.",
            Some(error.to_string()),
        ),
    }
}

fn update_hue_channel_positions_blocking(
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
        return re_pair_status("No Hue application key in the OS keychain or the request payload.");
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
    write_channel_positions(&client, &endpoint, &username, &channels)
}

#[cfg(test)]
mod tests {
    use std::io::{BufRead, BufReader, Read, Write};
    use std::net::TcpListener;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex};
    use std::thread::JoinHandle;
    use std::time::Duration;

    use super::*;
    use crate::models::room_map::HueChannelHeightOrigin;

    const SVC_A: &str = "11111111-1111-1111-1111-111111111111";
    const SVC_B: &str = "22222222-2222-2222-2222-222222222222";
    const SVC_GRADIENT: &str = "33333333-3333-3333-3333-333333333333";

    fn placement(channel_id: Option<u8>, x: f64, y: f64, z: f64) -> HueChannelPlacement {
        HueChannelPlacement {
            channel_index: channel_id.unwrap_or(0),
            x,
            y,
            z,
            z_origin: Some(HueChannelHeightOrigin::User),
            label: None,
            locked: None,
            entertainment_area_id: Some("area-1".to_string()),
            channel_id,
            zone_id: None,
            zone_relative_position: None,
        }
    }

    fn service(rid: &str) -> Value {
        json!({ "rid": rid, "rtype": "entertainment" })
    }

    fn pos(x: f64, y: f64, z: f64) -> Value {
        json!({ "x": x, "y": y, "z": z })
    }

    /// The shape the maintainer's bridge returned: two single-position
    /// services, one channel each, members addressing segment 0.
    fn two_service_area() -> Value {
        json!({
            "errors": [],
            "data": [{
                "id": "area-1",
                "type": "entertainment_configuration",
                "channels": [
                    { "channel_id": 0, "position": pos(-0.5, 0.8, 0.1),
                      "members": [{ "service": service(SVC_A), "index": 0 }] },
                    { "channel_id": 1, "position": pos(0.5, 0.8, -0.2),
                      "members": [{ "service": service(SVC_B), "index": 0 }] }
                ],
                "locations": { "service_locations": [
                    { "service": service(SVC_A), "position": pos(-0.5, 0.8, 0.1),
                      "positions": [pos(-0.5, 0.8, 0.1)], "equalization_factor": 1.0 },
                    { "service": service(SVC_B), "position": pos(0.5, 0.8, -0.2),
                      "positions": [pos(0.5, 0.8, -0.2)], "equalization_factor": 0.8 }
                ] }
            }]
        })
    }

    /// A gradient strip (two positions, three segment channels 2..4) beside a
    /// plain bulb on channel 0 — the layout diyHue synthesises for one.
    fn gradient_area() -> Value {
        json!({
            "errors": [],
            "data": [{
                "channels": [
                    { "channel_id": 0, "members": [{ "service": service(SVC_A), "index": 0 }] },
                    { "channel_id": 2, "members": [{ "service": service(SVC_GRADIENT), "index": 0 }] },
                    { "channel_id": 3, "members": [{ "service": service(SVC_GRADIENT), "index": 1 }] },
                    { "channel_id": 4, "members": [{ "service": service(SVC_GRADIENT), "index": 2 }] }
                ],
                "locations": { "service_locations": [
                    { "service": service(SVC_A), "positions": [pos(0.0, 0.0, 0.0)] },
                    { "service": service(SVC_GRADIENT),
                      "positions": [pos(-0.4, 0.8, 0.0), pos(0.4, 0.8, 0.0)] }
                ] }
            }]
        })
    }

    fn locations(merge: &ServiceLocationMerge) -> &Vec<Value> {
        merge.body["locations"]["service_locations"]
            .as_array()
            .expect("service_locations")
    }

    #[test]
    fn the_maintainers_two_service_area_writes_each_service_its_own_position() {
        let get = two_service_area();
        let merge = merge_service_locations(
            &get,
            &[
                placement(Some(0), 0.11, 0.22, 0.33),
                placement(Some(1), -0.6, -0.7, 0.9),
            ],
        )
        .unwrap();

        assert_eq!(merge.written, vec![0, 1]);
        assert!(merge.unmappable.is_empty());
        assert!(
            merge.body.get("channels").is_none(),
            "the bridge answers 400 to a PUT carrying `channels`"
        );
        let locs = locations(&merge);
        assert_eq!(locs.len(), 2, "the full list goes back, not a subset");
        assert_eq!(locs[0]["positions"], json!([pos(0.11, 0.22, 0.33)]));
        assert_eq!(locs[1]["positions"], json!([pos(-0.6, -0.7, 0.9)]));
        assert_eq!(locs[0]["position"], pos(0.11, 0.22, 0.33));
        // Everything else the GET returned rides along untouched.
        assert_eq!(locs[0]["service"], service(SVC_A));
        assert_eq!(locs[1]["equalization_factor"], json!(0.8));
    }

    #[test]
    fn channels_are_matched_by_bridge_id_not_by_list_order() {
        let get = two_service_area();
        let merge = merge_service_locations(&get, &[placement(Some(1), 0.3, 0.3, 0.3)]).unwrap();

        assert_eq!(merge.written, vec![1]);
        let locs = locations(&merge);
        assert_eq!(
            locs[0]["positions"],
            json!([pos(-0.5, 0.8, 0.1)]),
            "untouched"
        );
        assert_eq!(locs[1]["positions"], json!([pos(0.3, 0.3, 0.3)]));
    }

    #[test]
    fn a_gradient_service_is_left_untouched_and_the_bulb_beside_it_still_saves() {
        let get = gradient_area();
        let merge = merge_service_locations(
            &get,
            &[
                placement(Some(0), 0.5, 0.5, 0.5),
                placement(Some(2), 0.9, 0.9, 0.9),
                placement(Some(3), 0.9, 0.9, 0.9),
            ],
        )
        .unwrap();

        assert_eq!(merge.written, vec![0]);
        assert_eq!(merge.unmappable, vec![2, 3]);
        let locs = locations(&merge);
        assert_eq!(locs[0]["positions"], json!([pos(0.5, 0.5, 0.5)]));
        assert_eq!(
            locs[1]["positions"],
            json!([pos(-0.4, 0.8, 0.0), pos(0.4, 0.8, 0.0)]),
            "a segment channel's position is interpolated; writing one would be a guess"
        );
    }

    #[test]
    fn a_channel_that_cannot_be_mapped_is_skipped_never_guessed() {
        let mut get = two_service_area();
        // Channel 1 grouped over two services: its position is an average.
        get["data"][0]["channels"][1]["members"] = json!([
            { "service": service(SVC_A), "index": 0 },
            { "service": service(SVC_B), "index": 0 }
        ]);
        let merge = merge_service_locations(
            &get,
            &[
                placement(Some(1), 0.1, 0.1, 0.1),
                placement(Some(7), 0.1, 0.1, 0.1),
                placement(None, 0.1, 0.1, 0.1),
            ],
        )
        .unwrap();

        assert!(merge.written.is_empty());
        assert_eq!(
            merge.unmappable,
            vec![1, 7],
            "grouped, and absent from the area"
        );
        assert_eq!(merge.unresolved, 1);
        let original = two_service_area();
        assert_eq!(
            locations(&merge),
            original["data"][0]["locations"]["service_locations"]
                .as_array()
                .unwrap()
        );
    }

    #[test]
    fn a_two_position_service_is_not_written_even_with_one_channel() {
        let mut get = two_service_area();
        get["data"][0]["locations"]["service_locations"][0]["positions"] =
            json!([pos(-0.4, 0.8, 0.0), pos(0.4, 0.8, 0.0)]);
        let merge = merge_service_locations(&get, &[placement(Some(0), 0.1, 0.1, 0.1)]).unwrap();
        assert_eq!(merge.unmappable, vec![0]);

        let mut get = two_service_area();
        get["data"][0]["channels"][0]["members"][0]["index"] = json!(1);
        let merge = merge_service_locations(&get, &[placement(Some(0), 0.1, 0.1, 0.1)]).unwrap();
        assert_eq!(
            merge.unmappable,
            vec![0],
            "segment 1 of a one-position service"
        );
    }

    #[test]
    fn a_position_two_channels_share_is_not_written() {
        let mut get = two_service_area();
        get["data"][0]["channels"][1]["members"] =
            json!([{ "service": service(SVC_A), "index": 0 }]);
        let merge = merge_service_locations(&get, &[placement(Some(0), 0.1, 0.1, 0.1)]).unwrap();

        assert!(merge.written.is_empty());
        assert_eq!(merge.unmappable, vec![0]);
    }

    #[test]
    fn two_placements_for_one_channel_write_neither() {
        let get = two_service_area();
        let merge = merge_service_locations(
            &get,
            &[
                placement(Some(0), 0.1, 0.1, 0.1),
                placement(Some(0), 0.9, 0.9, 0.9),
            ],
        )
        .unwrap();

        assert!(merge.written.is_empty());
        assert_eq!(merge.unmappable, vec![0]);
    }

    #[test]
    fn a_height_of_unknown_origin_keeps_the_bridges_height() {
        let get = two_service_area();
        let mut unknown = placement(Some(0), 0.2, 0.3, 0.0);
        unknown.z_origin = None;
        let mut from_bridge = placement(Some(1), 0.2, 0.3, 0.6);
        from_bridge.z_origin = Some(HueChannelHeightOrigin::Bridge);

        let merge = merge_service_locations(&get, &[unknown, from_bridge]).unwrap();

        let locs = locations(&merge);
        assert_eq!(
            locs[0]["positions"],
            json!([pos(0.2, 0.3, 0.1)]),
            "the placeholder 0 must not overwrite the bridge's 0.1"
        );
        assert_eq!(locs[1]["positions"], json!([pos(0.2, 0.3, 0.6)]));
    }

    #[test]
    fn positions_are_clamped_to_the_bridges_range() {
        let get = two_service_area();
        let merge = merge_service_locations(&get, &[placement(Some(0), 1.4, -3.0, 2.0)]).unwrap();
        assert_eq!(
            locations(&merge)[0]["positions"],
            json!([pos(1.0, -1.0, 1.0)])
        );
    }

    #[test]
    fn a_body_without_locations_is_an_error_not_an_empty_write() {
        let get = json!({ "errors": [], "data": [{ "channels": [] }] });
        assert!(merge_service_locations(&get, &[placement(Some(0), 0.0, 0.0, 0.0)]).is_err());
    }

    #[test]
    fn clip_v2_errors_reads_a_2xx_rejection() {
        assert_eq!(
            clip_v2_errors(r#"{"data":[{"rid":"a"}],"errors":[]}"#),
            None
        );
        assert_eq!(
            clip_v2_errors(r#"{"data":[],"errors":[{"description":"bad"}]}"#).as_deref(),
            Some("bad")
        );
        assert!(clip_v2_errors("<html>").is_some());
    }

    // -----------------------------------------------------------------------
    // Command path against a local stand-in for the bridge
    // -----------------------------------------------------------------------

    #[derive(Debug)]
    struct Recorded {
        method: String,
        body: String,
    }

    struct FakeBridge {
        endpoint: String,
        stop: Arc<AtomicBool>,
        seen: Arc<Mutex<Vec<Recorded>>>,
        handle: Option<JoinHandle<()>>,
    }

    impl FakeBridge {
        /// Answers the queued `(status, body)` pairs in order, one request per
        /// connection; anything past the queue gets a 500.
        fn start(replies: Vec<(u16, String)>) -> Self {
            Self::start_with_content_type("application/json", replies)
        }

        fn start_with_content_type(
            content_type: &'static str,
            replies: Vec<(u16, String)>,
        ) -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            listener.set_nonblocking(true).unwrap();
            let endpoint = format!(
                "http://{}/clip/v2/resource/entertainment_configuration/area-1",
                listener.local_addr().unwrap()
            );
            let stop = Arc::new(AtomicBool::new(false));
            let seen = Arc::new(Mutex::new(Vec::new()));
            let (thread_stop, thread_seen) = (Arc::clone(&stop), Arc::clone(&seen));
            let handle = std::thread::spawn(move || {
                let mut replies = replies.into_iter();
                while !thread_stop.load(Ordering::SeqCst) {
                    let Ok((stream, _)) = listener.accept() else {
                        std::thread::sleep(Duration::from_millis(5));
                        continue;
                    };
                    stream.set_nonblocking(false).unwrap();
                    let mut reader = BufReader::new(stream.try_clone().unwrap());
                    let mut request_line = String::new();
                    reader.read_line(&mut request_line).unwrap();
                    let mut content_length = 0usize;
                    loop {
                        let mut line = String::new();
                        reader.read_line(&mut line).unwrap();
                        if line == "\r\n" || line.is_empty() {
                            break;
                        }
                        if let Some((name, value)) = line.split_once(':') {
                            if name.eq_ignore_ascii_case("content-length") {
                                content_length = value.trim().parse().unwrap();
                            }
                        }
                    }
                    let mut body = vec![0; content_length];
                    reader.read_exact(&mut body).unwrap();
                    thread_seen.lock().unwrap().push(Recorded {
                        method: request_line
                            .split_whitespace()
                            .next()
                            .unwrap_or_default()
                            .to_string(),
                        body: String::from_utf8(body).unwrap(),
                    });
                    let (status, reply) = replies.next().unwrap_or((
                        500,
                        r#"{"errors":[{"description":"unexpected"}]}"#.to_string(),
                    ));
                    let mut stream = stream;
                    write!(
                        stream,
                        "HTTP/1.1 {status} X\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{reply}",
                        reply.len()
                    )
                    .unwrap();
                }
            });
            Self {
                endpoint,
                stop,
                seen,
                handle: Some(handle),
            }
        }

        fn run(mut self, placements: &[HueChannelPlacement]) -> (CommandStatus, Vec<Recorded>) {
            let client = BlockingClient::builder()
                .timeout(Duration::from_secs(5))
                .build()
                .unwrap();
            let status = write_channel_positions(&client, &self.endpoint, "app-key", placements);
            self.stop.store(true, Ordering::SeqCst);
            self.handle.take().unwrap().join().unwrap();
            let seen = std::mem::take(&mut *self.seen.lock().unwrap());
            (status, seen)
        }
    }

    const PUT_OK: &str =
        r#"{"data":[{"rid":"area-1","rtype":"entertainment_configuration"}],"errors":[]}"#;
    const HUE_UNAUTHORIZED: &str = r#"{"errors":[{"description":"unauthorized user"}]}"#;

    #[test]
    fn a_save_gets_the_area_then_puts_the_full_service_location_list() {
        let bridge = FakeBridge::start(vec![
            (200, two_service_area().to_string()),
            (200, PUT_OK.to_string()),
        ]);
        let (status, seen) = bridge.run(&[placement(Some(0), 0.11, 0.22, 0.33)]);

        assert_eq!(status.code, "HUE_CHANNEL_POSITIONS_UPDATED");
        assert_eq!(seen.len(), 2);
        assert_eq!(seen[0].method, "GET");
        assert_eq!(seen[1].method, "PUT");
        let put: Value = serde_json::from_str(&seen[1].body).unwrap();
        assert!(put.get("channels").is_none());
        let locs = put["locations"]["service_locations"].as_array().unwrap();
        assert_eq!(locs.len(), 2);
        assert_eq!(locs[0]["positions"], json!([pos(0.11, 0.22, 0.33)]));
        assert_eq!(locs[1]["positions"], json!([pos(0.5, 0.8, -0.2)]));
    }

    #[test]
    fn a_2xx_that_carries_errors_is_a_failure() {
        let bridge = FakeBridge::start(vec![
            (200, two_service_area().to_string()),
            (
                200,
                r#"{"data":[],"errors":[{"description":"invalid position"}]}"#.to_string(),
            ),
        ]);
        let (status, _) = bridge.run(&[placement(Some(0), 0.1, 0.1, 0.1)]);

        assert_eq!(status.code, "CHAN_WB_SCHEMA_REJECTED");
        assert_eq!(status.details.as_deref(), Some("invalid position"));
    }

    #[test]
    fn the_old_channels_rejection_reads_as_rejected_not_re_pair() {
        let bridge = FakeBridge::start(vec![
            (200, two_service_area().to_string()),
            (
                400,
                r#"{"data":[],"errors":[{"description":"Invalid Request: Property [channels] cannot be specified for this request type"}]}"#.to_string(),
            ),
        ]);
        let (status, _) = bridge.run(&[placement(Some(0), 0.1, 0.1, 0.1)]);
        assert_eq!(status.code, "CHAN_WB_SCHEMA_REJECTED");
    }

    #[test]
    fn a_hue_shaped_401_on_the_get_asks_for_a_re_pair_and_never_puts() {
        let bridge = FakeBridge::start(vec![(401, HUE_UNAUTHORIZED.to_string())]);
        let (status, seen) = bridge.run(&[placement(Some(0), 0.1, 0.1, 0.1)]);

        assert_eq!(status.code, "AUTH_INVALID_RE_PAIR_REQUIRED");
        assert_eq!(seen.len(), 1, "no PUT after a rejected key");
    }

    #[test]
    fn a_hue_shaped_403_on_the_put_asks_for_a_re_pair() {
        let bridge = FakeBridge::start(vec![
            (200, two_service_area().to_string()),
            (403, HUE_UNAUTHORIZED.to_string()),
        ]);
        let (status, _) = bridge.run(&[placement(Some(0), 0.1, 0.1, 0.1)]);
        assert_eq!(status.code, "AUTH_INVALID_RE_PAIR_REQUIRED");
    }

    /// Area deleted in the Hue app (or an id from another bridge): the GET
    /// answers 404, which is neither a network error nor worth a PUT.
    #[test]
    fn a_404_on_the_get_is_an_area_not_found_and_never_puts() {
        let bridge = FakeBridge::start(vec![(
            404,
            r#"{"errors":[{"description":"Not Found"}],"data":[]}"#.to_string(),
        )]);
        let (status, seen) = bridge.run(&[placement(Some(0), 0.1, 0.1, 0.1)]);

        assert_eq!(status.code, "CHAN_WB_AREA_NOT_FOUND");
        assert_eq!(seen.len(), 1, "no PUT to an area that is gone");
    }

    #[test]
    fn a_404_on_the_put_is_an_area_not_found() {
        let bridge = FakeBridge::start(vec![
            (200, two_service_area().to_string()),
            (
                404,
                r#"{"errors":[{"description":"Not Found"}]}"#.to_string(),
            ),
        ]);
        let (status, _) = bridge.run(&[placement(Some(0), 0.1, 0.1, 0.1)]);
        assert_eq!(status.code, "CHAN_WB_AREA_NOT_FOUND");
    }

    /// The bridge's own HTML refusal of a bogus key (BSB002 fw 1978293000).
    #[test]
    fn the_bridges_html_403_on_the_get_asks_for_a_re_pair() {
        let bridge = FakeBridge::start_with_content_type(
            "text/html",
            vec![(
                403,
                crate::commands::hue_http::tests::BRIDGE_403_PAGE.to_string(),
            )],
        );
        let (status, seen) = bridge.run(&[placement(Some(0), 0.1, 0.1, 0.1)]);

        assert_eq!(status.code, "AUTH_INVALID_RE_PAIR_REQUIRED");
        assert_eq!(seen.len(), 1);
    }

    /// The command used to be sync, which Tauri runs on the main thread: two
    /// blocking HTTP calls froze the UI for up to ~10 s. The job must run on
    /// the blocking pool and leave the calling runtime free meanwhile.
    #[tokio::test(flavor = "current_thread")]
    async fn the_write_back_leaves_the_calling_runtime_free() {
        use std::sync::atomic::AtomicUsize;

        let ticks = Arc::new(AtomicUsize::new(0));
        let done = Arc::new(AtomicBool::new(false));
        let ticker = {
            let (ticks, done) = (Arc::clone(&ticks), Arc::clone(&done));
            tokio::spawn(async move {
                while !done.load(Ordering::SeqCst) {
                    ticks.fetch_add(1, Ordering::SeqCst);
                    tokio::task::yield_now().await;
                }
            })
        };

        let result = run_writeback_off_thread(|| {
            std::thread::sleep(Duration::from_millis(150));
            status("HUE_CHANNEL_POSITIONS_UPDATED", "ok", None)
        })
        .await;
        let observed = ticks.load(Ordering::SeqCst);
        done.store(true, Ordering::SeqCst);
        ticker.await.unwrap();

        assert_eq!(result.code, "HUE_CHANNEL_POSITIONS_UPDATED");
        assert!(
            observed > 0,
            "the runtime made no progress while the write-back ran"
        );
    }

    #[tokio::test]
    async fn a_panicking_write_back_still_answers_with_a_code() {
        let result = run_writeback_off_thread(|| panic!("boom")).await;
        assert_eq!(result.code, "CHAN_WB_NETWORK_ERROR");
    }

    #[test]
    fn a_proxy_403_is_not_a_re_pair() {
        let bridge = FakeBridge::start(vec![
            (200, two_service_area().to_string()),
            (403, "<html>Forbidden</html>".to_string()),
        ]);
        let (status, _) = bridge.run(&[placement(Some(0), 0.1, 0.1, 0.1)]);
        assert_eq!(status.code, "CHAN_WB_SCHEMA_REJECTED");
    }

    #[test]
    fn nothing_mappable_is_reported_unresolved_without_a_put() {
        let bridge = FakeBridge::start(vec![(200, gradient_area().to_string())]);
        let (status, seen) = bridge.run(&[placement(Some(3), 0.1, 0.1, 0.1)]);

        assert_eq!(status.code, "CHAN_WB_UNRESOLVED_CHANNEL");
        assert_eq!(seen.len(), 1, "GET only");
    }

    #[test]
    fn skipped_channels_are_named_on_a_partial_save() {
        let bridge = FakeBridge::start(vec![
            (200, gradient_area().to_string()),
            (200, PUT_OK.to_string()),
        ]);
        let (status, _) = bridge.run(&[
            placement(Some(0), 0.1, 0.1, 0.1),
            placement(Some(3), 0.1, 0.1, 0.1),
        ]);

        assert_eq!(status.code, "HUE_CHANNEL_POSITIONS_UPDATED");
        assert!(status.details.unwrap().contains("Channel(s) 3"));
    }

    #[test]
    fn placements_without_a_bridge_id_never_reach_the_network() {
        let bridge = FakeBridge::start(vec![]);
        let (status, seen) = bridge.run(&[placement(None, 0.1, 0.1, 0.1)]);

        assert_eq!(status.code, "CHAN_WB_UNRESOLVED_CHANNEL");
        assert!(seen.is_empty());
    }
}
