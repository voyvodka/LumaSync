//! The lighting mode state machine under the lighting transaction, on a mock
//! app with the real managed state. The bare mode commands that used to drive
//! it are no longer registered, so these call their test-only entry points
//! (`apply_mode`, `stop_mode`) instead of going over IPC.

use serde_json::json;
use tauri::test::MockRuntime;
use tauri::App;

use super::{apply_mode, mock_app, running_mode, status_code, stop_mode};

fn app() -> App<MockRuntime> {
    mock_app(tauri::generate_handler![])
}

#[test]
fn lighting_mode_starts_off() {
    let app = app();

    assert_eq!(running_mode(app.handle())["kind"], json!("off"));
}

/// Solid with no device is the everyday state before a controller is paired.
///
/// The invariant under test is that a gated request reports the mode that is
/// *actually* running, not the one that was asked for — `apply_mode_change`
/// returns `owner.active_mode.clone()` on the USB gate (`lighting_mode/transition.rs`).
/// Reporting `solid` here would light the mode strip with no LEDs behind it.
/// An empty `targets` list means USB-required by the legacy rule, so this
/// pins that default too.
#[test]
fn gated_mode_change_reports_the_running_mode_not_the_requested_one() {
    let app = app();

    let before = running_mode(app.handle());

    let response = apply_mode(
        app.handle(),
        json!({
            "kind": "solid",
            "solid": { "r": 255, "g": 128, "b": 0, "brightness": 0.8 },
            "targets": []
        }),
    );

    assert_eq!(status_code(&response), "DEVICE_NOT_CONNECTED");
    assert_eq!(response["active"], json!(false));
    assert_eq!(
        response["mode"], before,
        "a gated request must leave the reported mode untouched"
    );
    assert_ne!(response["mode"]["kind"], json!("solid"));

    assert_eq!(
        running_mode(app.handle()),
        before,
        "the gate must not mutate the runtime either"
    );
}

#[test]
fn stop_lighting_returns_to_off() {
    let app = app();

    apply_mode(
        app.handle(),
        json!({
            "kind": "solid",
            "solid": { "r": 10, "g": 20, "b": 30, "brightness": 1.0 },
            "targets": []
        }),
    );
    stop_mode(app.handle());

    assert_eq!(running_mode(app.handle())["kind"], json!("off"));
}

/// The mode commands run off the main thread, which used to serialise them for
/// free. `run_mode_transition` puts that back: one command at a time, in the
/// order they arrived, with what it applied inside its turn.
mod transitions {
    use std::net::UdpSocket;
    use std::sync::mpsc;
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    use serde_json::{json, Value};
    use tauri::test::MockRuntime;
    use tauri::{App, AppHandle, Manager};

    use super::super::{apply_mode, mock_app, running_mode, status_code, stop_mode};
    use crate::commands::device_connection::ActiveSinkRegistry;
    use crate::commands::lighting_mode::{
        stop_lighting_blocking, AppliedModeProbe, LightingModeKind, LightingRuntimeState,
    };
    use crate::commands::wled_sink::{WledProtocol, WledSinkConfig};

    /// A mode app whose "usb" channel is a WLED sink on a loopback socket
    /// nobody reads, so a solid mode really applies and nothing leaves the
    /// machine. The socket is returned to keep the port bound.
    fn app() -> (App<MockRuntime>, UdpSocket) {
        let app = mock_app(tauri::generate_handler![]);
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
            "kind": "solid",
            "solid": { "r": r, "g": 0, "b": 0, "brightness": 1.0 },
            "targets": ["usb"]
        })
    }

    /// Every applied mode, as `"off"` or `"solid:<r>"`.
    fn record_applied(app: &App<MockRuntime>) -> Arc<Mutex<Vec<String>>> {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&seen);
        app.manage(AppliedModeProbe(Box::new(move |mode| {
            let label = match (&mode.kind, &mode.solid) {
                (LightingModeKind::Solid, Some(solid)) => format!("solid:{}", solid.r),
                (LightingModeKind::Off, _) => "off".to_string(),
                (kind, _) => format!("{kind:?}"),
            };
            sink.lock().unwrap().push(label);
        })));
        seen
    }

    fn in_background(
        app: &App<MockRuntime>,
        run: impl FnOnce(&AppHandle<MockRuntime>) -> Value + Send + 'static,
    ) -> mpsc::Receiver<Value> {
        let (tx, rx) = mpsc::channel();
        let handle = app.handle().clone();
        std::thread::spawn(move || {
            let _ = tx.send(run(&handle));
        });
        rx
    }

    #[test]
    fn a_mode_command_waits_for_the_one_in_flight() {
        let (app, _receiver) = app();
        let seen = record_applied(&app);

        let state = app.state::<LightingRuntimeState>();
        let turn = state.hold_transition_for_tests();
        let pending = in_background(&app, |app| apply_mode(app, solid(200)));

        assert!(
            pending.recv_timeout(Duration::from_millis(300)).is_err(),
            "a mode apply ran while another transition held the turn"
        );
        assert!(seen.lock().unwrap().is_empty(), "applied outside its turn");

        drop(turn);
        let response = pending
            .recv_timeout(Duration::from_secs(5))
            .expect("the queued command must run once the turn is released");
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
        let seen = record_applied(&app);

        let state = app.state::<LightingRuntimeState>();
        let turn = state.hold_transition_for_tests();
        let mut pending = Vec::new();
        for r in [10u8, 20, 30, 40, 50] {
            pending.push(in_background(&app, move |app| apply_mode(app, solid(r))));
            std::thread::sleep(Duration::from_millis(100));
        }
        pending.push(in_background(&app, stop_mode));
        std::thread::sleep(Duration::from_millis(100));
        drop(turn);

        for response in pending {
            response
                .recv_timeout(Duration::from_secs(5))
                .expect("every queued command must answer");
        }
        assert_eq!(
            *seen.lock().unwrap(),
            ["solid:10", "solid:20", "solid:30", "solid:40", "solid:50", "off"]
        );
        assert_eq!(running_mode(app.handle())["kind"], json!("off"));
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
