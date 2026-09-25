//! The lighting transaction's commands over IPC, through the main window's
//! real grants.

use std::sync::{mpsc, Arc};
use std::time::Duration;

use serde_json::{json, Value};
use tauri::test::MockRuntime;
use tauri::{App, Manager, WebviewWindow};

use super::{assert_camel_case_keys, invoke, main_webview, mock_app, status_code};
use crate::commands::device_connection::SerialConnectionState;
use crate::commands::led_output::{LedOutputBridge, LedOutputError, LedPacketSender};
use crate::commands::lighting_mode::hue_driver::HueDriverHandle;
use crate::commands::lighting_mode::{EventLog, FakeHue, LightingRuntimeState};
use crate::commands::shell_state::ShellStateStore;

struct SilentStrip;

impl LedPacketSender for SilentStrip {
    fn send(&self, _port_name: &str, _packet: &[u8]) -> Result<(), LedOutputError> {
        Ok(())
    }

    fn disconnect_session(&self, _port_name: &str) {}
}

/// Solid only: the mock app keeps the real capture factory, and nothing here
/// may capture the screen.
fn app() -> App<MockRuntime> {
    let app = mock_app(tauri::generate_handler![
        crate::commands::lighting_mode::outputs::apply_outputs,
        crate::commands::lighting_mode::tuning::retune_lighting,
        crate::commands::lighting_mode::outputs::release_hue_output,
        crate::commands::lighting_mode::outputs::get_lighting_runtime
    ]);
    app.manage(HueDriverHandle(FakeHue::new(Arc::new(EventLog::default()))));
    app.state::<LightingRuntimeState>()
        .replace_output_bridge_for_tests(LedOutputBridge::from_sender(Arc::new(SilentStrip)));
    {
        let serial = app.state::<SerialConnectionState>();
        let mut status = serial.last_status.lock().unwrap();
        status.connected = true;
        status.port_name = Some("COM-IPC".to_string());
    }
    let seed = json!({
        "ledCalibration": crate::commands::lighting_mode::calibration_for_tests(),
    });
    app.state::<ShellStateStore>()
        .patch(seed.as_object().cloned().unwrap(), Vec::new(), None, |_| {})
        .unwrap();
    app
}

fn solid_request() -> Value {
    json!({
        "request": {
            "mode": { "kind": "solid", "solid": { "r": 200, "g": 10, "b": 10, "brightness": 1 } },
            "targets": ["usb"],
            "origin": "user"
        }
    })
}

#[test]
fn the_runtime_snapshot_answers_in_camel_case() {
    let app = app();
    let webview = main_webview(&app);

    let snapshot =
        invoke(&webview, "get_lighting_runtime", json!({})).expect("the snapshot resolves");

    assert_camel_case_keys(&snapshot);
    assert!(snapshot["revision"].is_u64());
    assert_eq!(snapshot["mode"]["kind"], json!("off"));
    assert_eq!(snapshot["phase"], json!("idle"));
}

#[test]
fn apply_outputs_runs_a_mode_and_says_what_runs() {
    let app = app();
    let webview = main_webview(&app);

    let result = invoke(&webview, "apply_outputs", solid_request()).expect("apply resolves");

    assert_eq!(status_code(&result), "OUTPUTS_APPLIED");
    assert_camel_case_keys(&result);
    assert_camel_case_keys(&result["outcome"]);
    assert_camel_case_keys(&result["snapshot"]);
    assert!(result["requestId"].is_u64());
    assert_eq!(result["snapshot"]["mode"]["kind"], json!("solid"));
    assert_eq!(result["snapshot"]["activeTargets"], json!(["usb"]));

    let runtime = invoke(&webview, "get_lighting_runtime", json!({})).unwrap();
    assert_eq!(runtime["revision"], result["snapshot"]["revision"]);
}

#[test]
fn apply_outputs_rejects_an_origin_it_does_not_know() {
    let app = app();
    let webview = main_webview(&app);

    let rejected = invoke(
        &webview,
        "apply_outputs",
        json!({ "request": { "targets": ["usb"], "origin": "somewhere" } }),
    );

    assert!(rejected.is_err(), "{rejected:?}");
}

#[test]
fn a_retune_reaches_the_running_mode_and_only_that_kind() {
    let app = app();
    let webview = main_webview(&app);
    let solid = json!({ "tuning": { "solid": { "r": 1, "g": 2, "b": 3, "brightness": 0.5 } } });

    let before = invoke(&webview, "retune_lighting", solid.clone()).unwrap();
    assert_eq!(status_code(&before), "RETUNE_NOT_RUNNING");

    invoke(&webview, "apply_outputs", solid_request()).unwrap();
    let during = invoke(&webview, "retune_lighting", solid).unwrap();
    assert_eq!(status_code(&during), "RETUNE_APPLIED");

    let wrong_kind = invoke(
        &webview,
        "retune_lighting",
        json!({ "tuning": { "ambilight": { "brightness": 0.5 } } }),
    )
    .unwrap();
    assert_eq!(status_code(&wrong_kind), "RETUNE_NOT_RUNNING");
}

#[test]
fn releasing_hue_with_the_mode_off_answers_applied() {
    let app = app();
    let webview = main_webview(&app);

    let result = invoke(
        &webview,
        "release_hue_output",
        json!({ "triggerSource": "device_surface" }),
    )
    .expect("release resolves");

    assert_eq!(status_code(&result), "OUTPUTS_APPLIED");
}

/// Sync commands run on the main thread: a status read that waited on the
/// runtime lock froze the window for as long as a transition held it.
fn answers_while_the_runtime_is_locked(command: &'static str) {
    let app = app();
    let webview: WebviewWindow<MockRuntime> = main_webview(&app);
    invoke(&webview, "apply_outputs", solid_request()).unwrap();
    let state = app.state::<LightingRuntimeState>();
    let _held = state.hold_runtime_for_tests();

    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(invoke(&webview, command, json!({})));
    });
    let answered = rx
        .recv_timeout(Duration::from_millis(500))
        .unwrap_or_else(|_| panic!("{command} waited on the runtime lock"));

    let value = answered.expect("the read resolves");
    let mode = value.get("mode").cloned().unwrap_or(Value::Null);
    assert_eq!(mode["kind"], json!("solid"), "{value}");
}

#[test]
fn the_runtime_snapshot_never_waits_for_the_runtime_lock() {
    answers_while_the_runtime_is_locked("get_lighting_runtime");
}
