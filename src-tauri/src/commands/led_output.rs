use std::collections::HashMap;
use std::io::Write;
use std::sync::{Arc, Mutex};
use std::time::Duration;

#[cfg(test)]
use super::device_connection::SerialConnectionState;

const OUTPUT_BAUD_RATE: u32 = 115_200;
const OUTPUT_TIMEOUT_MS: u64 = 500;

/// Per-channel gamma lookup tables for WS2812B LEDs.
///
/// Splits the previously unified `GAMMA_LUT` into three independent tables so
/// that each channel can be corrected with a different exponent. The default
/// tables use gamma 2.2 for all three channels, preserving the existing wire
/// behaviour until the user selects different values.
pub struct GammaLuts {
    pub r: [u8; 256],
    pub g: [u8; 256],
    pub b: [u8; 256],
}

/// Build three independent gamma LUTs from the supplied per-channel exponents.
/// Each entry: `round((i / 255)^gamma * 255)`.
pub fn build_gamma_luts(gamma_r: f32, gamma_g: f32, gamma_b: f32) -> GammaLuts {
    let mut r = [0u8; 256];
    let mut g = [0u8; 256];
    let mut b = [0u8; 256];
    for i in 0..=255usize {
        let v = i as f32 / 255.0_f32;
        r[i] = (v.powf(gamma_r) * 255.0_f32).round() as u8;
        g[i] = (v.powf(gamma_g) * 255.0_f32).round() as u8;
        b[i] = (v.powf(gamma_b) * 255.0_f32).round() as u8;
    }
    GammaLuts { r, g, b }
}

/// Default gamma 2.2 / 2.2 / 2.2 tables — identical to the old unified
/// `GAMMA_LUT`, kept as a static to avoid re-computing on every frame.
static DEFAULT_GAMMA_LUTS: std::sync::LazyLock<GammaLuts> =
    std::sync::LazyLock::new(|| build_gamma_luts(2.2, 2.2, 2.2));

/// Convert a colour temperature in Kelvin to per-channel RGB multipliers.
///
/// Uses the Tanner Helland curve-fit approximation, clamped to [0.0, 1.0] and
/// normalized so the maximum multiplier of each channel is 1.0.
///
/// 6500 K returns `[1.0, 1.0, 1.0]` (identity fast-path) so the default
/// configuration adds zero cost to the hot path.
///
/// The returned array is `[r_mul, g_mul, b_mul]`.
pub fn kelvin_to_rgb_multipliers(kelvin: u16) -> [f32; 3] {
    // Identity fast-path for the default 6500 K setting.
    if kelvin == 6500 {
        return [1.0_f32, 1.0_f32, 1.0_f32];
    }

    let temp = kelvin as f32 / 100.0_f32;

    // --- Red ---
    let r = if temp <= 66.0 {
        1.0_f32
    } else {
        let v = 329.698_727_446_f32 * (temp - 60.0_f32).powf(-0.133_204_759_2_f32);
        (v / 255.0_f32).clamp(0.0_f32, 1.0_f32)
    };

    // --- Green ---
    let g = if temp <= 66.0 {
        let v = 99.470_802_586_f32 * temp.ln() - 161.119_568_166_f32;
        (v / 255.0_f32).clamp(0.0_f32, 1.0_f32)
    } else {
        let v = 288.122_169_528_f32 * (temp - 60.0_f32).powf(-0.075_514_849_2_f32);
        (v / 255.0_f32).clamp(0.0_f32, 1.0_f32)
    };

    // --- Blue ---
    let b = if temp >= 66.0 {
        1.0_f32
    } else if temp <= 19.0 {
        0.0_f32
    } else {
        let v = 138.517_731_223_f32 * (temp - 10.0_f32).ln() - 305.044_792_730_f32;
        (v / 255.0_f32).clamp(0.0_f32, 1.0_f32)
    };

    [r, g, b]
}

/// Apply Kelvin white-balance multipliers to a single pixel.
///
/// `multipliers` must be pre-computed via `kelvin_to_rgb_multipliers`.
#[inline(always)]
pub fn apply_kelvin_to_pixel(rgb: [u8; 3], multipliers: &[f32; 3]) -> [u8; 3] {
    [
        (rgb[0] as f32 * multipliers[0]).round().clamp(0.0, 255.0) as u8,
        (rgb[1] as f32 * multipliers[1]).round().clamp(0.0, 255.0) as u8,
        (rgb[2] as f32 * multipliers[2]).round().clamp(0.0, 255.0) as u8,
    ]
}

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
    fn disconnect_session(&self, port_name: &str);
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

    fn disconnect_session(&self, port_name: &str) {
        if let Ok(mut sessions) = self.sessions.lock() {
            sessions.remove(port_name);
        }
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

    /// Drops the cached port handle for `port_name`.
    ///
    /// Must be called whenever the logical connection is terminated (disconnect
    /// command, health-check failure, lighting stop) so that the next connect
    /// attempt opens a fresh handle instead of reusing a stale one.
    pub fn disconnect_session(&self, port_name: &str) {
        self.sender.disconnect_session(port_name);
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
    encode_led_packet_with_kelvin(brightness, rgb_triplets, 6500)
}

/// Encode a LumaSync v1 packet with optional Kelvin white-balance applied
/// before gamma correction.
///
/// Wire format: `[0xAA 0x55] [brightness_u8] [led_count_u16_le] [R G B ...] [xor_checksum]`
pub fn encode_led_packet_with_kelvin(
    brightness: f32,
    rgb_triplets: &[[u8; 3]],
    kelvin: u16,
) -> Vec<u8> {
    let clamped_brightness = (brightness.clamp(0.0, 1.0) * 255.0).floor() as u8;
    let led_count = u16::try_from(rgb_triplets.len()).unwrap_or(u16::MAX);

    let mut packet = Vec::with_capacity(2 + 1 + 2 + (rgb_triplets.len() * 3) + 1);
    packet.push(0xAA);
    packet.push(0x55);
    packet.push(clamped_brightness);
    packet.extend_from_slice(&led_count.to_le_bytes());

    let luts = &*DEFAULT_GAMMA_LUTS;
    let kelvin_muls = kelvin_to_rgb_multipliers(kelvin);
    // Fast-path: if kelvin == 6500 the multipliers are all 1.0, skip the multiply.
    let identity = kelvin == 6500;

    for &pixel in rgb_triplets {
        let [r, g, b] = if identity {
            pixel
        } else {
            apply_kelvin_to_pixel(pixel, &kelvin_muls)
        };
        packet.extend_from_slice(&[luts.r[r as usize], luts.g[g as usize], luts.b[b as usize]]);
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

// ---------------------------------------------------------------------------
// SerialSink — `LedSink` implementation backed by `LedOutputBridge`
//
// Wraps the existing `LedOutputBridge` + `encode_led_packet` chain behind the
// `LedSink` trait so the worker loop can be written against the trait and
// future sinks (v1.5 WledUdpSink, v2.0 OpenRgbClientSink) drop in without
// touching the worker.
//
// Wire format is preserved exactly:
//   [0xAA 0x55] [brightness_u8] [led_count_u16_le] [R G B ...] [xor_checksum]
// Never change this silently — use a user-visible "Firmware profile" setting.
// ---------------------------------------------------------------------------

/// A `LedSink` implementation that encodes frames as LumaSync v1 packets and
/// writes them to a serial port via `LedOutputBridge`.
// v1.4 anchor: wired into the ambilight worker via the LedSink trait.
// Suppressed until the worker integration commit lands.
#[allow(dead_code)]
pub struct SerialSink {
    bridge: LedOutputBridge,
    port_name: Option<String>,
    brightness: f32,
}

impl SerialSink {
    /// Create a sink bound to the given port (or no-op when `port_name` is `None`).
    #[allow(dead_code)]
    pub fn new(bridge: LedOutputBridge, port_name: Option<String>, brightness: f32) -> Self {
        Self {
            bridge,
            port_name,
            brightness,
        }
    }

    /// Update brightness without stopping the sink. Called from the worker when
    /// the user changes brightness while ambilight is running.
    #[allow(dead_code)]
    pub fn set_brightness(&mut self, brightness: f32) {
        self.brightness = brightness.clamp(0.0, 1.0);
    }
}

impl super::led_sink::LedSink for SerialSink {
    fn name(&self) -> &'static str {
        "serial"
    }

    /// No-op: the underlying `SerialLedPacketSender` opens the port lazily on
    /// the first `send`. `start` is reserved for future sinks that need
    /// explicit connection setup (e.g. UDP socket bind for WLED).
    fn start(&mut self) -> Result<(), String> {
        Ok(())
    }

    /// Encode `colors` as a LumaSync v1 packet and write to the serial port.
    /// Returns `Err` if no port is configured or the write fails.
    fn send_frame(&mut self, colors: &[[u8; 3]]) -> Result<(), String> {
        let port = match &self.port_name {
            Some(p) => p.clone(),
            None => return Ok(()), // Hue-only mode — no serial port configured
        };
        send_ambilight_frame_hot_path_to_port(&self.bridge, &port, colors, self.brightness)
            .map_err(|e| e.as_reason())
    }

    /// Disconnect the cached serial port handle so the next `send_frame` opens
    /// a fresh connection. This mirrors the existing `stop_previous` behaviour.
    fn stop(&mut self) -> Result<(), String> {
        if let Some(ref port) = self.port_name {
            self.bridge.disconnect_session(port);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use std::io::Write;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};

    use super::{
        apply_kelvin_to_pixel, apply_solid_payload, build_gamma_luts, encode_led_packet,
        encode_led_packet_with_kelvin, kelvin_to_rgb_multipliers, send_ambilight_frame,
        LedOutputBridge, LedOutputError, LedPacketSender, SerialSink,
    };
    use crate::commands::device_connection::{
        CommandStatus, SerialConnectionState, SerialConnectionStatus,
    };
    use crate::commands::led_sink::LedSink;

    #[derive(Default)]
    struct FakeSender {
        writes: Mutex<Vec<(String, Vec<u8>)>>,
        fail_with: Option<&'static str>,
        disconnected: Mutex<Vec<String>>,
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
                disconnected: Mutex::new(Vec::new()),
            }
        }

        fn writes(&self) -> Vec<(String, Vec<u8>)> {
            self.writes.lock().expect("writes lock poisoned").clone()
        }

        fn disconnected_ports(&self) -> Vec<String> {
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
        // Gamma 2.2 is applied to RGB values: gamma(128) = 56, gamma(255) = 255, gamma(0) = 0.
        // Brightness byte (127) and packet structure are unchanged by gamma.
        let packet = encode_led_packet(0.5, &[[255, 0, 128]]);

        assert_eq!(packet, vec![0xAA, 0x55, 127, 1, 0, 255, 0, 56, 70]);
    }

    #[test]
    fn kelvin_6500_returns_identity_multipliers() {
        let muls = kelvin_to_rgb_multipliers(6500);
        assert_eq!(muls, [1.0_f32, 1.0_f32, 1.0_f32]);
    }

    #[test]
    fn kelvin_3200_produces_warm_tint() {
        // Warm temperature: R should be near 1.0, B should be below 0.7.
        let muls = kelvin_to_rgb_multipliers(3200);
        assert_eq!(muls[0], 1.0_f32, "R must be 1.0 below 6600 K");
        assert!(muls[2] < 0.7_f32, "B multiplier must be <0.7 at 3200 K, got {}", muls[2]);
    }

    #[test]
    fn kelvin_9000_produces_cool_tint() {
        // Cool temperature: B should be 1.0, R should be below 0.9.
        let muls = kelvin_to_rgb_multipliers(9000);
        assert_eq!(muls[2], 1.0_f32, "B must be 1.0 above 6600 K");
        assert!(muls[0] < 0.9_f32, "R multiplier must be <0.9 at 9000 K, got {}", muls[0]);
    }

    #[test]
    fn kelvin_6500_packet_is_byte_exact_with_default_encode() {
        // Kelvin 6500 must produce exactly the same bytes as `encode_led_packet`.
        let frame = &[[255_u8, 128, 64]];
        let default_packet = encode_led_packet(1.0, frame);
        let kelvin_packet = encode_led_packet_with_kelvin(1.0, frame, 6500);
        assert_eq!(default_packet, kelvin_packet, "6500 K must be a byte-exact identity");
    }

    #[test]
    fn kelvin_warm_tint_changes_blue_channel() {
        // At 2700 K the blue multiplier is well below 1.0. A pure white pixel
        // should result in a noticeably reduced blue byte.
        let muls = kelvin_to_rgb_multipliers(2700);
        let out = apply_kelvin_to_pixel([255, 255, 255], &muls);
        assert!(
            out[2] < 200,
            "Blue channel should be reduced at 2700 K, got {}",
            out[2]
        );
    }

    #[test]
    fn per_channel_gamma_luts_are_independent() {
        // R channel uses gamma 1.0 (linear), G/B use 2.2.
        // Changing R gamma must not affect G or B LUT values.
        let luts = build_gamma_luts(1.0, 2.2, 2.2);

        assert_eq!(luts.r[128], 128, "R gamma 1.0 must be linear (128→128)");
        assert_eq!(luts.g[128], 56, "G gamma 2.2 must match legacy value (128→56)");
        assert_eq!(luts.b[128], 56, "B gamma 2.2 must match legacy value (128→56)");

        assert_ne!(
            luts.r[128], luts.g[128],
            "R and G must differ when gammas differ"
        );
    }

    #[test]
    fn build_gamma_luts_222_matches_legacy_unified_lut() {
        let luts = build_gamma_luts(2.2, 2.2, 2.2);
        let legacy_spot_checks: &[(usize, u8)] = &[
            (0, 0),
            (1, 0),
            (10, 0),
            (64, 13),
            (128, 56),
            (200, 148),
            (254, 253),
            (255, 255),
        ];
        for &(idx, expected) in legacy_spot_checks {
            assert_eq!(
                luts.r[idx], expected,
                "R LUT mismatch at index {idx}: expected {expected}, got {}",
                luts.r[idx]
            );
            assert_eq!(
                luts.g[idx], expected,
                "G LUT mismatch at index {idx}: expected {expected}, got {}",
                luts.g[idx]
            );
            assert_eq!(
                luts.b[idx], expected,
                "B LUT mismatch at index {idx}: expected {expected}, got {}",
                luts.b[idx]
            );
        }
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

    #[test]
    fn disconnect_session_removes_cached_handle_and_forces_reopen() {
        let open_count = Arc::new(AtomicUsize::new(0));
        let open_count_for_factory = Arc::clone(&open_count);
        let sender = super::SerialLedPacketSender::with_port_factory_for_tests(move |_port_name| {
            open_count_for_factory.fetch_add(1, Ordering::SeqCst);
            Ok(Box::new(FakePort::default()))
        });

        sender
            .send("COM42", &[1, 2, 3])
            .expect("first write should open and succeed");
        assert_eq!(
            open_count.load(Ordering::SeqCst),
            1,
            "one open after first send"
        );

        sender.disconnect_session("COM42");

        sender
            .send("COM42", &[4, 5, 6])
            .expect("send after disconnect should reopen and succeed");
        assert_eq!(
            open_count.load(Ordering::SeqCst),
            2,
            "port must be reopened after disconnect_session"
        );
    }

    #[test]
    fn bridge_disconnect_session_delegates_to_sender() {
        let sender = Arc::new(FakeSender::successful());
        let bridge = LedOutputBridge::from_sender(sender.clone());

        bridge.disconnect_session("COM5");

        assert_eq!(
            sender.disconnected_ports(),
            vec!["COM5".to_string()],
            "bridge must forward disconnect_session to inner sender"
        );
    }

    // ---------------------------------------------------------------------------
    // SerialSink tests
    // ---------------------------------------------------------------------------

    #[test]
    fn serial_sink_send_frame_writes_encoded_packet() {
        let sender = Arc::new(FakeSender::successful());
        let bridge = LedOutputBridge::from_sender(sender.clone());
        let mut sink = SerialSink::new(bridge, Some("COM3".to_string()), 1.0);

        sink.start().expect("start should succeed");
        let frame = [[255_u8, 0, 0], [0, 255, 0]];
        sink.send_frame(&frame).expect("send_frame should succeed");

        let writes = sender.writes();
        assert_eq!(writes.len(), 1);
        assert_eq!(writes[0].0, "COM3");

        let expected = encode_led_packet(1.0, &frame);
        assert_eq!(writes[0].1, expected);
    }

    #[test]
    fn serial_sink_no_port_send_is_noop() {
        let sender = Arc::new(FakeSender::successful());
        let bridge = LedOutputBridge::from_sender(sender.clone());
        let mut sink = SerialSink::new(bridge, None, 1.0);

        sink.start().unwrap();
        sink.send_frame(&[[1, 2, 3]])
            .expect("no-port send should be a no-op");
        assert_eq!(sender.writes().len(), 0, "no writes expected without port");
    }

    #[test]
    fn serial_sink_stop_disconnects_session() {
        let sender = Arc::new(FakeSender::successful());
        let bridge = LedOutputBridge::from_sender(sender.clone());
        let mut sink = SerialSink::new(bridge, Some("COM8".to_string()), 0.8);

        sink.start().unwrap();
        sink.send_frame(&[[10, 20, 30]]).unwrap();
        sink.stop().expect("stop should succeed");

        assert!(
            sender.disconnected_ports().contains(&"COM8".to_string()),
            "stop must disconnect the serial session"
        );
    }

    #[test]
    fn serial_sink_implements_led_sink_trait_object() {
        let sender = Arc::new(FakeSender::successful());
        let bridge = LedOutputBridge::from_sender(sender.clone());
        let mut sink: Box<dyn LedSink> =
            Box::new(SerialSink::new(bridge, Some("COM1".to_string()), 1.0));

        assert_eq!(sink.name(), "serial");
        sink.start().unwrap();
        sink.send_frame(&[[50, 100, 150]]).unwrap();
        sink.stop().unwrap();
        assert_eq!(sender.writes().len(), 1);
    }
}
