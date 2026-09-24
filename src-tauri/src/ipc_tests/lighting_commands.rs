//! Lighting mode state machine over IPC. No window calls these commands since
//! the lighting transaction took over; they stay registered, so the tests
//! grant them to the test window.

use serde_json::json;
use tauri::test::MockRuntime;
use tauri::App;

use super::{grant_main_for_tests, invoke, main_webview, mock_app, status_code, OLD_MODE_COMMANDS};

fn app() -> App<MockRuntime> {
    let app = mock_app(tauri::generate_handler![
        crate::commands::lighting_mode::set_lighting_mode,
        crate::commands::lighting_mode::get_lighting_mode_status,
        crate::commands::lighting_mode::stop_lighting
    ]);
    grant_main_for_tests(&app, &OLD_MODE_COMMANDS);
    app
}

#[test]
fn lighting_mode_starts_off() {
    let app = app();
    let webview = main_webview(&app);

    let response =
        invoke(&webview, "get_lighting_mode_status", json!({})).expect("status must resolve");

    assert_eq!(status_code(&response), "LIGHTING_MODE_STATUS_OK");
    assert_eq!(response["mode"]["kind"], json!("off"));
}

/// Solid with no device is the everyday state before a controller is paired.
///
/// The invariant under test is that a gated request reports the mode that is
/// *actually* running, not the one that was asked for — `apply_mode_change`
/// returns `owner.active_mode.clone()` on the USB gate (`lighting_mode.rs`).
/// Reporting `solid` here would light the mode strip with no LEDs behind it.
/// An empty `targets` list means USB-required by the legacy rule, so this
/// pins that default too.
#[test]
fn gated_mode_change_reports_the_running_mode_not_the_requested_one() {
    let app = app();
    let webview = main_webview(&app);

    let before = invoke(&webview, "get_lighting_mode_status", json!({}))
        .expect("status must resolve")["mode"]
        .clone();

    let response = invoke(
        &webview,
        "set_lighting_mode",
        json!({
            "payload": {
                "kind": "solid",
                "solid": { "r": 255, "g": 128, "b": 0, "brightness": 0.8 },
                "targets": []
            }
        }),
    )
    .expect("set_lighting_mode must resolve, never reject");

    assert_eq!(status_code(&response), "DEVICE_NOT_CONNECTED");
    assert_eq!(response["active"], json!(false));
    assert_eq!(
        response["mode"], before,
        "a gated request must leave the reported mode untouched"
    );
    assert_ne!(response["mode"]["kind"], json!("solid"));

    let after = invoke(&webview, "get_lighting_mode_status", json!({}))
        .expect("status must resolve")["mode"]
        .clone();
    assert_eq!(after, before, "the gate must not mutate the runtime either");
}

#[test]
fn stop_lighting_returns_to_off() {
    let app = app();
    let webview = main_webview(&app);

    invoke(
        &webview,
        "set_lighting_mode",
        json!({
            "payload": {
                "kind": "solid",
                "solid": { "r": 10, "g": 20, "b": 30, "brightness": 1.0 },
                "targets": []
            }
        }),
    )
    .expect("set_lighting_mode must resolve");

    invoke(&webview, "stop_lighting", json!({})).expect("stop_lighting must resolve");

    let response =
        invoke(&webview, "get_lighting_mode_status", json!({})).expect("status must resolve");
    assert_eq!(response["mode"]["kind"], json!("off"));
}

/// The mode commands run off the main thread, which used to serialise them for
/// free. `run_mode_transition` puts that back: one command at a time, in the
/// order they arrived, with its broadcast inside its turn.
mod transitions {
    use std::net::UdpSocket;
    use std::sync::mpsc;
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    use serde_json::{json, Value};
    use tauri::test::MockRuntime;
    use tauri::{App, Listener, Manager, WebviewWindow};

    use super::super::{
        grant_main_for_tests, invoke, main_webview, mock_app, status_code, OLD_MODE_COMMANDS,
    };
    use crate::commands::device_connection::ActiveSinkRegistry;
    use crate::commands::lighting_mode::{
        stop_lighting_blocking, LightingRuntimeState, LIGHTING_MODE_CHANGED_EVENT,
    };
    use crate::commands::wled_sink::{WledProtocol, WledSinkConfig};

    /// A mode app whose "usb" channel is a WLED sink on a loopback socket
    /// nobody reads, so a solid mode really applies and nothing leaves the
    /// machine. The socket is returned to keep the port bound.
    fn app() -> (App<MockRuntime>, UdpSocket) {
        let app = mock_app(tauri::generate_handler![
            crate::commands::lighting_mode::set_lighting_mode,
            crate::commands::lighting_mode::stop_lighting,
            crate::commands::lighting_mode::get_lighting_mode_status
        ]);
        grant_main_for_tests(&app, &OLD_MODE_COMMANDS);
        let receiver = UdpSocket::bind("127.0.0.1:0").expect("bind receiver");
        let config = WledSinkConfig {
            ip: "127.0.0.1".parse().expect("loopback"),
            port: receiver.local_addr().expect("receiver addr").port(),
            led_count: 1,
            protocol: WledProtocol::Drgb,
        };
        app.state::<ActiveSinkRegistry>()
            .replace_wled(Box::new(config.build()), config);
        (app, receiver)
    }

    fn solid(r: u8) -> Value {
        json!({
            "payload": {
                "kind": "solid",
                "solid": { "r": r, "g": 0, "b": 0, "brightness": 1.0 },
                "targets": ["usb"]
            }
        })
    }

    /// Every `lighting://mode-changed` broadcast, as `"off"` or `"solid:<r>"`.
    fn record_broadcasts(app: &App<MockRuntime>) -> Arc<Mutex<Vec<String>>> {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&seen);
        app.listen_any(LIGHTING_MODE_CHANGED_EVENT, move |event| {
            let payload: Value = serde_json::from_str(event.payload()).expect("JSON payload");
            let config = &payload["config"];
            let label = match config["kind"].as_str() {
                Some("solid") => format!("solid:{}", config["solid"]["r"]),
                Some(kind) => kind.to_string(),
                None => panic!("mode-changed without a kind: {payload}"),
            };
            sink.lock().unwrap().push(label);
        });
        seen
    }

    fn invoke_in_background(
        webview: &WebviewWindow<MockRuntime>,
        cmd: &'static str,
        args: Value,
    ) -> mpsc::Receiver<Result<Value, Value>> {
        let (tx, rx) = mpsc::channel();
        let webview = webview.clone();
        std::thread::spawn(move || {
            let _ = tx.send(invoke(&webview, cmd, args));
        });
        rx
    }

    #[test]
    fn a_mode_command_waits_for_the_one_in_flight() {
        let (app, _receiver) = app();
        let webview = main_webview(&app);
        let seen = record_broadcasts(&app);

        let state = app.state::<LightingRuntimeState>();
        let turn = state.hold_transition_for_tests();
        let pending = invoke_in_background(&webview, "set_lighting_mode", solid(200));

        assert!(
            pending.recv_timeout(Duration::from_millis(300)).is_err(),
            "set_lighting_mode ran while another transition held the turn"
        );
        assert!(
            seen.lock().unwrap().is_empty(),
            "broadcast outside its turn"
        );

        drop(turn);
        let response = pending
            .recv_timeout(Duration::from_secs(5))
            .expect("the queued command must run once the turn is released")
            .expect("set_lighting_mode must resolve, never reject");
        assert_eq!(
            status_code(&response),
            "SOLID_MODE_APPLIED",
            "got: {response}"
        );
        assert_eq!(*seen.lock().unwrap(), ["solid:200"]);
    }

    /// A drag commits at 20 Hz without awaiting the previous commit, so while
    /// one transition runs several queue behind it. They must land in the
    /// order they were sent, or the strip settles on a stale value.
    #[test]
    fn queued_mode_commands_apply_in_arrival_order() {
        let (app, _receiver) = app();
        let webview = main_webview(&app);
        let seen = record_broadcasts(&app);

        let state = app.state::<LightingRuntimeState>();
        let turn = state.hold_transition_for_tests();
        let mut pending = Vec::new();
        for r in [10u8, 20, 30, 40, 50] {
            pending.push(invoke_in_background(
                &webview,
                "set_lighting_mode",
                solid(r),
            ));
            std::thread::sleep(Duration::from_millis(100));
        }
        pending.push(invoke_in_background(&webview, "stop_lighting", json!({})));
        std::thread::sleep(Duration::from_millis(100));
        drop(turn);

        for response in pending {
            response
                .recv_timeout(Duration::from_secs(5))
                .expect("every queued command must answer")
                .expect("mode commands must resolve, never reject");
        }
        assert_eq!(
            *seen.lock().unwrap(),
            ["solid:10", "solid:20", "solid:30", "solid:40", "solid:50", "off"]
        );
        let status =
            invoke(&webview, "get_lighting_mode_status", json!({})).expect("status must resolve");
        assert_eq!(status["mode"]["kind"], json!("off"));
    }

    /// Quit must not wait out a queue of mode changes: its lighting step has
    /// 1.5 s before it is abandoned.
    #[test]
    fn the_shutdown_stop_does_not_queue_behind_mode_commands() {
        let (app, _receiver) = app();
        let state = app.state::<LightingRuntimeState>();
        let _turn = state.hold_transition_for_tests();

        let (tx, rx) = mpsc::channel();
        let handle = app.handle().clone();
        std::thread::spawn(move || {
            let _ = tx.send(stop_lighting_blocking(&handle).map(|result| result.status.code));
        });

        let code = rx
            .recv_timeout(Duration::from_secs(2))
            .expect("the shutdown stop waited behind the transition queue")
            .expect("stop must resolve");
        assert_eq!(code, "LIGHTING_MODE_STOPPED");
    }
}
