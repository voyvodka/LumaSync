//! What may reach a serial `open()`: connect admits only what the listing
//! offers as supported, and a mode change writes only to a port that is
//! connected. Driven over a synthetic port inventory and a recording output
//! path, so every runner sees the same ports and every open is observable.

use std::net::UdpSocket;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use serialport::{SerialPortInfo, SerialPortType, UsbPortInfo};
use tauri::test::MockRuntime;
use tauri::{App, Manager};

use super::{
    grant_main_for_tests, invoke, main_webview, mock_app, mock_app_with_serial_ports, status_code,
};
use crate::commands::device_connection::{
    ActiveSinkRegistry, SerialConnectionState, SerialPortAccess, SerialPortIo, SettledPort,
};
use crate::commands::device_handshake::SerialRoundTrip;
use crate::commands::led_output::{LedOutputBridge, LedOutputError, LedPacketSender};
use crate::commands::lighting_mode::LightingRuntimeState;
use crate::commands::wled_sink::{WledProtocol, WledSinkConfig};

const CH340: (u16, u16) = (0x1A86, 0x7523);
const CALL_OUT: &str = "/dev/cu.usbserial-10";
const TTY_SIBLING: &str = "/dev/tty.usbserial-10";
const BLUETOOTH: &str = "/dev/cu.Bluetooth-Incoming-Port";
const UNKNOWN_USB: &str = "/dev/cu.usbmodem-unlisted";

#[derive(Default)]
struct FakeSerialPorts {
    ports: Vec<SerialPortInfo>,
    opened: Mutex<Vec<String>>,
}

impl FakeSerialPorts {
    fn opened(&self) -> Vec<String> {
        self.opened.lock().expect("opened lock poisoned").clone()
    }
}

impl SerialPortIo for FakeSerialPorts {
    fn available_ports(&self) -> serialport::Result<Vec<SerialPortInfo>> {
        Ok(self.ports.clone())
    }

    fn open_and_settle(&self, port_name: &str) -> serialport::Result<SettledPort> {
        self.opened
            .lock()
            .expect("opened lock poisoned")
            .push(port_name.to_string());
        Ok(Box::new(SilentDevice))
    }
}

/// Answers nothing, like an Adalight sketch: admission is all these tests read.
struct SilentDevice;

impl SerialRoundTrip for SilentDevice {
    fn write_all(&mut self, _bytes: &[u8]) -> std::io::Result<()> {
        Ok(())
    }

    fn read_with_timeout(&mut self, _buf: &mut [u8], _timeout: Duration) -> std::io::Result<usize> {
        Ok(0)
    }
}

fn usb_port(name: &str, (vid, pid): (u16, u16)) -> SerialPortInfo {
    SerialPortInfo {
        port_name: name.to_string(),
        port_type: SerialPortType::UsbPort(UsbPortInfo {
            vid,
            pid,
            serial_number: None,
            manufacturer: None,
            product: None,
        }),
    }
}

/// What a Mac with one CH340 adapter enumerates: the adapter under both of
/// its paths, the Bluetooth phantom, and a USB device off the allowlist.
fn mac_inventory() -> Arc<FakeSerialPorts> {
    Arc::new(FakeSerialPorts {
        ports: vec![
            usb_port(CALL_OUT, CH340),
            usb_port(TTY_SIBLING, CH340),
            SerialPortInfo {
                port_name: BLUETOOTH.to_string(),
                port_type: SerialPortType::BluetoothPort,
            },
            usb_port(UNKNOWN_USB, (0xDEAD, 0xBEEF)),
        ],
        opened: Mutex::default(),
    })
}

fn connect_app(ports: Arc<FakeSerialPorts>) -> App<MockRuntime> {
    mock_app_with_serial_ports(
        tauri::generate_handler![
            crate::commands::device_connection::list_serial_ports,
            crate::commands::device_connection::connect_serial_port,
            crate::commands::device_connection::get_serial_connection_status
        ],
        SerialPortAccess::from_io(ports),
    )
}

fn connect(webview: &tauri::WebviewWindow<MockRuntime>, port_name: &str) -> Value {
    invoke(
        webview,
        "connect_serial_port",
        json!({ "portName": port_name, "chipType": null }),
    )
    .expect("connect_serial_port must resolve, never reject")
}

#[test]
fn connect_opens_exactly_the_ports_the_listing_offers_as_supported() {
    let ports = mac_inventory();
    let app = connect_app(Arc::clone(&ports));
    let webview = main_webview(&app);

    let listed = invoke(&webview, "list_serial_ports", json!({})).expect("listing must resolve");
    let listed = listed["ports"].as_array().expect("`ports` is an array");
    assert!(!listed.is_empty());

    let mut supported = Vec::new();
    for port in listed {
        let name = port["name"].as_str().expect("port name");
        let response = connect(&webview, name);
        assert_eq!(
            response["connected"], port["isSupported"],
            "connect must agree with the listing for {name}: {response}"
        );
        if port["isSupported"] == json!(true) {
            supported.push(name.to_string());
        }
    }

    assert!(supported.contains(&CALL_OUT.to_string()));
    assert!(!supported.contains(&BLUETOOTH.to_string()));
    assert!(!supported.contains(&UNKNOWN_USB.to_string()));
    #[cfg(target_os = "macos")]
    assert!(!supported.contains(&TTY_SIBLING.to_string()));
    assert_eq!(ports.opened(), supported);
}

#[test]
fn refused_names_never_reach_open() {
    let ports = mac_inventory();
    let app = connect_app(Arc::clone(&ports));
    let webview = main_webview(&app);

    for (name, code) in [
        (BLUETOOTH, "PORT_UNSUPPORTED"),
        (UNKNOWN_USB, "PORT_UNSUPPORTED"),
        ("/dev/cu.usbserial-unplugged", "PORT_NOT_FOUND"),
    ] {
        let response = connect(&webview, name);
        assert_eq!(status_code(&response), code, "input {name:?}");
        assert_eq!(response["connected"], json!(false), "input {name:?}");
        assert_eq!(response["portName"], Value::Null, "input {name:?}");
    }

    assert_eq!(ports.opened(), Vec::<String>::new());
    let status =
        invoke(&webview, "get_serial_connection_status", json!({})).expect("status must resolve");
    assert_eq!(status["portName"], Value::Null);
}

/// The `/dev/tty.*` sibling of an allowlisted adapter shares its VID:PID, so
/// only the path decides. It opens and then stalls on DCD; the refusal names
/// the `/dev/cu.*` path instead. See docs/architecture/device-output.md.
#[cfg(target_os = "macos")]
#[test]
fn the_tty_sibling_of_an_allowlisted_adapter_is_refused() {
    let ports = mac_inventory();
    let app = connect_app(Arc::clone(&ports));
    let webview = main_webview(&app);

    let listed = invoke(&webview, "list_serial_ports", json!({})).expect("listing must resolve");
    assert!(
        listed["ports"]
            .as_array()
            .expect("`ports` is an array")
            .iter()
            .all(|port| port["name"] != json!(TTY_SIBLING)),
        "the listing hides the tty sibling: {listed}"
    );

    let response = connect(&webview, TTY_SIBLING);

    assert_eq!(status_code(&response), "PORT_UNSUPPORTED");
    assert_eq!(response["portName"], Value::Null);
    let details = response["status"]["details"].as_str().expect("details");
    assert!(
        details.contains(CALL_OUT),
        "the refusal points at the call-out path, got: {details}"
    );
    assert_eq!(ports.opened(), Vec::<String>::new());
}

// ---------------------------------------------------------------------------
// Output: a mode change writes only to a connected port
// ---------------------------------------------------------------------------

#[derive(Default)]
struct RecordingSender {
    writes: Mutex<Vec<String>>,
}

impl RecordingSender {
    fn writes(&self) -> Vec<String> {
        self.writes.lock().expect("writes lock poisoned").clone()
    }
}

impl LedPacketSender for RecordingSender {
    fn send(&self, port_name: &str, _packet: &[u8]) -> Result<(), LedOutputError> {
        self.writes
            .lock()
            .expect("writes lock poisoned")
            .push(port_name.to_string());
        Ok(())
    }

    fn disconnect_session(&self, _port_name: &str) {}
}

/// A mode-change app whose connection status names `port_name` without a
/// connection, and whose serial writes land in the returned recorder. The
/// status is written directly: since #421 connect cannot produce it, which is
/// exactly why the output side must not depend on connect alone.
fn output_app(port_name: &str) -> (App<MockRuntime>, Arc<RecordingSender>) {
    // `start_led_test_pattern` is covered in `lighting_mode.rs` instead: it
    // reads the monitor list, which `MockRuntime` leaves unimplemented.
    let app = mock_app(tauri::generate_handler![
        crate::commands::lighting_mode::set_lighting_mode
    ]);
    grant_main_for_tests(&app, &["allow-set-lighting-mode"]);
    {
        let state = app.state::<SerialConnectionState>();
        let mut status = state.last_status.lock().expect("status lock poisoned");
        status.port_name = Some(port_name.to_string());
        status.connected = false;
    }
    let recorder = Arc::new(RecordingSender::default());
    app.state::<LightingRuntimeState>()
        .replace_output_bridge_for_tests(LedOutputBridge::from_sender(recorder.clone()));
    (app, recorder)
}

fn solid_on_usb() -> Value {
    json!({
        "payload": {
            "kind": "solid",
            "solid": { "r": 255, "g": 0, "b": 0, "brightness": 1.0 },
            "targets": ["usb"]
        }
    })
}

#[test]
fn a_port_name_without_a_connection_is_not_written_to() {
    let (app, recorder) = output_app(BLUETOOTH);
    let webview = main_webview(&app);

    let response = invoke(&webview, "set_lighting_mode", solid_on_usb())
        .expect("set_lighting_mode must resolve, never reject");

    assert_eq!(
        status_code(&response),
        "DEVICE_NOT_CONNECTED",
        "got: {response}"
    );
    assert_eq!(response["active"], json!(false));
    assert_eq!(recorder.writes(), Vec::<String>::new());
}

/// A registered WLED sink is the "usb" channel on its own; a leftover serial
/// name must neither block it nor be written to alongside it.
#[test]
fn wled_output_runs_with_a_port_name_but_no_connection() {
    let (app, recorder) = output_app(BLUETOOTH);
    let webview = main_webview(&app);

    let receiver = UdpSocket::bind("127.0.0.1:0").expect("bind receiver");
    receiver
        .set_read_timeout(Some(Duration::from_secs(2)))
        .expect("set read timeout");
    let config = WledSinkConfig {
        ip: "127.0.0.1".parse().expect("loopback"),
        port: receiver.local_addr().expect("receiver addr").port(),
        led_count: 1,
        protocol: WledProtocol::Drgb,
    };
    app.state::<ActiveSinkRegistry>()
        .replace_wled(Box::new(config.build()), config);

    let response = invoke(&webview, "set_lighting_mode", solid_on_usb())
        .expect("set_lighting_mode must resolve, never reject");

    assert_eq!(
        status_code(&response),
        "SOLID_MODE_APPLIED",
        "got: {response}"
    );
    let mut datagram = [0u8; 64];
    let received = receiver
        .recv(&mut datagram)
        .expect("the WLED sink sends a frame");
    assert!(received > 0);
    assert_eq!(recorder.writes(), Vec::<String>::new());
}
