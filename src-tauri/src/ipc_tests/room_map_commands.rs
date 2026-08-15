//! Hue zone authoring over IPC.
//!
//! These commands persist nothing — the frontend hands in the current zone and
//! channel arrays and writes the mutated copies back through `shellStore`. So
//! the wire shape *is* the contract, and a dropped `camelCase` rename or a
//! changed status code breaks the room-map editor with nothing else to catch it.

use serde_json::{json, Value};
use tauri::test::MockRuntime;
use tauri::App;

use super::{assert_camel_case_keys, invoke, main_webview, mock_app, status_code};

fn app() -> App<MockRuntime> {
    mock_app(tauri::generate_handler![
        crate::commands::room_map::hue_zone::create_hue_zone,
        crate::commands::room_map::hue_zone::update_hue_zone,
        crate::commands::room_map::hue_zone::delete_hue_zone,
        crate::commands::room_map::hue_zone::assign_channel_to_hue_zone
    ])
}

fn zone(id: &str) -> Value {
    json!({
        "id": id,
        "name": format!("Zone {id}"),
        "entertainmentAreaId": "area-1",
        "centerX": 0.0, "centerY": 0.0, "centerZ": 0.0,
        "scaleX": 0.5, "scaleY": 0.5, "scaleZ": 0.5,
        "channelIndices": [],
    })
}

#[test]
fn creating_a_zone_echoes_it_back_in_camel_case() {
    let app = app();
    let webview = main_webview(&app);

    let response = invoke(
        &webview,
        "create_hue_zone",
        json!({ "request": { "zone": zone("z1"), "existingZones": [] } }),
    )
    .expect("create_hue_zone must resolve");

    assert_eq!(status_code(&response), "HUE_ZONE_CREATED");
    assert_eq!(response["zones"].as_array().expect("zones array").len(), 1);
    assert_camel_case_keys(&response);
    assert_camel_case_keys(&response["zones"][0]);
}

/// The room map is authored offline and written back wholesale, so a rejected
/// write must hand back the array it was given — returning an empty one would
/// erase every zone the user has.
#[test]
fn a_refused_write_returns_the_zones_it_was_given() {
    let app = app();
    let webview = main_webview(&app);

    let mut oversized = zone("z2");
    oversized["scaleX"] = json!(4.0);

    let response = invoke(
        &webview,
        "create_hue_zone",
        json!({ "request": { "zone": oversized, "existingZones": [zone("z1")] } }),
    )
    .expect("create_hue_zone must resolve, never reject");

    assert_eq!(status_code(&response), "HUE_ZONE_OVERSIZED");
    assert_eq!(response["zones"].as_array().expect("zones array").len(), 1);
    assert_eq!(response["zones"][0]["id"], json!("z1"));
}

#[test]
fn updating_a_zone_that_is_not_there_is_a_coded_refusal() {
    let app = app();
    let webview = main_webview(&app);

    let response = invoke(
        &webview,
        "update_hue_zone",
        json!({ "request": { "zone": zone("missing"), "existingZones": [zone("z1")] } }),
    )
    .expect("update_hue_zone must resolve, never reject");

    assert_eq!(status_code(&response), "HUE_ZONE_NOT_FOUND");
}

/// Deleting a zone must not orphan its channels — they fall back to absolute
/// placement, which is the only thing keeping them addressable.
#[test]
fn deleting_a_zone_detaches_its_channels_rather_than_dropping_them() {
    let app = app();
    let webview = main_webview(&app);

    let channel = json!({
        "channelIndex": 3,
        "x": 0.2, "y": 0.1, "z": 0.0,
        "zoneId": "z1",
        "zoneRelativePosition": { "x": 0.5, "y": 0.0, "z": 0.0 },
    });

    let response = invoke(
        &webview,
        "delete_hue_zone",
        json!({ "request": {
            "zoneId": "z1",
            "existingZones": [zone("z1")],
            "channels": [channel],
        } }),
    )
    .expect("delete_hue_zone must resolve");

    assert_eq!(status_code(&response), "HUE_ZONE_DELETED");
    assert!(response["zones"]
        .as_array()
        .expect("zones array")
        .is_empty());

    let channels = response["channels"].as_array().expect("channels array");
    assert_eq!(channels.len(), 1, "the channel must survive its zone");
    assert_eq!(channels[0]["zoneId"], json!(null));
    assert_camel_case_keys(&channels[0]);
}

/// A zone lives inside one entertainment area. Letting a channel from another
/// area join it would put a bulb the bridge cannot address into the frame.
#[test]
fn a_channel_from_another_area_cannot_join_the_zone() {
    let app = app();
    let webview = main_webview(&app);

    let response = invoke(
        &webview,
        "assign_channel_to_hue_zone",
        json!({ "request": {
            "channelIndex": 1,
            "zoneId": "z1",
            "zoneRelativePosition": { "x": 0.0, "y": 0.0, "z": 0.0 },
            "entertainmentAreaId": "area-2",
            "existingZones": [zone("z1")],
            "channels": [],
        } }),
    )
    .expect("assign_channel_to_hue_zone must resolve, never reject");

    assert_eq!(status_code(&response), "HUE_ZONE_CHANNEL_NOT_IN_AREA");
}

/// The cube is `[-1, 1]`; a relative position outside it resolves to a world
/// coordinate the bridge rejects.
#[test]
fn a_relative_position_outside_the_cube_is_refused() {
    let app = app();
    let webview = main_webview(&app);

    let response = invoke(
        &webview,
        "assign_channel_to_hue_zone",
        json!({ "request": {
            "channelIndex": 1,
            "zoneId": "z1",
            "zoneRelativePosition": { "x": 3.0, "y": 0.0, "z": 0.0 },
            "entertainmentAreaId": "area-1",
            "existingZones": [zone("z1")],
            "channels": [],
        } }),
    )
    .expect("assign_channel_to_hue_zone must resolve, never reject");

    assert_eq!(status_code(&response), "HUE_ZONE_CHANNEL_OUT_OF_BOUNDS");
}
