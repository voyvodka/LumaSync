//! WLED commands over IPC, driven with the exact argument shape `wledApi.ts`
//! sends. Every input here fails validation before any socket or HTTP call, so
//! the tests are deterministic on runners with no WLED device.

use serde_json::json;
use tauri::test::MockRuntime;
use tauri::App;

use super::{invoke, main_webview, mock_app, status_code};

fn app() -> App<MockRuntime> {
    mock_app(tauri::generate_handler![
        crate::commands::wled_discovery::discover_wled_devices,
        crate::commands::wled_discovery::connect_wled_sink,
        crate::commands::wled_discovery::test_wled_bridge
    ])
}

#[test]
fn discover_accepts_the_frontend_request_shape() {
    let app = app();
    let webview = main_webview(&app);

    let response = invoke(
        &webview,
        "discover_wled_devices",
        json!({ "request": { "ip": "127.0.0.1" } }),
    )
    .expect("discover_wled_devices must resolve, never reject");

    assert_eq!(status_code(&response), "WLED_INVALID_IP");
    assert_eq!(response["devices"], json!([]));
}

/// Issue #333: flat args never reach the handler. Pins why `wledApi.ts` nests
/// them under `request`.
#[test]
fn discover_rejects_flat_args() {
    let app = app();
    let webview = main_webview(&app);

    let rejection = invoke(
        &webview,
        "discover_wled_devices",
        json!({ "ip": "127.0.0.1" }),
    )
    .expect_err("flat args must be rejected during deserialization");

    assert!(
        rejection.to_string().contains("request"),
        "rejection should name the missing `request` key, got: {rejection}"
    );
}

#[test]
fn connect_accepts_the_frontend_request_shape() {
    let app = app();
    let webview = main_webview(&app);

    let response = invoke(
        &webview,
        "connect_wled_sink",
        json!({
            "request": {
                "device": { "ip": "192.0.2.10", "ledCount": 0 },
                "port": 4048,
                "protocol": "ddp"
            }
        }),
    )
    .expect("connect_wled_sink must resolve, never reject");

    assert_eq!(status_code(&response), "WLED_INVALID_LED_COUNT");
}

#[test]
fn test_bridge_accepts_the_frontend_request_shape() {
    let app = app();
    let webview = main_webview(&app);

    let response = invoke(
        &webview,
        "test_wled_bridge",
        json!({ "request": { "device": { "ip": "127.0.0.1", "ledCount": 60 } } }),
    )
    .expect("test_wled_bridge must resolve, never reject");

    assert_eq!(status_code(&response), "WLED_INVALID_IP");
}
