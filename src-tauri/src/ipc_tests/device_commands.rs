//! Serial device commands over IPC.

use serde_json::{json, Value};
use tauri::test::MockRuntime;
use tauri::App;

use super::{assert_camel_case_keys, invoke, main_webview, mock_app, status_code};

fn app() -> App<MockRuntime> {
    mock_app(tauri::generate_handler![
        crate::commands::device_connection::list_serial_ports,
        crate::commands::device_connection::connect_serial_port,
        crate::commands::device_connection::get_serial_connection_status
    ])
}

/// A port name no enumerator can produce, so the `PORT_NOT_FOUND` branch is
/// reached identically on every runner.
const ABSENT_PORT: &str = "/dev/lumasync-nonexistent-test-port";

#[test]
fn list_serial_ports_returns_camel_case_descriptors() {
    let app = app();
    let webview = main_webview(&app);

    let response = invoke(&webview, "list_serial_ports", json!({}))
        .expect("list_serial_ports must not reject");

    assert_camel_case_keys(&response);
    assert_eq!(status_code(&response), "LIST_PORTS_OK");

    let ports = response["ports"].as_array().expect("`ports` is an array");
    for port in ports {
        assert_camel_case_keys(port);
        assert!(
            port["isSupported"].is_boolean(),
            "every descriptor carries `isSupported`, got: {port}"
        );
    }
}

#[test]
fn connect_to_absent_port_resolves_with_port_not_found() {
    let app = app();
    let webview = main_webview(&app);

    let response = invoke(
        &webview,
        "connect_serial_port",
        json!({ "portName": ABSENT_PORT, "chipType": null }),
    )
    .expect("connect_serial_port must resolve, never reject");

    assert_eq!(status_code(&response), "PORT_NOT_FOUND");
    assert_eq!(response["connected"], json!(false));
    assert_eq!(
        response["portName"],
        Value::Null,
        "a port that was never opened is not the status's port"
    );
    assert_eq!(
        response["status"]["details"],
        json!(format!("port={ABSENT_PORT:?}")),
        "the attempted name is kept for diagnostics in `details`"
    );
}

/// The 9-entry VID/PID allowlist is only observable through a real enumeration,
/// so this asserts against whatever the runner exposes and skips when the host
/// has no unsupported port (bare CI containers usually have none).
#[test]
fn connect_to_unsupported_port_is_blocked() {
    let app = app();
    let webview = main_webview(&app);

    let listed = invoke(&webview, "list_serial_ports", json!({})).expect("listing must not reject");
    let unsupported = listed["ports"]
        .as_array()
        .expect("`ports` is an array")
        .iter()
        .find(|port| port["isSupported"] == json!(false))
        .and_then(|port| port["name"].as_str().map(str::to_owned));

    let Some(port_name) = unsupported else {
        eprintln!("skipped: host exposes no unsupported serial port");
        return;
    };

    let response = invoke(
        &webview,
        "connect_serial_port",
        json!({ "portName": port_name, "chipType": null }),
    )
    .expect("connect_serial_port must resolve, never reject");

    assert_eq!(
        status_code(&response),
        "PORT_UNSUPPORTED",
        "an allowlist miss must be refused before open(), not opened and written to"
    );
    assert_eq!(response["connected"], json!(false));
    assert_eq!(response["portName"], Value::Null);

    let status =
        invoke(&webview, "get_serial_connection_status", json!({})).expect("status must resolve");
    assert_eq!(
        status["portName"],
        Value::Null,
        "a refused port must not become the recorded port"
    );
}

/// The failed attempt has to land in `SerialConnectionState`, otherwise the UI
/// re-reads a stale "connected" status after a failure.
#[test]
fn failed_connect_is_readable_from_connection_status() {
    let app = app();
    let webview = main_webview(&app);

    let before =
        invoke(&webview, "get_serial_connection_status", json!({})).expect("status must resolve");
    assert_eq!(before["connected"], json!(false));

    invoke(
        &webview,
        "connect_serial_port",
        json!({ "portName": ABSENT_PORT, "chipType": null }),
    )
    .expect("connect must resolve");

    let after =
        invoke(&webview, "get_serial_connection_status", json!({})).expect("status must resolve");

    assert_eq!(status_code(&after), "PORT_NOT_FOUND");
    assert_eq!(after["connected"], json!(false));
    assert_eq!(after["portName"], Value::Null);
}

/// Names no enumerator produces, including path-shaped ones, are refused by
/// the inventory lookup and never recorded as the status's port.
#[test]
fn path_shaped_port_names_are_refused_without_becoming_the_status_port() {
    let app = app();
    let webview = main_webview(&app);

    for name in ["", "../../etc/passwd", "/etc/passwd", ABSENT_PORT] {
        let response = invoke(
            &webview,
            "connect_serial_port",
            json!({ "portName": name, "chipType": null }),
        )
        .expect("connect must resolve");

        assert_eq!(status_code(&response), "PORT_NOT_FOUND", "input {name:?}");
        assert_eq!(response["portName"], Value::Null, "input {name:?}");

        let status = invoke(&webview, "get_serial_connection_status", json!({}))
            .expect("status must resolve");
        assert_eq!(status["connected"], json!(false), "input {name:?}");
        assert_eq!(status["portName"], Value::Null, "input {name:?}");
    }
}

/// `apply_mode_change` plans USB output from the recorded port name even while
/// `connected` is false, so a refused name left in the status would be opened
/// and written to by the next mode change. The gate must hold instead.
#[test]
fn refused_connect_does_not_arm_usb_output() {
    let app = mock_app(tauri::generate_handler![
        crate::commands::device_connection::connect_serial_port,
        crate::commands::lighting_mode::set_lighting_mode
    ]);
    let webview = main_webview(&app);

    invoke(
        &webview,
        "connect_serial_port",
        json!({ "portName": ABSENT_PORT, "chipType": null }),
    )
    .expect("connect must resolve");

    let response = invoke(
        &webview,
        "set_lighting_mode",
        json!({
            "payload": {
                "kind": "solid",
                "solid": { "r": 255, "g": 0, "b": 0, "brightness": 1.0 },
                "targets": ["usb"]
            }
        }),
    )
    .expect("set_lighting_mode must resolve, never reject");

    assert_eq!(
        status_code(&response),
        "DEVICE_NOT_CONNECTED",
        "a refused port must leave USB output gated, got: {response}"
    );
    assert_eq!(response["active"], json!(false));
}

#[test]
fn unregistered_command_rejects() {
    let app = app();
    let webview = main_webview(&app);

    let error: Value = invoke(&webview, "connect_serial_port_typo", json!({}))
        .expect_err("an unregistered command must reject");

    assert!(
        error.to_string().contains("not found"),
        "expected a not-found rejection, got: {error}"
    );
}
