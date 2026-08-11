//! Runtime telemetry over IPC.

use serde_json::json;
use tauri::test::MockRuntime;
use tauri::App;

use super::{assert_camel_case_keys, invoke, main_webview, mock_app};

fn app() -> App<MockRuntime> {
    mock_app(tauri::generate_handler![
        crate::commands::runtime_telemetry::get_runtime_telemetry
    ])
}

/// Telemetry is polled on an interval with no error branch in the UI, so an
/// idle runtime must still produce a well-formed snapshot.
#[test]
fn telemetry_snapshot_is_well_formed_when_idle() {
    let app = app();
    let webview = main_webview(&app);

    let response =
        invoke(&webview, "get_runtime_telemetry", json!({})).expect("telemetry must resolve");

    assert_camel_case_keys(&response);
    assert_camel_case_keys(&response["usb"]);
    for field in ["captureFps", "sendFps", "frameLatencyMs", "linkMaxFps"] {
        assert!(
            response["usb"][field].is_number(),
            "`usb.{field}` must be numeric even at rest, got: {response}"
        );
    }
    assert_eq!(
        response["hue"],
        json!(null),
        "the Hue arm stays null until a stream exists"
    );
}
