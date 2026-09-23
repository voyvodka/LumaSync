//! Launch context over IPC. The `--tray` branch is covered by
//! `launched_to_tray`'s unit tests; a test binary cannot be launched with it.

use serde_json::json;

use super::{assert_camel_case_keys, invoke, main_webview, mock_app};

#[test]
fn a_plain_launch_is_not_started_hidden() {
    let app = mock_app(tauri::generate_handler![
        crate::commands::launch::get_launch_context
    ]);
    let webview = main_webview(&app);

    let response =
        invoke(&webview, "get_launch_context", json!({})).expect("launch context must resolve");

    assert_camel_case_keys(&response);
    assert_eq!(response, json!({ "startHidden": false }));
}
