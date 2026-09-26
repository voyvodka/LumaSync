//! `show_notification` over IPC: the Settings switch answers for every window, with a code.

use serde_json::json;

use super::{invoke, main_webview, mock_app};

#[test]
fn notifications_turned_off_in_settings_answer_suppressed_with_a_code() {
    let app = mock_app(tauri::generate_handler![
        crate::commands::notifications::show_notification,
        crate::commands::shell_state::patch_shell_state
    ]);
    let main = main_webview(&app);
    invoke(
        &main,
        "patch_shell_state",
        json!({ "patch": { "set": { "notifications": "off" }, "remove": [] } }),
    )
    .expect("the switch saves");

    let answer = invoke(
        &main,
        "show_notification",
        json!({ "payload": { "title": "LumaSync", "body": "Still running", "kind": "info" } }),
    )
    .expect("a suppressed notification is an answer, not an error");

    assert_eq!(
        answer,
        json!({ "status": "suppressed", "code": "NOTIF_SUPPRESSED" })
    );
}
