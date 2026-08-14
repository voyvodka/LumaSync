//! `WledUdpSink` -- `LedSink` implementation for WLED over DDP or WLED's own
//! realtime UDP family (DRGB, promoted to DNRGB once a frame outgrows one
//! datagram).
//!
//! DDP packet layout (header = 10 bytes, then RGB payload):
//!  Byte 0:    flags     -- 0x40 (version=1), | 0x01 push, set on the LAST chunk only
//!  Byte 1:    sequence  -- incrementing u8, wraps at 255
//!  Byte 2:    type      -- 0x01  (RGBRGB... data)
//!  Byte 3:    data-type -- 0x01  (8-bit RGB)
//!  Bytes 4-7: offset    -- big-endian u32, a BYTE offset into the frame
//!  Bytes 8-9: length    -- big-endian u16, payload bytes in THIS datagram
//!  Bytes 10+: payload   -- R G B per LED in strip order
//!
//! WLED realtime UDP (<https://kno.wled.ge/interfaces/udp-realtime/>): byte 0
//! selects the protocol and byte 1 is the timeout in seconds. DRGB (byte 0 = 2)
//! carries `[R,G,B]` per LED from byte 2 and updates every LED from index 0;
//! DNRGB (byte 0 = 4) inserts a big-endian **LED index** at bytes 2-3 so a
//! frame can be split across datagrams.
//!
//! Both offsets are easy to confuse and are not the same unit: DDP's is a byte
//! offset, DNRGB's is an LED index.
use std::net::{Ipv4Addr, SocketAddrV4, UdpSocket};
use std::sync::atomic::{AtomicU8, Ordering};

use super::led_output::{
    apply_color_correction_rgb_with_luts, gamma_luts_for, ColorCorrectionConfig, GammaLuts,
};
use super::led_sink::LedSink;

const DDP_FLAGS_VERSION_1: u8 = 0x40;
const DDP_FLAG_PUSH: u8 = 0x01;
const DDP_TYPE: u8 = 0x01;
const DDP_DATA_TYPE: u8 = 0x01;
const DDP_HEADER_LEN: usize = 10;

/// Payload bytes per DDP datagram. A multiple of 3 so a chunk never splits a
/// pixel, and 1440 + 10 header + 8 UDP + 20 IP = 1478 stays inside a 1500-byte
/// MTU. Above it the datagram IP-fragments, which wired LAN usually survives
/// and Wi-Fi -- what most WLED boards are on -- does not.
const DDP_MAX_PAYLOAD_BYTES: usize = 1440;

const REALTIME_PROTO_DRGB: u8 = 2;
const REALTIME_PROTO_DNRGB: u8 = 4;

/// Seconds WLED waits after the last realtime packet before reverting to its
/// own effects. The pipeline sends at 20 Hz, so 2 s absorbs 40 missed frames of
/// Wi-Fi jitter while still releasing the strip promptly if the host dies. The
/// docs recommend 1-2; 255 would mean "never revert" and would leave a frozen
/// frame on the strip after a crash.
const REALTIME_TIMEOUT_SEC: u8 = 2;

/// Per-packet LED ceilings from the WLED realtime docs. DRGB spends 2 header
/// bytes, DNRGB 4 -- hence one LED fewer.
const DRGB_MAX_LEDS: usize = 490;
const DNRGB_MAX_LEDS_PER_PACKET: usize = 489;

/// DNRGB addresses its start LED with a big-endian u16, so no realtime frame
/// can reach past index 65535.
const DNRGB_MAX_ADDRESSABLE_LEDS: usize = u16::MAX as usize + 1;

/// On-wire protocol used by `WledUdpSink`.
///
/// WARLS is deliberately absent. It spends 4 bytes per LED to carry an index
/// for sparse updates this pipeline never sends -- 33% more bandwidth for a
/// capability nothing uses -- and caps at 255 LEDs. DNRGB is absent for the
/// opposite reason: it is not a user-visible choice but the promotion
/// `Drgb` takes automatically once a frame outgrows one datagram.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum WledProtocol {
    /// DDP (Distributed Display Protocol), WLED DDP input port 4048.
    #[default]
    Ddp,
    /// WLED realtime UDP on the notifier port (default 21324): DRGB, or DNRGB
    /// once the frame needs more than one datagram.
    Drgb,
}

pub struct WledUdpSink {
    ip: std::net::Ipv4Addr,
    port: u16,
    #[allow(dead_code)] // used for LED-count mismatch detection (v1.5 G1)
    led_count: u16,
    protocol: WledProtocol,
    socket: Option<UdpSocket>,
    endpoint: Option<SocketAddrV4>,
    sequence: AtomicU8,
}

impl WledUdpSink {
    /// Build a sink targeting `ip:port`. The UDP socket is not opened until `start()`.
    pub fn new(ip: std::net::Ipv4Addr, port: u16, led_count: u16, protocol: WledProtocol) -> Self {
        Self {
            ip,
            port,
            led_count,
            protocol,
            socket: None,
            endpoint: None,
            sequence: AtomicU8::new(0),
        }
    }
}

impl LedSink for WledUdpSink {
    fn name(&self) -> &'static str {
        "wled-udp"
    }

    fn start(&mut self) -> Result<(), String> {
        if self.socket.is_some() {
            return Ok(());
        }
        let socket = UdpSocket::bind("0.0.0.0:0")
            .map_err(|e| format!("WLED_SOCKET_BIND_FAILED: could not bind UDP socket -- {e}"))?;
        let endpoint = SocketAddrV4::new(self.ip, self.port);
        self.socket = Some(socket);
        self.endpoint = Some(endpoint);
        Ok(())
    }

    fn send_frame(&mut self, colors: &[[u8; 3]]) -> Result<(), String> {
        let (socket, endpoint) = match (&self.socket, &self.endpoint) {
            (Some(s), Some(e)) => (s, *e),
            _ => return Err("WLED_SINK_NOT_STARTED: send_frame called before start()".to_string()),
        };
        let datagrams = match self.protocol {
            WledProtocol::Ddp => encode_ddp_packets(colors, &self.sequence),
            WledProtocol::Drgb => encode_realtime_packets(colors)?,
        };
        // Stop at the first failed chunk: pushing the rest adds partial state
        // and still reports an error, and the next frame lands in 50 ms.
        let total = datagrams.len();
        for (index, packet) in datagrams.iter().enumerate() {
            socket.send_to(packet, endpoint).map_err(|e| {
                format!(
                    "WLED_SEND_FAILED: UDP send_to {endpoint} failed on chunk {}/{total} -- {e}",
                    index + 1
                )
            })?;
        }
        Ok(())
    }

    fn stop(&mut self) -> Result<(), String> {
        self.socket = None;
        self.endpoint = None;
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// WledSinkConfig — snapshot for rebuilding a fresh WledUdpSink on demand
// ---------------------------------------------------------------------------

/// Snapshot of the config needed to (re)build a `WledUdpSink`.
///
/// `SerialSink` is rebuilt fresh from `port_name` on every worker/Solid-write
/// start rather than kept alive across mode changes (see `ls-led-protocols`
/// — sinks are cheap, mostly-stateless per-frame constructs; only the
/// transient resource, a serial handle or a UDP socket, is short-lived).
/// `WledSinkConfig` gives the lighting runtime the same option for WLED:
/// `ActiveSinkRegistry` stores this alongside the live sink it validated at
/// connect time, so `lighting_mode.rs` can build a fresh `WledUdpSink` per
/// mode-change without sharing a live trait object across threads or
/// freezing the config to whatever was true at connect time.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct WledSinkConfig {
    pub ip: Ipv4Addr,
    pub port: u16,
    pub led_count: u16,
    pub protocol: WledProtocol,
}

impl WledSinkConfig {
    pub fn build(&self) -> WledUdpSink {
        WledUdpSink::new(self.ip, self.port, self.led_count, self.protocol)
    }
}

// ---------------------------------------------------------------------------
// CorrectedWledSink — LedSink adapter applying the shared correction pipeline
// ---------------------------------------------------------------------------

/// `LedSink` adapter that applies the shared gamma/Kelvin/saturation
/// correction pipeline, plus host-side brightness scaling, before forwarding
/// to a `WledUdpSink`.
///
/// `WledUdpSink` stays a pure DDP/DRGB transport with no correction concept,
/// unlike `SerialSink`, which folds correction AND a brightness byte into its
/// own `send_frame` (`encode_packet_for_profile`). WLED has no on-wire
/// brightness field — DDP/DRGB ship raw RGB and the firmware does not scale
/// it — so this adapter scales brightness into the RGB values host-side
/// before sending, mirroring the scaling the ambilight worker already
/// applies for the LED-twin preview buffer.
pub struct CorrectedWledSink {
    inner: WledUdpSink,
    corrections: ColorCorrectionConfig,
    luts: std::borrow::Cow<'static, GammaLuts>,
    brightness: f32,
}

impl CorrectedWledSink {
    /// Wrap a `WledUdpSink` with the shared correction pipeline, computing
    /// gamma LUTs once from `corrections`.
    pub fn new(inner: WledUdpSink, corrections: ColorCorrectionConfig) -> Self {
        let luts = gamma_luts_for(&corrections);
        Self {
            inner,
            corrections,
            luts,
            brightness: 1.0,
        }
    }

    /// Update brightness without stopping the sink. Mirrors
    /// `SerialSink::set_brightness` so the ambilight worker can treat both
    /// sink kinds uniformly.
    pub fn set_brightness(&mut self, brightness: f32) {
        self.brightness = brightness.clamp(0.0, 1.0);
    }
}

impl LedSink for CorrectedWledSink {
    fn name(&self) -> &'static str {
        "wled-udp"
    }

    fn start(&mut self) -> Result<(), String> {
        self.inner.start()
    }

    fn send_frame(&mut self, colors: &[[u8; 3]]) -> Result<(), String> {
        let brightness = self.brightness;
        let corrected: Vec<[u8; 3]> = colors
            .iter()
            .map(|&[r, g, b]| {
                let (cr, cg, cb) =
                    apply_color_correction_rgb_with_luts((r, g, b), &self.corrections, &self.luts);
                [
                    (cr as f32 * brightness).round().clamp(0.0, 255.0) as u8,
                    (cg as f32 * brightness).round().clamp(0.0, 255.0) as u8,
                    (cb as f32 * brightness).round().clamp(0.0, 255.0) as u8,
                ]
            })
            .collect();
        self.inner.send_frame(&corrected)
    }

    fn stop(&mut self) -> Result<(), String> {
        self.inner.stop()
    }
}

/// Encode one frame as one or more DDP datagrams, chunked so none exceeds a
/// 1500-byte MTU.
///
/// The push flag rides the LAST chunk only. Setting it on every chunk -- what
/// the single-packet encoder did by using a constant 0x41 -- makes WLED latch
/// each fragment as a complete frame and display partial updates.
pub fn encode_ddp_packets(colors: &[[u8; 3]], sequence: &AtomicU8) -> Vec<Vec<u8>> {
    let leds_per_chunk = DDP_MAX_PAYLOAD_BYTES / 3;
    let chunks: Vec<&[[u8; 3]]> = if colors.is_empty() {
        vec![colors]
    } else {
        colors.chunks(leds_per_chunk).collect()
    };
    let last_index = chunks.len() - 1;

    chunks
        .iter()
        .enumerate()
        .map(|(index, chunk)| {
            let payload_len = chunk.len() * 3;
            let byte_offset = (index * leds_per_chunk * 3) as u32;
            let mut packet = Vec::with_capacity(DDP_HEADER_LEN + payload_len);
            let flags = if index == last_index {
                DDP_FLAGS_VERSION_1 | DDP_FLAG_PUSH
            } else {
                DDP_FLAGS_VERSION_1
            };
            packet.push(flags);
            packet.push(sequence.fetch_add(1, Ordering::Relaxed));
            packet.push(DDP_TYPE);
            packet.push(DDP_DATA_TYPE);
            packet.extend_from_slice(&byte_offset.to_be_bytes());
            // Chunking caps this at DDP_MAX_PAYLOAD_BYTES, so the u16 the old
            // encoder cast blindly can no longer wrap past 21 845 LEDs.
            packet.extend_from_slice(&(payload_len as u16).to_be_bytes());
            for &[r, g, b] in chunk.iter() {
                packet.push(r);
                packet.push(g);
                packet.push(b);
            }
            packet
        })
        .collect()
}

/// Encode one frame for WLED's realtime UDP family: a single DRGB datagram
/// while the frame fits, DNRGB chunks once it does not.
///
/// DNRGB's bytes 2-3 are a big-endian **LED index**, not the byte offset DDP
/// uses -- the two are a chunk apart in meaning and trivially swapped.
pub fn encode_realtime_packets(colors: &[[u8; 3]]) -> Result<Vec<Vec<u8>>, String> {
    if colors.len() > DNRGB_MAX_ADDRESSABLE_LEDS {
        return Err(format!(
            "WLED_FRAME_TOO_LONG: {} LEDs exceeds the {DNRGB_MAX_ADDRESSABLE_LEDS}-LED DNRGB address space; use the ddp protocol",
            colors.len()
        ));
    }

    if colors.len() <= DRGB_MAX_LEDS {
        let mut packet = Vec::with_capacity(2 + colors.len() * 3);
        packet.push(REALTIME_PROTO_DRGB);
        packet.push(REALTIME_TIMEOUT_SEC);
        for &[r, g, b] in colors {
            packet.push(r);
            packet.push(g);
            packet.push(b);
        }
        return Ok(vec![packet]);
    }

    Ok(colors
        .chunks(DNRGB_MAX_LEDS_PER_PACKET)
        .enumerate()
        .map(|(index, chunk)| {
            let start_led = (index * DNRGB_MAX_LEDS_PER_PACKET) as u16;
            let mut packet = Vec::with_capacity(4 + chunk.len() * 3);
            packet.push(REALTIME_PROTO_DNRGB);
            packet.push(REALTIME_TIMEOUT_SEC);
            packet.extend_from_slice(&start_led.to_be_bytes());
            for &[r, g, b] in chunk.iter() {
                packet.push(r);
                packet.push(g);
                packet.push(b);
            }
            packet
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::AtomicU8;

    use super::{encode_ddp_packets, encode_realtime_packets, WledProtocol, WledUdpSink};
    use crate::commands::led_sink::LedSink;

    /// 1440 payload bytes / 3 -- the LED count at which DDP starts a second
    /// datagram. Every boundary fixture below is anchored to it.
    const DDP_LEDS_PER_CHUNK: usize = 480;

    fn ramp(n: usize) -> Vec<[u8; 3]> {
        (0..n)
            .map(|i| [(i % 256) as u8, ((i / 256) % 256) as u8, 0])
            .collect()
    }

    #[test]
    fn ddp_packet_header_bytes_are_correct() {
        let seq = AtomicU8::new(7);
        let packets = encode_ddp_packets(&[[255, 0, 0]], &seq);
        assert_eq!(packets.len(), 1);
        assert_eq!(
            packets[0][0], 0x41,
            "a single-chunk frame is also the last, so push must be set"
        );
        assert_eq!(
            packets[0][1], 7,
            "sequence must match initial counter value"
        );
        assert_eq!(packets[0][2], 0x01, "type must be 0x01 (RGB data)");
        assert_eq!(packets[0][3], 0x01, "data-type must be 0x01 (8-bit RGB)");
    }

    #[test]
    fn ddp_packet_offset_is_zero_big_endian() {
        let seq = AtomicU8::new(0);
        let packets = encode_ddp_packets(&[[0, 0, 0]], &seq);
        assert_eq!(&packets[0][4..8], &[0x00, 0x00, 0x00, 0x00]);
    }

    #[test]
    fn ddp_packet_length_field_is_big_endian_payload_bytes() {
        let seq = AtomicU8::new(0);
        let packets = encode_ddp_packets(&[[1, 2, 3], [4, 5, 6], [7, 8, 9]], &seq);
        assert_eq!(packets[0][8], 0x00);
        assert_eq!(packets[0][9], 9, "length low byte must be 9 for 3 LEDs");
    }

    #[test]
    fn ddp_packet_payload_matches_input_colors() {
        let seq = AtomicU8::new(0);
        let colors: &[[u8; 3]] = &[[255, 128, 0], [0, 64, 255]];
        let packets = encode_ddp_packets(colors, &seq);
        assert_eq!(&packets[0][10..], &[255, 128, 0, 0, 64, 255]);
    }

    #[test]
    fn ddp_sequence_increments_per_packet() {
        let seq = AtomicU8::new(0);
        let p1 = encode_ddp_packets(&[[0, 0, 0]], &seq);
        let p2 = encode_ddp_packets(&[[0, 0, 0]], &seq);
        assert_eq!(p1[0][1], 0);
        assert_eq!(p2[0][1], 1);
    }

    #[test]
    fn ddp_480_leds_is_exactly_one_chunk() {
        let seq = AtomicU8::new(0);
        let packets = encode_ddp_packets(&ramp(DDP_LEDS_PER_CHUNK), &seq);
        assert_eq!(packets.len(), 1, "480 LEDs must still be a single datagram");
        assert_eq!(&packets[0][8..10], &1440u16.to_be_bytes());
        assert_eq!(packets[0].len(), 10 + 1440);
        assert!(
            packets[0].len() <= 1472,
            "the largest single chunk ({} bytes) must fit a 1500-byte MTU",
            packets[0].len()
        );
    }

    #[test]
    fn ddp_481_leds_splits_and_pushes_only_the_last_chunk() {
        let seq = AtomicU8::new(0);
        let packets = encode_ddp_packets(&ramp(DDP_LEDS_PER_CHUNK + 1), &seq);
        assert_eq!(
            packets.len(),
            2,
            "one LED past the chunk must add a datagram"
        );
        assert_eq!(packets[0][0], 0x40, "the non-final chunk must NOT push");
        assert_eq!(packets[1][0], 0x41, "the final chunk must push");
        assert_eq!(&packets[0][4..8], &0u32.to_be_bytes());
        assert_eq!(
            &packets[1][4..8],
            &1440u32.to_be_bytes(),
            "offset is a BYTE offset, so chunk 2 starts at 1440, not 480"
        );
        assert_eq!(&packets[1][8..10], &3u16.to_be_bytes());
    }

    #[test]
    fn ddp_487_leds_still_splits_at_the_same_boundary() {
        let seq = AtomicU8::new(0);
        let packets = encode_ddp_packets(&ramp(487), &seq);
        assert_eq!(packets.len(), 2);
        assert_eq!(&packets[1][8..10], &21u16.to_be_bytes(), "7 LEDs remain");
    }

    #[test]
    fn ddp_490_leds_carries_the_drgb_ceiling_without_fragmenting() {
        let seq = AtomicU8::new(0);
        let packets = encode_ddp_packets(&ramp(490), &seq);
        assert_eq!(packets.len(), 2);
        for packet in &packets {
            assert!(packet.len() <= 1472, "no chunk may exceed the MTU");
        }
    }

    #[test]
    fn ddp_large_strip_chunks_contiguously_and_losslessly() {
        let seq = AtomicU8::new(0);
        let colors = ramp(1500);
        let packets = encode_ddp_packets(&colors, &seq);
        assert_eq!(packets.len(), 4, "1500 LEDs at 480/chunk is 4 datagrams");

        let mut expected_offset = 0u32;
        let mut reassembled: Vec<u8> = Vec::new();
        for (i, packet) in packets.iter().enumerate() {
            assert_eq!(&packet[4..8], &expected_offset.to_be_bytes());
            let len = u16::from_be_bytes([packet[8], packet[9]]) as usize;
            assert_eq!(packet.len(), 10 + len, "length field must match the body");
            assert_eq!(
                packet[0] & 0x01,
                u8::from(i == packets.len() - 1),
                "push must be set on the last chunk and nowhere else"
            );
            reassembled.extend_from_slice(&packet[10..]);
            expected_offset += len as u32;
        }
        let flat: Vec<u8> = colors.iter().flat_map(|c| c.to_vec()).collect();
        assert_eq!(reassembled, flat, "chunks must reassemble to the frame");
    }

    #[test]
    fn drgb_frame_is_protocol_two_then_timeout() {
        let packets = encode_realtime_packets(&[[10, 20, 30], [40, 50, 60]])
            .expect("a 2-LED frame must encode");
        assert_eq!(packets.len(), 1);
        assert_eq!(packets[0][0], 2, "byte 0 selects DRGB");
        assert_eq!(packets[0][1], 2, "byte 1 is the timeout in seconds");
        assert_eq!(&packets[0][2..], &[10, 20, 30, 40, 50, 60]);
    }

    #[test]
    fn drgb_490_leds_is_the_last_single_packet_frame() {
        let packets = encode_realtime_packets(&ramp(490)).expect("490 LEDs must encode");
        assert_eq!(packets.len(), 1, "490 is the documented DRGB ceiling");
        assert_eq!(packets[0][0], 2);
        assert_eq!(packets[0].len(), 2 + 490 * 3);
    }

    #[test]
    fn drgb_491_leds_promotes_to_dnrgb_with_big_endian_led_indices() {
        let packets = encode_realtime_packets(&ramp(491)).expect("491 LEDs must encode");
        assert_eq!(packets.len(), 2, "past 490 the frame is chunked as DNRGB");
        assert_eq!(packets[0][0], 4, "byte 0 must switch to DNRGB");
        assert_eq!(packets[0][1], 2, "byte 1 stays the timeout");
        assert_eq!(&packets[0][2..4], &0u16.to_be_bytes());
        assert_eq!(
            &packets[1][2..4],
            &489u16.to_be_bytes(),
            "the start field is an LED INDEX (489), not a byte offset (1467)"
        );
        assert_eq!(packets[0].len(), 4 + 489 * 3);
        assert_eq!(packets[1].len(), 4 + 2 * 3);
    }

    #[test]
    fn dnrgb_rejects_a_frame_past_the_u16_address_space() {
        let err = encode_realtime_packets(&ramp(65_537))
            .expect_err("65 537 LEDs cannot be addressed by a u16 start index");
        assert!(err.starts_with("WLED_FRAME_TOO_LONG"), "got: {err}");
    }

    #[test]
    fn wled_sink_name_is_wled_udp() {
        let sink = WledUdpSink::new("127.0.0.1".parse().unwrap(), 4048, 60, WledProtocol::Ddp);
        assert_eq!(sink.name(), "wled-udp");
    }

    #[test]
    fn wled_sink_stop_before_start_is_idempotent() {
        let mut sink = WledUdpSink::new("127.0.0.1".parse().unwrap(), 4048, 30, WledProtocol::Ddp);
        sink.stop().expect("stop before start must not error");
        sink.stop().expect("second stop must also be idempotent");
    }

    #[test]
    fn wled_sink_send_before_start_returns_coded_error() {
        let mut sink = WledUdpSink::new("127.0.0.1".parse().unwrap(), 4048, 10, WledProtocol::Ddp);
        let err = sink
            .send_frame(&[[1, 2, 3]])
            .expect_err("send before start must return Err");
        assert!(
            err.starts_with("WLED_SINK_NOT_STARTED"),
            "error code must be WLED_SINK_NOT_STARTED, got: {err}"
        );
    }

    #[test]
    fn wled_sink_start_is_idempotent() {
        let mut sink = WledUdpSink::new("127.0.0.1".parse().unwrap(), 4048, 10, WledProtocol::Ddp);
        sink.start().expect("first start must succeed");
        sink.start().expect("second start must be idempotent");
    }

    #[test]
    fn wled_sink_implements_led_sink_trait_object() {
        let sink: Box<dyn LedSink> = Box::new(WledUdpSink::new(
            "127.0.0.1".parse().unwrap(),
            4048,
            30,
            WledProtocol::Ddp,
        ));
        assert_eq!(sink.name(), "wled-udp");
    }

    #[test]
    fn wled_sink_start_stop_clears_socket() {
        let mut sink = WledUdpSink::new("127.0.0.1".parse().unwrap(), 4048, 10, WledProtocol::Ddp);
        sink.start().expect("start must succeed");
        assert!(sink.socket.is_some(), "socket must be Some after start");
        sink.stop().expect("stop must succeed");
        assert!(sink.socket.is_none(), "socket must be None after stop");
    }
}
