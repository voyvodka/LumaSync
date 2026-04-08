use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

use reqwest::blocking::Client as BlockingClient;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::State;

use log::{error, info, warn};

use super::hue_onboarding::{check_hue_stream_readiness, CommandStatus};

const DEFAULT_RETRY_MAX_ATTEMPTS: u8 = 3;
const DEFAULT_RETRY_BASE_MS: u64 = 400;
const DEFAULT_RETRY_CAP_MS: u64 = 2_000;
const HUE_HTTP_TIMEOUT_MS: u64 = 5_000;
/// Minimum interval between Hue color pushes in the background sender thread.
/// 50ms = 20 Hz max, well within CLIP v2 limits and imperceptibly fast.
const HUE_SENDER_MIN_INTERVAL_MS: u64 = 50;
/// Hue Entertainment DTLS port.
const HUE_DTLS_PORT: u16 = 2100;
/// Maximum time (in seconds) to wait for the sender thread to shut down
/// before reporting a partial-stop timeout.
const HUE_STOP_TIMEOUT_SECS: u64 = 3;
/// Hard wall-clock deadline (in seconds) for the DTLS handshake attempt.
/// OpenSSL's DTLS retransmit loop ignores socket-level read timeouts, so we
/// run the handshake on a dedicated OS thread and abandon it after this limit.
const DTLS_CONNECT_TIMEOUT_SECS: u64 = 8;

// ---------------------------------------------------------------------------
// HueStream binary protocol constants (v2.0, API version 1.0)
// ---------------------------------------------------------------------------

/// "HueStream" magic bytes.
const HUESTREAM_MAGIC: &[u8; 9] = b"HueStream";
/// Protocol version: major=2, minor=0.
const HUESTREAM_VERSION_MAJOR: u8 = 0x02;
const HUESTREAM_VERSION_MINOR: u8 = 0x00;
/// Sequence number — 0x00 for non-sequenced mode (simplest).
const HUESTREAM_SEQUENCE: u8 = 0x00;
/// Reserved bytes (2 bytes, must be 0x00).
const HUESTREAM_RESERVED: [u8; 2] = [0x00, 0x00];
/// Color space: 0x00 = RGB, 0x01 = XY+Brightness.
const HUESTREAM_COLOR_SPACE_RGB: u8 = 0x00;

/// The screen region a Hue entertainment channel should receive colour from.
/// Derived from the channel's 3D position as reported by the bridge.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum HueScreenRegion {
    Top,
    Bottom,
    Left,
    Right,
    Center,
}

impl HueScreenRegion {
    pub fn as_str(&self) -> &'static str {
        match self {
            HueScreenRegion::Top => "top",
            HueScreenRegion::Bottom => "bottom",
            HueScreenRegion::Left => "left",
            HueScreenRegion::Right => "right",
            HueScreenRegion::Center => "center",
        }
    }
}

fn parse_screen_region(s: &str) -> Option<HueScreenRegion> {
    match s {
        "top" => Some(HueScreenRegion::Top),
        "bottom" => Some(HueScreenRegion::Bottom),
        "left" => Some(HueScreenRegion::Left),
        "right" => Some(HueScreenRegion::Right),
        "center" => Some(HueScreenRegion::Center),
        _ => None,
    }
}

/// A single resolved Hue entertainment channel: the lights it controls and
/// the screen region those lights should mirror.
#[derive(Clone, Debug)]
pub struct HueAreaChannel {
    /// Entertainment channel ID (0-based index used in HueStream frames).
    pub channel_id: u8,
    /// CLIP v2 light resource IDs belonging to this channel.
    pub light_ids: Vec<String>,
    /// Screen region derived from the channel's x/y position (or overridden by user).
    pub screen_region: HueScreenRegion,
    /// Raw position X reported by the bridge (-1 left ... +1 right).
    pub position_x: f32,
    /// Raw position Y reported by the bridge (-1 bottom ... +1 top).
    pub position_y: f32,
}

/// Serialisable summary of a single Hue entertainment channel for the UI.
#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct HueAreaChannelInfo {
    pub index: usize,
    pub position_x: f32,
    pub position_y: f32,
    pub light_count: usize,
    /// Auto-detected screen region ("left", "right", "top", "bottom", "center").
    pub auto_region: String,
}

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq, Debug)]
pub enum HueRuntimeState {
    Idle,
    Starting,
    Running,
    Reconnecting,
    Stopping,
    Failed,
}

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq, Debug)]
#[serde(rename_all = "snake_case")]
pub enum HueRuntimeTriggerSource {
    ModeControl,
    DeviceSurface,
    System,
}

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq, Debug)]
#[serde(rename_all = "snake_case")]
pub enum HueRuntimeActionHint {
    Retry,
    Reconnect,
    Repair,
    Revalidate,
    AdjustArea,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct HueRuntimeStatus {
    pub state: HueRuntimeState,
    pub code: String,
    pub message: String,
    pub details: Option<String>,
    pub remaining_attempts: Option<u8>,
    pub next_attempt_ms: Option<u64>,
    pub action_hint: Option<HueRuntimeActionHint>,
    pub trigger_source: HueRuntimeTriggerSource,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct HueRuntimeCommandResult {
    pub active: bool,
    pub status: HueRuntimeStatus,
    pub last_solid_color: Option<HueSolidColorSnapshot>,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct StartHueStreamRequest {
    pub bridge_ip: String,
    pub username: String,
    pub client_key: String,
    pub area_id: String,
    pub trigger_source: Option<HueRuntimeTriggerSource>,
    /// Optional per-channel region overrides indexed by channel index.
    /// Each entry is a region string: "left", "right", "top", "bottom", or "center".
    /// `None` entries use the auto-detected region.
    pub channel_region_overrides: Option<Vec<Option<String>>>,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SetHueSolidColorRequest {
    pub r: u8,
    pub g: u8,
    pub b: u8,
    pub brightness: Option<f32>,
    pub trigger_source: Option<HueRuntimeTriggerSource>,
}

/// Snapshot of the last solid color sent to the Hue bridge.
#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct HueSolidColorSnapshot {
    pub r: u8,
    pub g: u8,
    pub b: u8,
    pub brightness: f32,
}

#[derive(Clone, Debug)]
pub struct HueRuntimeGateEvidence {
    pub bridge_configured: bool,
    pub credentials_valid: bool,
    pub area_selected: bool,
    pub readiness_current: bool,
    pub ready: bool,
    pub auth_invalid_evidence: bool,
}

#[cfg_attr(not(test), allow(dead_code))]
#[derive(Clone, Debug)]
struct HueRetryPolicy {
    max_attempts: u8,
    base_backoff_ms: u64,
    cap_backoff_ms: u64,
}

impl Default for HueRetryPolicy {
    fn default() -> Self {
        Self {
            max_attempts: DEFAULT_RETRY_MAX_ATTEMPTS,
            base_backoff_ms: DEFAULT_RETRY_BASE_MS,
            cap_backoff_ms: DEFAULT_RETRY_CAP_MS,
        }
    }
}

/// Persists even when the stream is Idle so that solid-color commands keep
/// working without requiring an active streaming session.
struct HuePersistentSender {
    channels: Vec<HueAreaChannel>,
    /// Shares the same `Arc<SyncSender>` with `HueActiveStreamContext` while
    /// the stream is running. When the stream stops, this is the sole owner
    /// keeping the background thread alive.
    sender: HueColorSender,
}

/// Shared signal used to detect when a background sender thread has exited.
/// The thread sets the bool to `true` and notifies the condvar right before
/// returning, allowing `stop_hue_stream` to wait with a bounded timeout.
type ShutdownSignal = Arc<(Mutex<bool>, Condvar)>;

/// Create a fresh shutdown signal (initially `false` / not-yet-shut-down).
fn new_shutdown_signal() -> ShutdownSignal {
    Arc::new((Mutex::new(false), Condvar::new()))
}

/// Mark the shutdown signal as complete and wake any waiters.
fn signal_shutdown_complete(signal: &ShutdownSignal) {
    if let Ok(mut done) = signal.0.lock() {
        *done = true;
        signal.1.notify_all();
    }
}

/// Non-blocking probe: has the background thread already signalled shutdown?
/// Returns `true` if `signal_shutdown_complete` was called, `false` otherwise.
fn is_shutdown_signaled(signal: &ShutdownSignal) -> bool {
    signal.0.lock().map(|guard| *guard).unwrap_or(false)
}

/// Wait for the shutdown signal up to `timeout`. Returns `true` if the
/// thread confirmed shutdown within the deadline, `false` on timeout.
fn wait_for_shutdown(signal: &ShutdownSignal, timeout: Duration) -> bool {
    if let Ok(guard) = signal.0.lock() {
        let result = signal
            .1
            .wait_timeout_while(guard, timeout, |done| !*done);
        match result {
            Ok((_, timeout_result)) => !timeout_result.timed_out(),
            Err(_) => false,
        }
    } else {
        false
    }
}

pub(crate) struct HueRuntimeOwner {
    pub(crate) state: HueRuntimeState,
    pub(crate) active_stream: Option<HueActiveStreamContext>,
    /// Retained across stream stop/start cycles so that solid-color updates
    /// succeed even when the runtime is temporarily Idle.
    persistent_sender: Option<HuePersistentSender>,
    reconnect_attempt: u8,
    user_override_pending: bool,
    last_status: HueRuntimeStatus,
    /// Most recent solid color successfully sent to the bridge.
    /// Persists across reconnects so the UI can restore the last applied color.
    last_solid_color: Option<HueSolidColorSnapshot>,
    #[cfg_attr(not(test), allow(dead_code))]
    retry_policy: HueRetryPolicy,
    /// Instant when the current stream session started (for uptime calculation).
    pub(crate) stream_started_at: Option<Instant>,
    /// Cumulative reconnect counters for the current app session.
    pub(crate) session_reconnect_total: u32,
    pub(crate) session_reconnect_success: u32,
    /// DTLS cipher negotiated during handshake (stored for telemetry).
    pub(crate) dtls_cipher: Option<String>,
    /// Instant when the current DTLS connection was established.
    pub(crate) dtls_connected_at: Option<Instant>,
    /// Last error code reported (for telemetry display).
    pub(crate) last_error_code: Option<String>,
    /// Instant of the last error (for "X min ago" display).
    pub(crate) last_error_at: Option<Instant>,
    /// Approximate packet send rate (updated by sender thread via shared atomic on telemetry read).
    pub(crate) packet_send_count: Arc<std::sync::atomic::AtomicU32>,
    /// Last time packet_send_count was sampled for rate calculation.
    pub(crate) packet_rate_sampled_at: Option<Instant>,
    pub(crate) packet_rate_last_count: u32,
}

/// Lightweight, cloneable handle to the background Hue color sender thread.
/// Cloning only increments an Arc refcount -- cheap. When every clone drops,
/// the sender channel closes and the background thread exits on its own.
#[derive(Clone, Debug)]
pub struct HueColorSender {
    tx: Arc<std::sync::mpsc::SyncSender<HueColorUpdate>>,
    /// Number of channels; used by `try_send` to broadcast a solid colour.
    channel_count: usize,
}

#[derive(Debug)]
struct HueColorUpdate {
    /// Per-channel colours in channel order (one entry per `HueAreaChannel`).
    channel_colors: Vec<(u8, u8, u8)>,
    brightness: f32,
}

impl HueColorSender {
    /// Broadcast the same colour to every channel. Used by the solid-colour path.
    pub fn try_send(&self, r: u8, g: u8, b: u8, brightness: f32) {
        let channel_colors = vec![(r, g, b); self.channel_count.max(1)];
        let _ = self.tx.try_send(HueColorUpdate { channel_colors, brightness });
    }

    /// Send individual colours per channel. `colors` must be indexed the same
    /// way as the `HueAreaChannel` list used when the sender was spawned.
    pub fn try_send_channels(&self, colors: Vec<(u8, u8, u8)>, brightness: f32) {
        if colors.is_empty() {
            return;
        }
        let _ = self.tx.try_send(HueColorUpdate { channel_colors: colors, brightness });
    }
}

// ---------------------------------------------------------------------------
// HueStream binary frame builder
// ---------------------------------------------------------------------------

/// Build a HueStream v2 binary frame for the entertainment API.
///
/// Frame layout (header = 16 bytes):
///   Bytes  0..8:  "HueStream" (9 bytes magic)
///   Byte   9:     API version major (0x02)
///   Byte  10:     API version minor (0x00)
///   Byte  11:     Sequence number (0x00 = non-sequenced)
///   Bytes 12..13: Reserved (0x00, 0x00)
///   Byte  14:     Color space (0x00 = RGB)
///   Byte  15:     Reserved (0x00)
///
/// Per light entry (7 bytes each):
///   Byte   0:     Channel ID (uint8)
///   Bytes 1..2:   Red   (uint16 BE, 0..65535)
///   Bytes 3..4:   Green (uint16 BE, 0..65535)
///   Bytes 5..6:   Blue  (uint16 BE, 0..65535)
///
/// Between the header and channel entries there is a 36-byte field containing
/// the entertainment_configuration resource UUID (ASCII string, e.g.
/// "1a8d99cc-967b-44f2-9202-43f976c0fa6b"). This field is mandatory per the
/// Hue Entertainment API v2.0 specification — the bridge uses it to route the
/// frame to the correct entertainment area when multiple sessions could be
/// active. Without it the bridge cannot parse the channel data and ignores
/// the frame entirely.
fn build_huestream_frame(
    area_id: &str,
    channels: &[HueAreaChannel],
    channel_colors: &[(u8, u8, u8)],
    brightness: f32,
) -> Vec<u8> {
    const UUID_LEN: usize = 36;
    let header_len = 16;
    let entry_len = 7;
    let mut frame = Vec::with_capacity(header_len + UUID_LEN + channels.len() * entry_len);

    // Header
    frame.extend_from_slice(HUESTREAM_MAGIC);
    frame.push(HUESTREAM_VERSION_MAJOR);
    frame.push(HUESTREAM_VERSION_MINOR);
    frame.push(HUESTREAM_SEQUENCE);
    frame.extend_from_slice(&HUESTREAM_RESERVED);
    frame.push(HUESTREAM_COLOR_SPACE_RGB);
    frame.push(0x00); // reserved

    // Entertainment configuration UUID (36 ASCII bytes), required by spec.
    // Pad or truncate defensively to always emit exactly UUID_LEN bytes so
    // channel offsets are deterministic even if the stored ID is malformed.
    let id_bytes = area_id.as_bytes();
    if id_bytes.len() >= UUID_LEN {
        frame.extend_from_slice(&id_bytes[..UUID_LEN]);
    } else {
        frame.extend_from_slice(id_bytes);
        frame.extend(std::iter::repeat(0u8).take(UUID_LEN - id_bytes.len()));
    }

    let brightness_clamped = brightness.clamp(0.0, 1.0);

    for (i, channel) in channels.iter().enumerate() {
        let (r, g, b) = channel_colors.get(i).copied().unwrap_or((0, 0, 0));

        // Scale 8-bit to 16-bit and apply brightness
        let r16 = ((f32::from(r) / 255.0) * brightness_clamped * 65535.0) as u16;
        let g16 = ((f32::from(g) / 255.0) * brightness_clamped * 65535.0) as u16;
        let b16 = ((f32::from(b) / 255.0) * brightness_clamped * 65535.0) as u16;

        frame.push(channel.channel_id);
        frame.extend_from_slice(&r16.to_be_bytes());
        frame.extend_from_slice(&g16.to_be_bytes());
        frame.extend_from_slice(&b16.to_be_bytes());
    }

    frame
}

// ---------------------------------------------------------------------------
// DTLS 1.2 PSK connection via openssl
// ---------------------------------------------------------------------------

/// Thin wrapper around `UdpSocket` that implements `Read` + `Write` so that
/// `openssl::ssl::SslStream` can use it as its underlying transport.
#[derive(Debug)]
struct UdpSocketWrapper(std::net::UdpSocket);

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
fn connect_dtls(
    bridge_ip: &str,
    username: &str,
    client_key: &str,
) -> Result<openssl::ssl::SslStream<UdpSocketWrapper>, String> {
    use openssl::ssl::{SslConnector, SslMethod, SslVerifyMode};
    use std::net::UdpSocket;

    // Decode the 32-hex-char clientkey into 16 raw bytes for PSK.
    let psk_bytes = hex_decode(client_key)
        .map_err(|e| format!("DTLS_PSK_DECODE_FAILED: {e}"))?;

    let psk_identity = username.to_string();

    let mut builder = SslConnector::builder(SslMethod::dtls())
        .map_err(|e| format!("DTLS_CONNECTOR_BUILD_FAILED: {e}"))?;

    // Disable certificate verification (bridge uses self-signed cert).
    builder.set_verify(SslVerifyMode::NONE);

    // Set PSK client callback: bridge expects username as identity, clientkey as PSK.
    builder.set_psk_client_callback(move |_ssl, _hint, identity_out, psk_out| {
        // Write PSK identity
        let identity_bytes = psk_identity.as_bytes();
        let ilen = identity_bytes.len().min(identity_out.len().saturating_sub(1));
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
    let socket = UdpSocket::bind("0.0.0.0:0")
        .map_err(|e| format!("DTLS_SOCKET_BIND_FAILED: {e}"))?;
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
fn hex_decode(hex: &str) -> Result<Vec<u8>, String> {
    if hex.len() % 2 != 0 {
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

// ---------------------------------------------------------------------------
// Entertainment configuration activate/deactivate via CLIP v2
// ---------------------------------------------------------------------------

/// PUT /clip/v2/resource/entertainment_configuration/{area_id}
/// body: { "action": "start" }
///
/// This tells the bridge to enter entertainment mode for the given area.
/// Must be called BEFORE starting the DTLS stream.
fn activate_entertainment_config(
    client: &BlockingClient,
    bridge_ip: &str,
    username: &str,
    area_id: &str,
) -> Result<(), String> {
    let endpoint = format!(
        "https://{bridge_ip}/clip/v2/resource/entertainment_configuration/{area_id}"
    );
    let response = client
        .put(&endpoint)
        .header("hue-application-key", username)
        .json(&json!({ "action": "start" }))
        .send()
        .map_err(|e| format!("ENTERTAINMENT_ACTIVATE_SEND_FAILED: {e}"))?;

    let status = response.status();
    if status == reqwest::StatusCode::FORBIDDEN {
        return Err("AUTH_INVALID_ENTERTAINMENT_ACTIVATE: 403 Forbidden".to_string());
    }
    if !status.is_success() {
        let body = response.text().unwrap_or_default();
        return Err(format!(
            "ENTERTAINMENT_ACTIVATE_FAILED: HTTP {status} — {body}"
        ));
    }
    Ok(())
}

/// PUT /clip/v2/resource/entertainment_configuration/{area_id}
/// body: { "action": "stop" }
///
/// Tells the bridge to exit entertainment mode. Called when stopping the stream.
fn deactivate_entertainment_config(
    client: &BlockingClient,
    bridge_ip: &str,
    username: &str,
    area_id: &str,
) -> Result<(), String> {
    let endpoint = format!(
        "https://{bridge_ip}/clip/v2/resource/entertainment_configuration/{area_id}"
    );
    let response = client
        .put(&endpoint)
        .header("hue-application-key", username)
        .json(&json!({ "action": "stop" }))
        .send()
        .map_err(|e| format!("ENTERTAINMENT_DEACTIVATE_SEND_FAILED: {e}"))?;

    let status = response.status();
    if !status.is_success() {
        let body = response.text().unwrap_or_default();
        return Err(format!(
            "ENTERTAINMENT_DEACTIVATE_FAILED: HTTP {status} — {body}"
        ));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Background DTLS sender thread
// ---------------------------------------------------------------------------

/// Spawns a background thread that:
/// 1. Activates the entertainment configuration via HTTPS
/// 2. Connects via DTLS 1.2 PSK to bridge:2100
/// 3. Continuously sends HueStream frames at 20 Hz
/// 4. On channel close or error, deactivates entertainment config
///
/// Returns the color sender handle, a shutdown signal that fires when the
/// thread exits, and the DTLS cipher name used during the handshake.
fn spawn_hue_dtls_sender(
    client: Arc<BlockingClient>,
    bridge_ip: String,
    username: String,
    client_key: String,
    area_id: String,
    channels: Vec<HueAreaChannel>,
    packet_counter: Arc<std::sync::atomic::AtomicU32>,
) -> Result<(HueColorSender, ShutdownSignal, Option<String>), String> {
    let channel_count = channels.len();
    let (tx, rx) = std::sync::mpsc::sync_channel::<HueColorUpdate>(2);
    let tx = Arc::new(tx);

    // Activate entertainment mode via HTTPS before starting DTLS.
    activate_entertainment_config(&client, &bridge_ip, &username, &area_id)?;

    // Establish DTLS connection.
    let mut dtls_stream = connect_dtls(&bridge_ip, &username, &client_key)?;

    // Extract cipher name from the established handshake.
    let cipher_name = dtls_stream.ssl().current_cipher()
        .map(|c| c.name().to_string());

    // Spawn the sender thread.
    let deactivate_client = client;
    let deactivate_ip = bridge_ip.clone();
    let deactivate_username = username.clone();
    let deactivate_area_id = area_id.clone();

    let shutdown = new_shutdown_signal();
    let shutdown_inner = Arc::clone(&shutdown);

    thread::spawn(move || {
        use std::io::Write;

        let min_interval = Duration::from_millis(HUE_SENDER_MIN_INTERVAL_MS);
        let mut last_sent_at = Instant::now()
            .checked_sub(min_interval)
            .unwrap_or_else(Instant::now);

        // Keep-alive: send a frame even when no update arrives, to prevent the
        // bridge from closing the stream after ~10s of inactivity.
        let keepalive_timeout = Duration::from_secs(2);

        // Last known frame data for keep-alive re-sends.
        let mut last_colors: Vec<(u8, u8, u8)> = vec![(0, 0, 0); channels.len()];
        let mut last_brightness: f32 = 1.0;

        loop {
            // Try to receive with a timeout so we can send keep-alive frames.
            let update = match rx.recv_timeout(keepalive_timeout) {
                Ok(u) => Some(u),
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => None,
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
            };

            // If we got an update, drain any stale ones.
            let latest = if let Some(mut latest) = update {
                while let Ok(newer) = rx.try_recv() {
                    latest = newer;
                }
                last_colors = latest.channel_colors.clone();
                last_brightness = latest.brightness;
                latest
            } else {
                // Keep-alive: re-send the last known frame.
                HueColorUpdate {
                    channel_colors: last_colors.clone(),
                    brightness: last_brightness,
                }
            };

            // Honour the minimum interval so we don't slam the bridge.
            let elapsed = Instant::now().saturating_duration_since(last_sent_at);
            if elapsed < min_interval {
                thread::sleep(min_interval - elapsed);
            }

            // Build and send the HueStream binary frame.
            let frame = build_huestream_frame(&area_id, &channels, &latest.channel_colors, latest.brightness);
            if dtls_stream.write_all(&frame).is_err() {
                error!("DTLS write failed, stopping entertainment stream.");
                break;
            }

            // Increment packet counter for telemetry.
            packet_counter.fetch_add(1, std::sync::atomic::Ordering::Relaxed);

            last_sent_at = Instant::now();
        }

        // Cleanup: deactivate entertainment mode.
        let _ = deactivate_entertainment_config(
            &deactivate_client,
            &deactivate_ip,
            &deactivate_username,
            &deactivate_area_id,
        );

        // Signal that this thread has completed shutdown.
        signal_shutdown_complete(&shutdown_inner);
    });

    Ok((HueColorSender { tx, channel_count }, shutdown, cipher_name))
}

/// Fallback HTTP sender for when DTLS is not available (e.g. missing clientkey).
/// This uses the legacy per-light PUT approach.
///
/// Returns the color sender handle and a shutdown signal that fires when the
/// thread exits.
fn spawn_hue_http_sender(
    client: Arc<BlockingClient>,
    bridge_ip: String,
    username: String,
    channels: Vec<HueAreaChannel>,
) -> (HueColorSender, ShutdownSignal) {
    let channel_count = channels.len();
    let (tx, rx) = std::sync::mpsc::sync_channel::<HueColorUpdate>(2);
    let tx = Arc::new(tx);

    let shutdown = new_shutdown_signal();
    let shutdown_inner = Arc::clone(&shutdown);

    thread::spawn(move || {
        let min_interval = Duration::from_millis(HUE_SENDER_MIN_INTERVAL_MS);
        let mut last_sent_at = Instant::now()
            .checked_sub(min_interval)
            .unwrap_or_else(Instant::now);

        loop {
            let update = match rx.recv() {
                Ok(u) => u,
                Err(_) => break,
            };

            // Drain stale updates: keep only the latest.
            let mut latest = update;
            while let Ok(newer) = rx.try_recv() {
                latest = newer;
            }

            // Honour the minimum interval so we don't slam the bridge.
            let elapsed = Instant::now().saturating_duration_since(last_sent_at);
            if elapsed < min_interval {
                thread::sleep(min_interval - elapsed);
            }

            let brightness = latest.brightness;
            let client_ref: &BlockingClient = &client;
            let bridge_ref: &str = &bridge_ip;
            let username_ref: &str = &username;
            thread::scope(|s| {
                for (channel, color) in channels.iter().zip(latest.channel_colors.iter()) {
                    let (r, g, b) = *color;
                    let light_ids: &[String] = &channel.light_ids;
                    s.spawn(move || {
                        send_color_to_lights(
                            client_ref,
                            bridge_ref,
                            username_ref,
                            light_ids,
                            r,
                            g,
                            b,
                            brightness,
                        );
                    });
                }
            });

            last_sent_at = Instant::now();
        }

        // Signal that this thread has completed shutdown.
        signal_shutdown_complete(&shutdown_inner);
    });

    (HueColorSender { tx, channel_count }, shutdown)
}

/// Send to all lights via HTTP. For a single light: direct call. For multiple: parallel
/// threads via `thread::scope` so each HTTPS round-trip happens concurrently.
fn send_color_to_lights(
    client: &BlockingClient,
    bridge_ip: &str,
    username: &str,
    light_ids: &[String],
    r: u8,
    g: u8,
    b: u8,
    brightness: f32,
) {
    if light_ids.is_empty() {
        return;
    }

    let (x, y) = rgb_to_xy(r, g, b);
    let dimming = f64::from((brightness.clamp(0.0, 1.0) * 100.0) as f32);

    if light_ids.len() == 1 {
        let _ = send_light_put(client, bridge_ip, username, &light_ids[0], x, y, dimming);
        return;
    }

    thread::scope(|s| {
        for light_id in light_ids {
            s.spawn(|| {
                let _ = send_light_put(client, bridge_ip, username, light_id, x, y, dimming);
            });
        }
    });
}

fn send_light_put(
    client: &BlockingClient,
    bridge_ip: &str,
    username: &str,
    light_id: &str,
    x: f64,
    y: f64,
    dimming: f64,
) -> Result<(), String> {
    let endpoint = format!("https://{bridge_ip}/clip/v2/resource/light/{light_id}");
    client
        .put(endpoint)
        .header("hue-application-key", username)
        .json(&json!({
            "on": { "on": true },
            "dimming": { "brightness": dimming },
            "color": { "xy": { "x": x, "y": y } }
        }))
        .send()
        .and_then(|r| r.error_for_status())
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[derive(Clone, Debug)]
pub(crate) struct HueActiveStreamContext {
    pub(crate) bridge_ip: String,
    pub(crate) username: String,
    #[allow(dead_code)]
    pub(crate) client_key: String,
    pub(crate) area_id: String,
    pub(crate) channels: Vec<HueAreaChannel>,
    pub(crate) color_sender: HueColorSender,
    /// Whether this context uses real DTLS streaming (true) or HTTP fallback (false).
    pub(crate) uses_dtls: bool,
    /// Fires when the background sender thread exits. Used by `stop_hue_stream`
    /// to wait for graceful shutdown before reporting success or timeout.
    pub(crate) shutdown_signal: ShutdownSignal,
}

#[derive(Clone, Debug)]
pub struct HueActiveOutputContext {
    pub channels: Vec<HueAreaChannel>,
    pub color_sender: HueColorSender,
}

impl Default for HueRuntimeOwner {
    fn default() -> Self {
        Self {
            state: HueRuntimeState::Idle,
            active_stream: None,
            persistent_sender: None,
            reconnect_attempt: 0,
            user_override_pending: false,
            last_status: status_with(
                HueRuntimeState::Idle,
                "HUE_STREAM_IDLE",
                "Hue runtime is idle.",
                None,
                HueRuntimeTriggerSource::System,
            ),
            last_solid_color: None,
            retry_policy: HueRetryPolicy::default(),
            stream_started_at: None,
            session_reconnect_total: 0,
            session_reconnect_success: 0,
            dtls_cipher: None,
            dtls_connected_at: None,
            last_error_code: None,
            last_error_at: None,
            packet_send_count: Arc::new(std::sync::atomic::AtomicU32::new(0)),
            packet_rate_sampled_at: None,
            packet_rate_last_count: 0,
        }
    }
}

pub struct HueRuntimeStateStore {
    runtime: Arc<Mutex<HueRuntimeOwner>>,
}

impl Default for HueRuntimeStateStore {
    fn default() -> Self {
        Self {
            runtime: Arc::new(Mutex::new(HueRuntimeOwner::default())),
        }
    }
}

impl HueRuntimeStateStore {
    pub fn runtime_arc(&self) -> Arc<Mutex<HueRuntimeOwner>> {
        Arc::clone(&self.runtime)
    }
}


/// If a solid color was queued while the stream context was not ready, attempt
/// to flush it now.  Called whenever we hold the lock and the context may have
/// just become available (e.g. after status_refresh_with_evidence confirms the
/// stream is healthy, or on a periodic get_hue_stream_status poll).
fn flush_pending_solid_color(owner: &mut HueRuntimeOwner) {
    if owner.last_status.code != "HUE_COLOR_QUEUED_PENDING_STREAM" {
        return;
    }
    if let (Some(color), Some(stream)) = (owner.last_solid_color.clone(), owner.active_stream.as_ref()) {
        if !stream.channels.is_empty() {
            stream.color_sender.try_send(color.r, color.g, color.b, color.brightness);
            owner.last_status = status_with(
                owner.state.clone(),
                "HUE_COLOR_APPLIED",
                "Queued solid color flushed after stream context became ready.",
                None,
                HueRuntimeTriggerSource::System,
            );
        }
    }
}

/// Acquire the Hue runtime mutex, recovering from poison if a previous holder
/// panicked.  This ensures a single panic inside the lock does not permanently
/// brick the Hue subsystem for the rest of the application lifetime.
pub(crate) fn acquire_hue_runtime(runtime: &Mutex<HueRuntimeOwner>) -> std::sync::MutexGuard<'_, HueRuntimeOwner> {
    runtime.lock().unwrap_or_else(|poison| {
        error!("Hue runtime mutex was poisoned — recovering from poison guard.");
        poison.into_inner()
    })
}


fn status_with(
    state: HueRuntimeState,
    code: &str,
    message: &str,
    details: Option<String>,
    trigger_source: HueRuntimeTriggerSource,
) -> HueRuntimeStatus {
    HueRuntimeStatus {
        state,
        code: code.to_string(),
        message: message.to_string(),
        details,
        remaining_attempts: None,
        next_attempt_ms: None,
        action_hint: None,
        trigger_source,
    }
}

fn make_result(owner: &HueRuntimeOwner) -> HueRuntimeCommandResult {
    HueRuntimeCommandResult {
        active: matches!(
            owner.state,
            HueRuntimeState::Starting | HueRuntimeState::Running | HueRuntimeState::Reconnecting
        ),
        status: owner.last_status.clone(),
        last_solid_color: owner.last_solid_color.clone(),
    }
}

fn start_with_evidence(
    owner: &mut HueRuntimeOwner,
    evidence: &HueRuntimeGateEvidence,
    trigger_source: HueRuntimeTriggerSource,
) -> HueRuntimeCommandResult {
    owner.user_override_pending = false;

    if matches!(
        owner.state,
        HueRuntimeState::Starting | HueRuntimeState::Running | HueRuntimeState::Reconnecting
    ) {
        owner.state = HueRuntimeState::Running;
        owner.last_status = status_with(
            HueRuntimeState::Running,
            "HUE_START_NOOP_ALREADY_ACTIVE",
            "Hue runtime already active. Start request is a no-op.",
            None,
            trigger_source,
        );
        return make_result(owner);
    }

    if evidence.auth_invalid_evidence {
        owner.state = HueRuntimeState::Failed;
        owner.active_stream = None;
        owner.last_status = status_with(
            HueRuntimeState::Failed,
            "AUTH_INVALID_CREDENTIALS",
            "Hue credentials are invalid. Re-pair is required before starting stream.",
            Some("Bridge returned explicit auth-invalid evidence.".to_string()),
            trigger_source,
        );
        owner.last_status.action_hint = Some(HueRuntimeActionHint::Repair);
        return make_result(owner);
    }

    let strict_gate_ok = evidence.bridge_configured
        && evidence.credentials_valid
        && evidence.area_selected
        && evidence.readiness_current
        && evidence.ready;

    if !strict_gate_ok {
        let mut missing = Vec::new();
        if !evidence.bridge_configured {
            missing.push("bridge");
        }
        if !evidence.credentials_valid {
            missing.push("credentials");
        }
        if !evidence.area_selected {
            missing.push("area");
        }
        if !evidence.readiness_current {
            missing.push("readiness");
        }
        if evidence.readiness_current && !evidence.ready {
            missing.push("ready");
        }

        owner.state = HueRuntimeState::Idle;
        owner.active_stream = None;
        owner.last_status = status_with(
            HueRuntimeState::Idle,
            "CONFIG_NOT_READY_GATE_BLOCKED",
            "Hue stream start blocked by strict backend readiness gate.",
            Some(format!("Missing prerequisites: {}", missing.join(", "))),
            trigger_source,
        );
        owner.last_status.action_hint = Some(if !evidence.area_selected {
            HueRuntimeActionHint::AdjustArea
        } else {
            HueRuntimeActionHint::Revalidate
        });
        return make_result(owner);
    }

    owner.reconnect_attempt = 0;
    owner.state = HueRuntimeState::Starting;
    owner.last_status = status_with(
        HueRuntimeState::Starting,
        "HUE_STREAM_STARTING",
        "Hue runtime is starting.",
        None,
        trigger_source.clone(),
    );

    owner.state = HueRuntimeState::Running;
    owner.last_status = status_with(
        HueRuntimeState::Running,
        "HUE_STREAM_RUNNING",
        "Hue runtime is running.",
        None,
        trigger_source,
    );
    make_result(owner)
}

fn status_refresh_with_evidence(
    owner: &mut HueRuntimeOwner,
    evidence: &HueRuntimeGateEvidence,
    details: Option<String>,
) -> HueRuntimeCommandResult {
    if owner.user_override_pending
        || !matches!(
            owner.state,
            HueRuntimeState::Starting | HueRuntimeState::Running | HueRuntimeState::Reconnecting
        )
    {
        return make_result(owner);
    }

    if evidence.auth_invalid_evidence {
        let reason =
            details.unwrap_or_else(|| "Hue readiness reported auth-invalid evidence.".to_string());
        return register_auth_invalid(owner, &reason, HueRuntimeTriggerSource::System);
    }

    if !evidence.readiness_current {
        let reason = details.unwrap_or_else(|| {
            "Hue readiness check reported a transient transport fault.".to_string()
        });
        return register_transient_fault(owner, &reason, HueRuntimeTriggerSource::System);
    }

    if !evidence.ready {
        owner.state = HueRuntimeState::Running;
        owner.last_status = status_with(
            HueRuntimeState::Running,
            "CONFIG_NOT_READY_GATE_BLOCKED",
            "Hue stream is active but area readiness is currently not satisfied.",
            details,
            HueRuntimeTriggerSource::System,
        );
        owner.last_status.action_hint = Some(HueRuntimeActionHint::Revalidate);
        owner.last_status.remaining_attempts = Some(
            owner
                .retry_policy
                .max_attempts
                .saturating_sub(owner.reconnect_attempt),
        );
        owner.last_status.next_attempt_ms = None;
        return make_result(owner);
    }

    owner.reconnect_attempt = 0;
    owner.state = HueRuntimeState::Running;
    owner.last_status = status_with(
        HueRuntimeState::Running,
        "HUE_STREAM_RUNNING",
        "Hue runtime is running.",
        details,
        HueRuntimeTriggerSource::System,
    );
    make_result(owner)
}

/// Spawn the Hue color sender (DTLS or HTTP fallback) **outside** any mutex
/// lock.  This function performs blocking network I/O (DTLS handshake, HTTP
/// activate) and must never be called while the `HueRuntimeOwner` lock is held.
/// Returns (sender, uses_dtls, shutdown_signal, cipher_name).
fn build_hue_sender(
    request: &StartHueStreamRequest,
    channels: Vec<HueAreaChannel>,
) -> (HueColorSender, bool, ShutdownSignal) {
    let packet_counter = Arc::new(std::sync::atomic::AtomicU32::new(0));
    let (sender, uses_dtls, shutdown, _cipher) = build_hue_sender_with_counter(request, channels, packet_counter);
    (sender, uses_dtls, shutdown)
}

/// Variant of `build_hue_sender` that takes an external packet counter and returns cipher.
fn build_hue_sender_with_counter(
    request: &StartHueStreamRequest,
    channels: Vec<HueAreaChannel>,
    packet_counter: Arc<std::sync::atomic::AtomicU32>,
) -> (HueColorSender, bool, ShutdownSignal, Option<String>) {
    let has_client_key = !request.client_key.trim().is_empty();

    if has_client_key {
        match hue_http_client_arc() {
            Ok(client) => {
                // Spawn DTLS attempt on a dedicated OS thread with a hard deadline.
                // DTLS handshake can block indefinitely if the bridge ignores UDP:2100 —
                // the socket-level read timeout is not honored by OpenSSL's retransmit loop.
                let (tx_result, rx_result) = std::sync::mpsc::channel();
                let client_clone = client.clone();
                let bridge_ip_t = request.bridge_ip.clone();
                let username_t = request.username.clone();
                let client_key_t = request.client_key.clone();
                let area_id_t = request.area_id.clone();
                let channels_t = channels.clone();
                let counter_t = Arc::clone(&packet_counter);

                std::thread::spawn(move || {
                    let result = spawn_hue_dtls_sender(
                        client_clone, bridge_ip_t, username_t, client_key_t, area_id_t, channels_t,
                        counter_t,
                    );
                    let _ = tx_result.send(result);
                });

                match rx_result.recv_timeout(Duration::from_secs(DTLS_CONNECT_TIMEOUT_SECS)) {
                    Ok(Ok((sender, shutdown, cipher_name))) => {
                        info!("DTLS entertainment stream established successfully.");
                        (sender, true, shutdown, cipher_name)
                    }
                    Ok(Err(err)) => {
                        warn!("DTLS connection failed ({err}), falling back to HTTP.");
                        let (sender, shutdown) = spawn_hue_http_sender(
                            client,
                            request.bridge_ip.clone(),
                            request.username.clone(),
                            channels.clone(),
                        );
                        (sender, false, shutdown, None)
                    }
                    Err(_timeout) => {
                        warn!("DTLS handshake timed out after {DTLS_CONNECT_TIMEOUT_SECS}s, falling back to HTTP.");
                        let (sender, shutdown) = spawn_hue_http_sender(
                            client,
                            request.bridge_ip.clone(),
                            request.username.clone(),
                            channels.clone(),
                        );
                        (sender, false, shutdown, None)
                    }
                }
            }
            Err(err) => {
                error!("HUE_SENDER_INIT_FAILED: {err}");
                let (tx, _rx) = std::sync::mpsc::sync_channel::<HueColorUpdate>(1);
                (HueColorSender { tx: Arc::new(tx), channel_count: 0 }, false, new_shutdown_signal(), None)
            }
        }
    } else {
        info!("No clientKey provided, using HTTP fallback sender.");
        match hue_http_client_arc() {
            Ok(client) => {
                let (sender, shutdown) = spawn_hue_http_sender(
                    client,
                    request.bridge_ip.clone(),
                    request.username.clone(),
                    channels.clone(),
                );
                (sender, false, shutdown, None)
            }
            Err(err) => {
                error!("HUE_SENDER_INIT_FAILED: {err}");
                let (tx, _rx) = std::sync::mpsc::sync_channel::<HueColorUpdate>(1);
                (HueColorSender { tx: Arc::new(tx), channel_count: 0 }, false, new_shutdown_signal(), None)
            }
        }
    }
}

/// Store an already-spawned sender into the runtime owner.  This function only
/// touches in-memory fields — no I/O — so it is safe to call under the lock.
fn store_active_stream_context(
    owner: &mut HueRuntimeOwner,
    request: &StartHueStreamRequest,
    channels: Vec<HueAreaChannel>,
    color_sender: HueColorSender,
    uses_dtls: bool,
    shutdown_signal: ShutdownSignal,
) {
    store_active_stream_context_with_cipher(owner, request, channels, color_sender, uses_dtls, shutdown_signal, None);
}

fn store_active_stream_context_with_cipher(
    owner: &mut HueRuntimeOwner,
    request: &StartHueStreamRequest,
    channels: Vec<HueAreaChannel>,
    color_sender: HueColorSender,
    uses_dtls: bool,
    shutdown_signal: ShutdownSignal,
    cipher_name: Option<String>,
) {
    // Keep a persistent clone that survives stream stop/start cycles.
    if !channels.is_empty() {
        owner.persistent_sender = Some(HuePersistentSender {
            channels: channels.clone(),
            sender: color_sender.clone(),
        });
    }

    owner.active_stream = Some(HueActiveStreamContext {
        bridge_ip: request.bridge_ip.clone(),
        username: request.username.clone(),
        client_key: request.client_key.clone(),
        area_id: request.area_id.clone(),
        channels,
        color_sender,
        uses_dtls,
        shutdown_signal,
    });

    // Update telemetry tracking fields.
    owner.stream_started_at = Some(Instant::now());
    owner.reconnect_attempt = 0;
    owner.packet_send_count.store(0, std::sync::atomic::Ordering::Relaxed);
    owner.packet_rate_sampled_at = Some(Instant::now());
    owner.packet_rate_last_count = 0;
    if uses_dtls {
        owner.dtls_cipher = cipher_name;
        owner.dtls_connected_at = Some(Instant::now());
    }
}

static HUE_BLOCKING_CLIENT: OnceLock<Arc<BlockingClient>> = OnceLock::new();

fn hue_http_client() -> Result<BlockingClient, String> {
    BlockingClient::builder()
        .timeout(Duration::from_millis(HUE_HTTP_TIMEOUT_MS))
        .danger_accept_invalid_certs(true)
        .build()
        .map_err(|error| error.to_string())
}

fn hue_http_client_arc() -> Result<Arc<BlockingClient>, String> {
    Ok(Arc::clone(HUE_BLOCKING_CLIENT.get_or_init(|| {
        Arc::new(
            BlockingClient::builder()
                .timeout(Duration::from_millis(HUE_HTTP_TIMEOUT_MS))
                .danger_accept_invalid_certs(true)
                .build()
                .expect("Failed to build Hue blocking HTTP client")
        )
    })))
}

fn async_hue_http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_millis(HUE_HTTP_TIMEOUT_MS))
        .danger_accept_invalid_certs(true)
        .build()
        .map_err(|error| error.to_string())
}

/// Map a Hue channel's 2D position (x: -1 left ... +1 right, y: -1 bottom ... +1 top)
/// to the screen region whose colour that channel should display.
fn channel_position_to_screen_region(x: f32, y: f32) -> HueScreenRegion {
    let abs_x = x.abs();
    let abs_y = y.abs();
    if abs_x >= abs_y {
        if x < -0.3 {
            HueScreenRegion::Left
        } else if x > 0.3 {
            HueScreenRegion::Right
        } else {
            HueScreenRegion::Center
        }
    } else if y > 0.3 {
        HueScreenRegion::Top
    } else if y < -0.3 {
        HueScreenRegion::Bottom
    } else {
        HueScreenRegion::Center
    }
}

async fn fetch_area_channels(
    bridge_ip: &str,
    username: &str,
    area_id: &str,
) -> Result<Vec<HueAreaChannel>, String> {
    let client = async_hue_http_client()?;
    let endpoint =
        format!("https://{bridge_ip}/clip/v2/resource/entertainment_configuration/{area_id}");
    let response = client
        .get(endpoint)
        .header("hue-application-key", username)
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|error| error.to_string())?;
    let payload = response.text().await.map_err(|error| error.to_string())?;

    let parsed: Value = serde_json::from_str(&payload).map_err(|error| error.to_string())?;
    let raw_channels = parsed
        .get("data")
        .and_then(|value| value.as_array())
        .and_then(|items| items.first())
        .and_then(|item| item.get("channels"))
        .and_then(|value| value.as_array())
        .ok_or_else(|| "Missing channels in entertainment area payload".to_string())?;

    fn push_unique(target: &mut Vec<String>, id: &str) {
        if !target.iter().any(|existing| existing == id) {
            target.push(id.to_string());
        }
    }

    async fn fetch_resource(
        client: &reqwest::Client,
        bridge_ip: &str,
        username: &str,
        rtype: &str,
        rid: &str,
    ) -> Result<Value, String> {
        let endpoint = format!("https://{bridge_ip}/clip/v2/resource/{rtype}/{rid}");
        let response = client
            .get(endpoint)
            .header("hue-application-key", username)
            .send()
            .await
            .and_then(|r| r.error_for_status())
            .map_err(|error| error.to_string())?;
        let payload = response.text().await.map_err(|error| error.to_string())?;
        serde_json::from_str::<Value>(&payload).map_err(|error| error.to_string())
    }

    async fn resolve_to_light_ids(
        client: &reqwest::Client,
        bridge_ip: &str,
        username: &str,
        seed_rtype: &str,
        seed_rid: &str,
    ) -> Vec<String> {
        let mut resolved = Vec::new();
        if seed_rtype == "light" {
            resolved.push(seed_rid.to_string());
            return resolved;
        }
        let mut current_rtype = seed_rtype.to_string();
        let mut current_rid = seed_rid.to_string();
        for _ in 0..4 {
            let resource = match fetch_resource(
                client,
                bridge_ip,
                username,
                &current_rtype,
                &current_rid,
            )
            .await
            {
                Ok(value) => value,
                Err(_) => return resolved,
            };
            let Some(item) = resource
                .get("data")
                .and_then(|value| value.as_array())
                .and_then(|items| items.first())
            else {
                return resolved;
            };
            let svc_array = item
                .get("light_services")
                .or_else(|| item.get("services"))
                .and_then(|value| value.as_array());
            if let Some(light_services) = svc_array {
                for light in light_services {
                    let rid = light.get("rid").and_then(|value| value.as_str());
                    let rtype = light.get("rtype").and_then(|value| value.as_str());
                    if matches!(rtype, Some("light")) {
                        if let Some(light_id) = rid {
                            push_unique(&mut resolved, light_id);
                        }
                    }
                }
                if !resolved.is_empty() {
                    return resolved;
                }
            }
            let Some(owner) = item.get("owner") else {
                return resolved;
            };
            let Some(next_rtype) = owner.get("rtype").and_then(|value| value.as_str()) else {
                return resolved;
            };
            let Some(next_rid) = owner.get("rid").and_then(|value| value.as_str()) else {
                return resolved;
            };
            if next_rtype == "light" {
                push_unique(&mut resolved, next_rid);
                return resolved;
            }
            current_rtype = next_rtype.to_string();
            current_rid = next_rid.to_string();
        }
        resolved
    }

    // Build one `HueAreaChannel` per entertainment channel, preserving position.
    let mut result: Vec<HueAreaChannel> = Vec::new();

    for (idx, raw_ch) in raw_channels.iter().enumerate() {
        // Extract the channel_id from the bridge payload.
        let channel_id = raw_ch
            .get("channel_id")
            .and_then(|v| v.as_u64())
            .unwrap_or(idx as u64) as u8;

        // Extract position.x and position.y (default 0.0 if absent).
        let pos = raw_ch.get("position");
        let pos_x = pos
            .and_then(|p| p.get("x"))
            .and_then(|v| v.as_f64())
            .unwrap_or(0.0) as f32;
        let pos_y = pos
            .and_then(|p| p.get("y"))
            .and_then(|v| v.as_f64())
            .unwrap_or(0.0) as f32;

        let screen_region = channel_position_to_screen_region(pos_x, pos_y);

        let mut light_ids: Vec<String> = Vec::new();

        let Some(members) = raw_ch.get("members").and_then(|value| value.as_array()) else {
            result.push(HueAreaChannel {
                channel_id,
                light_ids,
                screen_region,
                position_x: pos_x,
                position_y: pos_y,
            });
            continue;
        };

        for member in members {
            let Some(service) = member.get("service") else {
                continue;
            };
            let Some(rtype) = service.get("rtype").and_then(|value| value.as_str()) else {
                continue;
            };
            let Some(rid) = service.get("rid").and_then(|value| value.as_str()) else {
                continue;
            };
            for light_id in
                resolve_to_light_ids(&client, bridge_ip, username, rtype, rid).await
            {
                push_unique(&mut light_ids, &light_id);
            }
        }

        result.push(HueAreaChannel {
            channel_id,
            light_ids,
            screen_region,
            position_x: pos_x,
            position_y: pos_y,
        });
    }

    Ok(result)
}

/// Apply user-supplied region overrides to a channel list fetched from the bridge.
fn apply_channel_region_overrides(
    channels: &mut Vec<HueAreaChannel>,
    overrides: &[Option<String>],
) {
    for (i, channel) in channels.iter_mut().enumerate() {
        if let Some(Some(region_str)) = overrides.get(i) {
            if let Some(region) = parse_screen_region(region_str) {
                channel.screen_region = region;
            }
        }
    }
}

fn channels_to_info(channels: &[HueAreaChannel]) -> Vec<HueAreaChannelInfo> {
    channels
        .iter()
        .enumerate()
        .map(|(index, ch)| HueAreaChannelInfo {
            index,
            position_x: ch.position_x,
            position_y: ch.position_y,
            light_count: ch.light_ids.len(),
            auto_region: ch.screen_region.as_str().to_string(),
        })
        .collect()
}

/// Return channel metadata for the selected Hue entertainment area.
/// Prefers the channels already resolved by the active runtime stream to avoid
/// a redundant bridge round-trip (and race with `start_hue_stream`). Falls back
/// to a live bridge fetch only when the runtime has no matching data.
#[tauri::command]
pub async fn get_hue_area_channels(
    bridge_ip: String,
    username: String,
    area_id: String,
    runtime_state: State<'_, HueRuntimeStateStore>,
) -> Result<Vec<HueAreaChannelInfo>, String> {
    // Fast path: reuse channels already resolved by the running stream (brief lock, no I/O).
    {
        let owner = acquire_hue_runtime(&runtime_state.runtime);
        if let Some(stream) = owner.active_stream.as_ref() {
            if stream.area_id == area_id && !stream.channels.is_empty() {
                return Ok(channels_to_info(&stream.channels));
            }
        }
        // Also check persistent sender (covers app-startup solid-only mode).
        if let Some(persistent) = owner.persistent_sender.as_ref() {
            if !persistent.channels.is_empty() {
                return Ok(channels_to_info(&persistent.channels));
            }
        }
    } // lock released before any async I/O
    // Slow path: fetch directly from bridge (no lock held).
    let channels = fetch_area_channels(&bridge_ip, &username, &area_id).await?;
    Ok(channels_to_info(&channels))
}

fn rgb_to_xy(r: u8, g: u8, b: u8) -> (f64, f64) {
    let mut red = f64::from(r) / 255.0;
    let mut green = f64::from(g) / 255.0;
    let mut blue = f64::from(b) / 255.0;

    red = if red > 0.04045 {
        ((red + 0.055) / 1.055).powf(2.4)
    } else {
        red / 12.92
    };
    green = if green > 0.04045 {
        ((green + 0.055) / 1.055).powf(2.4)
    } else {
        green / 12.92
    };
    blue = if blue > 0.04045 {
        ((blue + 0.055) / 1.055).powf(2.4)
    } else {
        blue / 12.92
    };

    let x = red * 0.664_511 + green * 0.154_324 + blue * 0.162_028;
    let y = red * 0.283_881 + green * 0.668_433 + blue * 0.047_685;
    let z = red * 0.000_088 + green * 0.072_31 + blue * 0.986_039;
    let sum = x + y + z;

    if sum <= f64::EPSILON {
        return (0.3127, 0.3290);
    }

    (x / sum, y / sum)
}


pub fn snapshot_hue_output_context(
    runtime_state: &HueRuntimeStateStore,
) -> Result<Option<HueActiveOutputContext>, String> {
    let owner = acquire_hue_runtime(&runtime_state.runtime);

    Ok(owner.active_stream.as_ref().map(|stream| HueActiveOutputContext {
        channels: stream.channels.clone(),
        color_sender: stream.color_sender.clone(),
    }))
}

/// Broadcast one colour to every channel (solid-colour path).
/// Always returns `Ok(())` immediately -- never blocks the caller.
pub fn apply_hue_color_with_context(
    context: &HueActiveOutputContext,
    r: u8,
    g: u8,
    b: u8,
    brightness: f32,
) -> Result<(), String> {
    if context.channels.is_empty() {
        return Err("HUE_COLOR_APPLY_SKIPPED_NO_LIGHTS".to_string());
    }
    context.color_sender.try_send(r, g, b, brightness);
    Ok(())
}

/// Send individual colours per channel (ambilight path).
/// `channel_colors` must be ordered the same as `context.channels`.
/// Always returns `Ok(())` immediately -- never blocks the caller.
pub fn apply_hue_channels_with_context(
    context: &HueActiveOutputContext,
    channel_colors: Vec<(u8, u8, u8)>,
    brightness: f32,
) -> Result<(), String> {
    if context.channels.is_empty() {
        return Err("HUE_COLOR_APPLY_SKIPPED_NO_LIGHTS".to_string());
    }
    context.color_sender.try_send_channels(channel_colors, brightness);
    Ok(())
}


fn next_backoff_ms(policy: &HueRetryPolicy, attempt_index: u8) -> u64 {
    let exponent = u32::from(attempt_index.saturating_sub(1));
    let factor = 2_u64.saturating_pow(exponent);
    let raw = policy.base_backoff_ms.saturating_mul(factor);
    raw.min(policy.cap_backoff_ms)
}

fn register_transient_fault(
    owner: &mut HueRuntimeOwner,
    details: &str,
    trigger_source: HueRuntimeTriggerSource,
) -> HueRuntimeCommandResult {
    if owner.user_override_pending {
        owner.state = HueRuntimeState::Idle;
        owner.last_status = status_with(
            HueRuntimeState::Idle,
            "HUE_STOPPED_BY_USER",
            "User action canceled reconnect workflow.",
            None,
            trigger_source,
        );
        return make_result(owner);
    }

    owner.state = HueRuntimeState::Reconnecting;
    let next_attempt_index = owner.reconnect_attempt.saturating_add(1);
    if next_attempt_index >= owner.retry_policy.max_attempts {
        owner.reconnect_attempt = owner.retry_policy.max_attempts;
        owner.state = HueRuntimeState::Failed;
        owner.last_status = status_with(
            HueRuntimeState::Failed,
            "TRANSIENT_RETRY_EXHAUSTED",
            "Transient retry budget exhausted. Hue runtime moved to failed state.",
            Some(details.to_string()),
            trigger_source,
        );
        owner.last_status.action_hint = Some(HueRuntimeActionHint::Retry);
        owner.last_status.remaining_attempts = Some(0);
        owner.last_status.next_attempt_ms = None;
        return make_result(owner);
    }

    owner.reconnect_attempt = next_attempt_index;
    owner.last_status = status_with(
        HueRuntimeState::Reconnecting,
        "TRANSIENT_RETRY_SCHEDULED",
        "Hue runtime scheduled bounded reconnect attempt.",
        Some(details.to_string()),
        trigger_source,
    );
    owner.last_status.action_hint = Some(HueRuntimeActionHint::Reconnect);
    owner.last_status.remaining_attempts = Some(
        owner
            .retry_policy
            .max_attempts
            .saturating_sub(owner.reconnect_attempt),
    );
    owner.last_status.next_attempt_ms = Some(next_backoff_ms(
        &owner.retry_policy,
        owner.reconnect_attempt,
    ));
    // Record error for telemetry.
    owner.last_error_code = Some(owner.last_status.code.clone());
    owner.last_error_at = Some(Instant::now());
    make_result(owner)
}

fn register_auth_invalid(
    owner: &mut HueRuntimeOwner,
    details: &str,
    trigger_source: HueRuntimeTriggerSource,
) -> HueRuntimeCommandResult {
    owner.state = HueRuntimeState::Failed;
    owner.last_status = status_with(
        HueRuntimeState::Failed,
        "AUTH_INVALID_CREDENTIALS",
        "Hue credentials are invalid and require repair.",
        Some(details.to_string()),
        trigger_source,
    );
    owner.last_status.action_hint = Some(HueRuntimeActionHint::Repair);
    owner.last_status.remaining_attempts = Some(0);
    owner.last_status.next_attempt_ms = None;
    // Record error for telemetry.
    owner.last_error_code = Some(owner.last_status.code.clone());
    owner.last_error_at = Some(Instant::now());
    make_result(owner)
}

fn stop_with_timeout(
    owner: &mut HueRuntimeOwner,
    timed_out: bool,
    trigger_source: HueRuntimeTriggerSource,
) -> HueRuntimeCommandResult {
    owner.user_override_pending = true;
    owner.state = HueRuntimeState::Stopping;
    owner.last_status = status_with(
        HueRuntimeState::Stopping,
        "HUE_STREAM_STOPPING",
        "Hue runtime stop requested. Running deterministic cleanup.",
        Some("cleanup-order=stream-stop->state-restore".to_string()),
        trigger_source.clone(),
    );

    // Dropping active_stream (and thus the sender Arc) closes the mpsc channel,
    // which causes the background thread to exit. DTLS deactivation is performed
    // by the caller AFTER releasing the lock to avoid blocking the mutex on HTTP I/O.

    owner.reconnect_attempt = 0;
    owner.active_stream = None;
    // A4: Drop persistent_sender so the background thread's mpsc channel closes
    // immediately (Arc refcount falls to zero). Without this, wait_for_shutdown
    // always times out because the thread's recv loop never sees Disconnected.
    owner.persistent_sender = None;
    owner.state = HueRuntimeState::Idle;
    if timed_out {
        owner.last_status = status_with(
            HueRuntimeState::Idle,
            "HUE_STOP_TIMEOUT_PARTIAL",
            "Hue runtime reached stop timeout; partial-stop cleanup reported.",
            Some("retry stop to ensure bridge state restore".to_string()),
            trigger_source,
        );
        owner.last_status.action_hint = Some(HueRuntimeActionHint::Retry);
    } else {
        owner.last_status = status_with(
            HueRuntimeState::Idle,
            "HUE_STREAM_STOPPED",
            "Hue runtime stopped and state restored to non-stream mode.",
            None,
            trigger_source,
        );
    }
    make_result(owner)
}

/// RAII guard that resets the Hue runtime to `Failed` if `start_hue_stream`
/// exits without successfully completing step 4c.  Call `.disarm()` once
/// `store_active_stream_context` has been called.
struct StartAbortGuard {
    runtime: Arc<Mutex<HueRuntimeOwner>>,
    armed: bool,
}

impl StartAbortGuard {
    fn new(runtime: Arc<Mutex<HueRuntimeOwner>>) -> Self {
        Self { runtime, armed: true }
    }
    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for StartAbortGuard {
    fn drop(&mut self) {
        if !self.armed { return; }
        let mut owner = acquire_hue_runtime(&self.runtime);
        if matches!(owner.state, HueRuntimeState::Starting | HueRuntimeState::Running) {
            owner.state = HueRuntimeState::Failed;
            owner.active_stream = None;
            owner.last_status = status_with(
                HueRuntimeState::Failed,
                "HUE_STREAM_START_ABORTED",
                "Hue stream start was aborted before the stream context could be established.",
                Some("Retry start. If this persists, check bridge connectivity.".to_string()),
                HueRuntimeTriggerSource::System,
            );
            owner.last_status.action_hint = Some(HueRuntimeActionHint::Retry);
        }
    }
}

#[tauri::command]
pub async fn start_hue_stream(
    request: StartHueStreamRequest,
    runtime_state: State<'_, HueRuntimeStateStore>,
) -> Result<HueRuntimeCommandResult, String> {
    let trigger = request
        .trigger_source
        .clone()
        .unwrap_or(HueRuntimeTriggerSource::ModeControl);

    // 1. Async readiness check -- no lock held during network I/O.
    let readiness = check_hue_stream_readiness(
        request.bridge_ip.clone(),
        request.username.clone(),
        request.area_id.clone(),
    )
    .await;

    let gate = HueRuntimeGateEvidence {
        bridge_configured: !request.bridge_ip.trim().is_empty(),
        credentials_valid: !request.username.trim().is_empty(),
        area_selected: !request.area_id.trim().is_empty(),
        readiness_current: readiness.status.code != "HUE_STREAM_READINESS_FAILED",
        ready: readiness.readiness.ready,
        auth_invalid_evidence: readiness.status.code.starts_with("AUTH_INVALID_")
            || readiness.status.code == "HUE_CREDENTIAL_INVALID",
    };

    // 2. Lock briefly for state decision only.
    let result = {
        let mut owner = acquire_hue_runtime(&runtime_state.runtime);
        let result = start_with_evidence(&mut owner, &gate, trigger);
        // If the stream was already active (NOOP), return early without re-fetching
        // channels. Re-fetching while the stream is live can fail and would overwrite
        // the working channel/sender state with empty data, breaking solid color.
        if result.status.code == "HUE_START_NOOP_ALREADY_ACTIVE" {
            return Ok(result);
        }
        result
    }; // lock released before async I/O

    // Abort guard: if we exit before step 4c stores the context, roll back to Failed.
    let mut abort_guard = StartAbortGuard::new(runtime_state.runtime_arc());

    // 3. Async channel fetch -- no lock held.
    let mut channels = if result.active {
        fetch_area_channels(&request.bridge_ip, &request.username, &request.area_id)
            .await
            .unwrap_or_default()
    } else {
        Vec::new()
    };
    if let Some(overrides) = &request.channel_region_overrides {
        apply_channel_region_overrides(&mut channels, overrides);
    }

    // 4a. Lock briefly for race-condition guard only.
    let has_no_lights = result.active && channels.is_empty();
    {
        let owner = acquire_hue_runtime(&runtime_state.runtime);
        if matches!(owner.state, HueRuntimeState::Idle | HueRuntimeState::Stopping | HueRuntimeState::Failed) {
            abort_guard.disarm();
            return Ok(make_result(&owner));
        }
    } // lock released before blocking I/O

    // 4b. Spawn sender on a blocking thread — DTLS handshake / HTTP activate
    //     create/drop a reqwest::blocking::Client which panics on Tokio workers.
    let (color_sender, uses_dtls, shutdown_signal) = if result.active {
        let req = request.clone();
        let ch = channels.clone();
        tokio::task::spawn_blocking(move || build_hue_sender(&req, ch))
            .await
            .unwrap_or_else(|_join_err| {
                error!("build_hue_sender task panicked, using no-op sender.");
                let (tx, _rx) = std::sync::mpsc::sync_channel::<HueColorUpdate>(1);
                (HueColorSender { tx: Arc::new(tx), channel_count: 0 }, false, new_shutdown_signal())
            })
    } else {
        let (tx, _rx) = std::sync::mpsc::sync_channel::<HueColorUpdate>(1);
        (HueColorSender { tx: Arc::new(tx), channel_count: 0 }, false, new_shutdown_signal())
    };

    // 4c. Re-acquire lock to store the spawned sender context.
    let final_result = {
        let mut owner = acquire_hue_runtime(&runtime_state.runtime);

        // Second race-condition guard: a stop may have arrived while we were
        // spawning the sender.
        if matches!(owner.state, HueRuntimeState::Idle | HueRuntimeState::Stopping | HueRuntimeState::Failed) {
            abort_guard.disarm();
            return Ok(make_result(&owner));
        }

        store_active_stream_context(&mut owner, &request, channels, color_sender, uses_dtls, shutdown_signal);
        abort_guard.disarm();

        if has_no_lights {
            owner.last_status = status_with(
                HueRuntimeState::Running,
                "HUE_STREAM_RUNNING_NO_LIGHTS",
                "Hue runtime started but no color-addressable lights were resolved for the selected area.",
                Some("Revalidate area members and restart Hue runtime.".to_string()),
                HueRuntimeTriggerSource::System,
            );
            owner.last_status.action_hint = Some(HueRuntimeActionHint::Revalidate);
            return Ok(make_result(&owner));
        }

        // If DTLS was established, update the status to indicate entertainment streaming.
        if let Some(stream) = owner.active_stream.as_ref() {
            if stream.uses_dtls {
                owner.last_status = status_with(
                    HueRuntimeState::Running,
                    "HUE_STREAM_RUNNING_DTLS",
                    "Hue entertainment stream active via DTLS.",
                    None,
                    HueRuntimeTriggerSource::System,
                );
            }
        }

        // Flush any solid color that was queued while the stream context was not ready.
        flush_pending_solid_color(&mut owner);

        make_result(&owner)
    };

    // Spawn reconnect monitor to detect sender thread exit and trigger bounded retry.
    {
        let owner = acquire_hue_runtime(&runtime_state.runtime);
        if let Some(ref stream) = owner.active_stream {
            spawn_reconnect_monitor(
                Arc::clone(&stream.shutdown_signal),
                runtime_state.runtime_arc(),
                request.clone(),
            );
        }
    }

    Ok(final_result)
}

/// Stop the Hue entertainment stream with a bounded wait for the background
/// sender thread to exit. If the thread does not shut down within
/// `HUE_STOP_TIMEOUT_SECS`, the command reports `HUE_STOP_TIMEOUT_PARTIAL`
/// with an action hint to retry.
///
/// This is a **synchronous** Tauri command. Tauri automatically dispatches
/// sync commands onto a blocking thread pool, so the `Condvar` wait inside
/// will never starve the async runtime.
#[tauri::command]
pub fn stop_hue_stream(
    trigger_source: Option<HueRuntimeTriggerSource>,
    runtime_state: State<'_, HueRuntimeStateStore>,
) -> Result<HueRuntimeCommandResult, String> {
    let trigger = trigger_source.unwrap_or(HueRuntimeTriggerSource::System);

    // 1. Brief lock: extract the shutdown signal and DTLS deactivation params,
    //    then initiate cleanup.  Dropping the active_stream (and thus the sender
    //    Arc) closes the mpsc channel, which unblocks the background thread's
    //    recv loop.  DTLS deactivation HTTP call happens AFTER the lock is released.
    let (maybe_shutdown, dtls_deactivate) = {
        let mut owner = acquire_hue_runtime(&runtime_state.runtime);

        // Grab the shutdown signal before stop_with_timeout drops active_stream.
        let signal = owner
            .active_stream
            .as_ref()
            .map(|s| Arc::clone(&s.shutdown_signal));

        // Extract DTLS deactivation params before active_stream is cleared.
        let dtls_deactivate = owner.active_stream.as_ref()
            .filter(|s| s.uses_dtls)
            .map(|s| (s.bridge_ip.clone(), s.username.clone(), s.area_id.clone()));

        // Perform synchronous cleanup (drop sender, reset state).
        // We pass `timed_out=false` initially; if the wait below times out
        // we will re-lock and update the status.
        let _ = stop_with_timeout(&mut owner, false, trigger.clone());

        (signal, dtls_deactivate)
    }; // lock released -- background thread can now observe the channel close.

    // Best-effort DTLS deactivation outside the lock to avoid blocking the mutex.
    if let Some((ip, username, area_id)) = dtls_deactivate {
        if let Ok(client) = hue_http_client() {
            let _ = deactivate_entertainment_config(&client, &ip, &username, &area_id);
        }
    }

    // 2. If there was an active stream, wait for the sender thread to confirm
    //    shutdown within HUE_STOP_TIMEOUT_SECS.
    if let Some(shutdown_signal) = maybe_shutdown {
        let shutdown_ok = wait_for_shutdown(
            &shutdown_signal,
            Duration::from_secs(HUE_STOP_TIMEOUT_SECS),
        );

        if !shutdown_ok {
            // 3. Re-lock and overwrite status to reflect the partial-stop timeout.
            let mut owner = acquire_hue_runtime(&runtime_state.runtime);
            owner.last_status = status_with(
                HueRuntimeState::Idle,
                "HUE_STOP_TIMEOUT_PARTIAL",
                "Hue runtime reached stop timeout; partial-stop cleanup reported.",
                Some("retry stop to ensure bridge state restore".to_string()),
                trigger,
            );
            owner.last_status.action_hint = Some(HueRuntimeActionHint::Retry);
            return Ok(make_result(&owner));
        }
    }

    // Either no active stream existed or the thread shut down in time.
    let owner = acquire_hue_runtime(&runtime_state.runtime);
    Ok(make_result(&owner))
}

#[tauri::command]
pub async fn restart_hue_stream(
    request: StartHueStreamRequest,
    runtime_state: State<'_, HueRuntimeStateStore>,
) -> Result<HueRuntimeCommandResult, String> {
    let trigger = request
        .trigger_source
        .clone()
        .unwrap_or(HueRuntimeTriggerSource::DeviceSurface);

    // 1. Stop first -- brief lock, no I/O.  Extract DTLS deactivation params
    //    before the lock is released so we can deactivate outside the lock.
    let dtls_deactivate = {
        let mut owner = acquire_hue_runtime(&runtime_state.runtime);
        let dtls_deactivate = owner.active_stream.as_ref()
            .filter(|s| s.uses_dtls)
            .map(|s| (s.bridge_ip.clone(), s.username.clone(), s.area_id.clone()));
        let _ = stop_with_timeout(&mut owner, false, trigger.clone());
        dtls_deactivate
    }; // lock released before async I/O

    // Best-effort DTLS deactivation outside the lock.
    if let Some((ip, username, area_id)) = dtls_deactivate {
        let _ = tokio::task::spawn_blocking(move || {
            if let Ok(client) = hue_http_client() {
                let _ = deactivate_entertainment_config(&client, &ip, &username, &area_id);
            }
        }).await;
    }

    // 2. Async readiness check -- no lock held.
    let readiness = check_hue_stream_readiness(
        request.bridge_ip.clone(),
        request.username.clone(),
        request.area_id.clone(),
    )
    .await;

    let gate = HueRuntimeGateEvidence {
        bridge_configured: !request.bridge_ip.trim().is_empty(),
        credentials_valid: !request.username.trim().is_empty(),
        area_selected: !request.area_id.trim().is_empty(),
        readiness_current: readiness.status.code != "HUE_STREAM_READINESS_FAILED",
        ready: readiness.readiness.ready,
        auth_invalid_evidence: readiness.status.code.starts_with("AUTH_INVALID_")
            || readiness.status.code == "HUE_CREDENTIAL_INVALID",
    };

    // 3. Lock briefly for state decision.
    let result = {
        let mut owner = acquire_hue_runtime(&runtime_state.runtime);
        start_with_evidence(&mut owner, &gate, trigger)
    }; // lock released

    // Abort guard: if we exit before step 5c stores the context, roll back to Failed.
    let mut abort_guard = StartAbortGuard::new(runtime_state.runtime_arc());

    // 4. Async channel fetch -- no lock held.
    let mut channels = if result.active {
        fetch_area_channels(&request.bridge_ip, &request.username, &request.area_id)
            .await
            .unwrap_or_default()
    } else {
        Vec::new()
    };
    if let Some(overrides) = &request.channel_region_overrides {
        apply_channel_region_overrides(&mut channels, overrides);
    }

    // 5a. Lock briefly for race-condition guard only.
    let has_no_lights = result.active && channels.is_empty();
    {
        let owner = acquire_hue_runtime(&runtime_state.runtime);
        if matches!(owner.state, HueRuntimeState::Idle | HueRuntimeState::Stopping | HueRuntimeState::Failed) {
            abort_guard.disarm();
            return Ok(make_result(&owner));
        }
    } // lock released before blocking I/O

    // 5b. Spawn sender on a blocking thread — same rationale as start_hue_stream 4b.
    let (color_sender, uses_dtls, shutdown_signal) = if result.active {
        let req = request.clone();
        let ch = channels.clone();
        tokio::task::spawn_blocking(move || build_hue_sender(&req, ch))
            .await
            .unwrap_or_else(|_join_err| {
                error!("build_hue_sender task panicked, using no-op sender.");
                let (tx, _rx) = std::sync::mpsc::sync_channel::<HueColorUpdate>(1);
                (HueColorSender { tx: Arc::new(tx), channel_count: 0 }, false, new_shutdown_signal())
            })
    } else {
        let (tx, _rx) = std::sync::mpsc::sync_channel::<HueColorUpdate>(1);
        (HueColorSender { tx: Arc::new(tx), channel_count: 0 }, false, new_shutdown_signal())
    };

    // 5c. Re-acquire lock to store the spawned sender context.
    let final_result = {
        let mut owner = acquire_hue_runtime(&runtime_state.runtime);

        if matches!(owner.state, HueRuntimeState::Idle | HueRuntimeState::Stopping | HueRuntimeState::Failed) {
            abort_guard.disarm();
            return Ok(make_result(&owner));
        }

        store_active_stream_context(&mut owner, &request, channels, color_sender, uses_dtls, shutdown_signal);
        abort_guard.disarm();

        if has_no_lights {
            owner.last_status = status_with(
                HueRuntimeState::Running,
                "HUE_STREAM_RUNNING_NO_LIGHTS",
                "Hue runtime restarted but no color-addressable lights were resolved for the selected area.",
                Some("Revalidate area members and retry.".to_string()),
                HueRuntimeTriggerSource::System,
            );
            owner.last_status.action_hint = Some(HueRuntimeActionHint::Revalidate);
            return Ok(make_result(&owner));
        }

        // If DTLS was established, update the status to indicate entertainment streaming.
        if let Some(stream) = owner.active_stream.as_ref() {
            if stream.uses_dtls {
                owner.last_status = status_with(
                    HueRuntimeState::Running,
                    "HUE_STREAM_RUNNING_DTLS",
                    "Hue entertainment stream active via DTLS.",
                    None,
                    HueRuntimeTriggerSource::System,
                );
            }
        }

        // Flush any solid color that was queued while the stream context was not ready.
        flush_pending_solid_color(&mut owner);

        make_result(&owner)
    };

    // Spawn reconnect monitor to detect sender thread exit and trigger bounded retry.
    {
        let owner = acquire_hue_runtime(&runtime_state.runtime);
        if let Some(ref stream) = owner.active_stream {
            spawn_reconnect_monitor(
                Arc::clone(&stream.shutdown_signal),
                runtime_state.runtime_arc(),
                request.clone(),
            );
        }
    }

    Ok(final_result)
}

#[tauri::command]
pub fn set_hue_solid_color(
    request: SetHueSolidColorRequest,
    runtime_state: State<'_, HueRuntimeStateStore>,
) -> Result<HueRuntimeCommandResult, String> {
    let mut owner = acquire_hue_runtime(&runtime_state.runtime);

    let trigger = request
        .trigger_source
        .clone()
        .unwrap_or(HueRuntimeTriggerSource::ModeControl);

    let brightness = request.brightness.unwrap_or(1.0).clamp(0.0, 1.0);

    // Fast path: active stream -- use the pre-warmed background sender.
    if let Some(active_stream) = owner.active_stream.as_ref() {
        if active_stream.channels.is_empty() {
            owner.last_status = status_with(
                HueRuntimeState::Running,
                "HUE_COLOR_APPLY_SKIPPED_NO_LIGHTS",
                "Hue color apply skipped because no addressable lights were resolved for the selected area.",
                Some("Revalidate area and restart Hue runtime to refresh channel mapping.".to_string()),
                trigger,
            );
            owner.last_status.action_hint = Some(HueRuntimeActionHint::Revalidate);
            return Ok(make_result(&owner));
        }

        active_stream
            .color_sender
            .try_send(request.r, request.g, request.b, brightness);
        owner.last_solid_color = Some(HueSolidColorSnapshot {
            r: request.r,
            g: request.g,
            b: request.b,
            brightness,
        });
        owner.last_status = status_with(
            HueRuntimeState::Running,
            "HUE_COLOR_APPLIED",
            "Hue solid color update applied.",
            None,
            trigger,
        );
        return Ok(make_result(&owner));
    }

    // Fallback path: stream is not active but we have a persistent sender from
    // a previous successful start. This covers app-startup and quick color
    // adjustments that arrive before the runtime transitions to Running.
    if let Some(persistent) = owner.persistent_sender.as_ref() {
        if !persistent.channels.is_empty() {
            persistent
                .sender
                .try_send(request.r, request.g, request.b, brightness);
            owner.last_solid_color = Some(HueSolidColorSnapshot {
                r: request.r,
                g: request.g,
                b: request.b,
                brightness,
            });
            owner.last_status = status_with(
                owner.state.clone(),
                "HUE_COLOR_APPLIED",
                "Hue solid color queued via persistent sender (stream not active).",
                None,
                trigger,
            );
            return Ok(make_result(&owner));
        }
    }

    // Stream context not ready — differentiate between "starting" and truly idle.
    if matches!(owner.state, HueRuntimeState::Starting | HueRuntimeState::Running | HueRuntimeState::Reconnecting) {
        // Stream is starting but context not ready yet — record the color for later flush
        owner.last_solid_color = Some(HueSolidColorSnapshot { r: request.r, g: request.g, b: request.b, brightness });
        owner.last_status = status_with(
            owner.state.clone(),
            "HUE_COLOR_QUEUED_PENDING_STREAM",
            "Color queued — stream context not ready yet, will be flushed when stream starts.",
            None,
            trigger,
        );
    } else {
        owner.last_status = status_with(
            HueRuntimeState::Idle,
            "HUE_COLOR_APPLY_SKIPPED",
            "Hue color apply skipped because stream context is not active.",
            Some("Start Hue runtime before sending color updates.".to_string()),
            trigger,
        );
    }
    Ok(make_result(&owner))
}

#[tauri::command]
pub async fn get_hue_stream_status(
    runtime_state: State<'_, HueRuntimeStateStore>,
) -> Result<HueRuntimeCommandResult, String> {
    // 1. Check if stream is active and read params -- brief lock, no I/O.
    let active_stream_params = {
        let owner = acquire_hue_runtime(&runtime_state.runtime);
        if matches!(
            owner.state,
            HueRuntimeState::Starting | HueRuntimeState::Running | HueRuntimeState::Reconnecting
        ) {
            owner.active_stream.as_ref().map(|stream| {
                (
                    stream.bridge_ip.clone(),
                    stream.username.clone(),
                    stream.area_id.clone(),
                    Arc::clone(&stream.shutdown_signal),
                )
            })
        } else {
            None
        }
    }; // lock released before async I/O

    // A3: Non-blocking probe — if the background sender thread has already exited,
    // register a transient fault immediately without doing a network round-trip.
    if let Some((_, _, _, ref shutdown_signal)) = active_stream_params {
        if is_shutdown_signaled(shutdown_signal) {
            let mut owner = acquire_hue_runtime(&runtime_state.runtime);
            if matches!(
                owner.state,
                HueRuntimeState::Starting | HueRuntimeState::Running | HueRuntimeState::Reconnecting
            ) {
                // Clear dead stream/sender contexts so the next start can spawn fresh.
                owner.active_stream = None;
                owner.persistent_sender = None;
                return Ok(register_transient_fault(
                    &mut owner,
                    "DTLS sender thread exited unexpectedly.",
                    HueRuntimeTriggerSource::System,
                ));
            }
            return Ok(make_result(&owner));
        }
    }

    // 2. If stream is active, check readiness async -- no lock held.
    if let Some((bridge_ip, username, area_id, _)) = active_stream_params {
        let readiness = check_hue_stream_readiness(bridge_ip, username, area_id).await;
        // During a health poll the area will have active_streamer=true (we are
        // the active streamer).  The readiness check treats active_streamer as
        // "not ready" to prevent hijacking a foreign stream, but for an ongoing
        // health check that flag means everything is working.  Override ready=true
        // when the only blocking reason is active_streamer.
        let only_blocked_by_us = !readiness.readiness.ready
            && readiness
                .readiness
                .reasons
                .iter()
                .all(|r| r.contains("ACTIVE_STREAMER"));
        let ready_for_health = readiness.readiness.ready || only_blocked_by_us;
        let gate = HueRuntimeGateEvidence {
            bridge_configured: true,
            credentials_valid: true,
            area_selected: true,
            readiness_current: readiness.status.code != "HUE_STREAM_READINESS_FAILED",
            ready: ready_for_health,
            auth_invalid_evidence: readiness.status.code.starts_with("AUTH_INVALID_")
                || readiness.status.code == "HUE_CREDENTIAL_INVALID",
        };
        // Suppress the "not ready" details when we are the active streamer — the
        // area is healthy from our perspective and leaking those details into the
        // Running status creates misleading "Adjust Entertainment Area" messages.
        let details = if only_blocked_by_us {
            None
        } else {
            readiness
                .status
                .details
                .clone()
                .or_else(|| Some(readiness.status.message.clone()))
        };

        // 3. Lock briefly to apply the refreshed state.
        let mut owner = acquire_hue_runtime(&runtime_state.runtime);
        let _ = status_refresh_with_evidence(&mut owner, &gate, details);
        // Flush any solid color that was queued during the stream-starting window.
        flush_pending_solid_color(&mut owner);
        return Ok(make_result(&owner));
    }

    // Fallback: active_stream was None at step 1, but step 4c of start_hue_stream
    // may have stored the context by now. Re-acquire the lock and attempt a flush.
    let mut owner = acquire_hue_runtime(&runtime_state.runtime);
    flush_pending_solid_color(&mut owner);
    Ok(make_result(&owner))
}

#[allow(dead_code)]
fn to_legacy_status(status: &HueRuntimeStatus) -> CommandStatus {
    CommandStatus {
        code: status.code.clone(),
        message: status.message.clone(),
        details: status.details.clone(),
    }
}

// ---------------------------------------------------------------------------
// Reconnect monitor (HUE-08) — detects sender thread exit and triggers retry
// ---------------------------------------------------------------------------

/// Spawns a Tokio task that monitors the sender thread's shutdown signal.
/// When the signal fires (sender died), it triggers register_transient_fault
/// and attempts bounded reconnection.
///
/// The monitor exits when:
/// - All retry attempts are exhausted (transitions to Failed)
/// - A successful reconnect occurs (new monitor spawned by restart flow)
/// - User manually stops the stream (user_override_pending = true)
fn spawn_reconnect_monitor(
    shutdown_signal: ShutdownSignal,
    runtime: Arc<Mutex<HueRuntimeOwner>>,
    request: StartHueStreamRequest,
) {
    tokio::spawn(async move {
        // Poll shutdown signal with 200ms interval.
        loop {
            tokio::time::sleep(Duration::from_millis(200)).await;
            if is_shutdown_signaled(&shutdown_signal) {
                break;
            }
        }

        // Sender thread has exited — check if this is an intentional stop.
        {
            let owner = acquire_hue_runtime(&runtime);
            if owner.user_override_pending
                || matches!(owner.state, HueRuntimeState::Idle | HueRuntimeState::Stopping)
            {
                return;
            }
            // If already Failed or Reconnecting from another path, don't double-trigger.
            if matches!(owner.state, HueRuntimeState::Failed | HueRuntimeState::Reconnecting) {
                return;
            }
        }

        // Register transient fault and get backoff delay.
        let backoff_ms = {
            let mut owner = acquire_hue_runtime(&runtime);
            let result = register_transient_fault(
                &mut owner,
                "DTLS sender thread exited unexpectedly",
                HueRuntimeTriggerSource::System,
            );
            owner.session_reconnect_total += 1;

            if owner.state == HueRuntimeState::Failed {
                // Retry budget exhausted (D-02).
                info!("Reconnect monitor: retry budget exhausted, entering Failed state.");
                return;
            }

            result.status.next_attempt_ms.unwrap_or(400)
        };

        // Wait for backoff.
        info!("Reconnect monitor: waiting {}ms before reconnect attempt.", backoff_ms);
        tokio::time::sleep(Duration::from_millis(backoff_ms)).await;

        // Check state again before attempting reconnect.
        {
            let owner = acquire_hue_runtime(&runtime);
            if owner.user_override_pending
                || matches!(
                    owner.state,
                    HueRuntimeState::Idle | HueRuntimeState::Stopping | HueRuntimeState::Failed
                )
            {
                return;
            }
        }

        // Attempt restart using internal logic.
        info!("Reconnect monitor: attempting stream restart.");
        let restart_result = internal_restart_stream(&runtime, &request).await;

        match restart_result {
            Ok(true) => {
                let mut owner = acquire_hue_runtime(&runtime);
                owner.session_reconnect_success += 1;
                info!("Reconnect monitor: stream restarted successfully.");
                // New monitor is spawned by the restart flow.
            }
            Ok(false) | Err(_) => {
                info!("Reconnect monitor: restart failed.");
                // The restart flow itself handles state transitions.
            }
        }
    });
}

/// Internal stream restart logic for the reconnect monitor.
/// Replicates the core logic of restart_hue_stream but accepts
/// Arc<Mutex<HueRuntimeOwner>> directly instead of Tauri State<>.
async fn internal_restart_stream(
    runtime: &Arc<Mutex<HueRuntimeOwner>>,
    request: &StartHueStreamRequest,
) -> Result<bool, String> {
    // 1. Extract current stream info and clear state.
    let dtls_deactivate = {
        let mut owner = acquire_hue_runtime(runtime);
        let deactivate = owner
            .active_stream
            .as_ref()
            .filter(|s| s.uses_dtls)
            .map(|s| (s.bridge_ip.clone(), s.username.clone(), s.area_id.clone()));
        owner.active_stream = None;
        owner.persistent_sender = None;
        deactivate
    };

    // Best-effort DTLS deactivation outside lock.
    if let Some((ip, username, area_id)) = dtls_deactivate {
        let _ = tokio::task::spawn_blocking(move || {
            if let Ok(client) = hue_http_client() {
                let _ = deactivate_entertainment_config(&client, &ip, &username, &area_id);
            }
        })
        .await;
        // Give the bridge ~1 s to propagate the deactivation before checking readiness.
        // Without this delay, the bridge may still report active_streamer=true and
        // the reconnect fails immediately.
        tokio::time::sleep(Duration::from_millis(1000)).await;
    }

    // 2. Readiness check (async, no lock held).
    let readiness = check_hue_stream_readiness(
        request.bridge_ip.clone(),
        request.username.clone(),
        request.area_id.clone(),
    )
    .await;

    if !readiness.readiness.ready {
        let mut owner = acquire_hue_runtime(runtime);
        let _ = register_transient_fault(
            &mut owner,
            &format!(
                "Readiness check failed during reconnect: {}",
                readiness.status.message
            ),
            HueRuntimeTriggerSource::System,
        );
        return Ok(false);
    }

    // 3. Set state to Starting.
    {
        let mut owner = acquire_hue_runtime(runtime);
        if owner.user_override_pending
            || matches!(owner.state, HueRuntimeState::Idle | HueRuntimeState::Failed)
        {
            return Ok(false);
        }
        owner.state = HueRuntimeState::Starting;
    }

    // 4. Fetch channels.
    let mut channels =
        fetch_area_channels(&request.bridge_ip, &request.username, &request.area_id)
            .await
            .unwrap_or_default();
    if let Some(overrides) = &request.channel_region_overrides {
        apply_channel_region_overrides(&mut channels, overrides);
    }

    // 5. Spawn sender (blocking), passing the owner's packet counter.
    let req = request.clone();
    let ch = channels.clone();
    let packet_counter = {
        let owner = acquire_hue_runtime(runtime);
        Arc::clone(&owner.packet_send_count)
    };
    let (color_sender, uses_dtls, shutdown_signal, cipher_name) =
        tokio::task::spawn_blocking(move || build_hue_sender_with_counter(&req, ch, packet_counter))
            .await
            .unwrap_or_else(|_| {
                let (tx, _rx) = std::sync::mpsc::sync_channel::<HueColorUpdate>(1);
                (
                    HueColorSender {
                        tx: Arc::new(tx),
                        channel_count: 0,
                    },
                    false,
                    new_shutdown_signal(),
                    None,
                )
            });

    // 6. Store context and spawn new monitor.
    {
        let mut owner = acquire_hue_runtime(runtime);
        if owner.user_override_pending
            || matches!(owner.state, HueRuntimeState::Idle | HueRuntimeState::Failed)
        {
            return Ok(false);
        }

        let stream_ctx = HueActiveStreamContext {
            bridge_ip: request.bridge_ip.clone(),
            username: request.username.clone(),
            client_key: request.client_key.clone(),
            area_id: request.area_id.clone(),
            channels: channels.clone(),
            color_sender: color_sender.clone(),
            uses_dtls,
            shutdown_signal: Arc::clone(&shutdown_signal),
        };
        if !channels.is_empty() {
            owner.persistent_sender = Some(HuePersistentSender {
                channels: channels.clone(),
                sender: color_sender.clone(),
            });
        }
        owner.active_stream = Some(stream_ctx);
        owner.state = HueRuntimeState::Running;
        owner.reconnect_attempt = 0;
        owner.stream_started_at = Some(Instant::now());
        owner.packet_send_count.store(0, std::sync::atomic::Ordering::Relaxed);
        owner.packet_rate_sampled_at = Some(Instant::now());
        owner.packet_rate_last_count = 0;
        if uses_dtls {
            owner.dtls_cipher = cipher_name;
            owner.dtls_connected_at = Some(Instant::now());
            owner.last_status = status_with(
                HueRuntimeState::Running,
                "HUE_STREAM_RUNNING_DTLS",
                "Hue entertainment stream active via DTLS (reconnected).",
                None,
                HueRuntimeTriggerSource::System,
            );
        } else {
            owner.last_status = status_with(
                HueRuntimeState::Running,
                "HUE_STREAM_RUNNING",
                "Hue stream running (reconnected).",
                None,
                HueRuntimeTriggerSource::System,
            );
        }
    }

    // Spawn new monitor for the new connection.
    spawn_reconnect_monitor(
        shutdown_signal,
        Arc::clone(runtime),
        request.clone(),
    );

    Ok(true)
}

// ---------------------------------------------------------------------------
// simulate_hue_fault — debug-only command (D-10, D-11)
// ---------------------------------------------------------------------------

#[cfg(debug_assertions)]
#[tauri::command]
pub fn simulate_hue_fault(
    runtime_state: State<'_, HueRuntimeStateStore>,
) -> Result<String, String> {
    let owner = acquire_hue_runtime(&runtime_state.runtime);
    if let Some(ref stream) = owner.active_stream {
        if stream.uses_dtls {
            // D-11: Fire shutdown signal to trigger reconnect monitor.
            signal_shutdown_complete(&stream.shutdown_signal);
            info!("simulate_hue_fault: shutdown signal fired for active DTLS stream.");
            return Ok("HUE_FAULT_SIMULATED".to_string());
        }
    }
    Err("NO_ACTIVE_DTLS_STREAM".to_string())
}

#[cfg(not(debug_assertions))]
#[tauri::command]
pub fn simulate_hue_fault() -> Result<String, String> {
    Err("SIMULATE_NOT_AVAILABLE_IN_RELEASE".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn strict_gate_ready() -> HueRuntimeGateEvidence {
        HueRuntimeGateEvidence {
            bridge_configured: true,
            credentials_valid: true,
            area_selected: true,
            readiness_current: true,
            ready: true,
            auth_invalid_evidence: false,
        }
    }

    fn strict_gate_missing_readiness() -> HueRuntimeGateEvidence {
        HueRuntimeGateEvidence {
            bridge_configured: true,
            credentials_valid: true,
            area_selected: true,
            readiness_current: false,
            ready: false,
            auth_invalid_evidence: false,
        }
    }

    /// Helper: build a dummy `HueActiveStreamContext` for tests that need one
    /// without spawning a real background thread.
    fn dummy_active_stream_context() -> HueActiveStreamContext {
        let (tx, _rx) = std::sync::mpsc::sync_channel::<HueColorUpdate>(1);
        HueActiveStreamContext {
            bridge_ip: "192.168.1.2".to_string(),
            username: "username".to_string(),
            client_key: String::new(),
            area_id: "area".to_string(),
            channels: vec![HueAreaChannel {
                channel_id: 0,
                light_ids: vec!["light-1".to_string()],
                screen_region: HueScreenRegion::Center,
                position_x: 0.0,
                position_y: 0.0,
            }],
            color_sender: HueColorSender { tx: Arc::new(tx), channel_count: 1 },
            uses_dtls: false,
            shutdown_signal: new_shutdown_signal(),
        }
    }

    #[test]
    fn start_fails_with_config_not_ready_when_strict_gate_is_missing() {
        let mut owner = HueRuntimeOwner::default();
        let result = start_with_evidence(
            &mut owner,
            &strict_gate_missing_readiness(),
            HueRuntimeTriggerSource::ModeControl,
        );

        assert_eq!(result.status.code, "CONFIG_NOT_READY_GATE_BLOCKED");
        assert_eq!(result.status.state, HueRuntimeState::Idle);
        assert!(!result.active);
    }

    #[test]
    fn start_is_idempotent_while_starting_or_running() {
        let mut owner = HueRuntimeOwner::default();

        let _ = start_with_evidence(
            &mut owner,
            &strict_gate_ready(),
            HueRuntimeTriggerSource::ModeControl,
        );
        let second = start_with_evidence(
            &mut owner,
            &strict_gate_ready(),
            HueRuntimeTriggerSource::ModeControl,
        );

        assert_eq!(second.status.code, "HUE_START_NOOP_ALREADY_ACTIVE");
        assert_eq!(second.status.state, HueRuntimeState::Running);
        assert!(second.active);
    }

    #[test]
    fn transient_faults_exhaust_into_failed_and_auth_invalid_sets_repair_hint() {
        let mut owner = HueRuntimeOwner::default();

        let _ = start_with_evidence(
            &mut owner,
            &strict_gate_ready(),
            HueRuntimeTriggerSource::ModeControl,
        );

        let first =
            register_transient_fault(&mut owner, "udp timeout", HueRuntimeTriggerSource::System);
        assert_eq!(first.status.code, "TRANSIENT_RETRY_SCHEDULED");
        assert_eq!(first.status.state, HueRuntimeState::Reconnecting);

        let _ =
            register_transient_fault(&mut owner, "udp timeout", HueRuntimeTriggerSource::System);
        let exhausted =
            register_transient_fault(&mut owner, "udp timeout", HueRuntimeTriggerSource::System);

        assert_eq!(exhausted.status.code, "TRANSIENT_RETRY_EXHAUSTED");
        assert_eq!(exhausted.status.state, HueRuntimeState::Failed);
        assert_eq!(
            exhausted.status.action_hint,
            Some(HueRuntimeActionHint::Retry)
        );

        let auth =
            register_auth_invalid(&mut owner, "unauthorized", HueRuntimeTriggerSource::System);
        assert_eq!(auth.status.code, "AUTH_INVALID_CREDENTIALS");
        assert_eq!(auth.status.action_hint, Some(HueRuntimeActionHint::Repair));
    }

    #[test]
    fn command_status_refresh_marks_running_runtime_as_reconnecting_on_transient_fault() {
        let mut owner = HueRuntimeOwner::default();
        let ready_gate = strict_gate_ready();
        let mut transient_fault_gate = strict_gate_ready();
        transient_fault_gate.readiness_current = false;
        transient_fault_gate.ready = false;

        let _ = start_with_evidence(
            &mut owner,
            &ready_gate,
            HueRuntimeTriggerSource::ModeControl,
        );
        let result = status_refresh_with_evidence(&mut owner, &transient_fault_gate, None);

        assert_eq!(result.status.state, HueRuntimeState::Reconnecting);
        assert_eq!(result.status.code, "TRANSIENT_RETRY_SCHEDULED");
        assert!(result.status.next_attempt_ms.is_some());
        assert_eq!(result.status.remaining_attempts, Some(2));
    }

    #[test]
    fn command_status_refresh_preserves_retry_budget_for_not_ready_area_state() {
        let mut owner = HueRuntimeOwner::default();
        let ready_gate = strict_gate_ready();
        let mut not_ready_gate = strict_gate_ready();
        not_ready_gate.ready = false;

        let _ = start_with_evidence(
            &mut owner,
            &ready_gate,
            HueRuntimeTriggerSource::ModeControl,
        );
        owner.reconnect_attempt = 1;

        let result = status_refresh_with_evidence(
            &mut owner,
            &not_ready_gate,
            Some("area readiness dropped".to_string()),
        );

        assert_eq!(result.status.state, HueRuntimeState::Running);
        assert_eq!(result.status.code, "CONFIG_NOT_READY_GATE_BLOCKED");
        assert_eq!(
            result.status.action_hint,
            Some(HueRuntimeActionHint::Revalidate)
        );
        assert_eq!(result.status.remaining_attempts, Some(2));
        assert_eq!(owner.reconnect_attempt, 1);
    }

    #[test]
    fn start_success_persists_active_stream_context_for_status_refresh() {
        let mut owner = HueRuntimeOwner::default();
        let request = StartHueStreamRequest {
            bridge_ip: "192.168.1.2".to_string(),
            username: "hue-user".to_string(),
            client_key: String::new(),
            area_id: "living-room".to_string(),
            trigger_source: Some(HueRuntimeTriggerSource::ModeControl),
            channel_region_overrides: None,
        };

        let start_result = start_with_evidence(
            &mut owner,
            &strict_gate_ready(),
            HueRuntimeTriggerSource::ModeControl,
        );
        let (tx, _rx) = std::sync::mpsc::sync_channel::<HueColorUpdate>(1);
        let dummy_sender = HueColorSender { tx: Arc::new(tx), channel_count: 1 };
        store_active_stream_context(
            &mut owner,
            &request,
            vec![HueAreaChannel {
                channel_id: 0,
                light_ids: vec!["light-1".to_string()],
                screen_region: HueScreenRegion::Center,
                position_x: 0.0,
                position_y: 0.0,
            }],
            dummy_sender,
            false,
            new_shutdown_signal(),
        );

        let active_stream = owner.active_stream.as_ref().expect("active stream context");
        assert_eq!(active_stream.bridge_ip, "192.168.1.2");
        assert_eq!(active_stream.username, "hue-user");
        assert_eq!(active_stream.area_id, "living-room");
        assert_eq!(active_stream.channels.len(), 1);
        assert_eq!(active_stream.channels[0].light_ids, vec!["light-1".to_string()]);
    }

    #[test]
    fn command_status_refresh_exhausts_retry_budget_and_marks_failed() {
        let mut owner = HueRuntimeOwner::default();
        let ready_gate = strict_gate_ready();
        let mut transient_fault_gate = strict_gate_ready();
        transient_fault_gate.readiness_current = false;
        transient_fault_gate.ready = false;

        let _ = start_with_evidence(
            &mut owner,
            &ready_gate,
            HueRuntimeTriggerSource::ModeControl,
        );
        let _ = status_refresh_with_evidence(&mut owner, &transient_fault_gate, None);
        let _ = status_refresh_with_evidence(&mut owner, &transient_fault_gate, None);
        let exhausted = status_refresh_with_evidence(&mut owner, &transient_fault_gate, None);

        assert_eq!(exhausted.status.state, HueRuntimeState::Failed);
        assert_eq!(exhausted.status.code, "TRANSIENT_RETRY_EXHAUSTED");
        assert_eq!(exhausted.status.remaining_attempts, Some(0));
    }

    #[test]
    fn command_status_refresh_marks_auth_invalid_fault_as_repair_required() {
        let mut owner = HueRuntimeOwner::default();
        let ready_gate = strict_gate_ready();
        let mut auth_invalid_gate = strict_gate_ready();
        auth_invalid_gate.auth_invalid_evidence = true;

        let _ = start_with_evidence(
            &mut owner,
            &ready_gate,
            HueRuntimeTriggerSource::ModeControl,
        );
        let result = status_refresh_with_evidence(&mut owner, &auth_invalid_gate, None);

        assert_eq!(result.status.state, HueRuntimeState::Failed);
        assert_eq!(result.status.code, "AUTH_INVALID_CREDENTIALS");
        assert_eq!(
            result.status.action_hint,
            Some(HueRuntimeActionHint::Repair)
        );
    }

    #[test]
    fn user_stop_prevents_new_reconnect_attempts_during_status_refresh() {
        let mut owner = HueRuntimeOwner::default();

        let _ = start_with_evidence(
            &mut owner,
            &strict_gate_ready(),
            HueRuntimeTriggerSource::ModeControl,
        );
        owner.active_stream = Some(dummy_active_stream_context());
        let _ = stop_with_timeout(&mut owner, false, HueRuntimeTriggerSource::DeviceSurface);

        let mut transient_fault_gate = strict_gate_ready();
        transient_fault_gate.readiness_current = false;
        transient_fault_gate.ready = false;

        let result = status_refresh_with_evidence(&mut owner, &transient_fault_gate, None);

        assert_eq!(result.status.state, HueRuntimeState::Idle);
        assert_eq!(result.status.code, "HUE_STREAM_STOPPED");
        assert_eq!(owner.reconnect_attempt, 0);
    }

    #[test]
    fn stop_runs_deterministic_cleanup_and_timeout_reports_partial_stop() {
        let mut owner = HueRuntimeOwner::default();
        let _ = start_with_evidence(
            &mut owner,
            &strict_gate_ready(),
            HueRuntimeTriggerSource::ModeControl,
        );

        let timeout = stop_with_timeout(&mut owner, true, HueRuntimeTriggerSource::DeviceSurface);

        assert_eq!(timeout.status.code, "HUE_STOP_TIMEOUT_PARTIAL");
        assert_eq!(timeout.status.state, HueRuntimeState::Idle);
        assert_eq!(
            timeout.status.action_hint,
            Some(HueRuntimeActionHint::Retry)
        );
        assert!(!timeout.active);
    }

    #[test]
    fn shutdown_signal_fires_when_sender_thread_exits() {
        let signal = new_shutdown_signal();
        let signal_clone = Arc::clone(&signal);

        thread::spawn(move || {
            thread::sleep(Duration::from_millis(50));
            signal_shutdown_complete(&signal_clone);
        });

        let completed = wait_for_shutdown(&signal, Duration::from_secs(2));
        assert!(completed, "shutdown signal should have fired within 2s");
    }

    #[test]
    fn shutdown_signal_times_out_when_thread_does_not_signal() {
        let signal = new_shutdown_signal();
        let completed = wait_for_shutdown(&signal, Duration::from_millis(100));
        assert!(!completed, "should have timed out");
    }

    #[test]
    fn build_huestream_frame_produces_correct_header_and_channels() {
        let channels = vec![
            HueAreaChannel {
                channel_id: 0,
                light_ids: vec!["l1".to_string()],
                screen_region: HueScreenRegion::Left,
                position_x: -0.8,
                position_y: 0.0,
            },
            HueAreaChannel {
                channel_id: 1,
                light_ids: vec!["l2".to_string()],
                screen_region: HueScreenRegion::Right,
                position_x: 0.8,
                position_y: 0.0,
            },
        ];
        let colors = vec![(255, 0, 0), (0, 255, 0)];
        let area_id = "1a8d99cc-967b-44f2-9202-43f976c0fa6b";
        let frame = build_huestream_frame(area_id, &channels, &colors, 1.0);

        // Header: 9 magic + 1 major + 1 minor + 1 seq + 2 reserved + 1 color_space + 1 reserved = 16
        assert_eq!(&frame[0..9], b"HueStream");
        assert_eq!(frame[9], 0x02);  // major
        assert_eq!(frame[10], 0x00); // minor
        assert_eq!(frame[11], 0x00); // sequence
        assert_eq!(frame[12], 0x00); // reserved
        assert_eq!(frame[13], 0x00); // reserved
        assert_eq!(frame[14], 0x00); // color space RGB
        assert_eq!(frame[15], 0x00); // reserved

        // Entertainment configuration UUID (bytes 16..52, 36 bytes ASCII)
        assert_eq!(&frame[16..52], area_id.as_bytes());

        // Channel 0: id=0, R=65535, G=0, B=0  (starts at byte 52)
        assert_eq!(frame[52], 0);       // channel_id
        assert_eq!(frame[53..55], 0xFFFFu16.to_be_bytes()); // R
        assert_eq!(frame[55..57], 0x0000u16.to_be_bytes()); // G
        assert_eq!(frame[57..59], 0x0000u16.to_be_bytes()); // B

        // Channel 1: id=1, R=0, G=65535, B=0  (starts at byte 59)
        assert_eq!(frame[59], 1);       // channel_id
        assert_eq!(frame[60..62], 0x0000u16.to_be_bytes()); // R
        assert_eq!(frame[62..64], 0xFFFFu16.to_be_bytes()); // G
        assert_eq!(frame[64..66], 0x0000u16.to_be_bytes()); // B

        // Total: 16 header + 36 UUID + 2*7 channels = 66
        assert_eq!(frame.len(), 66);
    }

    #[test]
    fn build_huestream_frame_applies_brightness() {
        let channels = vec![HueAreaChannel {
            channel_id: 0,
            light_ids: vec!["l1".to_string()],
            screen_region: HueScreenRegion::Center,
            position_x: 0.0,
            position_y: 0.0,
        }];
        let colors = vec![(255, 255, 255)];
        let frame = build_huestream_frame("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", &channels, &colors, 0.5);

        // Channel starts at byte 52 (16 header + 36 UUID). At 50% brightness, 255 -> ~32767.
        let r = u16::from_be_bytes([frame[53], frame[54]]);
        let g = u16::from_be_bytes([frame[55], frame[56]]);
        let b = u16::from_be_bytes([frame[57], frame[58]]);
        assert!(r > 32000 && r < 33000, "R={r} should be ~32767");
        assert!(g > 32000 && g < 33000, "G={g} should be ~32767");
        assert!(b > 32000 && b < 33000, "B={b} should be ~32767");
    }

    #[test]
    fn hex_decode_works() {
        assert_eq!(hex_decode("AABB").unwrap(), vec![0xAA, 0xBB]);
        assert_eq!(hex_decode("0123456789abcdef").unwrap(), vec![0x01, 0x23, 0x45, 0x67, 0x89, 0xAB, 0xCD, 0xEF]);
        assert!(hex_decode("ABC").is_err()); // odd length
        assert!(hex_decode("GG").is_err()); // invalid hex
    }
}
