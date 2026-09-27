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

use super::{apply_mode, invoke, main_webview, mock_app, mock_app_with_serial_ports, status_code};
use crate::commands::device_connection::{
    serial_watch_tick, SerialPortAccess, SerialPortIo, SerialWatch, SettledPort,
};
use crate::commands::device_handshake::SerialRoundTrip;
use crate::commands::led_output::{LedOutputBridge, LedOutputError, LedPacketSender};
use crate::commands::lighting_mode::LightingRuntimeState;
use crate::commands::local_outputs::{
    disconnect_serial_with, LocalOutputRegistry, LocalOutputStatus,
};
use crate::commands::wled_sink::{WledProtocol, WledSinkConfig};

const CH340: (u16, u16) = (0x1A86, 0x7523);
const CALL_OUT: &str = "/dev/cu.usbserial-10";
const TTY_SIBLING: &str = "/dev/tty.usbserial-10";
const BLUETOOTH: &str = "/dev/cu.Bluetooth-Incoming-Port";
const UNKNOWN_USB: &str = "/dev/cu.usbmodem-unlisted";

#[derive(Default)]
struct FakeSerialPorts {
    ports: Mutex<Vec<SerialPortInfo>>,
    opened: Mutex<Vec<String>>,
    /// Every open fails with this `Unknown` error, as a wedged driver's does.
    refuse_open: Option<&'static str>,
}

impl FakeSerialPorts {
    fn opened(&self) -> Vec<String> {
        self.opened.lock().expect("opened lock poisoned").clone()
    }

    fn unplug_all(&self) {
        self.ports.lock().expect("ports lock poisoned").clear();
    }
}

impl SerialPortIo for FakeSerialPorts {
    fn available_ports(&self) -> serialport::Result<Vec<SerialPortInfo>> {
        Ok(self.ports.lock().expect("ports lock poisoned").clone())
    }

    fn open_and_settle(&self, port_name: &str) -> serialport::Result<SettledPort> {
        self.opened
            .lock()
            .expect("opened lock poisoned")
            .push(port_name.to_string());
        if let Some(description) = self.refuse_open {
            return Err(serialport::Error::new(
                serialport::ErrorKind::Unknown,
                description,
            ));
        }
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
        ports: Mutex::new(vec![
            usb_port(CALL_OUT, CH340),
            usb_port(TTY_SIBLING, CH340),
            SerialPortInfo {
                port_name: BLUETOOTH.to_string(),
                port_type: SerialPortType::BluetoothPort,
            },
            usb_port(UNKNOWN_USB, (0xDEAD, 0xBEEF)),
        ]),
        ..FakeSerialPorts::default()
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

/// The macOS CH340 driver, once wedged, fails every open's termios setup with EINVAL until the cable
/// is re-plugged; connect says so instead of a bare `CONNECT_FAILED`.
#[test]
fn a_wedged_driver_asks_for_a_replug() {
    let ports = Arc::new(FakeSerialPorts {
        ports: Mutex::new(vec![usb_port(CALL_OUT, CH340)]),
        refuse_open: Some("Invalid argument"),
        ..FakeSerialPorts::default()
    });
    let app = connect_app(Arc::clone(&ports));
    let webview = main_webview(&app);

    let response = connect(&webview, CALL_OUT);

    assert_eq!(
        status_code(&response),
        "CONNECT_REPLUG_REQUIRED",
        "got: {response}"
    );
    assert_eq!(response["connected"], json!(false));
    assert_eq!(ports.opened(), vec![CALL_OUT.to_string()]);
}

// ---------------------------------------------------------------------------
// Output: a mode change writes only to a connected port
// ---------------------------------------------------------------------------

#[derive(Default)]
struct RecordingSender {
    writes: Mutex<Vec<String>>,
    forgotten: Mutex<Vec<String>>,
}

impl RecordingSender {
    fn writes(&self) -> Vec<String> {
        self.writes.lock().expect("writes lock poisoned").clone()
    }

    fn forgotten(&self) -> Vec<String> {
        self.forgotten
            .lock()
            .expect("forgotten lock poisoned")
            .clone()
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

    fn disconnect_session(&self, port_name: &str) {
        self.forgotten
            .lock()
            .expect("forgotten lock poisoned")
            .push(port_name.to_string());
    }
}

/// A mode-change app whose connection status names `port_name` without a
/// connection, and whose serial writes land in the returned recorder. The
/// status is written directly: since #421 connect cannot produce it, which is
/// exactly why the output side must not depend on connect alone.
fn output_app(port_name: &str) -> (App<MockRuntime>, Arc<RecordingSender>) {
    // `start_led_test_pattern` is covered in `lighting_mode/transition_tests.rs` instead: it
    // reads the monitor list, which `MockRuntime` leaves unimplemented.
    let app = mock_app(tauri::generate_handler![]);
    app.state::<LocalOutputRegistry>()
        .set_serial_for_tests(port_name, false, 0);
    let recorder = Arc::new(RecordingSender::default());
    app.state::<LightingRuntimeState>()
        .replace_output_bridge_for_tests(LedOutputBridge::from_sender(recorder.clone()));
    (app, recorder)
}

fn solid_on_usb() -> Value {
    json!({
        "kind": "solid",
        "solid": { "r": 255, "g": 0, "b": 0, "brightness": 1.0 },
        "targets": ["usb"]
    })
}

#[test]
fn a_port_name_without_a_connection_is_not_written_to() {
    let (app, recorder) = output_app(BLUETOOTH);

    let response = apply_mode(app.handle(), solid_on_usb());

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
    app.state::<LocalOutputRegistry>().wled_bound(config);

    let response = apply_mode(app.handle(), solid_on_usb());

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

// ---------------------------------------------------------------------------
// The serial port watcher
// ---------------------------------------------------------------------------

fn loopback_wled() -> WledSinkConfig {
    WledSinkConfig {
        ip: "127.0.0.1".parse().expect("loopback"),
        port: 9,
        led_count: 1,
        protocol: WledProtocol::Drgb,
    }
}

fn recording_writer(app: &App<MockRuntime>) -> Arc<RecordingSender> {
    let recorder = Arc::new(RecordingSender::default());
    app.state::<LightingRuntimeState>()
        .replace_output_bridge_for_tests(LedOutputBridge::from_sender(recorder.clone()));
    recorder
}

fn serial_outputs(app: &App<MockRuntime>) -> Vec<(String, bool, String)> {
    app.state::<LocalOutputRegistry>()
        .snapshot()
        .outputs
        .into_iter()
        .filter_map(|output| match output {
            LocalOutputStatus::Serial(entry) => {
                Some((entry.port_name, entry.connected, entry.status.code))
            }
            LocalOutputStatus::Wled(_) => None,
        })
        .collect()
}

/// Every supported port that went away has its writer dropped. Off macOS the `tty.*` sibling is a
/// listed port of its own, so it goes too (it holds no writer; forgetting it is a no-op).
fn writers_dropped_by_unplug_all() -> Vec<String> {
    let mut lost = vec![CALL_OUT.to_string()];
    if !cfg!(target_os = "macos") {
        lost.push(TTY_SIBLING.to_string());
    }
    lost
}

/// An unplugged strip loses its connection and its cached writer.
#[test]
fn an_unplugged_strip_drops_its_writer_and_its_connection() {
    let ports = mac_inventory();
    let app = connect_app(Arc::clone(&ports));
    let webview = main_webview(&app);
    app.state::<LocalOutputRegistry>()
        .set_serial_for_tests(CALL_OUT, true, 0);
    let recorder = recording_writer(&app);

    let mut watch = SerialWatch::default();
    serial_watch_tick(app.handle(), &mut watch);
    ports.unplug_all();
    serial_watch_tick(app.handle(), &mut watch);
    assert_eq!(recorder.forgotten(), Vec::<String>::new());
    serial_watch_tick(app.handle(), &mut watch);

    assert_eq!(recorder.forgotten(), writers_dropped_by_unplug_all());
    let status =
        invoke(&webview, "get_serial_connection_status", json!({})).expect("status must resolve");
    assert_eq!(status["connected"], json!(false));
    assert_eq!(status_code(&status), "PORT_NOT_FOUND");
    assert_eq!(
        serial_outputs(&app),
        vec![(CALL_OUT.to_string(), false, "PORT_NOT_FOUND".to_string())]
    );
}

/// A strip WLED replaced is no longer connected, but its writer may still hold the port: an unplug
/// drops it all the same, and the WLED device stays bound.
#[test]
fn an_unplug_after_wled_took_over_drops_the_old_writer_and_keeps_wled() {
    let ports = mac_inventory();
    let app = connect_app(Arc::clone(&ports));
    let registry = app.state::<LocalOutputRegistry>();
    registry.set_serial_for_tests(CALL_OUT, true, 0);
    registry.wled_bound(loopback_wled());
    let recorder = recording_writer(&app);

    let mut watch = SerialWatch::default();
    serial_watch_tick(app.handle(), &mut watch);
    ports.unplug_all();
    serial_watch_tick(app.handle(), &mut watch);
    serial_watch_tick(app.handle(), &mut watch);

    assert_eq!(recorder.forgotten(), writers_dropped_by_unplug_all());
    assert_eq!(registry.wled_config(), Some(loopback_wled()));
}

// ---------------------------------------------------------------------------
// The local-output registry over IPC
// ---------------------------------------------------------------------------

fn registry_app(ports: Arc<FakeSerialPorts>) -> App<MockRuntime> {
    let app = mock_app_with_serial_ports(
        tauri::generate_handler![
            crate::commands::device_connection::connect_serial_port,
            crate::commands::local_outputs::get_local_outputs
        ],
        SerialPortAccess::from_io(ports),
    );
    // Registered but granted to no window until the frontend reads it.
    super::grant_main_for_tests(&app, &["allow-get-local-outputs"]);
    app
}

#[test]
fn get_local_outputs_lists_a_connected_strip() {
    let app = registry_app(mac_inventory());
    let webview = main_webview(&app);

    let connected = connect(&webview, CALL_OUT);
    assert_eq!(connected["connected"], json!(true), "got: {connected}");
    let snapshot = invoke(&webview, "get_local_outputs", json!({})).expect("never rejects");

    assert_eq!(snapshot["revision"], json!(1));
    assert_eq!(
        snapshot["outputs"],
        json!([{
            "kind": "serial",
            "portName": CALL_OUT,
            "connected": true,
            "status": connected["status"],
            "firmware": null,
            "updatedAtUnixMs": connected["updatedAtUnixMs"],
        }])
    );
}

/// Bug A: a failed serial attempt used to empty the "usb" channel, bound WLED device and all, while
/// the UI still showed it bound.
#[test]
fn a_failed_serial_attempt_leaves_a_bound_wled_device_in_place() {
    let ports = Arc::new(FakeSerialPorts {
        ports: Mutex::new(vec![usb_port(CALL_OUT, CH340)]),
        refuse_open: Some("Invalid argument"),
        ..FakeSerialPorts::default()
    });
    let app = registry_app(ports);
    let webview = main_webview(&app);
    app.state::<LocalOutputRegistry>()
        .wled_bound(loopback_wled());

    let refused = connect(&webview, CALL_OUT);
    assert_eq!(status_code(&refused), "CONNECT_REPLUG_REQUIRED");
    let unknown = connect(&webview, "../../etc/passwd");
    assert_eq!(status_code(&unknown), "PORT_NOT_FOUND");

    assert_eq!(
        app.state::<LocalOutputRegistry>().wled_config(),
        Some(loopback_wled())
    );
    // The admitted port is recorded; the name that was never a port is not.
    assert_eq!(
        serial_outputs(&app),
        vec![(
            CALL_OUT.to_string(),
            false,
            "CONNECT_REPLUG_REQUIRED".to_string()
        )]
    );
}

#[test]
fn disconnecting_a_port_that_is_not_connected_touches_nothing() {
    let (app, recorder) = output_app(CALL_OUT);

    let result = tauri::async_runtime::block_on(disconnect_serial_with(app.handle(), CALL_OUT));

    assert_eq!(result.status.code, "SERIAL_DISCONNECT_NOT_CONNECTED");
    assert_eq!(recorder.forgotten(), Vec::<String>::new());
}

// The frontend follows the registry through this event from PR 4 on; each change announces itself.
#[test]
fn a_connect_announces_the_registry_to_the_main_window() {
    use tauri::Listener;

    let app = registry_app(mac_inventory());
    let webview = main_webview(&app);
    let seen = Arc::new(Mutex::new(Vec::<String>::new()));
    let sink = Arc::clone(&seen);
    app.listen_any(
        crate::events::DEVICE_LOCAL_OUTPUTS_CHANGED_EVENT,
        move |event| sink.lock().expect("seen").push(event.payload().to_string()),
    );

    connect(&webview, CALL_OUT);
    connect(&webview, UNKNOWN_USB);

    let seen = seen.lock().expect("seen");
    assert_eq!(seen.len(), 2, "one per change: {seen:?}");
    let last: Value = serde_json::from_str(&seen[1]).expect("json");
    assert_eq!(last["revision"], json!(2));
    assert_eq!(last["outputs"][0]["connected"], json!(true));
}

/// Every change announces the registry once, with the revision it produced: a connect, a WLED
/// bind and forget, a disconnect, and the watcher's clear.
#[test]
fn each_change_announces_the_registry_once_in_revision_order() {
    use tauri::Listener;

    let ports = mac_inventory();
    let app = mock_app_with_serial_ports(
        tauri::generate_handler![
            crate::commands::device_connection::connect_serial_port,
            crate::commands::wled_discovery::connect_wled_sink,
            crate::commands::wled_discovery::forget_wled_device,
            crate::commands::local_outputs::disconnect_serial_port
        ],
        SerialPortAccess::from_io(Arc::clone(&ports) as Arc<dyn SerialPortIo>),
    );
    super::grant_main_for_tests(&app, &["allow-disconnect-serial-port"]);
    let webview = main_webview(&app);
    let seen = Arc::new(Mutex::new(Vec::<Value>::new()));
    let sink = Arc::clone(&seen);
    app.listen_any(
        crate::events::DEVICE_LOCAL_OUTPUTS_CHANGED_EVENT,
        move |event| {
            let payload = serde_json::from_str(event.payload()).expect("json");
            sink.lock().expect("seen").push(payload);
        },
    );
    let wled = json!({ "request": {
        // Private and never sent to: a connect only binds a local socket, and forget contacts nothing.
        "device": { "ip": "192.168.254.254", "mac": null, "ledCount": 1, "name": null, "version": null },
        "port": 9,
        "protocol": "drgb"
    }});

    connect(&webview, CALL_OUT);
    let bound = invoke(&webview, "connect_wled_sink", wled).expect("wled connect");
    assert_eq!(status_code(&bound), "WLED_CONNECT_OK", "got: {bound}");
    let forgotten = invoke(
        &webview,
        "forget_wled_device",
        json!({ "request": { "ip": "192.168.254.254" } }),
    )
    .expect("forget");
    assert_eq!(
        status_code(&forgotten),
        "WLED_FORGET_OK",
        "got: {forgotten}"
    );
    connect(&webview, CALL_OUT);
    let let_go = invoke(
        &webview,
        "disconnect_serial_port",
        json!({ "portName": CALL_OUT }),
    )
    .expect("disconnect");
    assert_eq!(
        status_code(&let_go),
        "SERIAL_DISCONNECT_OK",
        "got: {let_go}"
    );
    assert_eq!(let_go["portName"], json!(CALL_OUT));
    connect(&webview, CALL_OUT);
    // The watcher clears only what was connected before its listing, compared in milliseconds.
    std::thread::sleep(Duration::from_millis(5));
    let mut watch = SerialWatch::default();
    serial_watch_tick(app.handle(), &mut watch);
    ports.unplug_all();
    serial_watch_tick(app.handle(), &mut watch);
    serial_watch_tick(app.handle(), &mut watch);

    let seen = seen.lock().expect("seen");
    let revisions: Vec<u64> = seen
        .iter()
        .map(|payload| payload["revision"].as_u64().expect("revision"))
        .collect();
    assert_eq!(revisions, (1..=7).collect::<Vec<u64>>(), "{seen:#?}");
    assert_eq!(seen[1]["outputs"][1]["kind"], json!("wled"));
    assert_eq!(seen[2]["outputs"].as_array().map(Vec::len), Some(1));
    assert_eq!(
        seen[4]["outputs"][0]["status"]["code"],
        json!("DISCONNECTED")
    );
    assert_eq!(
        seen[6]["outputs"][0]["status"]["code"],
        json!("PORT_NOT_FOUND")
    );
}
