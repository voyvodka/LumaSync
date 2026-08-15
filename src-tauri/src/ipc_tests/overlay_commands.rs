//! Calibration overlay + Hue channel write-back over IPC.
//!
//! `open_display_overlay` and `list_displays` are not here: both reach
//! `MockRuntime::available_monitors`, which is `unimplemented!()`. What is
//! reachable is every path that answers before a monitor is needed — the
//! no-overlay-open arms, and the two input guards on the Hue write-back, which
//! return before the request is built.
//!
//! There is no "a valid input gets through" counterpart: past those guards the
//! command builds a real blocking HTTP request and falls back to the OS keychain
//! for the app key, so the result would depend on the developer's machine and
//! could reach the network. Proving acceptance needs the predicates extracted.

use serde_json::json;
use tauri::test::MockRuntime;
use tauri::App;

use super::{invoke, main_webview, mock_app};

fn app() -> App<MockRuntime> {
    mock_app(tauri::generate_handler![
        crate::commands::calibration::close_display_overlay,
        crate::commands::calibration::update_display_overlay_preview,
        crate::commands::room_map::save_load::update_hue_channel_positions
    ])
}

/// Close is reached from unmount and from a display switch, neither of which
/// knows whether an overlay is up. Rejecting here would surface as a thrown
/// exception in a cleanup path with nothing to catch it.
#[test]
fn closing_an_overlay_that_is_not_open_still_resolves() {
    let app = app();
    let webview = main_webview(&app);

    let response = invoke(
        &webview,
        "close_display_overlay",
        json!({ "displayId": "display-1" }),
    )
    .expect("close_display_overlay must resolve, never reject");

    assert_eq!(response["code"], json!("OVERLAY_CLOSED"));
}

/// The preview push runs on every editor keystroke. With no overlay open it has
/// to be a cheap no-op with its own code, not an error the UI would surface.
#[test]
fn a_preview_push_with_no_overlay_open_is_skipped_not_failed() {
    let app = app();
    let webview = main_webview(&app);

    let response = invoke(
        &webview,
        "update_display_overlay_preview",
        json!({ "preview": {
            "counts": { "top": 4, "right": 3, "bottom": 4, "left": 3 },
            "bottomMissing": 0,
            "cornerOwnership": "horizontal",
            "visualPreset": "vivid",
            "sequence": [],
        } }),
    )
    .expect("update_display_overlay_preview must resolve, never reject");

    assert_eq!(response["code"], json!("OVERLAY_PREVIEW_SKIPPED"));
}

/// SSRF guard. The bridge IP arrives from persisted state the user can hand-edit,
/// and the command builds an HTTP request from it with certificate validation
/// deliberately switched off — so loopback and the wildcard address must be
/// refused before the client is ever constructed.
#[test]
fn the_hue_write_back_refuses_an_ip_that_would_point_at_ourselves() {
    let app = app();
    let webview = main_webview(&app);

    for ip in [
        "127.0.0.1",
        "0.0.0.0",
        "255.255.255.255",
        "224.0.0.1",
        "not-an-ip",
    ] {
        let response = invoke(
            &webview,
            "update_hue_channel_positions",
            json!({
                "channels": [],
                "bridgeIp": ip,
                "username": "app-key",
                "areaId": "area-1",
            }),
        )
        .expect("update_hue_channel_positions must resolve, never reject");

        assert_eq!(
            response["code"],
            json!("HUE_IP_INVALID"),
            "{ip} must be refused before any request is built"
        );
    }
}

/// Path-traversal guard: the area id is interpolated straight into the CLIP v2
/// endpoint path.
#[test]
fn the_hue_write_back_refuses_an_area_id_that_could_escape_the_endpoint() {
    let app = app();
    let webview = main_webview(&app);

    for area in ["../config", "area/1", "area 1", "area?x=1"] {
        let response = invoke(
            &webview,
            "update_hue_channel_positions",
            json!({
                "channels": [],
                "bridgeIp": "192.168.1.10",
                "username": "app-key",
                "areaId": area,
            }),
        )
        .expect("update_hue_channel_positions must resolve, never reject");

        assert_eq!(
            response["code"],
            json!("HUE_AREA_INVALID"),
            "`{area}` must be refused before the endpoint is built"
        );
    }
}
