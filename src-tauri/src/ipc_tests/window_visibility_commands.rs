//! The main window's visibility, and its title bar's drag, over IPC. `MockRuntime` reports every window
//! as shown and never minimised, so only the visible branch is reachable here;
//! the change detection is unit-tested beside `MainWindowVisibilityState`.

use serde_json::json;

use super::{assert_camel_case_keys, invoke, main_webview, mock_app};

#[test]
fn a_shown_main_window_reads_visible() {
    let app = mock_app(tauri::generate_handler![
        crate::commands::window_visibility::get_main_window_visibility
    ]);
    let webview = main_webview(&app);

    let response = invoke(&webview, "get_main_window_visibility", json!({}))
        .expect("window visibility must resolve");

    assert_camel_case_keys(&response);
    assert_eq!(response, json!({ "visible": true }));
}

/// No mouse is down under `MockRuntime`, and off macOS Tauri's own drag answers; either way the
/// command resolves rather than failing the press.
#[test]
fn the_title_bar_drag_resolves_null() {
    let app = mock_app(tauri::generate_handler![
        crate::commands::window_drag::start_window_drag
    ]);
    let webview = main_webview(&app);

    let response = invoke(&webview, "start_window_drag", json!({})).expect("the drag must resolve");

    assert_eq!(response, json!(null));
}
