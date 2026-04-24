//! # LumaSync v1 Serial Handshake Protocol
//!
//! Implements the PING → PONG round-trip for the LumaSync v1 native serial
//! protocol. The handshake serves two purposes:
//!
//! 1. **Liveness probe** — confirms a responding LumaSync firmware is present on
//!    the other end of the cable (not just any USB-serial device).
//! 2. **Profile advertisement** — the PONG frame carries the firmware's
//!    self-reported profile byte so the host can validate that the device matches
//!    the user-selected `FirmwareProfile`.
//!
//! ## Frame format
//!
//! Both frames share the LumaSync v1 magic prefix (`0xAA 0x55`) followed by a
//! one-byte opcode, a variable payload, and a trailing XOR checksum.
//!
//! ### PING (host → device)
//!
//! ```text
//! Offset  Width  Field
//! 0       1      magic_hi      = 0xAA
//! 1       1      magic_lo      = 0x55
//! 2       1      opcode        = 0x10  (HANDSHAKE_OPCODE_PING)
//! 3       1      payload_len   = 0x00  (no payload in v1)
//! 4       1      xor_checksum  = XOR of bytes [0..4)
//! ```
//!
//! Total: 5 bytes.
//!
//! ### PONG (device → host)
//!
//! ```text
//! Offset  Width  Field
//! 0       1      magic_hi          = 0xAA
//! 1       1      magic_lo          = 0x55
//! 2       1      opcode            = 0x11  (HANDSHAKE_OPCODE_PONG)
//! 3       2      firmware_version  little-endian u16 (e.g. 0x0104 = v1.4)
//! 5       1      firmware_profile  0x01 = LumaSyncV1, 0x02 = Adalight
//! 6       1      xor_checksum      = XOR of bytes [0..6)
//! ```
//!
//! Total: 7 bytes.
//!
//! ## Firmware companion (v1.5)
//!
//! Real firmware integration is deferred to v1.5. The current Rust implementation
//! is complete and tested using mock PONG responses. When the firmware companion
//! repository is opened, integration tests will drive a real Arduino via a CI
//! self-hosted runner with a USB loopback fixture.

use std::io::{Read, Write};
use std::time::{Duration, Instant};

use super::led_output::FirmwareProfile;

// ---------------------------------------------------------------------------
// Opcode constants
// ---------------------------------------------------------------------------

/// Opcode sent by the host to request a handshake PONG from firmware.
pub const HANDSHAKE_OPCODE_PING: u8 = 0x10;

/// Opcode the firmware returns in its handshake response.
pub const HANDSHAKE_OPCODE_PONG: u8 = 0x11;

/// LumaSync v1 frame magic prefix (shared with the LED data frames).
pub const FRAME_MAGIC: [u8; 2] = [0xAA, 0x55];

// ---------------------------------------------------------------------------
// Firmware profile wire byte mapping
// ---------------------------------------------------------------------------

/// Wire byte for `FirmwareProfile::LumaSyncV1` in a PONG frame.
const PROFILE_BYTE_LUMASYNC_V1: u8 = 0x01;

/// Wire byte for `FirmwareProfile::Adalight` in a PONG frame.
const PROFILE_BYTE_ADALIGHT: u8 = 0x02;

// ---------------------------------------------------------------------------
// Parsed PONG response
// ---------------------------------------------------------------------------

/// Parsed fields extracted from a valid PONG frame.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HandshakePongResponse {
    /// Firmware version as a raw little-endian u16.
    ///
    /// Encoding: `(major << 8) | minor`. For example, v1.4 → `0x0104`.
    pub firmware_version: u16,
    /// Firmware profile advertised by the device.
    pub firmware_profile: FirmwareProfile,
}

impl HandshakePongResponse {
    /// Format firmware_version as a human-readable string, e.g. `"1.4"`.
    pub fn version_string(&self) -> String {
        let major = (self.firmware_version >> 8) as u8;
        let minor = (self.firmware_version & 0xFF) as u8;
        format!("{}.{}", major, minor)
    }
}

// ---------------------------------------------------------------------------
// Handshake error
// ---------------------------------------------------------------------------

/// Errors produced by the PONG frame decoder or the round-trip helper.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum HandshakeError {
    /// The two-byte magic prefix was not `0xAA 0x55`.
    BadMagic,
    /// The opcode byte was not `HANDSHAKE_OPCODE_PONG`.
    WrongOpcode,
    /// The trailing XOR checksum did not match.
    BadChecksum,
    /// The frame was shorter than the minimum valid PONG length (7 bytes),
    /// or no bytes were received within the timeout window.
    TooShort,
    /// The profile byte did not map to a known `FirmwareProfile`.
    UnknownProfile,
}

impl HandshakeError {
    /// Machine-readable status code consistent with the project's coded-error
    /// convention. The caller maps these to `SerialHealthCode` values.
    pub fn as_status_code(&self) -> &'static str {
        match self {
            Self::BadMagic | Self::WrongOpcode | Self::BadChecksum | Self::UnknownProfile => {
                "SERIAL_HEALTH_PROTOCOL_ERROR"
            }
            Self::TooShort => "SERIAL_HEALTH_HANDSHAKE_TIMEOUT",
        }
    }
}

// ---------------------------------------------------------------------------
// PING frame builder
// ---------------------------------------------------------------------------

/// Encode a PING frame.
///
/// The v1 PING carries no payload — it is a 5-byte probe that asks the
/// firmware to respond with a PONG carrying its version and profile.
///
/// ```text
/// AA 55 10 00 <xor>
/// ```
pub fn encode_handshake_ping() -> Vec<u8> {
    let mut frame: Vec<u8> = Vec::with_capacity(5);
    frame.push(FRAME_MAGIC[0]); // 0xAA
    frame.push(FRAME_MAGIC[1]); // 0x55
    frame.push(HANDSHAKE_OPCODE_PING); // 0x10
    frame.push(0x00); // payload_len = 0

    // XOR over the first 4 bytes
    let checksum = frame.iter().fold(0_u8, |acc, b| acc ^ b);
    frame.push(checksum);

    frame
}

// ---------------------------------------------------------------------------
// PONG frame decoder
// ---------------------------------------------------------------------------

/// Decode a PONG frame, returning the parsed response or a typed error.
///
/// Expected layout (7 bytes):
/// ```text
/// AA 55 11 <fw_ver_lo> <fw_ver_hi> <profile_byte> <xor_checksum>
/// ```
///
/// The `firmware_version` is stored little-endian (lo byte first), so
/// `bytes[3]` is the minor version and `bytes[4]` is the major version in the
/// wire order used by most Arduino firmware linkers. The host interprets the
/// u16 as `(major << 8) | minor`.
pub fn decode_handshake_pong(bytes: &[u8]) -> Result<HandshakePongResponse, HandshakeError> {
    // Minimum frame: AA 55 11 <ver_lo> <ver_hi> <profile> <xor> = 7 bytes
    if bytes.len() < 7 {
        return Err(HandshakeError::TooShort);
    }

    // Magic check
    if bytes[0] != FRAME_MAGIC[0] || bytes[1] != FRAME_MAGIC[1] {
        return Err(HandshakeError::BadMagic);
    }

    // Opcode check
    if bytes[2] != HANDSHAKE_OPCODE_PONG {
        return Err(HandshakeError::WrongOpcode);
    }

    // XOR checksum — covers bytes [0..6), expected in bytes[6]
    let expected_checksum = bytes[..6].iter().fold(0_u8, |acc, b| acc ^ b);
    if bytes[6] != expected_checksum {
        return Err(HandshakeError::BadChecksum);
    }

    // Firmware version: little-endian u16 at bytes[3..5]
    let firmware_version = u16::from_le_bytes([bytes[3], bytes[4]]);

    // Profile byte
    let firmware_profile = match bytes[5] {
        PROFILE_BYTE_LUMASYNC_V1 => FirmwareProfile::LumaSyncV1,
        PROFILE_BYTE_ADALIGHT => FirmwareProfile::Adalight,
        _ => return Err(HandshakeError::UnknownProfile),
    };

    Ok(HandshakePongResponse {
        firmware_version,
        firmware_profile,
    })
}

// ---------------------------------------------------------------------------
// SerialRoundTrip — port abstraction for testability
// ---------------------------------------------------------------------------

/// Minimal I/O trait that abstracts over a real `serialport::SerialPort` and
/// a test-controlled `MockPort`. Only write and timed-read are needed for the
/// handshake; keeping the surface minimal avoids pulling in the full
/// `serialport` trait in unit tests.
pub trait SerialRoundTrip {
    /// Write all bytes to the port or return an I/O error.
    fn write_all(&mut self, bytes: &[u8]) -> std::io::Result<()>;

    /// Read bytes into `buf` with a wall-clock `timeout`.
    ///
    /// Returns the number of bytes read, or an I/O error on failure / timeout.
    /// Implementations may return fewer bytes than `buf.len()` if the timeout
    /// elapses; a return of `0` with `Ok(0)` is treated as TooShort by the
    /// caller.
    fn read_with_timeout(&mut self, buf: &mut [u8], timeout: Duration) -> std::io::Result<usize>;
}

/// Blanket implementation for any `Read + Write` value whose timeout can be
/// set via the `serialport` crate's `set_timeout` method.
///
/// For real ports obtained via `serialport::open`, call `port.set_timeout(…)`
/// before wrapping in this adapter, or use the `TimedSerialPort` helper below.
pub struct TimedSerialPort<P: Read + Write> {
    inner: P,
}

impl<P: Read + Write> TimedSerialPort<P> {
    pub fn new(inner: P) -> Self {
        Self { inner }
    }
}

impl<P: Read + Write> SerialRoundTrip for TimedSerialPort<P> {
    fn write_all(&mut self, bytes: &[u8]) -> std::io::Result<()> {
        self.inner.write_all(bytes)
    }

    fn read_with_timeout(&mut self, buf: &mut [u8], timeout: Duration) -> std::io::Result<usize> {
        // Poll in a tight loop until we accumulate at least 7 bytes (minimum
        // valid PONG) or the deadline passes. The underlying serial port should
        // already have its per-call timeout set to a short value so each
        // `read` call returns quickly even when no data is available.
        let deadline = Instant::now() + timeout;
        let mut total = 0usize;

        while Instant::now() < deadline && total < buf.len() {
            match self.inner.read(&mut buf[total..]) {
                Ok(0) => break,
                Ok(n) => total += n,
                Err(ref e) if e.kind() == std::io::ErrorKind::TimedOut => {
                    if Instant::now() >= deadline {
                        break;
                    }
                    // poll again
                }
                Err(e) => return Err(e),
            }
        }

        Ok(total)
    }
}

// ---------------------------------------------------------------------------
// perform_handshake — generic round-trip
// ---------------------------------------------------------------------------

/// Send a PING and wait for a PONG on the given port.
///
/// `timeout` governs the entire round-trip window. The function measures the
/// elapsed wall-clock time from the moment the PING is flushed and returns it
/// alongside the parsed `HandshakePongResponse` so the caller can populate
/// `SerialHealthReport.roundTripMs`.
///
/// # Errors
///
/// Returns a `HandshakeError` variant that maps directly to the appropriate
/// `SerialHealthCode` in `run_serial_health_check`.
pub fn perform_handshake<T: SerialRoundTrip>(
    port: &mut T,
    timeout: Duration,
) -> Result<(HandshakePongResponse, u32), HandshakeError> {
    let ping = encode_handshake_ping();

    port.write_all(&ping)
        .map_err(|_| HandshakeError::TooShort)?;

    let start = Instant::now();

    let mut buf = [0u8; 16];
    let n = port
        .read_with_timeout(&mut buf, timeout)
        .map_err(|_| HandshakeError::TooShort)?;

    let elapsed_ms = start.elapsed().as_millis().min(u32::MAX as u128) as u32;

    if n < 7 {
        return Err(HandshakeError::TooShort);
    }

    let response = decode_handshake_pong(&buf[..n])?;
    Ok((response, elapsed_ms))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;

    // -----------------------------------------------------------------------
    // MockPort — deterministic scripted responses for unit tests
    //
    // Implements `SerialRoundTrip` using an in-memory byte queue. The test
    // controls exactly what bytes the "port" returns on each read call.
    // `write_all` appends to a capture buffer so tests can assert on outgoing
    // bytes too. No real I/O or timing machinery is involved.
    // -----------------------------------------------------------------------

    struct MockPort {
        /// Bytes pre-loaded by the test that `read_with_timeout` will drain.
        read_queue: VecDeque<u8>,
        /// Captures every byte written by `write_all`.
        written: Vec<u8>,
        /// When `true`, `read_with_timeout` returns 0 bytes (simulates timeout).
        silent: bool,
    }

    impl MockPort {
        /// Port that returns `response` bytes when read.
        fn with_response(response: Vec<u8>) -> Self {
            Self {
                read_queue: VecDeque::from(response),
                written: Vec::new(),
                silent: false,
            }
        }

        /// Port that returns no bytes — simulates a device that never replies.
        fn silent() -> Self {
            Self {
                read_queue: VecDeque::new(),
                written: Vec::new(),
                silent: true,
            }
        }
    }

    impl SerialRoundTrip for MockPort {
        fn write_all(&mut self, bytes: &[u8]) -> std::io::Result<()> {
            self.written.extend_from_slice(bytes);
            Ok(())
        }

        fn read_with_timeout(
            &mut self,
            buf: &mut [u8],
            _timeout: Duration,
        ) -> std::io::Result<usize> {
            if self.silent {
                return Ok(0);
            }
            let mut count = 0usize;
            for slot in buf.iter_mut() {
                match self.read_queue.pop_front() {
                    Some(b) => {
                        *slot = b;
                        count += 1;
                    }
                    None => break,
                }
            }
            Ok(count)
        }
    }

    // -----------------------------------------------------------------------
    // Helper: build a syntactically valid PONG frame
    // -----------------------------------------------------------------------

    /// Build a correctly checksummed PONG frame for the given version and
    /// profile byte.
    fn build_valid_pong(fw_version: u16, profile_byte: u8) -> Vec<u8> {
        let ver_bytes = fw_version.to_le_bytes();
        let mut frame = vec![
            0xAA,
            0x55,
            HANDSHAKE_OPCODE_PONG,
            ver_bytes[0],
            ver_bytes[1],
            profile_byte,
        ];
        let checksum = frame.iter().fold(0_u8, |acc, b| acc ^ b);
        frame.push(checksum);
        frame
    }

    // -----------------------------------------------------------------------
    // Test 1: encode_handshake_ping — byte-exact output
    // -----------------------------------------------------------------------

    #[test]
    fn encode_ping_produces_byte_exact_frame() {
        let ping = encode_handshake_ping();

        // Fixed prefix: AA 55 10 00
        assert_eq!(ping[0], 0xAA, "magic_hi");
        assert_eq!(ping[1], 0x55, "magic_lo");
        assert_eq!(ping[2], HANDSHAKE_OPCODE_PING, "opcode");
        assert_eq!(ping[3], 0x00, "payload_len");

        // Checksum: 0xAA ^ 0x55 ^ 0x10 (payload_len 0x00 contributes nothing to XOR)
        let expected_checksum: u8 = 0xAA ^ 0x55 ^ 0x10;
        assert_eq!(ping[4], expected_checksum, "xor checksum");
        assert_eq!(ping.len(), 5, "PING must be exactly 5 bytes");
    }

    // -----------------------------------------------------------------------
    // Test 2: decode_handshake_pong — valid frame, LumaSyncV1 profile
    // -----------------------------------------------------------------------

    #[test]
    fn decode_valid_pong_lumasync_v1() {
        // v1.4: firmware_version = 0x0104 → lo=0x04, hi=0x01
        let pong = build_valid_pong(0x0104, PROFILE_BYTE_LUMASYNC_V1);
        let result = decode_handshake_pong(&pong).expect("valid PONG must parse");

        assert_eq!(result.firmware_version, 0x0104);
        assert_eq!(result.firmware_profile, FirmwareProfile::LumaSyncV1);
        assert_eq!(result.version_string(), "1.4");
    }

    // -----------------------------------------------------------------------
    // Test 3: decode_handshake_pong — bad magic
    // -----------------------------------------------------------------------

    #[test]
    fn decode_pong_bad_magic_returns_error() {
        let mut pong = build_valid_pong(0x0104, PROFILE_BYTE_LUMASYNC_V1);
        pong[0] = 0xFF; // corrupt magic_hi
                        // Re-compute checksum so we isolate the magic failure
        let checksum = pong[..6].iter().fold(0_u8, |acc, b| acc ^ b);
        pong[6] = checksum;

        assert_eq!(decode_handshake_pong(&pong), Err(HandshakeError::BadMagic));
    }

    // -----------------------------------------------------------------------
    // Test 4: decode_handshake_pong — bad checksum
    // -----------------------------------------------------------------------

    #[test]
    fn decode_pong_bad_checksum_returns_error() {
        let mut pong = build_valid_pong(0x0104, PROFILE_BYTE_LUMASYNC_V1);
        // Flip one bit in the checksum
        pong[6] ^= 0x01;

        assert_eq!(
            decode_handshake_pong(&pong),
            Err(HandshakeError::BadChecksum)
        );
    }

    // -----------------------------------------------------------------------
    // Test 5: decode_handshake_pong — too short
    // -----------------------------------------------------------------------

    #[test]
    fn decode_pong_too_short_returns_error() {
        let short = vec![0xAA, 0x55, HANDSHAKE_OPCODE_PONG]; // only 3 bytes
        assert_eq!(decode_handshake_pong(&short), Err(HandshakeError::TooShort));
    }

    // -----------------------------------------------------------------------
    // Test 5b: decode_handshake_pong — wrong opcode
    // -----------------------------------------------------------------------

    #[test]
    fn decode_pong_wrong_opcode_returns_error() {
        let mut pong = build_valid_pong(0x0104, PROFILE_BYTE_LUMASYNC_V1);
        pong[2] = 0xFF; // not HANDSHAKE_OPCODE_PONG
                        // Re-compute checksum
        let checksum = pong[..6].iter().fold(0_u8, |acc, b| acc ^ b);
        pong[6] = checksum;

        assert_eq!(
            decode_handshake_pong(&pong),
            Err(HandshakeError::WrongOpcode)
        );
    }

    // -----------------------------------------------------------------------
    // Test 6: perform_handshake — valid PONG via MockPort
    // -----------------------------------------------------------------------

    #[test]
    fn perform_handshake_with_valid_pong_returns_ok() {
        let pong = build_valid_pong(0x0104, PROFILE_BYTE_LUMASYNC_V1);
        let mut port = MockPort::with_response(pong);

        let (response, elapsed_ms) = perform_handshake(&mut port, Duration::from_millis(1_000))
            .expect("valid mock PONG should succeed");

        assert_eq!(response.firmware_version, 0x0104);
        assert_eq!(response.firmware_profile, FirmwareProfile::LumaSyncV1);
        // MockPort is synchronous; elapsed will be ~0 ms but must not panic
        let _ = elapsed_ms;

        // The PING must have been written
        assert_eq!(port.written, encode_handshake_ping());
    }

    // -----------------------------------------------------------------------
    // Test 7: perform_handshake — silent port → TooShort
    // -----------------------------------------------------------------------

    #[test]
    fn perform_handshake_with_silent_port_returns_too_short() {
        let mut port = MockPort::silent();
        let err = perform_handshake(&mut port, Duration::from_millis(100))
            .expect_err("silent port should fail");
        assert_eq!(err, HandshakeError::TooShort);
    }

    // -----------------------------------------------------------------------
    // Test 8: perform_handshake — garbled bytes → parse error
    // -----------------------------------------------------------------------

    #[test]
    fn perform_handshake_with_garbled_bytes_returns_parse_error() {
        let garbled = vec![0xDE, 0xAD, 0xBE, 0xEF, 0x11, 0x22, 0x33];
        let mut port = MockPort::with_response(garbled);

        let err = perform_handshake(&mut port, Duration::from_millis(1_000))
            .expect_err("garbled bytes should fail");

        // Bad magic is the first error caught
        assert_eq!(err, HandshakeError::BadMagic);
    }

    // -----------------------------------------------------------------------
    // Test 9: round-trip latency measurement — zero latency on mock port
    // -----------------------------------------------------------------------

    #[test]
    fn perform_handshake_elapsed_ms_is_non_negative() {
        let pong = build_valid_pong(0x0104, PROFILE_BYTE_ADALIGHT);
        let mut port = MockPort::with_response(pong);

        let (response, elapsed_ms) = perform_handshake(&mut port, Duration::from_millis(1_000))
            .expect("valid PONG should succeed");

        assert_eq!(response.firmware_profile, FirmwareProfile::Adalight);
        // elapsed_ms is u32; 0 is valid for in-memory mock
        assert!(elapsed_ms < 1_000, "mock elapsed should be well under 1 s");
    }

    // -----------------------------------------------------------------------
    // version_string formatting
    // -----------------------------------------------------------------------

    #[test]
    fn version_string_formats_correctly() {
        let resp = HandshakePongResponse {
            firmware_version: 0x0104,
            firmware_profile: FirmwareProfile::LumaSyncV1,
        };
        assert_eq!(resp.version_string(), "1.4");

        let resp2 = HandshakePongResponse {
            firmware_version: 0x0200,
            firmware_profile: FirmwareProfile::Adalight,
        };
        assert_eq!(resp2.version_string(), "2.0");
    }

    // -----------------------------------------------------------------------
    // HandshakeError::as_status_code mapping
    // -----------------------------------------------------------------------

    #[test]
    fn handshake_error_maps_to_correct_status_codes() {
        assert_eq!(
            HandshakeError::TooShort.as_status_code(),
            "SERIAL_HEALTH_HANDSHAKE_TIMEOUT"
        );
        assert_eq!(
            HandshakeError::BadMagic.as_status_code(),
            "SERIAL_HEALTH_PROTOCOL_ERROR"
        );
        assert_eq!(
            HandshakeError::WrongOpcode.as_status_code(),
            "SERIAL_HEALTH_PROTOCOL_ERROR"
        );
        assert_eq!(
            HandshakeError::BadChecksum.as_status_code(),
            "SERIAL_HEALTH_PROTOCOL_ERROR"
        );
        assert_eq!(
            HandshakeError::UnknownProfile.as_status_code(),
            "SERIAL_HEALTH_PROTOCOL_ERROR"
        );
    }
}
