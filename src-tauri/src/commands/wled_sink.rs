/// `WledUdpSink` -- `LedSink` implementation for WLED over DDP (UDP).
///
/// DDP packet layout (header = 10 bytes, then RGB payload):
///  Byte 0:    flags     -- 0x41  (version=1, push flag set)
///  Byte 1:    sequence  -- incrementing u8, wraps at 255
///  Byte 2:    type      -- 0x01  (RGBRGB... data)
///  Byte 3:    data-type -- 0x01  (8-bit RGB)
///  Bytes 4-7: offset    -- big-endian u32 (0x00000000 for full frame)
///  Bytes 8-9: length    -- big-endian u16 (led_count * 3)
///  Bytes 10+: payload   -- R G B per LED in strip order
use std::net::{SocketAddrV4, UdpSocket};
use std::sync::atomic::{AtomicU8, Ordering};

use super::led_sink::LedSink;

const DDP_FLAGS: u8 = 0x41;
const DDP_TYPE: u8 = 0x01;
const DDP_DATA_TYPE: u8 = 0x01;

/// On-wire protocol used by `WledUdpSink`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum WledProtocol {
    /// DDP (Distributed Display Protocol), WLED DDP input port 4048.
    #[default]
    Ddp,
    /// WARLS (Wi-Fi Addressable RGB Light Strip), WLED WARLS UDP port 21324.
    /// Scaffold only in v1.5.
    Warls,
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
        let socket = UdpSocket::bind("0.0.0.0:0").map_err(|e| {
            format!("WLED_SOCKET_BIND_FAILED: could not bind UDP socket -- {e}")
        })?;
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
        let packet = match self.protocol {
            WledProtocol::Ddp => encode_ddp_packet(colors, &self.sequence),
            WledProtocol::Warls => encode_warls_packet(colors),
        };
        socket
            .send_to(&packet, endpoint)
            .map(|_| ())
            .map_err(|e| format!("WLED_SEND_FAILED: UDP send_to {endpoint} failed -- {e}"))
    }

    fn stop(&mut self) -> Result<(), String> {
        self.socket = None;
        self.endpoint = None;
        Ok(())
    }
}

pub fn encode_ddp_packet(colors: &[[u8; 3]], sequence: &AtomicU8) -> Vec<u8> {
    let seq = sequence.fetch_add(1, Ordering::Relaxed);
    let payload_len = colors.len() * 3;
    let mut packet = Vec::with_capacity(10 + payload_len);
    packet.push(DDP_FLAGS);
    packet.push(seq);
    packet.push(DDP_TYPE);
    packet.push(DDP_DATA_TYPE);
    packet.extend_from_slice(&0u32.to_be_bytes());
    packet.extend_from_slice(&(payload_len as u16).to_be_bytes());
    for &[r, g, b] in colors {
        packet.push(r);
        packet.push(g);
        packet.push(b);
    }
    packet
}

pub fn encode_warls_packet(colors: &[[u8; 3]]) -> Vec<u8> {
    const WARLS_TIMEOUT_SEC: u8 = 1;
    let payload_len = colors.len() * 3;
    let mut packet = Vec::with_capacity(1 + payload_len);
    packet.push(WARLS_TIMEOUT_SEC);
    for &[r, g, b] in colors {
        packet.push(r);
        packet.push(g);
        packet.push(b);
    }
    packet
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::AtomicU8;

    use super::{encode_ddp_packet, encode_warls_packet, WledProtocol, WledUdpSink};
    use crate::commands::led_sink::LedSink;

    #[test]
    fn ddp_packet_header_bytes_are_correct() {
        let seq = AtomicU8::new(7);
        let packet = encode_ddp_packet(&[[255, 0, 0]], &seq);
        assert_eq!(packet[0], 0x41, "flags must be 0x41 (version=1, push)");
        assert_eq!(packet[1], 7, "sequence must match initial counter value");
        assert_eq!(packet[2], 0x01, "type must be 0x01 (RGB data)");
        assert_eq!(packet[3], 0x01, "data-type must be 0x01 (8-bit RGB)");
    }

    #[test]
    fn ddp_packet_offset_is_zero_big_endian() {
        let seq = AtomicU8::new(0);
        let packet = encode_ddp_packet(&[[0, 0, 0]], &seq);
        assert_eq!(&packet[4..8], &[0x00, 0x00, 0x00, 0x00]);
    }

    #[test]
    fn ddp_packet_length_field_is_big_endian_payload_bytes() {
        let seq = AtomicU8::new(0);
        let packet = encode_ddp_packet(&[[1, 2, 3], [4, 5, 6], [7, 8, 9]], &seq);
        assert_eq!(packet[8], 0x00);
        assert_eq!(packet[9], 9, "length field low byte must be 9 for 3 LEDs");
    }

    #[test]
    fn ddp_packet_payload_matches_input_colors() {
        let seq = AtomicU8::new(0);
        let colors: &[[u8; 3]] = &[[255, 128, 0], [0, 64, 255]];
        let packet = encode_ddp_packet(colors, &seq);
        assert_eq!(&packet[10..], &[255, 128, 0, 0, 64, 255]);
    }

    #[test]
    fn ddp_packet_total_length_is_header_plus_payload() {
        let seq = AtomicU8::new(0);
        let n = 50usize;
        let colors: Vec<[u8; 3]> = vec![[10, 20, 30]; n];
        let packet = encode_ddp_packet(&colors, &seq);
        assert_eq!(packet.len(), 10 + n * 3);
    }

    #[test]
    fn ddp_sequence_increments_per_packet() {
        let seq = AtomicU8::new(0);
        let p1 = encode_ddp_packet(&[[0, 0, 0]], &seq);
        let p2 = encode_ddp_packet(&[[0, 0, 0]], &seq);
        let p3 = encode_ddp_packet(&[[0, 0, 0]], &seq);
        assert_eq!(p1[1], 0);
        assert_eq!(p2[1], 1);
        assert_eq!(p3[1], 2);
    }

    #[test]
    fn ddp_200_led_frame_fits_udp_mtu() {
        let seq = AtomicU8::new(0);
        let colors: Vec<[u8; 3]> = vec![[0u8; 3]; 200];
        let packet = encode_ddp_packet(&colors, &seq);
        assert!(
            packet.len() <= 1472,
            "200-LED DDP packet ({} bytes) must fit UDP MTU (1472)",
            packet.len()
        );
    }

    #[test]
    fn warls_packet_first_byte_is_timeout() {
        let packet = encode_warls_packet(&[[255, 0, 0]]);
        assert_eq!(packet[0], 1, "WARLS first byte must be timeout=1");
    }

    #[test]
    fn warls_packet_payload_follows_timeout_byte() {
        let packet = encode_warls_packet(&[[10, 20, 30], [40, 50, 60]]);
        assert_eq!(&packet[1..], &[10, 20, 30, 40, 50, 60]);
    }

    #[test]
    fn warls_packet_length_is_one_plus_n_times_three() {
        let colors: Vec<[u8; 3]> = vec![[0u8; 3]; 100];
        let packet = encode_warls_packet(&colors);
        assert_eq!(packet.len(), 1 + 100 * 3);
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
