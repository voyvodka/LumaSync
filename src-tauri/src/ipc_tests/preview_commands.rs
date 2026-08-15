//! LED test pattern over IPC.
//!
//! #270 shipped because `apply_mode_change`'s return code and
//! `start_led_test_pattern`'s reading of it were each tested in isolation and
//! the seam between them was not: the retune added in #264 returned a code the
//! caller mapped to a runtime error, so every change to a running test reported
//! a failed start over a test that was lighting. These drive the whole command.
//!
//! Two limits of the harness, found the hard way rather than assumed:
//! `MockRuntime::available_monitors` is `unimplemented!()`, so anything reaching
//! `resolve_display_aspect` panics — which is every path past the brightness
//! guard. And `f64::NAN` serialises to JSON `null`, so the non-finite arm of
//! that guard is unreachable over IPC and only out-of-range values test it.

use serde_json::json;
use tauri::test::MockRuntime;
use tauri::App;

use super::{assert_camel_case_keys, invoke, main_webview, mock_app, status_code};

fn app() -> App<MockRuntime> {
    mock_app(tauri::generate_handler![
        crate::commands::lighting_mode::start_led_test_pattern,
        crate::commands::lighting_mode::stop_led_test_pattern,
        crate::commands::lighting_mode::get_led_preview_status
    ])
}

fn start(brightness: f64) -> serde_json::Value {
    json!({
        "payload": {
            "pattern": { "kind": "chase", "r": 255, "g": 255, "b": 255 },
            "brightness": brightness,
            "speed": "med",
            "targets": ["usb"]
        }
    })
}

/// Every arm of this command must ride a coded status, never a rejection —
/// `previewApi` degrades a throw to a synthesised runtime error, which would
/// hide whichever real code the backend meant to send.
#[test]
fn an_invalid_brightness_is_a_coded_refusal_not_a_rejection() {
    let app = app();
    let webview = main_webview(&app);

    for brightness in [-0.1, 1.5] {
        let response = invoke(&webview, "start_led_test_pattern", start(brightness))
            .expect("start_led_test_pattern must resolve, never reject");

        assert_eq!(status_code(&response), "LED_TEST_PATTERN_INVALID_PARAMS");
        assert_eq!(response["active"], json!(false));
    }
}

/// Stop is reached from the popup's close button and from a mode-strip
/// takeover, neither of which knows whether a pattern is actually running.
#[test]
fn stopping_a_test_that_never_started_still_resolves() {
    let app = app();
    let webview = main_webview(&app);

    let response = invoke(&webview, "stop_led_test_pattern", json!({}))
        .expect("stop_led_test_pattern must resolve, never reject");

    assert_eq!(status_code(&response), "LED_TEST_PATTERN_STOPPED");
    assert_camel_case_keys(&response);
}

#[test]
fn preview_status_reports_an_idle_surface_before_anything_runs() {
    let app = app();
    let webview = main_webview(&app);

    let response =
        invoke(&webview, "get_led_preview_status", json!({})).expect("status must resolve");

    assert_camel_case_keys(&response);
    assert_eq!(response["testActive"], json!(false));
    assert_eq!(response["popupVisible"], json!(false));
}
