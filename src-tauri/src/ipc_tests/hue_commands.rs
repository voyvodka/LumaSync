//! Hue runtime commands over IPC.
//!
//! The invariant these guard: Hue commands never reject. The frontend
//! discriminates on `status.code` and has no catch around the call, so a
//! `Result::Err` surfaces as an unhandled rejection rather than a user-visible
//! notice. Assertions therefore pin the *code set*, not one particular code —
//! which code wins for a given state is the state machine's business.

use serde_json::json;
use tauri::test::MockRuntime;
use tauri::App;

use super::{invoke, main_webview, mock_app, status_code};

fn app() -> App<MockRuntime> {
    mock_app(tauri::generate_handler![
        crate::commands::hue::commands::set_hue_solid_color,
        crate::commands::hue::commands::get_hue_stream_status
    ])
}

/// Mirrors `HUE_SOLID_COLOR_STATUS` in `src/shared/contracts/hue.ts`.
const SOLID_COLOR_CODES: &[&str] = &[
    "HUE_COLOR_APPLIED",
    "HUE_COLOR_QUEUED_PENDING_STREAM",
    "HUE_COLOR_APPLY_SKIPPED",
    "HUE_COLOR_APPLY_SKIPPED_NO_LIGHTS",
];

#[test]
fn solid_color_without_a_stream_resolves_with_a_contract_code() {
    let app = app();
    let webview = main_webview(&app);

    let response = invoke(
        &webview,
        "set_hue_solid_color",
        json!({
            "request": { "r": 255, "g": 40, "b": 0, "brightness": 0.9 }
        }),
    )
    .expect("set_hue_solid_color must resolve, never reject");

    let code = status_code(&response);
    assert!(
        SOLID_COLOR_CODES.contains(&code),
        "`{code}` is not in HUE_SOLID_COLOR_STATUS — frontend has no branch for it"
    );
    assert!(
        code != "HUE_COLOR_APPLIED",
        "no stream context exists, so nothing can have reached the bridge"
    );
}

/// Out-of-range brightness is clamped rather than refused; the picker can emit
/// values slightly outside 0..=1 from float arithmetic.
#[test]
fn solid_color_clamps_out_of_range_brightness() {
    let app = app();
    let webview = main_webview(&app);

    for brightness in [-4.0_f32, 9.5_f32] {
        let response = invoke(
            &webview,
            "set_hue_solid_color",
            json!({
                "request": { "r": 0, "g": 0, "b": 255, "brightness": brightness }
            }),
        )
        .expect("set_hue_solid_color must resolve, never reject");

        assert!(SOLID_COLOR_CODES.contains(&status_code(&response)));
    }
}

#[test]
fn stream_status_is_idle_before_any_start() {
    let app = app();
    let webview = main_webview(&app);

    let response =
        invoke(&webview, "get_hue_stream_status", json!({})).expect("status must resolve");

    assert_eq!(response["active"], json!(false));
    assert!(
        response["status"]["state"].is_string(),
        "status carries a state discriminator: {response}"
    );
}
