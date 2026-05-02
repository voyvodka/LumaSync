//! Background sender threads that push Hue entertainment frames to the bridge.
//!
//! Carved out of the original `hue_stream_lifecycle.rs` during the v1.5 G8
//! split. Two sender variants:
//!
//! - DTLS (preferred): UDP/2100, 20 Hz cadence, keep-alive frames every 2 s
//!   so the bridge does not auto-close after ~10 s of silence.
//! - HTTP fallback: per-light `PUT /clip/v2/resource/light/{id}` when the
//!   client key is missing or the DTLS handshake times out.
//!
//! The 50 ms (20 Hz) minimum interval and the keep-alive cadence are
//! protocol-critical (`ls-hue-protocol §2.1` and §2.3) and must not drift.
//!

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering as AtomicOrdering};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

use log::{error, info, warn};
use reqwest::blocking::Client as BlockingClient;
use serde_json::{json, Value};

use super::super::hue_http::classify_hue_response_blocking;
use super::dtls::connect_dtls;
use super::frame::{
    build_huestream_frame, channel_position_to_screen_region, HueAreaChannel, HueColorSender,
    HueColorUpdate,
};

// ---------------------------------------------------------------------------
// HTTP client tunables
// ---------------------------------------------------------------------------

pub(crate) const HUE_HTTP_TIMEOUT_MS: u64 = 5_000;

/// Minimum interval between Hue color pushes in the background sender thread.
/// 50ms = 20 Hz max, well within CLIP v2 limits and imperceptibly fast.
pub(super) const HUE_SENDER_MIN_INTERVAL_MS: u64 = 50;

// ---------------------------------------------------------------------------
// Shared shutdown signal — used to detect background thread exit
// ---------------------------------------------------------------------------

/// Shared signal used to detect when a background sender thread has exited.
/// The thread sets the bool to `true` and notifies the condvar right before
/// returning, allowing `stop_hue_stream` to wait with a bounded timeout.
pub(crate) type ShutdownSignal = Arc<(Mutex<bool>, Condvar)>;

/// Create a fresh shutdown signal (initially `false` / not-yet-shut-down).
pub(crate) fn new_shutdown_signal() -> ShutdownSignal {
    Arc::new((Mutex::new(false), Condvar::new()))
}

/// Mark the shutdown signal as complete and wake any waiters.
pub(crate) fn signal_shutdown_complete(signal: &ShutdownSignal) {
    if let Ok(mut done) = signal.0.lock() {
        *done = true;
        signal.1.notify_all();
    }
}

/// Non-blocking probe: has the background thread already signalled shutdown?
/// Returns `true` if `signal_shutdown_complete` was called, `false` otherwise.
pub(crate) fn is_shutdown_signaled(signal: &ShutdownSignal) -> bool {
    signal.0.lock().map(|guard| *guard).unwrap_or(false)
}

/// Wait for the shutdown signal up to `timeout`. Returns `true` if the
/// thread confirmed shutdown within the deadline, `false` on timeout.
pub(crate) fn wait_for_shutdown(signal: &ShutdownSignal, timeout: Duration) -> bool {
    if let Ok(guard) = signal.0.lock() {
        let result = signal.1.wait_timeout_while(guard, timeout, |done| !*done);
        match result {
            Ok((_, timeout_result)) => !timeout_result.timed_out(),
            Err(_) => false,
        }
    } else {
        false
    }
}

// ---------------------------------------------------------------------------
// Deactivate dedupe token (v1.5.2 A1.3)
// ---------------------------------------------------------------------------
//
// `entertainment_configuration` deactivation can race between three call
// sites: the sender thread's own cleanup path, the foreground
// `stop_hue_stream` Tauri command, and the reconnect monitor's pre-restart
// cleanup. Without coordination all three may PUT
// `{ "action": "stop" }` to the same area, which the bridge logs as
// duplicate stale-state mutations and which historically produced the
// "phantom active streamer" symptom that bug audit A1.3 captured.
//
// `DeactivateToken` is the single-shot coordination primitive: whichever
// caller wins `try_acquire()` is the only one that performs the HTTP PUT;
// every later caller observes `false` and no-ops. The token is shared as
// `Arc<DeactivateToken>` so all three call sites point at the same atomic
// boolean for a given stream session.

/// Single-shot atomic flag that gates the entertainment-configuration
/// deactivation HTTP PUT. Exactly one acquirer wins; subsequent callers
/// see the in-flight bit and skip the network round-trip.
#[derive(Debug, Default)]
pub(crate) struct DeactivateToken {
    in_flight: AtomicBool,
}

impl DeactivateToken {
    pub(crate) fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// Returns `true` exactly once per token lifetime. The winner is
    /// expected to perform the deactivation PUT; every later caller
    /// observes `false` and must skip the request.
    pub(crate) fn try_acquire(&self) -> bool {
        self.in_flight
            .compare_exchange(false, true, AtomicOrdering::AcqRel, AtomicOrdering::Acquire)
            .is_ok()
    }

    /// Test/diagnostic-only probe: was the token already acquired?
    #[cfg(test)]
    pub(crate) fn was_acquired(&self) -> bool {
        self.in_flight.load(AtomicOrdering::Acquire)
    }
}

/// Best-effort, dedupe-aware wrapper around `deactivate_entertainment_config`.
/// The first caller through the token performs the PUT; later callers are
/// no-ops and return `Ok(())`. This is the only entry point any of the three
/// shutdown call sites should use — direct calls to
/// `deactivate_entertainment_config` bypass the dedupe and reintroduce the
/// double-PUT race A1.3 fixed.
pub(crate) fn deactivate_with_token(
    token: &DeactivateToken,
    client: &BlockingClient,
    bridge_ip: &str,
    username: &str,
    area_id: &str,
) -> Result<(), String> {
    if !token.try_acquire() {
        log::debug!("deactivate_with_token: skip — token already acquired for area {area_id}");
        return Ok(());
    }
    deactivate_entertainment_config(client, bridge_ip, username, area_id)
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
    let endpoint =
        format!("https://{bridge_ip}/clip/v2/resource/entertainment_configuration/{area_id}");
    let response = client
        .put(&endpoint)
        .header("hue-application-key", username)
        .json(&json!({ "action": "start" }))
        .send()
        .map_err(|e| format!("ENTERTAINMENT_ACTIVATE_SEND_FAILED: {e}"))?;

    classify_hue_response_blocking(response)
        .map(|_| ())
        .map_err(|fault| format!("ENTERTAINMENT_ACTIVATE_FAILED: {fault}"))
}

/// PUT /clip/v2/resource/entertainment_configuration/{area_id}
/// body: { "action": "stop" }
///
/// Tells the bridge to exit entertainment mode. Called when stopping the stream.
///
/// Prefer `deactivate_with_token` over calling this directly — direct
/// callers bypass the v1.5.2 A1.3 dedupe primitive and risk re-introducing
/// the double-PUT race.
pub(crate) fn deactivate_entertainment_config(
    client: &BlockingClient,
    bridge_ip: &str,
    username: &str,
    area_id: &str,
) -> Result<(), String> {
    let endpoint =
        format!("https://{bridge_ip}/clip/v2/resource/entertainment_configuration/{area_id}");
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
// HTTP-fallback per-light PUT helpers
// ---------------------------------------------------------------------------

/// Connection handle bundling the reqwest client with bridge IP + app key so helper
/// fns don't need to carry three correlated arguments through every call.
struct HueBridgeConnection<'a> {
    client: &'a BlockingClient,
    bridge_ip: &'a str,
    username: &'a str,
}

/// Send to all lights via HTTP. For a single light: direct call. For multiple: parallel
/// threads via `thread::scope` so each HTTPS round-trip happens concurrently.
fn send_color_to_lights(
    conn: &HueBridgeConnection<'_>,
    light_ids: &[String],
    r: u8,
    g: u8,
    b: u8,
    brightness: f32,
) {
    if light_ids.is_empty() {
        return;
    }

    let (x, y, _big_y) = super::frame::rgb_to_xy(r, g, b);
    let dimming = f64::from(brightness.clamp(0.0, 1.0) * 100.0);

    if light_ids.len() == 1 {
        let _ = send_light_put(conn, &light_ids[0], x, y, dimming);
        return;
    }

    thread::scope(|s| {
        for light_id in light_ids {
            s.spawn(|| {
                let _ = send_light_put(conn, light_id, x, y, dimming);
            });
        }
    });
}

fn send_light_put(
    conn: &HueBridgeConnection<'_>,
    light_id: &str,
    x: f64,
    y: f64,
    dimming: f64,
) -> Result<(), String> {
    let endpoint = format!(
        "https://{}/clip/v2/resource/light/{light_id}",
        conn.bridge_ip
    );
    conn.client
        .put(endpoint)
        .header("hue-application-key", conn.username)
        .json(&json!({
            "on": { "on": true },
            "dimming": { "brightness": dimming },
            "color": { "xy": { "x": x, "y": y } }
        }))
        .send()
        .map_err(|e| e.to_string())
        .and_then(|r| classify_hue_response_blocking(r).map_err(|f| f.to_string()))
        .map(|_| ())
}

// ---------------------------------------------------------------------------
// Background DTLS sender thread
// ---------------------------------------------------------------------------

/// Spawns a background thread that:
/// 1. Activates the entertainment configuration via HTTPS
/// 2. Connects via DTLS 1.2 PSK to bridge:2100
/// 3. Continuously sends HueStream frames at 20 Hz
/// 4. On channel close or error, emits a DTLS `close_notify` alert and
///    deactivates the entertainment configuration via the dedupe token.
///
/// Returns the color sender handle, a shutdown signal that fires when the
/// thread exits, and the DTLS cipher name used during the handshake.
#[allow(clippy::too_many_arguments)] // bridge ip + username + client_key + area_id + channels + light_metadata + packet_counter + deactivate_token is the minimal DTLS sender contract; collapsing into a struct would cost ergonomic clarity at the call sites in commands.rs / reconnect.rs
pub(crate) fn spawn_hue_dtls_sender(
    client: Arc<BlockingClient>,
    bridge_ip: String,
    username: String,
    client_key: String,
    area_id: String,
    channels: Vec<HueAreaChannel>,
    light_metadata: Arc<HashMap<String, HueLightMetadata>>,
    packet_counter: Arc<std::sync::atomic::AtomicU32>,
    deactivate_token: Arc<DeactivateToken>,
) -> Result<(HueColorSender, ShutdownSignal, Option<String>), String> {
    let channel_count = channels.len();
    let (tx, rx) = std::sync::mpsc::sync_channel::<HueColorUpdate>(2);
    let tx = Arc::new(tx);

    // Activate entertainment mode via HTTPS before starting DTLS.
    activate_entertainment_config(&client, &bridge_ip, &username, &area_id)?;

    // Establish DTLS connection.
    let mut dtls_stream = connect_dtls(&bridge_ip, &username, &client_key)?;

    // Extract cipher name from the established handshake.
    let cipher_name = dtls_stream
        .ssl()
        .current_cipher()
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

        // Per-light metadata cache (gamut_type / archetype). Read by the
        // frame builder on every send for per-bulb gamut clipping (W1-C3b).
        let light_metadata = Arc::clone(&light_metadata);

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
            let frame = build_huestream_frame(
                &area_id,
                &channels,
                &latest.channel_colors,
                latest.brightness,
                &light_metadata,
            );
            if dtls_stream.write_all(&frame).is_err() {
                error!("DTLS write failed, stopping entertainment stream.");
                break;
            }

            // Increment packet counter for telemetry.
            packet_counter.fetch_add(1, std::sync::atomic::Ordering::Relaxed);

            last_sent_at = Instant::now();
        }

        // A1.3: emit DTLS `close_notify` before dropping the socket so the
        // bridge releases its "active streamer" slot immediately. Without
        // this the Hue bridge holds the slot for ~10 s and the next start
        // (ours or another app's) sees `HUE_STREAM_NOT_READY_ACTIVE_STREAMER`.
        // OpenSSL's `SslStream::shutdown` returns `Result<ShutdownResult, _>`;
        // we treat any failure as best-effort (the deactivate PUT below is
        // the protocol-level fallback). The `set_shutdown(RECEIVED)` hint
        // nudges OpenSSL to skip waiting for the peer's matching alert,
        // which the bridge does not always reply with promptly.
        {
            use openssl::ssl::ShutdownState;
            // Hint to OpenSSL: we don't care about a peer close_notify reply;
            // do not block waiting for one.
            dtls_stream.set_shutdown(ShutdownState::RECEIVED);
            match dtls_stream.shutdown() {
                Ok(_state) => {
                    log::debug!("DTLS close_notify emitted to bridge before socket drop.");
                }
                Err(err) => {
                    log::debug!(
                        "DTLS close_notify emission failed ({err}); falling back to deactivate PUT only."
                    );
                }
            }
        }

        // Cleanup: deactivate entertainment mode via dedupe-aware token. Whoever
        // wins the token (sender thread / foreground stop / reconnect monitor)
        // performs the single PUT; later callers no-op. See `DeactivateToken`.
        let _ = deactivate_with_token(
            &deactivate_token,
            &deactivate_client,
            &deactivate_ip,
            &deactivate_username,
            &deactivate_area_id,
        );

        // Drop the DTLS stream explicitly so the underlying UDP socket
        // releases before we signal shutdown — every observer of
        // `wait_for_shutdown` can now safely assume the bridge slot is free.
        drop(dtls_stream);

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
pub(crate) fn spawn_hue_http_sender(
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

        while let Ok(update) = rx.recv() {
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
            let conn = HueBridgeConnection {
                client: &client,
                bridge_ip: &bridge_ip,
                username: &username,
            };
            let conn_ref = &conn;
            thread::scope(|s| {
                for (channel, color) in channels.iter().zip(latest.channel_colors.iter()) {
                    let (r, g, b) = *color;
                    let light_ids: &[String] = &channel.light_ids;
                    s.spawn(move || {
                        send_color_to_lights(conn_ref, light_ids, r, g, b, brightness);
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

// ---------------------------------------------------------------------------
// Reqwest client constructors (shared blocking client + per-call async client)
// ---------------------------------------------------------------------------

static HUE_BLOCKING_CLIENT: OnceLock<Arc<BlockingClient>> = OnceLock::new();

pub(crate) fn hue_http_client() -> Result<BlockingClient, String> {
    BlockingClient::builder()
        .timeout(Duration::from_millis(HUE_HTTP_TIMEOUT_MS))
        .danger_accept_invalid_certs(true)
        .build()
        .map_err(|error| error.to_string())
}

pub(crate) fn hue_http_client_arc() -> Result<Arc<BlockingClient>, String> {
    Ok(Arc::clone(HUE_BLOCKING_CLIENT.get_or_init(|| {
        Arc::new(
            BlockingClient::builder()
                .timeout(Duration::from_millis(HUE_HTTP_TIMEOUT_MS))
                .danger_accept_invalid_certs(true)
                .build()
                .expect("Failed to build Hue blocking HTTP client"),
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

// ---------------------------------------------------------------------------
// Channel resolution from the bridge
// ---------------------------------------------------------------------------

pub(crate) async fn fetch_area_channels(
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
            let resource =
                match fetch_resource(client, bridge_ip, username, &current_rtype, &current_rid)
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
            for light_id in resolve_to_light_ids(&client, bridge_ip, username, rtype, rid).await {
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
pub(crate) fn apply_channel_region_overrides(
    channels: &mut [HueAreaChannel],
    overrides: &[Option<String>],
) {
    for (i, channel) in channels.iter_mut().enumerate() {
        if let Some(Some(region_str)) = overrides.get(i) {
            if let Some(region) = super::frame::parse_screen_region(region_str) {
                channel.screen_region = region;
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Sender builder: DTLS-with-HTTP-fallback orchestrator
// ---------------------------------------------------------------------------

/// No-op sender used when the HTTP client cannot be built. Centralised so we
/// avoid scattering the `tx`/`channel_count` initialiser across the failure
/// paths of `build_hue_sender_with_counter`.
pub(crate) fn no_op_sender() -> HueColorSender {
    let (tx, _rx) = std::sync::mpsc::sync_channel::<HueColorUpdate>(1);
    HueColorSender {
        tx: Arc::new(tx),
        channel_count: 0,
    }
}

/// Spawn the Hue color sender (DTLS or HTTP fallback) **outside** any mutex
/// lock.  This function performs blocking network I/O (DTLS handshake, HTTP
/// activate) and must never be called while the `HueRuntimeOwner` lock is held.
/// Returns `(sender, uses_dtls, shutdown_signal, deactivate_token)`. The
/// caller stores the token in `HueActiveStreamContext` so foreground
/// `stop_hue_stream` and the reconnect monitor share the same one-shot
/// dedupe primitive as the sender thread itself.
pub(crate) fn build_hue_sender(
    request: &super::state_store::StartHueStreamRequest,
    channels: Vec<HueAreaChannel>,
    light_metadata: Arc<HashMap<String, HueLightMetadata>>,
) -> (HueColorSender, bool, ShutdownSignal, Arc<DeactivateToken>) {
    let packet_counter = Arc::new(std::sync::atomic::AtomicU32::new(0));
    let (sender, uses_dtls, shutdown, _cipher, token) =
        build_hue_sender_with_counter(request, channels, light_metadata, packet_counter);
    (sender, uses_dtls, shutdown, token)
}

/// Variant of `build_hue_sender` that takes an external packet counter and
/// returns the negotiated cipher together with the deactivate dedupe token.
pub(crate) fn build_hue_sender_with_counter(
    request: &super::state_store::StartHueStreamRequest,
    channels: Vec<HueAreaChannel>,
    light_metadata: Arc<HashMap<String, HueLightMetadata>>,
    packet_counter: Arc<std::sync::atomic::AtomicU32>,
) -> (
    HueColorSender,
    bool,
    ShutdownSignal,
    Option<String>,
    Arc<DeactivateToken>,
) {
    // v1.5 W2-A2 — keychain-first credential resolution. The request
    // values from the Tauri command are treated as a downgrade-safe
    // fallback for legacy v1.4 users whose credentials still live in
    // the plaintext shellStore fields. When the keychain holds both
    // halves we use those over the request values; this is the path
    // every v1.5+ user takes after the first successful pairing.
    let store = super::credential_store::default_store();
    let resolved = super::credential_store::resolve_hue_credentials(
        store.as_ref(),
        &request.username,
        &request.client_key,
    );
    let (resolved_username, resolved_client_key) = match resolved {
        Some(r) => (r.username, r.client_key),
        None => (request.username.clone(), request.client_key.clone()),
    };
    let has_client_key = !resolved_client_key.trim().is_empty();

    // Single dedupe token shared by the sender thread, foreground stop, and
    // reconnect monitor. The HTTP fallback path also gets a token so call
    // sites have a uniform shape — fallback paths simply never need to
    // acquire it because there is no DTLS slot to release on the bridge.
    let deactivate_token = DeactivateToken::new();

    if has_client_key {
        match hue_http_client_arc() {
            Ok(client) => {
                // Spawn DTLS attempt on a dedicated OS thread with a hard deadline.
                // DTLS handshake can block indefinitely if the bridge ignores UDP:2100 —
                // the socket-level read timeout is not honored by OpenSSL's retransmit loop.
                let (tx_result, rx_result) = std::sync::mpsc::channel();
                let client_clone = client.clone();
                let bridge_ip_t = request.bridge_ip.clone();
                let username_t = resolved_username.clone();
                let client_key_t = resolved_client_key.clone();
                let area_id_t = request.area_id.clone();
                let channels_t = channels.clone();
                let light_metadata_t = Arc::clone(&light_metadata);
                let counter_t = Arc::clone(&packet_counter);
                let token_t = Arc::clone(&deactivate_token);

                std::thread::spawn(move || {
                    let result = spawn_hue_dtls_sender(
                        client_clone,
                        bridge_ip_t,
                        username_t,
                        client_key_t,
                        area_id_t,
                        channels_t,
                        light_metadata_t,
                        counter_t,
                        token_t,
                    );
                    let _ = tx_result.send(result);
                });

                match rx_result
                    .recv_timeout(Duration::from_secs(super::dtls::DTLS_CONNECT_TIMEOUT_SECS))
                {
                    Ok(Ok((sender, shutdown, cipher_name))) => {
                        info!("DTLS entertainment stream established successfully.");
                        (sender, true, shutdown, cipher_name, deactivate_token)
                    }
                    Ok(Err(err)) => {
                        warn!("DTLS connection failed ({err}), falling back to HTTP.");
                        let (sender, shutdown) = spawn_hue_http_sender(
                            client,
                            request.bridge_ip.clone(),
                            resolved_username.clone(),
                            channels.clone(),
                        );
                        (sender, false, shutdown, None, deactivate_token)
                    }
                    Err(_timeout) => {
                        warn!(
                            "DTLS handshake timed out after {}s, falling back to HTTP.",
                            super::dtls::DTLS_CONNECT_TIMEOUT_SECS
                        );
                        let (sender, shutdown) = spawn_hue_http_sender(
                            client,
                            request.bridge_ip.clone(),
                            resolved_username.clone(),
                            channels.clone(),
                        );
                        (sender, false, shutdown, None, deactivate_token)
                    }
                }
            }
            Err(err) => {
                error!("HUE_SENDER_INIT_FAILED: {err}");
                (
                    no_op_sender(),
                    false,
                    new_shutdown_signal(),
                    None,
                    deactivate_token,
                )
            }
        }
    } else {
        info!("No clientKey provided, using HTTP fallback sender.");
        match hue_http_client_arc() {
            Ok(client) => {
                let (sender, shutdown) = spawn_hue_http_sender(
                    client,
                    request.bridge_ip.clone(),
                    resolved_username.clone(),
                    channels.clone(),
                );
                (sender, false, shutdown, None, deactivate_token)
            }
            Err(err) => {
                error!("HUE_SENDER_INIT_FAILED: {err}");
                (
                    no_op_sender(),
                    false,
                    new_shutdown_signal(),
                    None,
                    deactivate_token,
                )
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Per-light archetype + gamut metadata (v1.5 W1-C1)
// ---------------------------------------------------------------------------
//
// CLIP v2 `/resource/light/{id}` exposes a `color.gamut_type` field
// (`"A"`, `"B"`, `"C"`, or `"other"`) that we need before applying the
// per-bulb gamut triangle clip in W1-C2. The archetype string (e.g.
// `"hue_go"`, `"sultan_bulb"`) is also surfaced for telemetry and for
// future bulb-specific dimming curves.
//
// The fetch helper is `async` (uses the same `reqwest::Client` pool as
// `fetch_area_channels`) and must run **outside** the streaming hot
// path: callers should populate the cache once at runtime activation
// and then read it under the runtime lock during frame build. The cache
// itself is a plain `HashMap<lightId, HueLightMetadata>` so it can be
// embedded inside `HueActiveStreamContext` without extra synchronisation
// (the lock that protects the active stream context already covers it).

/// Hue per-bulb gamut type as advertised by the bridge under
/// `color.gamut_type` in the `/resource/light/{id}` payload. The four
/// canonical Hue gamuts are A (early bulbs), B (Hue v1 bulbs from
/// 2012-2016), C (modern Hue Color White & Ambiance), and `Other`
/// (unknown / fallback).
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum HueGamutType {
    A,
    B,
    C,
    Other,
}

impl HueGamutType {
    pub fn from_clip_str(value: &str) -> Self {
        match value.trim() {
            "A" | "a" => HueGamutType::A,
            "B" | "b" => HueGamutType::B,
            "C" | "c" => HueGamutType::C,
            _ => HueGamutType::Other,
        }
    }
}

/// Per-bulb metadata fetched from `/clip/v2/resource/light/{id}`. The
/// runtime keeps a `light_id → HueLightMetadata` cache so the streaming
/// hot path never hits the bridge to look up gamut info.
#[derive(Clone, Debug)]
pub struct HueLightMetadata {
    pub light_id: String,
    /// Bulb archetype (e.g. `"sultan_bulb"`, `"hue_go"`) reported by CLIP v2.
    /// Surfaced for telemetry; consumed by future bulb-specific dimming curves.
    #[allow(dead_code)] // read-by-W1-C3b frame builder + future telemetry
    pub archetype: Option<String>,
    /// Gamut triangle this bulb supports — read by the frame builder hot
    /// path for per-bulb CIE xy clipping.
    pub gamut_type: HueGamutType,
}

/// Parse a single CLIP v2 `/resource/light/{id}` response payload and
/// extract the archetype + gamut type. Public so the unit tests in
/// `sender::tests` can exercise the parser without a live bridge.
pub fn parse_light_metadata(light_id: &str, payload: &Value) -> Option<HueLightMetadata> {
    let item = payload
        .get("data")
        .and_then(|v| v.as_array())
        .and_then(|items| items.first())?;
    let archetype = item
        .get("metadata")
        .and_then(|m| m.get("archetype"))
        .and_then(|a| a.as_str())
        .map(|s| s.to_string());
    let gamut_type = item
        .get("color")
        .and_then(|c| c.get("gamut_type"))
        .and_then(|g| g.as_str())
        .map(HueGamutType::from_clip_str)
        .unwrap_or(HueGamutType::Other);
    Some(HueLightMetadata {
        light_id: light_id.to_string(),
        archetype,
        gamut_type,
    })
}

/// Fetch `/clip/v2/resource/light/{light_id}` and return the parsed
/// metadata. Errors propagate as a string so the caller can decide
/// whether to fall back to `HueGamutType::Other` (loud) or skip the
/// clipping step (silent).
pub async fn fetch_light_metadata(
    bridge_ip: &str,
    username: &str,
    light_id: &str,
) -> Result<HueLightMetadata, String> {
    let client = async_hue_http_client()?;
    let endpoint = format!("https://{bridge_ip}/clip/v2/resource/light/{light_id}");
    let response = client
        .get(endpoint)
        .header("hue-application-key", username)
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|error| error.to_string())?;
    let body = response.text().await.map_err(|error| error.to_string())?;
    let value: Value = serde_json::from_str(&body).map_err(|error| error.to_string())?;
    parse_light_metadata(light_id, &value).ok_or_else(|| {
        format!("Bridge response for light `{light_id}` did not include a data array")
    })
}

/// Convenience: drain a slice of resolved channels into a flat list of
/// unique light ids. Used by the runtime to populate the metadata cache
/// in a single batch (one `fetch_light_metadata` call per light id).
pub fn unique_light_ids(channels: &[HueAreaChannel]) -> Vec<String> {
    let mut out = Vec::new();
    for ch in channels {
        for id in &ch.light_ids {
            if !out.iter().any(|existing: &String| existing == id) {
                out.push(id.clone());
            }
        }
    }
    out
}

/// Pre-fetch per-light metadata for every unique light id referenced by the
/// provided channels and return it as a ready-to-share `Arc<HashMap>`.
///
/// Failure mode is **graceful**: any single `fetch_light_metadata` error is
/// swallowed (the bridge response shape can vary across firmware versions
/// and we never want a metadata fetch to abort entertainment-area
/// activation). The returned map omits the failing light ids; the frame
/// builder treats absent entries as `HueGamutType::Other` and skips the
/// per-bulb gamut clip — i.e. the bulb keeps the v1.4 behaviour while the
/// rest of the area benefits from the per-bulb projection.
///
/// Bridge fan-out is sequential: a typical Hue entertainment area has
/// 1-10 lights and CLIP v2 light fetches each return in <50 ms on a LAN,
/// well below the activation budget. If a future area type pushes that
/// envelope this helper can be parallelised with `futures::future::join_all`
/// without changing the public signature.
pub async fn fetch_light_metadata_for_channels(
    bridge_ip: &str,
    username: &str,
    channels: &[HueAreaChannel],
) -> HashMap<String, HueLightMetadata> {
    let mut out = HashMap::new();
    for light_id in unique_light_ids(channels) {
        match fetch_light_metadata(bridge_ip, username, &light_id).await {
            Ok(meta) => {
                out.insert(meta.light_id.clone(), meta);
            }
            Err(err) => {
                warn!("light metadata fetch failed for `{light_id}`: {err}; falling back to HueGamutType::Other");
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::super::frame::HueScreenRegion;
    use super::*;

    use std::thread;

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

    // -----------------------------------------------------------------------
    // Per-light metadata parser (v1.5 W1-C1)
    // -----------------------------------------------------------------------

    #[test]
    fn from_clip_str_maps_canonical_gamut_letters() {
        assert_eq!(HueGamutType::from_clip_str("A"), HueGamutType::A);
        assert_eq!(HueGamutType::from_clip_str("B"), HueGamutType::B);
        assert_eq!(HueGamutType::from_clip_str("C"), HueGamutType::C);
        assert_eq!(HueGamutType::from_clip_str("other"), HueGamutType::Other);
        assert_eq!(HueGamutType::from_clip_str(""), HueGamutType::Other);
        assert_eq!(HueGamutType::from_clip_str("Z"), HueGamutType::Other);
    }

    #[test]
    fn parse_light_metadata_extracts_archetype_and_gamut() {
        let payload = serde_json::json!({
            "data": [{
                "id": "abc-123",
                "metadata": { "archetype": "sultan_bulb", "name": "Sofa back" },
                "color": { "gamut_type": "C" }
            }]
        });
        let meta = parse_light_metadata("abc-123", &payload).expect("metadata parsed");
        assert_eq!(meta.light_id, "abc-123");
        assert_eq!(meta.archetype.as_deref(), Some("sultan_bulb"));
        assert_eq!(meta.gamut_type, HueGamutType::C);
    }

    #[test]
    fn parse_light_metadata_falls_back_to_other_when_gamut_missing() {
        let payload = serde_json::json!({
            "data": [{
                "id": "abc-123",
                "metadata": { "archetype": "hue_go" }
            }]
        });
        let meta = parse_light_metadata("abc-123", &payload).expect("metadata parsed");
        assert_eq!(meta.gamut_type, HueGamutType::Other);
        assert_eq!(meta.archetype.as_deref(), Some("hue_go"));
    }

    #[test]
    fn parse_light_metadata_returns_none_on_empty_payload() {
        let payload = serde_json::json!({ "data": [] });
        assert!(parse_light_metadata("nope", &payload).is_none());
    }

    #[test]
    fn unique_light_ids_dedupes_across_channels() {
        let channels = vec![
            HueAreaChannel {
                channel_id: 0,
                light_ids: vec!["a".to_string(), "b".to_string()],
                screen_region: HueScreenRegion::Center,
                position_x: 0.0,
                position_y: 0.0,
            },
            HueAreaChannel {
                channel_id: 1,
                light_ids: vec!["b".to_string(), "c".to_string()],
                screen_region: HueScreenRegion::Center,
                position_x: 0.0,
                position_y: 0.0,
            },
        ];
        let ids = unique_light_ids(&channels);
        assert_eq!(ids, vec!["a".to_string(), "b".to_string(), "c".to_string()]);
    }

    // -----------------------------------------------------------------------
    // DeactivateToken (v1.5.2 A1.3) — dedupe primitive for entertainment-config
    // deactivation across the sender thread, foreground stop, and reconnect monitor.
    // -----------------------------------------------------------------------

    #[test]
    fn deactivate_token_grants_first_caller_only_once() {
        let token = DeactivateToken::new();
        assert!(
            token.try_acquire(),
            "first caller should win the deactivate token"
        );
        assert!(
            !token.try_acquire(),
            "second caller must observe the in-flight bit and no-op"
        );
        assert!(
            token.was_acquired(),
            "was_acquired must reflect that a winner exists"
        );
    }

    #[test]
    fn deactivate_token_dedupes_concurrent_callers() {
        // Spawn many threads that race for the token; exactly one wins.
        let token = DeactivateToken::new();
        let mut handles = Vec::new();
        let winners = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        for _ in 0..16 {
            let t = Arc::clone(&token);
            let w = Arc::clone(&winners);
            handles.push(thread::spawn(move || {
                if t.try_acquire() {
                    w.fetch_add(1, std::sync::atomic::Ordering::AcqRel);
                }
            }));
        }
        for h in handles {
            h.join().expect("worker did not panic");
        }
        assert_eq!(
            winners.load(std::sync::atomic::Ordering::Acquire),
            1,
            "exactly one caller must win the token even under concurrent pressure"
        );
        assert!(token.was_acquired());
    }
}
