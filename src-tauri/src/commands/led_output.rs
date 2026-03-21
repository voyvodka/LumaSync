use std::collections::HashMap;
use std::io::Write;
use std::sync::{Arc, Mutex};
use std::time::Duration;

#[cfg(test)]
use super::device_connection::SerialConnectionState;

const OUTPUT_BAUD_RATE: u32 = 115_200;
const OUTPUT_TIMEOUT_MS: u64 = 500;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LedOutputError {
    pub code: &'static str,
    pub details: Option<String>,
}

impl LedOutputError {
    fn new(code: &'static str, details: Option<String>) -> Self {
        Self { code, details }
    }

    pub fn as_reason(&self) -> String {
        match &self.details {
            Some(details) => format!("{}: {}", self.code, details),
            None => self.code.to_string(),
        }
    }
}

pub trait LedPacketSender: Send + Sync {
    fn send(&self, port_name: &str, packet: &[u8]) -> Result<(), LedOutputError>;
}

type PortFactory = dyn Fn(&str) -> Result<Box<dyn Write + Send>, LedOutputError> + Send + Sync;

struct SerialLedPacketSender {
    sessions: Mutex<HashMap<String, Box<dyn Write + Send>>>,
    port_factory: Arc<PortFactory>,
}

impl SerialLedPacketSender {
    fn new(port_factory: Arc<PortFactory>) -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            port_factory,
        }
    }

    #[cfg(test)]
    fn with_port_factory_for_tests<F>(factory: F) -> Self
    where
        F: Fn(&str) -> Result<Box<dyn Write + Send>, LedOutputError> + Send + Sync + 'static,
    {
        Self::new(Arc::new(factory))
    }
}

impl Default for SerialLedPacketSender {
    fn default() -> Self {
        Self::new(Arc::new(|port_name: &str| {
            serialport::new(port_name, OUTPUT_BAUD_RATE)
                .timeout(Duration::from_millis(OUTPUT_TIMEOUT_MS))
                .open()
                .map(|port| port as Box<dyn Write + Send>)
                .map_err(|error| {
                    LedOutputError::new("LED_OUTPUT_PORT_OPEN_FAILED", Some(error.to_string()))
                })
        }))
    }
}

impl LedPacketSender for SerialLedPacketSender {
    fn send(&self, port_name: &str, packet: &[u8]) -> Result<(), LedOutputError> {
        let mut sessions = self.sessions.lock().map_err(|error| {
            LedOutputError::new("LED_OUTPUT_SESSION_LOCK_FAILED", Some(error.to_string()))
        })?;

        if !sessions.contains_key(port_name) {
            let opened = (self.port_factory)(port_name)?;
            sessions.insert(port_name.to_string(), opened);
        }

        let Some(port) = sessions.get_mut(port_name) else {
            return Err(LedOutputError::new(
                "LED_OUTPUT_PORT_UNAVAILABLE",
                Some("Port session could not be created for output write.".to_string()),
            ));
        };

        let write_result = port.write_all(packet).map_err(|error| {
            LedOutputError::new("LED_OUTPUT_WRITE_FAILED", Some(error.to_string()))
        });
        let flush_result = if write_result.is_ok() {
            port.flush().map_err(|error| {
                LedOutputError::new("LED_OUTPUT_FLUSH_FAILED", Some(error.to_string()))
            })
        } else {
            Ok(())
        };
        let result = write_result.and(flush_result);

        if result.is_err() {
            sessions.remove(port_name);
        }

        result
    }
}

#[derive(Clone)]
pub struct LedOutputBridge {
    sender: Arc<dyn LedPacketSender>,
}

impl LedOutputBridge {
    pub fn new() -> Self {
        Self {
            sender: Arc::new(SerialLedPacketSender::default()),
        }
    }

    #[cfg(test)]
    pub fn from_sender(sender: Arc<dyn LedPacketSender>) -> Self {
        Self { sender }
    }

    #[cfg(test)]
    pub fn send_packet(
        &self,
        connection_state: &SerialConnectionState,
        packet: &[u8],
    ) -> Result<(), LedOutputError> {
        let status = connection_state
            .last_status
            .lock()
            .map_err(|error| {
                LedOutputError::new(
                    "LED_OUTPUT_CONNECTION_STATE_LOCK_FAILED",
                    Some(error.to_string()),
                )
            })?
            .clone();

        if !status.connected {
            return Err(LedOutputError::new(
                "LED_OUTPUT_DEVICE_NOT_CONNECTED",
                Some("Last known device state is disconnected.".to_string()),
            ));
        }

        let port_name = status.port_name.ok_or_else(|| {
            LedOutputError::new(
                "LED_OUTPUT_PORT_UNAVAILABLE",
                Some("No connected serial port is recorded in connection state.".to_string()),
            )
        })?;

        self.send_packet_to_port(&port_name, packet)
    }

    pub fn send_packet_to_port(
        &self,
        port_name: &str,
        packet: &[u8],
    ) -> Result<(), LedOutputError> {
        self.sender.send(port_name, packet)
    }
}

impl Default for LedOutputBridge {
    fn default() -> Self {
        Self::new()
    }
}

pub fn encode_led_packet(brightness: f32, rgb_triplets: &[[u8; 3]]) -> Vec<u8> {
    let clamped_brightness = (brightness.clamp(0.0, 1.0) * 255.0).floor() as u8;
    let led_count = u16::try_from(rgb_triplets.len()).unwrap_or(u16::MAX);

    let mut packet = Vec::with_capacity(2 + 1 + 2 + (rgb_triplets.len() * 3) + 1);
    packet.push(0xAA);
    packet.push(0x55);
    packet.push(clamped_brightness);
    packet.extend_from_slice(&led_count.to_le_bytes());

    for rgb in rgb_triplets {
        packet.extend_from_slice(rgb);
    }

    let checksum = packet.iter().fold(0_u8, |acc, byte| acc ^ byte);
    packet.push(checksum);
    packet
}

#[cfg(test)]
pub fn apply_solid_payload(
    bridge: &LedOutputBridge,
    connection_state: &SerialConnectionState,
    r: u8,
    g: u8,
    b: u8,
    brightness: f32,
) -> Result<(), LedOutputError> {
    let packet = encode_led_packet(brightness, &[[r, g, b]]);
    bridge.send_packet(connection_state, &packet)
}

pub fn apply_solid_payload_to_port(
    bridge: &LedOutputBridge,
    port_name: &str,
    r: u8,
    g: u8,
    b: u8,
    brightness: f32,
) -> Result<(), LedOutputError> {
    let packet = encode_led_packet(brightness, &[[r, g, b]]);
    bridge.send_packet_to_port(port_name, &packet)
}

#[cfg(test)]
pub fn send_ambilight_frame(
    bridge: &LedOutputBridge,
    connection_state: &SerialConnectionState,
    frame: &[[u8; 3]],
    brightness: f32,
) -> Result<(), LedOutputError> {
    let packet = encode_led_packet(brightness, frame);
    bridge.send_packet(connection_state, &packet)
}

pub fn send_ambilight_frame_to_port(
    bridge: &LedOutputBridge,
    port_name: &str,
    frame: &[[u8; 3]],
    brightness: f32,
) -> Result<(), LedOutputError> {
    let packet = encode_led_packet(brightness, frame);
    bridge.send_packet_to_port(port_name, &packet)
}

pub fn send_ambilight_frame_hot_path_to_port(
    bridge: &LedOutputBridge,
    port_name: &str,
    frame: &[[u8; 3]],
    brightness: f32,
) -> Result<(), LedOutputError> {
    send_ambilight_frame_to_port(bridge, port_name, frame, brightness)
}

#[cfg(test)]
mod tests {
    use std::io::Write;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};

    use super::{
        apply_solid_payload, encode_led_packet, send_ambilight_frame, LedOutputBridge,
        LedOutputError, LedPacketSender,
    };
    use crate::commands::device_connection::{
        CommandStatus, SerialConnectionState, SerialConnectionStatus,
    };

    #[derive(Default)]
    struct FakeSender {
        writes: Mutex<Vec<(String, Vec<u8>)>>,
        fail_with: Option<&'static str>,
    }

    #[derive(Default)]
    struct FakePort {
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
        fn successful() -> Self {
            Self::default()
        }

        fn failing(code: &'static str) -> Self {
            Self {
                writes: Mutex::new(Vec::new()),
                fail_with: Some(code),
            }
        }

        fn writes(&self) -> Vec<(String, Vec<u8>)> {
            self.writes.lock().expect("writes lock poisoned").clone()
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
    }

    fn connected_state(port_name: &str) -> SerialConnectionState {
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
            }),
        }
    }

    #[test]
    fn solid_payload_encodes_to_deterministic_packet() {
        let packet = encode_led_packet(0.5, &[[255, 0, 128]]);

        assert_eq!(packet, vec![0xAA, 0x55, 127, 1, 0, 255, 0, 128, 254]);
    }

    #[test]
    fn bridge_uses_connected_port_and_returns_coded_write_error() {
        let success_sender = Arc::new(FakeSender::successful());
        let success_bridge = LedOutputBridge::from_sender(success_sender.clone());
        let state = connected_state("COM9");

        let success = apply_solid_payload(&success_bridge, &state, 1, 2, 3, 1.0);
        assert!(success.is_ok());
        let writes = success_sender.writes();
        assert_eq!(writes.len(), 1);
        assert_eq!(writes[0].0, "COM9");

        let failing_sender = Arc::new(FakeSender::failing("LED_OUTPUT_WRITE_FAILED"));
        let failing_bridge = LedOutputBridge::from_sender(failing_sender);
        let error = apply_solid_payload(&failing_bridge, &state, 1, 2, 3, 1.0)
            .expect_err("write failure should bubble up");
        assert_eq!(error.code, "LED_OUTPUT_WRITE_FAILED");
    }

    #[test]
    fn ambilight_frame_uses_same_packet_rules_as_solid() {
        let sender = Arc::new(FakeSender::successful());
        let bridge = LedOutputBridge::from_sender(sender.clone());
        let state = connected_state("COM7");

        let frame = [[10, 20, 30], [5, 15, 25]];
        send_ambilight_frame(&bridge, &state, &frame, 0.25).expect("frame send should succeed");

        let writes = sender.writes();
        assert_eq!(writes.len(), 1);

        let expected = encode_led_packet(0.25, &frame);
        assert_eq!(writes[0].1, expected);
    }

    #[test]
    fn serial_sender_reuses_open_port_for_repeated_hot_path_writes() {
        let open_count = Arc::new(AtomicUsize::new(0));
        let open_count_for_factory = Arc::clone(&open_count);
        let sender = super::SerialLedPacketSender::with_port_factory_for_tests(move |_port_name| {
            open_count_for_factory.fetch_add(1, Ordering::SeqCst);
            Ok(Box::new(FakePort::default()))
        });

        sender
            .send("COM42", &[1, 2, 3])
            .expect("first write should succeed");
        sender
            .send("COM42", &[4, 5, 6])
            .expect("second write should reuse open session");

        assert_eq!(open_count.load(Ordering::SeqCst), 1);
    }
}
