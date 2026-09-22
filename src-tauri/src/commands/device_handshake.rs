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
//! ## Reading the response
//!
//! The reply is read frame-aware: bytes before the magic are skipped, the
//! opcode fixes the frame length, and the round-trip returns the moment a
//! complete valid PONG is buffered rather than waiting out the timeout.
//!
//! No companion firmware ships yet; the PONG path is exercised by mock ports.

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
    /// Returns as soon as any bytes arrive, which may be fewer than
    /// `buf.len()`; `Ok(0)` means nothing arrived within `timeout`. The caller
    /// reassembles frames across calls, so waiting to fill `buf` only adds
    /// latency.
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
        // Return on the first non-empty read: the caller's frame reader decides
        // when a response is complete. Waiting to fill `buf` held every health
        // check for the full timeout, since a PONG is shorter than the buffer.
        let deadline = Instant::now() + timeout;

        while Instant::now() < deadline {
            match self.inner.read(buf) {
                Ok(n) => return Ok(n),
                Err(ref e) if e.kind() == std::io::ErrorKind::TimedOut => {}
                Err(e) => return Err(e),
            }
        }

        Ok(0)
    }
}

// ---------------------------------------------------------------------------
// ResponseReader — resynchronising frame accumulator
// ---------------------------------------------------------------------------

/// Length of a PONG frame on the wire.
const PONG_FRAME_LEN: usize = 7;

/// What the buffered bytes hold at the next magic boundary.
#[derive(Debug, PartialEq, Eq)]
enum Candidate {
    /// Not enough bytes yet to know or complete the frame.
    Pending,
    /// A complete frame of this many bytes starts at the front of the buffer.
    Complete(usize),
    /// A magic prefix followed by an opcode this host does not expect.
    UnknownOpcode,
}

/// Total frame length (magic through checksum) of the response carrying
/// `opcode`, or `None` when the opcode is not an expected response.
///
/// A future length-prefixed response (`opcode, payload_len, payload, xor`)
/// would widen this to take the buffered header and read `payload_len`; the
/// resync and deadline logic in `ResponseReader` stays as it is.
fn response_frame_len(opcode: u8) -> Option<usize> {
    match opcode {
        HANDSHAKE_OPCODE_PONG => Some(PONG_FRAME_LEN),
        _ => None,
    }
}

/// Accumulates bytes across reads and yields frames aligned on `FRAME_MAGIC`.
#[derive(Default)]
struct ResponseReader {
    pending: Vec<u8>,
    /// Bytes were dropped because they did not start a frame.
    skipped_noise: bool,
}

impl ResponseReader {
    fn extend(&mut self, bytes: &[u8]) {
        self.pending.extend_from_slice(bytes);
    }

    fn pending(&self) -> &[u8] {
        &self.pending
    }

    /// Drop everything before the next magic prefix, then classify what follows.
    fn next_candidate(&mut self) -> Candidate {
        let start = self
            .pending
            .windows(FRAME_MAGIC.len())
            .position(|w| w == FRAME_MAGIC)
            .unwrap_or_else(|| {
                // Keep a trailing magic_hi: its magic_lo may be in the next read.
                if self.pending.last() == Some(&FRAME_MAGIC[0]) {
                    self.pending.len() - 1
                } else {
                    self.pending.len()
                }
            });
        if start > 0 {
            self.pending.drain(..start);
            self.skipped_noise = true;
        }

        let Some(&opcode) = self.pending.get(FRAME_MAGIC.len()) else {
            return Candidate::Pending;
        };
        match response_frame_len(opcode) {
            None => Candidate::UnknownOpcode,
            Some(len) if self.pending.len() >= len => Candidate::Complete(len),
            Some(_) => Candidate::Pending,
        }
    }

    /// Discard the frame at the front after it has been handled.
    fn consume(&mut self, len: usize) {
        self.pending.drain(..len.min(self.pending.len()));
    }

    /// Step past a rejected magic so a real frame starting inside it is found.
    fn skip_one(&mut self) {
        self.consume(1);
        self.skipped_noise = true;
    }

    /// The error to report when the deadline passes without a valid PONG.
    fn timeout_error(&self, last_rejection: Option<HandshakeError>) -> HandshakeError {
        if let Some(err) = last_rejection {
            return err;
        }
        let holds_partial_frame = self.pending.starts_with(&FRAME_MAGIC);
        if self.skipped_noise && !holds_partial_frame {
            HandshakeError::BadMagic
        } else {
            HandshakeError::TooShort
        }
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
/// Returns on the first valid PONG. A frame that fails validation is skipped
/// rather than fatal, because a real PONG may still follow it; its error is
/// what gets reported if the deadline passes first.
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
    let deadline = start + timeout;
    let mut reader = ResponseReader::default();
    let mut last_rejection: Option<HandshakeError> = None;
    let mut chunk = [0u8; 16];

    loop {
        loop {
            match reader.next_candidate() {
                Candidate::Pending => break,
                Candidate::UnknownOpcode => {
                    last_rejection = Some(HandshakeError::WrongOpcode);
                    reader.skip_one();
                }
                Candidate::Complete(len) => match decode_handshake_pong(&reader.pending()[..len]) {
                    Ok(response) => {
                        let elapsed_ms = start.elapsed().as_millis().min(u32::MAX as u128) as u32;
                        return Ok((response, elapsed_ms));
                    }
                    Err(err) => {
                        last_rejection = Some(err);
                        reader.skip_one();
                    }
                },
            }
        }

        let now = Instant::now();
        if now >= deadline {
            return Err(reader.timeout_error(last_rejection));
        }
        let n = port
            .read_with_timeout(&mut chunk, deadline - now)
            .map_err(|_| HandshakeError::TooShort)?;
        reader.extend(&chunk[..n]);
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;
    use std::io::{Read, Write};

    // -----------------------------------------------------------------------
    // MockPort — deterministic scripted responses for unit tests
    //
    // Implements `SerialRoundTrip` using an in-memory byte queue. The test
    // controls exactly what bytes the "port" returns on each read call.
    // `write_all` appends to a capture buffer so tests can assert on outgoing
    // bytes too. No real I/O or timing machinery is involved.
    // -----------------------------------------------------------------------

    struct MockPort {
        /// One entry per `read_with_timeout` call, drained in order.
        reads: VecDeque<Vec<u8>>,
        /// Captures every byte written by `write_all`.
        written: Vec<u8>,
    }

    impl MockPort {
        /// Port that returns `response` bytes when read.
        fn with_response(response: Vec<u8>) -> Self {
            Self::with_chunks(vec![response])
        }

        /// Port that delivers each chunk on a separate read.
        fn with_chunks(chunks: Vec<Vec<u8>>) -> Self {
            Self {
                reads: VecDeque::from(chunks),
                written: Vec::new(),
            }
        }

        /// Port that returns no bytes — simulates a device that never replies.
        fn silent() -> Self {
            Self::with_chunks(Vec::new())
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
            let Some(mut chunk) = self.reads.pop_front() else {
                return Ok(0);
            };
            let n = chunk.len().min(buf.len());
            buf[..n].copy_from_slice(&chunk[..n]);
            if n < chunk.len() {
                self.reads.push_front(chunk.split_off(n));
            }
            Ok(n)
        }
    }

    // -----------------------------------------------------------------------
    // ScriptedSerial — a `Read + Write` port on the real clock, for driving
    // `TimedSerialPort`. Each chunk becomes readable `ready_after` the PING is
    // written; until then a read blocks for one poll interval and reports
    // `TimedOut`, the way a serialport handle with a short timeout does.
    // -----------------------------------------------------------------------

    const SCRIPTED_POLL: Duration = Duration::from_millis(5);

    struct ScriptedSerial {
        script: VecDeque<(Duration, Vec<u8>)>,
        written_at: Option<Instant>,
    }

    impl ScriptedSerial {
        fn new(script: Vec<(Duration, Vec<u8>)>) -> Self {
            Self {
                script: VecDeque::from(script),
                written_at: None,
            }
        }
    }

    impl Write for ScriptedSerial {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.written_at.get_or_insert_with(Instant::now);
            Ok(bytes.len())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    impl Read for ScriptedSerial {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            let ready = match (self.written_at, self.script.front()) {
                (Some(at), Some((after, _))) => at.elapsed() >= *after,
                _ => false,
            };
            if !ready {
                std::thread::sleep(SCRIPTED_POLL);
                return Err(std::io::ErrorKind::TimedOut.into());
            }
            let (after, mut chunk) = self.script.pop_front().expect("checked above");
            let n = chunk.len().min(buf.len());
            buf[..n].copy_from_slice(&chunk[..n]);
            if n < chunk.len() {
                self.script.push_front((after, chunk.split_off(n)));
            }
            Ok(n)
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

        let err = perform_handshake(&mut port, Duration::from_millis(100))
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
    // Frame-aware reading: return on a complete PONG, resync past noise
    // -----------------------------------------------------------------------

    fn pong_v1() -> Vec<u8> {
        build_valid_pong(0x0104, PROFILE_BYTE_LUMASYNC_V1)
    }

    #[test]
    fn perform_handshake_reassembles_pong_split_across_reads() {
        let pong = pong_v1();
        let mut port = MockPort::with_chunks(vec![
            pong[..1].to_vec(),
            pong[1..4].to_vec(),
            Vec::new(),
            pong[4..].to_vec(),
        ]);

        let (response, _) = perform_handshake(&mut port, Duration::from_millis(1_000))
            .expect("split PONG should reassemble");
        assert_eq!(response.firmware_version, 0x0104);
    }

    #[test]
    fn perform_handshake_skips_leading_garbage_before_magic() {
        let mut noise = b"Ada\n".to_vec();
        noise.extend_from_slice(&[0x00, 0xAA]);
        let pong = pong_v1();
        // The trailing 0xAA is a false start; the real magic follows it.
        let mut port = MockPort::with_chunks(vec![noise, pong[..2].to_vec(), pong[2..].to_vec()]);

        let (response, _) = perform_handshake(&mut port, Duration::from_millis(1_000))
            .expect("PONG after noise should be found");
        assert_eq!(response.firmware_profile, FirmwareProfile::LumaSyncV1);
    }

    #[test]
    fn perform_handshake_resyncs_past_a_false_magic_with_unknown_opcode() {
        let mut bytes = vec![0xAA, 0x55, 0xFF];
        bytes.extend(pong_v1());
        let mut port = MockPort::with_response(bytes);

        let (response, _) = perform_handshake(&mut port, Duration::from_millis(1_000))
            .expect("real PONG after a false magic should be found");
        assert_eq!(response.firmware_version, 0x0104);
    }

    #[test]
    fn perform_handshake_with_truncated_pong_times_out_as_too_short() {
        let pong = pong_v1();
        let mut port = MockPort::with_response(pong[..5].to_vec());

        let err = perform_handshake(&mut port, Duration::from_millis(100))
            .expect_err("truncated PONG must not succeed");
        assert_eq!(err, HandshakeError::TooShort);
    }

    #[test]
    fn perform_handshake_reports_bad_checksum_when_no_valid_pong_follows() {
        let mut pong = pong_v1();
        pong[6] ^= 0x01;
        let mut port = MockPort::with_response(pong);

        let err = perform_handshake(&mut port, Duration::from_millis(100))
            .expect_err("corrupt PONG must not succeed");
        assert_eq!(err, HandshakeError::BadChecksum);
    }

    #[test]
    fn perform_handshake_reports_wrong_opcode_for_an_unknown_response() {
        let mut port = MockPort::with_response(vec![0xAA, 0x55, 0x42, 0x00, 0x00, 0x00, 0x00]);

        let err = perform_handshake(&mut port, Duration::from_millis(100))
            .expect_err("unknown opcode must not succeed");
        assert_eq!(err, HandshakeError::WrongOpcode);
    }

    // Timing is asserted through `TimedSerialPort` over a real-clock port,
    // because that is the layer that used to wait for a full 16-byte buffer.
    const REAL_TIMEOUT: Duration = Duration::from_millis(1_500);
    const PROMPT_BOUND: Duration = Duration::from_millis(500);

    #[test]
    fn timed_port_returns_as_soon_as_a_one_chunk_pong_arrives() {
        let reply_after = Duration::from_millis(40);
        let mut port = TimedSerialPort::new(ScriptedSerial::new(vec![(reply_after, pong_v1())]));

        let started = Instant::now();
        let (response, round_trip_ms) =
            perform_handshake(&mut port, REAL_TIMEOUT).expect("PONG should be read");
        let wall = started.elapsed();

        assert_eq!(response.firmware_version, 0x0104);
        assert!(
            wall < PROMPT_BOUND,
            "handshake took {wall:?}; it must not wait out the {REAL_TIMEOUT:?} timeout"
        );
        assert!(
            u128::from(round_trip_ms) >= reply_after.as_millis()
                && u128::from(round_trip_ms) < PROMPT_BOUND.as_millis(),
            "roundTripMs {round_trip_ms} must reflect the ~40 ms reply, not the timeout"
        );
    }

    #[test]
    fn timed_port_reassembles_a_pong_split_across_delayed_chunks() {
        let pong = pong_v1();
        let mut port = TimedSerialPort::new(ScriptedSerial::new(vec![
            (Duration::from_millis(10), vec![0x00, 0xAA]),
            (Duration::from_millis(20), pong[..3].to_vec()),
            (Duration::from_millis(30), pong[3..].to_vec()),
        ]));

        let started = Instant::now();
        let (response, round_trip_ms) =
            perform_handshake(&mut port, REAL_TIMEOUT).expect("split PONG should be read");

        assert_eq!(response.firmware_profile, FirmwareProfile::LumaSyncV1);
        assert!(started.elapsed() < PROMPT_BOUND);
        assert!(
            round_trip_ms >= 30,
            "roundTripMs {round_trip_ms} ends at the last chunk"
        );
    }

    #[test]
    fn timed_port_with_no_reply_times_out_after_the_deadline() {
        let timeout = Duration::from_millis(150);
        let mut port = TimedSerialPort::new(ScriptedSerial::new(Vec::new()));

        let started = Instant::now();
        let err = perform_handshake(&mut port, timeout).expect_err("silence must fail");

        assert_eq!(err, HandshakeError::TooShort);
        assert!(started.elapsed() >= timeout);
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
