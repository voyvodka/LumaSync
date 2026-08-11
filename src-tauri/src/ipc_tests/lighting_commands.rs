//! Lighting mode state machine over IPC.

use serde_json::json;
use tauri::test::MockRuntime;
use tauri::App;

use super::{invoke, main_webview, mock_app, status_code};

fn app() -> App<MockRuntime> {
    mock_app(tauri::generate_handler![
        crate::commands::lighting_mode::set_lighting_mode,
        crate::commands::lighting_mode::get_lighting_mode_status,
        crate::commands::lighting_mode::stop_lighting
    ])
}

#[test]
fn lighting_mode_starts_off() {
    let app = app();
    let webview = main_webview(&app);

    let response =
        invoke(&webview, "get_lighting_mode_status", json!({})).expect("status must resolve");

    assert_eq!(status_code(&response), "LIGHTING_MODE_STATUS_OK");
    assert_eq!(response["mode"]["kind"], json!("off"));
}

/// Solid with no device is the everyday state before a controller is paired.
///
/// The invariant under test is that a gated request reports the mode that is
/// *actually* running, not the one that was asked for — `apply_mode_change`
/// returns `owner.active_mode.clone()` on the USB gate (`lighting_mode.rs`).
/// Reporting `solid` here would light the mode strip with no LEDs behind it.
/// An empty `targets` list means USB-required by the legacy D-10 rule, so this
/// pins that default too.
#[test]
fn gated_mode_change_reports_the_running_mode_not_the_requested_one() {
    let app = app();
    let webview = main_webview(&app);

    let before = invoke(&webview, "get_lighting_mode_status", json!({}))
        .expect("status must resolve")["mode"]
        .clone();

    let response = invoke(
        &webview,
        "set_lighting_mode",
        json!({
            "payload": {
                "kind": "solid",
                "solid": { "r": 255, "g": 128, "b": 0, "brightness": 0.8 },
                "targets": []
            }
        }),
    )
    .expect("set_lighting_mode must resolve, never reject");

    assert_eq!(status_code(&response), "DEVICE_NOT_CONNECTED");
    assert_eq!(response["active"], json!(false));
    assert_eq!(
        response["mode"], before,
        "a gated request must leave the reported mode untouched"
    );
    assert_ne!(response["mode"]["kind"], json!("solid"));

    let after = invoke(&webview, "get_lighting_mode_status", json!({}))
        .expect("status must resolve")["mode"]
        .clone();
    assert_eq!(after, before, "the gate must not mutate the runtime either");
}

#[test]
fn stop_lighting_returns_to_off() {
    let app = app();
    let webview = main_webview(&app);

    invoke(
        &webview,
        "set_lighting_mode",
        json!({
            "payload": {
                "kind": "solid",
                "solid": { "r": 10, "g": 20, "b": 30, "brightness": 1.0 },
                "targets": []
            }
        }),
    )
    .expect("set_lighting_mode must resolve");

    invoke(&webview, "stop_lighting", json!({})).expect("stop_lighting must resolve");

    let response =
        invoke(&webview, "get_lighting_mode_status", json!({})).expect("status must resolve");
    assert_eq!(response["mode"]["kind"], json!("off"));
}
