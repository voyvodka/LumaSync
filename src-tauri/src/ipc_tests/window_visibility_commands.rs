//! The main window's visibility over IPC. `MockRuntime` reports every window
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
