//! What a Hue start needs, read from the persisted state: the bridge, the area,
//! the pairing evidence and the user's channel placements. Rust mirror of
//! `toHueStartConfig`, `toChannelPlacements` (`src/features/hue/model/
//! hueStartConfig.ts`) and `toRoomGeometry` (`room-map/model/roomGeometry.ts`).
//! The two sides are held together by one JSON fixture both test suites read.

use serde::Deserialize;

use super::state_store::{
    HueChannelPlacementOverride, HueRuntimeTriggerSource, StartHueStreamRequest,
};
use crate::commands::shell_state::PersistedShellState;
use crate::models::room_map::{
    RoomDimensions, RoomGeometry, TvAnchorPlacement, ZoneRelativePosition,
};

/// `credentialStorageBackend` value that alone proves a pairing: the keys left
/// the state file for the keychain.
const KEYCHAIN_BACKEND: &str = "keychain";

/// The persisted fields a Hue start is built from, as `shell_state.rs` reads them.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct HueStartView {
    pub bridge_ip: Option<String>,
    pub app_key: Option<String>,
    pub client_key: Option<String>,
    pub credential_backend: Option<String>,
    pub area_id: Option<String>,
}

/// The part of `roomMap` placement and room geometry depend on. Everything
/// else in the document stays unread here.
#[derive(Clone, Debug, Default)]
pub struct RoomPlacementView {
    pub hue_channels: Vec<PlacementRecord>,
    pub zones: Vec<ZoneFrame>,
    pub tv_anchor: Option<TvAnchorPlacement>,
    pub dimensions: Option<RoomDimensions>,
}

/// One `HueChannelPlacement`, reduced to what the projection reads.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlacementRecord {
    #[serde(default)]
    pub entertainment_area_id: Option<String>,
    #[serde(default)]
    pub channel_id: Option<u8>,
    pub x: f64,
    pub y: f64,
    #[serde(default)]
    pub z: Option<f64>,
    #[serde(default)]
    pub z_origin: Option<String>,
    #[serde(default)]
    pub zone_id: Option<String>,
    #[serde(default)]
    pub zone_relative_position: Option<ZoneRelativePosition>,
}

/// A `HueZone`'s frame: where its relative positions land in the area.
#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ZoneFrame {
    pub id: String,
    pub center_x: f64,
    pub center_y: f64,
    pub center_z: f64,
    pub scale_x: f64,
    pub scale_y: f64,
    pub scale_z: f64,
}

/// `clampUnit` in `hueChannelPosition.ts`: a non-finite value is 0.
fn clamp_unit(value: f64) -> f64 {
    if !value.is_finite() {
        return 0.0;
    }
    value.clamp(-1.0, 1.0)
}

fn non_empty(value: Option<&str>) -> Option<&str> {
    value.filter(|v| !v.is_empty())
}

fn bound_zone<'a>(channel: &PlacementRecord, zones: &'a [ZoneFrame]) -> Option<&'a ZoneFrame> {
    let zone_id = non_empty(channel.zone_id.as_deref())?;
    zones.iter().find(|zone| zone.id == zone_id)
}

/// `resolveHueChannelWorld`: only the zone-relative path is clamped; an
/// absolute position passes through as stored.
fn resolve_world(channel: &PlacementRecord, zones: &[ZoneFrame]) -> (f64, f64) {
    match (bound_zone(channel, zones), &channel.zone_relative_position) {
        (Some(zone), Some(rel)) => (
            clamp_unit(zone.center_x + zone.scale_x * rel.x),
            clamp_unit(zone.center_y + zone.scale_y * rel.y),
        ),
        _ => (channel.x, channel.y),
    }
}

fn resolve_world_z(channel: &PlacementRecord, zones: &[ZoneFrame]) -> Option<f64> {
    match (bound_zone(channel, zones), &channel.zone_relative_position) {
        (Some(zone), Some(rel)) => Some(clamp_unit(zone.center_z + zone.scale_z * rel.z)),
        _ => channel.z,
    }
}

/// `toChannelPlacements`: the area's placements in world space, keyed by the
/// bridge's channel id. A channel scoped to no area belongs to every area; one
/// with no `channelId` is dropped rather than addressed by our ordinal; a
/// height rides only when its origin is known. `None` when nothing is left.
pub fn to_channel_placements(
    room: Option<&RoomPlacementView>,
    area_id: &str,
) -> Option<Vec<HueChannelPlacementOverride>> {
    let room = room?;
    let placements: Vec<HueChannelPlacementOverride> = room
        .hue_channels
        .iter()
        .filter(|channel| {
            non_empty(channel.entertainment_area_id.as_deref()).is_none_or(|area| area == area_id)
        })
        .filter_map(|channel| {
            let channel_id = channel.channel_id?;
            let (x, y) = resolve_world(channel, &room.zones);
            let position_z = non_empty(channel.z_origin.as_deref())
                .and_then(|_| resolve_world_z(channel, &room.zones))
                .map(|z| z as f32);
            Some(HueChannelPlacementOverride {
                channel_id,
                position_x: x as f32,
                position_y: y as f32,
                position_z,
            })
        })
        .collect();
    (!placements.is_empty()).then_some(placements)
}

/// `toRoomGeometry`: present only while a TV anchor exists, which is the gate
/// that keeps a room map with no TV on the legacy sampling path.
pub fn to_room_geometry(
    room: Option<&RoomPlacementView>,
    last_area_id: Option<&str>,
) -> Option<RoomGeometry> {
    let view = room?;
    let anchor = view.tv_anchor.as_ref()?;
    let dimensions = view.dimensions.clone()?;
    let hue_placements = non_empty(last_area_id.map(str::trim))
        .and_then(|area| to_channel_placements(Some(view), area))
        .unwrap_or_default();
    Some(RoomGeometry {
        dimensions,
        tv: TvAnchorPlacement {
            x: anchor.x,
            y: anchor.y,
            width: anchor.width,
            height: anchor.height,
            locked: None,
            mount_height_meters: anchor.mount_height_meters,
        },
        hue_placements,
    })
}

/// `toHueStartConfig` as a start request, or `None` unless a bridge, an area
/// and a pairing are all on record. Paired is the app key on disk *or* the
/// keychain backend: an empty key is the "resolve from the keychain" signal the
/// start path acts on, so it cannot also mean "never paired".
pub fn hue_start_request(
    state: &PersistedShellState,
    trigger: HueRuntimeTriggerSource,
) -> Option<StartHueStreamRequest> {
    let view = state.hue_start_view();
    let bridge_ip = non_empty(view.bridge_ip.as_deref().map(str::trim))?.to_string();
    let area_id = non_empty(view.area_id.as_deref().map(str::trim))?.to_string();
    let username = view.app_key.as_deref().map(str::trim).unwrap_or_default();
    let client_key = view
        .client_key
        .as_deref()
        .map(str::trim)
        .unwrap_or_default();
    let paired =
        !username.is_empty() || view.credential_backend.as_deref() == Some(KEYCHAIN_BACKEND);
    if !paired {
        return None;
    }
    let room = state.room_placement_view();
    Some(StartHueStreamRequest {
        channel_placements: to_channel_placements(room.as_ref(), &area_id),
        bridge_ip,
        username: username.to_string(),
        client_key: client_key.to_string(),
        area_id,
        trigger_source: Some(trigger),
    })
}

/// The room geometry the ambilight worker samples by, from the persisted room
/// map and area.
pub fn room_geometry_from_state(state: &PersistedShellState) -> Option<RoomGeometry> {
    let area = state.hue_start_view().area_id;
    to_room_geometry(state.room_placement_view().as_ref(), area.as_deref())
}

#[cfg(test)]
mod tests {
    use serde::Deserialize;
    use serde_json::Value;

    use super::*;
    use crate::commands::shell_state::PersistedShellState;

    /// Shared with `hueStartConfig.parity.test.ts`; both suites must pass it
    /// unchanged. Edit it only together with both implementations.
    const PARITY_FIXTURE: &str = include_str!(
        "../../../../src/features/hue/model/__tests__/fixtures/channelPlacements.parity.json"
    );

    #[derive(Deserialize)]
    struct Fixture {
        placements: Vec<PlacementCase>,
        #[serde(rename = "roomGeometry")]
        room_geometry: Vec<GeometryCase>,
    }

    #[derive(Deserialize)]
    struct PlacementCase {
        name: String,
        #[serde(rename = "roomMap")]
        room_map: Option<Value>,
        #[serde(rename = "areaId")]
        area_id: String,
        expected: Option<Vec<Value>>,
    }

    #[derive(Deserialize)]
    struct GeometryCase {
        name: String,
        state: Value,
        expected: Option<Value>,
    }

    fn view_of(room_map: &Value) -> Option<RoomPlacementView> {
        let raw = serde_json::json!({ "shell-state": { "roomMap": room_map } }).to_string();
        PersistedShellState::from_file_json(&raw)?.room_placement_view()
    }

    fn close(actual: f64, expected: &Value, what: &str) {
        let expected = expected
            .as_f64()
            .unwrap_or_else(|| panic!("{what}: not a number"));
        assert!(
            (actual - expected).abs() < 1e-6,
            "{what}: expected {expected}, got {actual}"
        );
    }

    fn assert_placements(name: &str, actual: &[HueChannelPlacementOverride], expected: &[Value]) {
        assert_eq!(actual.len(), expected.len(), "{name}: placement count");
        for (index, (got, want)) in actual.iter().zip(expected).enumerate() {
            let what = format!("{name}[{index}]");
            assert_eq!(
                Some(u64::from(got.channel_id)),
                want["channelId"].as_u64(),
                "{what}.channelId"
            );
            close(
                f64::from(got.position_x),
                &want["positionX"],
                &format!("{what}.positionX"),
            );
            close(
                f64::from(got.position_y),
                &want["positionY"],
                &format!("{what}.positionY"),
            );
            match (got.position_z, want.get("positionZ")) {
                (None, None) => {}
                (Some(z), Some(want_z)) => {
                    close(f64::from(z), want_z, &format!("{what}.positionZ"))
                }
                (got_z, want_z) => panic!("{what}.positionZ: got {got_z:?}, expected {want_z:?}"),
            }
        }
    }

    /// Same keys, numbers equal as numbers: `1` from the fixture and `1.0`
    /// from an `f64` are different `Value`s but the same value.
    fn assert_json_close(got: &Value, want: &Value, name: &str) {
        match (got, want) {
            (Value::Object(got), Value::Object(want)) => {
                let mut got_keys: Vec<_> = got.keys().collect();
                let mut want_keys: Vec<_> = want.keys().collect();
                got_keys.sort();
                want_keys.sort();
                assert_eq!(got_keys, want_keys, "{name}: keys");
                for (key, value) in want {
                    assert_json_close(&got[key], value, &format!("{name}.{key}"));
                }
            }
            (Value::Number(_), Value::Number(_)) => close(got.as_f64().unwrap(), want, name),
            _ => assert_eq!(got, want, "{name}"),
        }
    }

    fn fixture() -> Fixture {
        serde_json::from_str(PARITY_FIXTURE).expect("the parity fixture parses")
    }

    #[test]
    fn channel_placements_match_the_frontend_projection() {
        let fixture = fixture();
        assert!(fixture.placements.len() >= 8, "the fixture lost its cases");
        for case in fixture.placements {
            let view = case.room_map.as_ref().and_then(view_of);
            let actual = to_channel_placements(view.as_ref(), &case.area_id);
            match (&actual, &case.expected) {
                (None, None) => {}
                (Some(actual), Some(expected)) => assert_placements(&case.name, actual, expected),
                _ => panic!(
                    "{}: got {actual:?}, expected {:?}",
                    case.name, case.expected
                ),
            }
        }
    }

    #[test]
    fn room_geometry_matches_the_frontend_projection() {
        for case in fixture().room_geometry {
            let raw = serde_json::json!({ "shell-state": case.state }).to_string();
            let state = PersistedShellState::from_file_json(&raw).expect("state parses");
            let actual = room_geometry_from_state(&state);
            match (&actual, &case.expected) {
                (None, None) => {}
                (Some(actual), Some(expected)) => {
                    let got = serde_json::to_value(actual).unwrap();
                    assert_json_close(&got["dimensions"], &expected["dimensions"], &case.name);
                    assert_json_close(&got["tv"], &expected["tv"], &case.name);
                    let want: Vec<Value> = expected["huePlacements"]
                        .as_array()
                        .cloned()
                        .unwrap_or_default();
                    assert_placements(&case.name, &actual.hue_placements, &want);
                }
                _ => panic!(
                    "{}: got {actual:?}, expected {:?}",
                    case.name, case.expected
                ),
            }
        }
    }

    fn start_state(json: Value) -> PersistedShellState {
        PersistedShellState::from_file_json(&serde_json::json!({ "shell-state": json }).to_string())
            .expect("state parses")
    }

    #[test]
    fn a_start_request_needs_a_bridge_an_area_and_a_pairing() {
        let trigger = HueRuntimeTriggerSource::ModeControl;
        let full = serde_json::json!({
            "lastHueBridge": { "ip": " 192.168.1.50 ", "id": "abc" },
            "lastHueAreaId": "area-1",
            "credentialStorageBackend": "keychain"
        });
        let request = hue_start_request(&start_state(full.clone()), trigger.clone())
            .expect("keychain-paired config builds");
        assert_eq!(request.bridge_ip, "192.168.1.50");
        assert_eq!(request.area_id, "area-1");
        assert_eq!(
            request.username, "",
            "an empty key tells the start to read the keychain"
        );
        assert_eq!(request.channel_placements, None);

        let mut legacy = full.clone();
        legacy["credentialStorageBackend"] = Value::String("plaintext-legacy".into());
        assert!(hue_start_request(&start_state(legacy.clone()), trigger.clone()).is_none());
        legacy["hueAppKey"] = Value::String("app-key".into());
        legacy["hueClientKey"] = Value::String("client".into());
        let request = hue_start_request(&start_state(legacy), trigger.clone()).unwrap();
        assert_eq!(
            (request.username.as_str(), request.client_key.as_str()),
            ("app-key", "client")
        );

        for missing in ["lastHueBridge", "lastHueAreaId"] {
            let mut partial = full.clone();
            partial.as_object_mut().unwrap().remove(missing);
            assert!(
                hue_start_request(&start_state(partial), trigger.clone()).is_none(),
                "{missing}"
            );
        }
    }

    #[test]
    fn a_start_request_carries_the_areas_placements() {
        let state = start_state(serde_json::json!({
            "lastHueBridge": { "ip": "192.168.1.50" },
            "lastHueAreaId": "area-1",
            "hueAppKey": "k",
            "roomMap": {
                "hueChannels": [
                    { "channelIndex": 0, "channelId": 4, "entertainmentAreaId": "area-1", "x": 0.5, "y": -0.25, "z": 0 },
                    { "channelIndex": 0, "channelId": 9, "entertainmentAreaId": "area-2", "x": 0.1, "y": 0.1, "z": 0 }
                ],
                "zones": []
            }
        }));
        let placements = hue_start_request(&state, HueRuntimeTriggerSource::System)
            .unwrap()
            .channel_placements
            .unwrap();
        assert_eq!(placements.len(), 1);
        assert_eq!(placements[0].channel_id, 4);
    }
}
