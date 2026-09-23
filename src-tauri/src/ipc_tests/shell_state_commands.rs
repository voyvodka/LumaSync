//! Shell-state commands through the real invoke pipeline and the real
//! capability files. The store here is in memory; the disk half is covered by
//! `commands::shell_state`'s unit tests.

use std::sync::{Arc, Mutex};

use serde_json::{json, Value};
use tauri::test::MockRuntime;
use tauri::{App, Listener, WebviewWindow, WebviewWindowBuilder};

use super::{assert_camel_case_keys, invoke, main_webview, mock_app};
use crate::commands::shell_state::SHELL_STATE_CHANGED_EVENT;

fn app() -> App<MockRuntime> {
    mock_app(tauri::generate_handler![
        crate::commands::shell_state::get_shell_state,
        crate::commands::shell_state::patch_shell_state,
        crate::commands::shell_state::replace_shell_state,
    ])
}

fn window(app: &App<MockRuntime>, label: &str) -> WebviewWindow<MockRuntime> {
    WebviewWindowBuilder::new(app, label, Default::default())
        .build()
        .expect("mock webview should build")
}

fn record_changes(app: &App<MockRuntime>) -> Arc<Mutex<Vec<Value>>> {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&seen);
    app.listen(SHELL_STATE_CHANGED_EVENT, move |event| {
        let payload = serde_json::from_str(event.payload()).expect("event payload is JSON");
        sink.lock().unwrap().push(payload);
    });
    seen
}

#[test]
fn nothing_stored_reads_as_null_at_revision_zero() {
    let app = app();
    let main = main_webview(&app);

    let snapshot = invoke(&main, "get_shell_state", json!({})).expect("read resolves");
    assert_camel_case_keys(&snapshot);
    assert_eq!(snapshot, json!({ "state": null, "revision": 0 }));
}

#[test]
fn a_patch_merges_removes_and_announces_itself() {
    let app = app();
    let main = main_webview(&app);
    let changes = record_changes(&app);

    invoke(
        &main,
        "patch_shell_state",
        json!({ "patch": { "set": { "hueAppKey": "plain", "language": "en" }, "remove": [] } }),
    )
    .expect("first patch resolves");
    let written = invoke(
        &main,
        "patch_shell_state",
        json!({ "patch": {
            "set": { "credentialStorageBackend": "keychain" },
            "remove": ["hueAppKey"],
            "writerId": "main-1"
        } }),
    )
    .expect("second patch resolves");
    assert_eq!(written, json!({ "applied": true, "revision": 2 }));

    let snapshot = invoke(&main, "get_shell_state", json!({})).unwrap();
    assert_eq!(
        snapshot["state"],
        json!({ "language": "en", "credentialStorageBackend": "keychain" })
    );

    let changes = changes.lock().unwrap();
    assert_eq!(changes.len(), 2);
    assert_eq!(
        changes[1],
        json!({
            "set": { "credentialStorageBackend": "keychain" },
            "remove": ["hueAppKey"],
            "revision": 2,
            "writerId": "main-1"
        })
    );
}

#[test]
fn the_popup_and_the_main_window_patch_different_keys_and_both_survive() {
    let app = app();
    let main = main_webview(&app);
    let popup = window(&app, crate::commands::led_preview::LED_CONTROL_POPUP_LABEL);

    invoke(
        &main,
        "patch_shell_state",
        json!({ "patch": { "set": { "lastSection": "devices" } } }),
    )
    .unwrap();
    invoke(
        &popup,
        "patch_shell_state",
        json!({ "patch": { "set": { "ledPreviewPopupCenterX": 640 } } }),
    )
    .expect("the popup persists its own position");

    let snapshot = invoke(&popup, "get_shell_state", json!({})).unwrap();
    assert_eq!(
        snapshot["state"],
        json!({ "lastSection": "devices", "ledPreviewPopupCenterX": 640 })
    );
}

#[test]
fn a_stale_replace_is_refused_and_writes_nothing() {
    let app = app();
    let main = main_webview(&app);

    invoke(
        &main,
        "patch_shell_state",
        json!({ "patch": { "set": { "schemaVersion": 5 } } }),
    )
    .unwrap();
    invoke(
        &main,
        "patch_shell_state",
        json!({ "patch": { "set": { "trayHintShown": true } } }),
    )
    .unwrap();

    let refused = invoke(
        &main,
        "replace_shell_state",
        json!({ "request": { "state": { "schemaVersion": 6 }, "expectedRevision": 1 } }),
    )
    .expect("a conflict is an answer, not a rejection");
    assert_eq!(refused, json!({ "applied": false, "revision": 2 }));

    let applied = invoke(
        &main,
        "replace_shell_state",
        json!({ "request": { "state": { "schemaVersion": 6 }, "expectedRevision": 2 } }),
    )
    .unwrap();
    assert_eq!(applied, json!({ "applied": true, "revision": 3 }));
    assert_eq!(
        invoke(&main, "get_shell_state", json!({})).unwrap()["state"],
        json!({ "schemaVersion": 6 })
    );
}

/// The ACL, not the handler, is what stops these: the twin reads settings and
/// never writes them, and only the main window runs the migration write-back.
#[test]
fn the_overlays_cannot_write_and_the_popup_cannot_replace() {
    let app = app();
    let twin = window(&app, "led-twin-overlay-0");
    let calibration = window(&app, "calibration-overlay-00000000000000ff-0");
    let popup = window(&app, crate::commands::led_preview::LED_CONTROL_POPUP_LABEL);

    invoke(&twin, "get_shell_state", json!({})).expect("the twin reads its layout");
    for webview in [&twin, &calibration] {
        assert!(invoke(
            webview,
            "patch_shell_state",
            json!({ "patch": { "set": { "language": "tr" } } }),
        )
        .is_err());
    }
    assert!(invoke(&calibration, "get_shell_state", json!({})).is_err());
    assert!(invoke(
        &popup,
        "replace_shell_state",
        json!({ "request": { "state": {}, "expectedRevision": 0 } }),
    )
    .is_err());

    let main = main_webview(&app);
    assert_eq!(
        invoke(&main, "get_shell_state", json!({})).unwrap(),
        json!({ "state": null, "revision": 0 }),
        "a refused write must not have landed"
    );
}
