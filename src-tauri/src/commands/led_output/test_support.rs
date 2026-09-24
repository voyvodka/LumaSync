//! Fakes shared by the serial and sink tests: a recording packet sender, an
//! in-memory port, and a connection state that reports a port as connected.

use std::io::Write;
use std::sync::Mutex;

use super::serial::{LedOutputError, LedPacketSender};
use crate::commands::device_connection::{SerialConnectionState, SerialConnectionStatus};
use crate::commands::status::CommandStatus;

#[derive(Default)]
pub(super) struct FakeSender {
    writes: Mutex<Vec<(String, Vec<u8>)>>,
    fail_with: Option<&'static str>,
    disconnected: Mutex<Vec<String>>,
}

#[derive(Default)]
pub(super) struct FakePort {
    writes: Vec<u8>,
}

impl Write for FakePort {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.writes.extend_from_slice(buf);
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl FakeSender {
    pub(super) fn successful() -> Self {
        Self::default()
    }

    pub(super) fn failing(code: &'static str) -> Self {
        Self {
            writes: Mutex::new(Vec::new()),
            fail_with: Some(code),
            disconnected: Mutex::new(Vec::new()),
        }
    }

    pub(super) fn writes(&self) -> Vec<(String, Vec<u8>)> {
        self.writes.lock().expect("writes lock poisoned").clone()
    }

    pub(super) fn disconnected_ports(&self) -> Vec<String> {
        self.disconnected
            .lock()
            .expect("disconnected lock poisoned")
            .clone()
    }
}

impl LedPacketSender for FakeSender {
    fn send(&self, port_name: &str, packet: &[u8]) -> Result<(), LedOutputError> {
        if let Some(code) = self.fail_with {
            return Err(LedOutputError::new(
                code,
                Some("forced failure".to_string()),
            ));
        }

        self.writes
            .lock()
            .expect("writes lock poisoned")
            .push((port_name.to_string(), packet.to_vec()));
        Ok(())
    }

    fn disconnect_session(&self, port_name: &str) {
        self.disconnected
            .lock()
            .expect("disconnected lock poisoned")
            .push(port_name.to_string());
    }
}

pub(super) fn connected_state(port_name: &str) -> SerialConnectionState {
    SerialConnectionState {
        last_status: Mutex::new(SerialConnectionStatus {
            port_name: Some(port_name.to_string()),
            connected: true,
            status: CommandStatus {
                code: "CONNECT_OK".to_string(),
                message: "Connected".to_string(),
                details: None,
            },
            updated_at_unix_ms: 0,
            firmware: None,
        }),
    }
}
