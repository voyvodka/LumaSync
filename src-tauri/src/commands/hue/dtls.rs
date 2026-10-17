//! DTLS 1.2 PSK connection to the Hue bridge entertainment endpoint.
//!
//! Carved out of the original `hue_stream_lifecycle.rs`. Cipher suite
//! (`PSK-AES128-GCM-SHA256`), PSK identity layout, and the dedicated-thread
//! handshake-deadline pattern are preserved exactly — these are
//! protocol-critical and must not drift.

use std::time::{Duration, Instant};

/// Hue Entertainment DTLS port.
pub(super) const HUE_DTLS_PORT: u16 = 2100;

/// Hard wall-clock deadline (in seconds) for the DTLS handshake attempt. The
/// handshake runs on a dedicated OS thread that the caller abandons after this
/// limit, whatever the socket is doing.
pub(crate) const DTLS_CONNECT_TIMEOUT_SECS: u64 = 8;

/// The socket's read timeout is OpenSSL's only retransmit clock: rust-openssl's
/// BIO drops the timer hint OpenSSL sets, so a lost flight was resent only when
/// a read timed out. At 5 s that put a lost first ClientHello 5 s behind every
/// stream start; under OpenSSL's 1 s first retransmit it is resent on schedule.
const HANDSHAKE_READ_TIMEOUT: Duration = Duration::from_millis(200);

/// Inside `DTLS_CONNECT_TIMEOUT_SECS`, so a bridge that never answers fails here
/// with a code rather than being abandoned mid-handshake.
const HANDSHAKE_DEADLINE: Duration = Duration::from_secs(7);

/// Thin wrapper around `UdpSocket` that implements `Read` + `Write` so that
/// `openssl::ssl::SslStream` can use it as its underlying transport.
#[derive(Debug)]
pub(crate) struct UdpSocketWrapper(pub(super) std::net::UdpSocket);

impl std::io::Read for UdpSocketWrapper {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        // Windows reports a timed-out read as `TimedOut`, Unix as `WouldBlock`,
        // and only `WouldBlock` is a retry to rust-openssl: as `TimedOut` the
        // handshake failed instead of resending.
        match self.0.recv(buf) {
            Err(error) if error.kind() == std::io::ErrorKind::TimedOut => {
                Err(std::io::ErrorKind::WouldBlock.into())
            }
            received => received,
        }
    }
}

impl std::io::Write for UdpSocketWrapper {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0.send(buf)
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

/// Establish a DTLS 1.2 connection to the Hue bridge using PSK.
///
/// - `bridge_ip`: IP address of the bridge
/// - `username`: Hue application username (used as PSK identity, ASCII hex)
/// - `client_key`: Hue clientkey (16-byte hex string, used as PSK)
///
/// Returns an `openssl::ssl::SslStream<UdpSocketWrapper>` on success.
pub(crate) fn connect_dtls(
    bridge_ip: &str,
    username: &str,
    client_key: &str,
) -> Result<openssl::ssl::SslStream<UdpSocketWrapper>, String> {
    connect_dtls_at(
        "0.0.0.0:0",
        &format!("{bridge_ip}:{HUE_DTLS_PORT}"),
        bridge_ip,
        username,
        client_key,
    )
}

/// `connect_dtls` from a chosen local address to a chosen endpoint, so a test
/// can shake hands on loopback without an all-interfaces bind.
fn connect_dtls_at(
    local: &str,
    endpoint: &str,
    bridge_ip: &str,
    username: &str,
    client_key: &str,
) -> Result<openssl::ssl::SslStream<UdpSocketWrapper>, String> {
    use openssl::ssl::{SslConnector, SslMethod, SslVerifyMode};
    use std::net::UdpSocket;

    // Decode the 32-hex-char clientkey into 16 raw bytes for PSK.
    let psk_bytes = hex_decode(client_key).map_err(|e| format!("DTLS_PSK_DECODE_FAILED: {e}"))?;

    let psk_identity = username.to_string();

    let mut builder = SslConnector::builder(SslMethod::dtls())
        .map_err(|e| format!("DTLS_CONNECTOR_BUILD_FAILED: {e}"))?;

    // Disable certificate verification (bridge uses self-signed cert).
    builder.set_verify(SslVerifyMode::NONE);

    // Set PSK client callback: bridge expects username as identity, clientkey as PSK.
    builder.set_psk_client_callback(move |_ssl, _hint, identity_out, psk_out| {
        // Write PSK identity
        let identity_bytes = psk_identity.as_bytes();
        let ilen = identity_bytes
            .len()
            .min(identity_out.len().saturating_sub(1));
        identity_out[..ilen].copy_from_slice(&identity_bytes[..ilen]);
        identity_out[ilen] = 0; // null terminate

        // Write PSK key
        let klen = psk_bytes.len().min(psk_out.len());
        psk_out[..klen].copy_from_slice(&psk_bytes[..klen]);

        Ok(klen)
    });

    // Force TLS_PSK_WITH_AES_128_GCM_SHA256 which Hue bridges expect.
    builder
        .set_cipher_list("PSK-AES128-GCM-SHA256")
        .map_err(|e| format!("DTLS_CIPHER_SET_FAILED: {e}"))?;

    let connector = builder.build();

    // Bind a UDP socket and connect to bridge:2100.
    let socket = UdpSocket::bind(local).map_err(|e| format!("DTLS_SOCKET_BIND_FAILED: {e}"))?;
    socket
        .connect(endpoint)
        .map_err(|e| format!("DTLS_SOCKET_CONNECT_FAILED: {e}"))?;
    socket
        .set_read_timeout(Some(HANDSHAKE_READ_TIMEOUT))
        .map_err(|e| format!("DTLS_SOCKET_TIMEOUT_FAILED: {e}"))?;

    let ssl_stream = finish_handshake(connector.connect(bridge_ip, UdpSocketWrapper(socket)))?;

    Ok(ssl_stream)
}

/// Drives a handshake that ran out of reads back into OpenSSL, which resends a
/// lost flight on each re-entry once its timer has passed.
fn finish_handshake<S: std::io::Read + std::io::Write + std::fmt::Debug>(
    mut attempt: Result<openssl::ssl::SslStream<S>, openssl::ssl::HandshakeError<S>>,
) -> Result<openssl::ssl::SslStream<S>, String> {
    use openssl::ssl::HandshakeError;

    let deadline = Instant::now() + HANDSHAKE_DEADLINE;
    loop {
        attempt = match attempt {
            Ok(stream) => return Ok(stream),
            Err(HandshakeError::WouldBlock(mid)) if Instant::now() < deadline => mid.handshake(),
            Err(HandshakeError::WouldBlock(_)) => {
                return Err(format!(
                    "DTLS_HANDSHAKE_FAILED: no answer from the bridge in {}s",
                    HANDSHAKE_DEADLINE.as_secs()
                ))
            }
            Err(error) => return Err(format!("DTLS_HANDSHAKE_FAILED: {error}")),
        };
    }
}

/// Decode a hex string (e.g. "AABBCCDD") into raw bytes.
///
/// Works on bytes, not `str` slices: slicing at a byte offset panics inside a
/// multi-byte character, and the input is a stored secret we do not control.
fn hex_decode(hex: &str) -> Result<Vec<u8>, String> {
    fn nibble(byte: u8) -> Option<u8> {
        char::from(byte).to_digit(16).map(|digit| digit as u8)
    }
    let bytes = hex.as_bytes();
    if !bytes.len().is_multiple_of(2) {
        return Err("Hex string has odd length".to_string());
    }
    bytes
        .as_chunks::<2>()
        .0
        .iter()
        .enumerate()
        .map(|(pair, [high, low])| match (nibble(*high), nibble(*low)) {
            (Some(high), Some(low)) => Ok(high << 4 | low),
            _ => Err(format!("Invalid hex at position {}", pair * 2)),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hex_decode_works() {
        assert_eq!(hex_decode("AABB").unwrap(), vec![0xAA, 0xBB]);
        assert_eq!(
            hex_decode("0123456789abcdef").unwrap(),
            vec![0x01, 0x23, 0x45, 0x67, 0x89, 0xAB, 0xCD, 0xEF]
        );
        assert!(hex_decode("ABC").is_err()); // odd length
        assert!(hex_decode("GG").is_err()); // invalid hex
    }

    #[test]
    fn hex_decode_refuses_non_ascii_input_instead_of_panicking() {
        // "aé0": four bytes, so the length check passes and a two-byte slice
        // starting at 0 ends inside 'é'.
        assert!(hex_decode("aé0").is_err());
        assert!(hex_decode("éé").is_err());
        assert!(hex_decode("+1").is_err(), "a sign is not a hex digit");
    }

    // Every stream start sat 5 s behind a lost ClientHello: the read timeout was
    // the only retransmit clock.
    #[test]
    fn a_lost_client_hello_is_resent_on_openssls_schedule() {
        use openssl::ssl::{Ssl, SslContext, SslMethod};
        use std::net::UdpSocket;

        const KEY: &str = "00112233445566778899AABBCCDDEEFF";
        let server = UdpSocket::bind("127.0.0.1:0").unwrap();
        let endpoint = server.local_addr().unwrap().to_string();
        let bridge = std::thread::spawn(move || {
            let mut context = SslContext::builder(SslMethod::dtls()).unwrap();
            context.set_cipher_list("PSK-AES128-GCM-SHA256").unwrap();
            context.set_psk_server_callback(|_ssl, _identity, psk_out| {
                let key = hex_decode(KEY).unwrap();
                psk_out[..key.len()].copy_from_slice(&key);
                Ok(key.len())
            });
            let context = context.build();
            let mut lost = [0u8; 2048];
            let (_, client) = server.recv_from(&mut lost).unwrap();
            server.connect(client).unwrap();
            server
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            Ssl::new(&context)
                .unwrap()
                .accept(UdpSocketWrapper(server))
                .map(|_| ())
                .map_err(|e| e.to_string())
        });

        let started = Instant::now();
        let stream = connect_dtls_at("127.0.0.1:0", &endpoint, "127.0.0.1", "identity", KEY);
        let elapsed = started.elapsed();
        bridge.join().unwrap().expect("the bridge side completes");
        stream.expect("the handshake completes");
        assert!(elapsed < Duration::from_millis(2500), "took {elapsed:?}");
    }
}
