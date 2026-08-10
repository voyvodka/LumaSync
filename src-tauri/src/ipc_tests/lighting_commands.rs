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

/// Solid with no sink attached is the everyday state before a device is paired.
/// Two things must hold: the call resolves (the mode strip has no catch around
/// it) and the runtime stays `off` rather than reporting a mode nothing is
/// driving, which would light the strip button with no LEDs behind it.
#[test]
fn solid_without_output_target_is_gated_on_device_connection() {
    let app = app();
    let webview = main_webview(&app);

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
    assert_eq!(response["mode"]["kind"], json!("off"));
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
