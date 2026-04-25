//! DTLS 1.2 PSK connection to the Hue bridge entertainment endpoint.
//!
//! Carved out of the original `hue_stream_lifecycle.rs` during the v1.5 G8
//! split. Cipher suite (`PSK-AES128-GCM-SHA256`), PSK identity layout, and
//! the dedicated-thread handshake-deadline pattern are preserved exactly —
//! these are protocol-critical and cannot drift from `ls-hue-protocol §2.5`.

use std::time::Duration;

/// Hue Entertainment DTLS port.
pub(super) const HUE_DTLS_PORT: u16 = 2100;

/// Hard wall-clock deadline (in seconds) for the DTLS handshake attempt.
/// OpenSSL's DTLS retransmit loop ignores socket-level read timeouts, so we
/// run the handshake on a dedicated OS thread and abandon it after this limit.
pub(crate) const DTLS_CONNECT_TIMEOUT_SECS: u64 = 8;

/// Thin wrapper around `UdpSocket` that implements `Read` + `Write` so that
/// `openssl::ssl::SslStream` can use it as its underlying transport.
#[derive(Debug)]
pub(crate) struct UdpSocketWrapper(pub(super) std::net::UdpSocket);

impl std::io::Read for UdpSocketWrapper {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        self.0.recv(buf)
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
    let socket =
        UdpSocket::bind("0.0.0.0:0").map_err(|e| format!("DTLS_SOCKET_BIND_FAILED: {e}"))?;
    socket
        .connect(format!("{bridge_ip}:{HUE_DTLS_PORT}"))
        .map_err(|e| format!("DTLS_SOCKET_CONNECT_FAILED: {e}"))?;
    socket
        .set_read_timeout(Some(Duration::from_secs(5)))
        .map_err(|e| format!("DTLS_SOCKET_TIMEOUT_FAILED: {e}"))?;

    let ssl_stream = connector
        .connect(bridge_ip, UdpSocketWrapper(socket))
        .map_err(|e| format!("DTLS_HANDSHAKE_FAILED: {e}"))?;

    Ok(ssl_stream)
}

/// Decode a hex string (e.g. "AABBCCDD") into raw bytes.
pub(crate) fn hex_decode(hex: &str) -> Result<Vec<u8>, String> {
    if !hex.len().is_multiple_of(2) {
        return Err("Hex string has odd length".to_string());
    }
    (0..hex.len())
        .step_by(2)
        .map(|i| {
            u8::from_str_radix(&hex[i..i + 2], 16)
                .map_err(|e| format!("Invalid hex at position {i}: {e}"))
        })
        .collect()
}
