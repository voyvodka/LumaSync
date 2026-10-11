//! LED test patterns and the preview session over IPC.
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
use tauri::{App, WebviewWindowBuilder};

use super::{assert_camel_case_keys, invoke, main_webview, mock_app, status_code};

fn app() -> App<MockRuntime> {
    mock_app(tauri::generate_handler![
        crate::commands::lighting_mode::led_test_pattern::start_led_test_pattern,
        crate::commands::lighting_mode::led_test_pattern::stop_led_test_pattern,
        crate::commands::preview::session::open_preview,
        crate::commands::preview::session::close_preview,
        crate::commands::preview::session::get_preview_session,
        crate::commands::preview::session::set_preview_popup_hidden,
        crate::commands::preview::session::set_preview_twin_hidden,
        crate::commands::preview::feed::subscribe_twin_frames
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

/// Slots 0..=2 are the three wire bytes of a pixel; anything past them names
/// a byte that does not exist.
#[test]
fn a_channel_probe_past_the_third_slot_is_a_coded_refusal() {
    let app = app();
    let webview = main_webview(&app);

    let response = invoke(
        &webview,
        "start_led_test_pattern",
        json!({
            "payload": {
                "pattern": { "kind": "channelProbe", "slot": 3 },
                "brightness": 0.5,
                "targets": ["usb"]
            }
        }),
    )
    .expect("start_led_test_pattern must resolve, never reject");

    assert_eq!(status_code(&response), "LED_TEST_PATTERN_INVALID_PARAMS");
    assert_eq!(response["active"], json!(false));
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

fn popup(app: &App<MockRuntime>) -> tauri::WebviewWindow<MockRuntime> {
    WebviewWindowBuilder::new(
        app,
        format!(
            "{}0",
            crate::commands::preview::LED_CONTROL_POPUP_LABEL_PREFIX
        ),
        Default::default(),
    )
    .build()
    .expect("mock webview should build")
}

/// Close is reached from the popup's button, Escape and the tray, none of
/// which knows whether the session is still open. A popup with no session
/// behind it is itself a stray, so its close clears it rather than answering
/// that nothing was open; a hide has nothing to act on.
#[test]
fn closing_or_hiding_with_no_session_never_rejects() {
    let app = app();
    let webview = popup(&app);

    let hidden = invoke(
        &webview,
        "set_preview_popup_hidden",
        json!({ "payload": { "hidden": true } }),
    )
    .expect("hide must resolve");
    assert_eq!(status_code(&hidden), "PREVIEW_NOT_OPEN");
    assert_eq!(hidden["session"], json!({ "state": "closed" }));

    let closed = invoke(&webview, "close_preview", json!({})).expect("close must resolve");
    assert_eq!(status_code(&closed), "PREVIEW_CLOSED");
    assert_eq!(closed["session"], json!({ "state": "closed" }));
}

/// A session reports where its twin is, tagged the way the TS union is, and
/// closing it over IPC ends it.
#[test]
fn an_open_session_is_reported_and_closed_over_ipc() {
    use tauri::Manager;

    let app = app();
    let webview = popup(&app);
    app.state::<crate::commands::preview::PreviewSessionState>()
        .open_for_test("display-1", "led-twin-overlay-1", "led-control-popup-0");

    let hidden = invoke(
        &webview,
        "set_preview_popup_hidden",
        json!({ "payload": { "hidden": true } }),
    )
    .expect("hide must resolve");
    assert_camel_case_keys(&hidden);
    assert_eq!(status_code(&hidden), "PREVIEW_POPUP_UPDATED");
    assert_eq!(
        hidden["session"],
        json!({
            "state": "live",
            "displayId": "display-1",
            "popupHidden": true,
            "twinHidden": false,
            "twinHeldForCapture": false
        })
    );

    let closed = invoke(&webview, "close_preview", json!({})).expect("close must resolve");
    assert_eq!(status_code(&closed), "PREVIEW_CLOSED");
    assert_eq!(closed["session"], json!({ "state": "closed" }));
}

/// Lights or the tray asked again while the preview is up: the popup comes
/// back, nothing is rebuilt, and the answer is a success the caller stays
/// quiet on.
#[test]
fn opening_an_open_session_brings_its_popup_back() {
    use tauri::Manager;

    let app = app();
    let main = main_webview(&app);
    let popup = popup(&app);
    let session = app.state::<crate::commands::preview::PreviewSessionState>();
    session.open_for_test("display-1", "led-twin-overlay-1", "led-control-popup-0");
    invoke(
        &popup,
        "set_preview_popup_hidden",
        json!({ "payload": { "hidden": true } }),
    )
    .expect("hide must resolve");

    let reopened = invoke(&main, "open_preview", json!({})).expect("open must resolve");

    assert_eq!(status_code(&reopened), "PREVIEW_ALREADY_OPEN");
    assert_eq!(reopened["session"]["popupHidden"], json!(false));
}

/// The popup reads the session on mount: a bare `PreviewSession`, no status.
#[test]
fn the_popup_reads_the_session_as_it_is() {
    use tauri::Manager;

    let app = app();
    let webview = popup(&app);
    let closed = invoke(&webview, "get_preview_session", json!({})).expect("read must resolve");
    assert_eq!(closed, json!({ "state": "closed" }));

    app.state::<crate::commands::preview::PreviewSessionState>()
        .open_for_test("display-1", "led-twin-overlay-1", "led-control-popup-0");
    let live = invoke(&webview, "get_preview_session", json!({})).expect("read must resolve");
    assert_camel_case_keys(&live);
    assert_eq!(live["state"], json!("live"));
    assert_eq!(live["twinHidden"], json!(false));
}

/// The twin switch: hidden, the worker's gate shuts; shown, it opens again
/// for a twin that subscribed. A reopen keeps the user's choice.
#[test]
fn hiding_the_twin_shuts_its_feed_and_a_reopen_keeps_it_hidden() {
    use std::sync::atomic::Ordering;
    use tauri::Manager;

    let app = app();
    let main = main_webview(&app);
    let webview = popup(&app);
    let state = app.state::<crate::commands::preview::PreviewSessionState>();

    let none = invoke(
        &webview,
        "set_preview_twin_hidden",
        json!({ "payload": { "hidden": true } }),
    )
    .expect("hide must resolve");
    assert_eq!(status_code(&none), "PREVIEW_NOT_OPEN");

    state.open_for_test("display-1", "led-twin-overlay-1", "led-control-popup-0");
    state.subscribe_for_test("led-twin-overlay-1", tauri::ipc::Channel::new(|_| Ok(())));
    let gate = state.twin_open();
    assert!(gate.load(Ordering::SeqCst));

    let hidden = invoke(
        &webview,
        "set_preview_twin_hidden",
        json!({ "payload": { "hidden": true } }),
    )
    .expect("hide must resolve");
    assert_camel_case_keys(&hidden);
    assert_eq!(status_code(&hidden), "PREVIEW_TWIN_UPDATED");
    assert_eq!(hidden["session"]["twinHidden"], json!(true));
    assert!(!gate.load(Ordering::SeqCst), "a hidden twin is fed nothing");

    let reopened = invoke(&main, "open_preview", json!({})).expect("open must resolve");
    assert_eq!(status_code(&reopened), "PREVIEW_ALREADY_OPEN");
    assert_eq!(reopened["session"]["twinHidden"], json!(true));

    let shown = invoke(
        &webview,
        "set_preview_twin_hidden",
        json!({ "payload": { "hidden": false } }),
    )
    .expect("show must resolve");
    assert_eq!(shown["session"]["twinHidden"], json!(false));
    assert!(gate.load(Ordering::SeqCst), "shown again, the twin is fed");
}

/// Shown before the twin subscribed, the gate stays shut: nothing would
/// take the frames the worker built.
#[test]
fn showing_a_twin_that_has_not_subscribed_leaves_the_gate_shut() {
    use std::sync::atomic::Ordering;
    use tauri::Manager;

    let app = app();
    let webview = popup(&app);
    let state = app.state::<crate::commands::preview::PreviewSessionState>();
    state.open_for_test("display-1", "led-twin-overlay-1", "led-control-popup-0");

    invoke(
        &webview,
        "set_preview_twin_hidden",
        json!({ "payload": { "hidden": false } }),
    )
    .expect("show must resolve");
    assert!(!state.twin_open().load(Ordering::SeqCst));
}

/// Only the open session's own twin may take the frames: the popup asking, or
/// a twin left from an earlier session, is told nothing is open. The twin
/// gets the layout in the same answer, so it never waits for an event.
#[test]
fn only_the_sessions_twin_subscribes_and_it_gets_the_layout() {
    use tauri::Manager;

    let app = app();
    let twin = WebviewWindowBuilder::new(&app, "led-twin-overlay-1", Default::default())
        .build()
        .expect("mock twin should build");
    let channel = json!({ "onFrame": "__CHANNEL__:7" });

    let before =
        invoke(&twin, "subscribe_twin_frames", channel.clone()).expect("subscribe must resolve");
    assert_eq!(status_code(&before), "PREVIEW_NOT_OPEN");
    assert_eq!(before["layout"], json!(null));

    app.state::<crate::commands::preview::PreviewSessionState>()
        .open_for_test("display-1", "led-twin-overlay-1", "led-control-popup-0");
    // The popup is a preview window too, but not the twin: the frames are the
    // twin's alone.
    let from_popup = invoke(&popup(&app), "subscribe_twin_frames", channel.clone());
    assert!(
        from_popup.is_err(),
        "the popup has no grant for the twin's frames"
    );

    let subscribed =
        invoke(&twin, "subscribe_twin_frames", channel).expect("subscribe must resolve");
    assert_camel_case_keys(&subscribed);
    assert_eq!(status_code(&subscribed), "PREVIEW_TWIN_SUBSCRIBED");
    assert_eq!(subscribed["layout"]["displayId"], json!("display-1"));
    assert!(subscribed["layout"]["layoutRevision"].as_u64().unwrap() > 0);
}
