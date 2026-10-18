//! The main window's title-bar drag over IPC. The AppKit body needs a real
//! window and a held mouse button, so only the answer is reachable here.

use serde_json::json;

use super::{invoke, main_webview, mock_app};

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
