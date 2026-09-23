//! The connect-time PING: what `connect_serial_port` reports for a device that
//! answers, stays silent, or answers garbage. Only an answer adds anything; the
//! other two must connect exactly as they did before the probe existed.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use serialport::{SerialPortInfo, SerialPortType, UsbPortInfo};
use tauri::test::MockRuntime;
use tauri::App;

use super::{invoke, main_webview, mock_app_with_serial_ports, status_code};
use crate::commands::device_connection::{SerialPortAccess, SerialPortIo, SettledPort};
use crate::commands::device_handshake::{
    encode_handshake_ping, SerialRoundTrip, FRAME_MAGIC, HANDSHAKE_OPCODE_PONG,
};

const PORT: &str = "/dev/cu.usbserial-nano";

/// The settled handle connect PINGs on. Records what was written to it.
struct ScriptedDevice {
    reply: Vec<u8>,
    written: Arc<Mutex<Vec<u8>>>,
}

impl SerialRoundTrip for ScriptedDevice {
    fn write_all(&mut self, bytes: &[u8]) -> std::io::Result<()> {
        self.written
            .lock()
            .expect("written lock poisoned")
            .extend_from_slice(bytes);
        Ok(())
    }

    fn read_with_timeout(&mut self, buf: &mut [u8], _timeout: Duration) -> std::io::Result<usize> {
        let n = buf.len().min(self.reply.len());
        buf[..n].copy_from_slice(&self.reply[..n]);
        self.reply.drain(..n);
        Ok(n)
    }
}

struct Nano {
    reply: Vec<u8>,
    written: Arc<Mutex<Vec<u8>>>,
    opens: Mutex<usize>,
}

impl Nano {
    fn replying(reply: Vec<u8>) -> Arc<Self> {
        Arc::new(Self {
            reply,
            written: Arc::default(),
            opens: Mutex::new(0),
        })
    }
}

impl SerialPortIo for Nano {
    fn available_ports(&self) -> serialport::Result<Vec<SerialPortInfo>> {
        Ok(vec![SerialPortInfo {
            port_name: PORT.to_string(),
            port_type: SerialPortType::UsbPort(UsbPortInfo {
                vid: 0x1A86,
                pid: 0x7523,
                serial_number: None,
                manufacturer: None,
                product: None,
            }),
        }])
    }

    fn open_and_settle(&self, _port_name: &str) -> serialport::Result<SettledPort> {
        *self.opens.lock().expect("opens lock poisoned") += 1;
        Ok(Box::new(ScriptedDevice {
            reply: self.reply.clone(),
            written: Arc::clone(&self.written),
        }))
    }
}

fn pong(version: u16, format_byte: u8) -> Vec<u8> {
    let [lo, hi] = version.to_le_bytes();
    let mut frame = vec![
        FRAME_MAGIC[0],
        FRAME_MAGIC[1],
        HANDSHAKE_OPCODE_PONG,
        lo,
        hi,
        format_byte,
    ];
    frame.push(frame.iter().fold(0, |acc, b| acc ^ b));
    frame
}

fn app(device: Arc<Nano>) -> App<MockRuntime> {
    mock_app_with_serial_ports(
        tauri::generate_handler![
            crate::commands::device_connection::connect_serial_port,
            crate::commands::device_connection::get_serial_connection_status
        ],
        SerialPortAccess::from_io(device),
    )
}

fn connect(device: Arc<Nano>) -> (Value, Value) {
    let app = app(device);
    let webview = main_webview(&app);
    let response = invoke(
        &webview,
        "connect_serial_port",
        json!({ "portName": PORT, "chipType": null }),
    )
    .expect("connect_serial_port must resolve, never reject");
    let status =
        invoke(&webview, "get_serial_connection_status", json!({})).expect("status must resolve");
    (response, status)
}

#[test]
fn an_answering_firmware_is_reported_on_connect() {
    let device = Nano::replying(pong(0x0104, 0x11));
    let (response, status) = connect(Arc::clone(&device));

    assert_eq!(status_code(&response), "CONNECT_OK");
    assert_eq!(response["connected"], json!(true));
    assert_eq!(
        response["firmware"],
        json!({
            "version": "1.4",
            "versionRaw": 0x0104,
            "profile": "lumasync-v1",
            "pixelLayout": "rgbw",
        })
    );
    assert_eq!(response["status"]["details"], Value::Null);
    assert_eq!(
        status["firmware"], response["firmware"],
        "the status read agrees"
    );

    // One open: the PING goes out on the settled handle, not a reopened one.
    assert_eq!(*device.opens.lock().unwrap(), 1);
    assert_eq!(*device.written.lock().unwrap(), encode_handshake_ping());
}

#[test]
fn a_silent_device_connects_exactly_as_before() {
    let device = Nano::replying(Vec::new());
    let (response, status) = connect(Arc::clone(&device));

    assert_eq!(status_code(&response), "CONNECT_OK");
    assert_eq!(response["connected"], json!(true));
    assert_eq!(response["portName"], json!(PORT));
    assert!(response.get("firmware").is_none(), "got: {response}");
    assert_eq!(response["status"]["details"], Value::Null);
    assert!(status.get("firmware").is_none(), "got: {status}");
}

#[test]
fn a_garbled_reply_never_fails_connect() {
    // An Adalight sketch that prints a banner, then a PONG with a bad checksum.
    let mut reply = b"Ada\n".to_vec();
    let mut corrupt = pong(0x0104, 0x01);
    corrupt[6] ^= 0xFF;
    reply.extend(corrupt);
    let (response, _) = connect(Nano::replying(reply));

    assert_eq!(status_code(&response), "CONNECT_OK");
    assert_eq!(response["connected"], json!(true));
    assert!(response.get("firmware").is_none(), "got: {response}");
    assert_eq!(response["status"]["details"], Value::Null);
}

#[test]
fn a_version_outside_the_window_connects_with_a_warning() {
    let (response, _) = connect(Nano::replying(pong(0x0200, 0x01)));

    assert_eq!(status_code(&response), "CONNECT_OK");
    assert_eq!(response["connected"], json!(true));
    assert_eq!(response["firmware"]["version"], json!("2.0"));
    let details = response["status"]["details"]
        .as_str()
        .expect("the warning rides details");
    assert!(
        details.starts_with("SERIAL_HEALTH_VERSION_MISMATCH"),
        "got: {details}"
    );
}
