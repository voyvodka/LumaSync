//! The background DTLS sender thread: pacing loop, keep-alive, and the
//! bring-up/handshake that spawns it. Carved out of `sender.rs`.
//!
//! The 50 ms (20 Hz) minimum interval and the keep-alive cadence are
//! protocol-critical and must not drift (the floor: docs/architecture/hue.md).

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering as AtomicOrdering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use log::{debug, error, warn};
use reqwest::blocking::Client as BlockingClient;

use super::super::dtls::connect_dtls;
use super::super::easing::HueEasing;
use super::super::frame::{
    clip_channels_to_gamut, encode_huestream_frame, HueAreaChannel, HueColorSender, HueFrameRx,
};
use super::channels::HueLightMetadata;
use super::entertainment::{
    activate_entertainment_config, deactivate_with_token, new_shutdown_signal,
    signal_shutdown_complete, DeactivateToken, ShutdownSignal,
};

/// Minimum interval between Hue color pushes in the background sender thread.
/// 50ms = 20 Hz max, well within CLIP v2 limits and imperceptibly fast.
pub(crate) const HUE_SENDER_MIN_INTERVAL_MS: u64 = 50;

// ---------------------------------------------------------------------------
// Background DTLS sender thread
// ---------------------------------------------------------------------------

/// Is a failed DTLS write the stop we are in the middle of, rather than a
/// fault? Either somebody holds the deactivate token (a stop, restart or
/// reconnect cleanup already PUT `action: stop`), or every sender handle is
/// gone. Only the write-failure log level depends on this.
pub(super) fn dtls_write_failed_during_stop(
    deactivate_token: &DeactivateToken,
    rx: &HueFrameRx,
) -> bool {
    deactivate_token.was_acquired() || rx.is_closed()
}

/// Keep-alive: with no new frame for this long, the last one is sent again so
/// the bridge does not close the session after ~10 s of silence.
const HUE_DTLS_KEEPALIVE: Duration = Duration::from_secs(2);

/// One DTLS session's send loop, apart from the socket so the frame it picks
/// is testable. `min_interval` is `HUE_SENDER_MIN_INTERVAL_MS` outside tests.
pub(crate) struct DtlsSendLoop<'a> {
    pub(crate) area_id: &'a str,
    pub(crate) channels: &'a [HueAreaChannel],
    pub(crate) light_metadata: &'a HashMap<String, HueLightMetadata>,
    pub(crate) packet_counter: &'a AtomicU32,
    pub(crate) deactivate_token: &'a DeactivateToken,
    pub(crate) min_interval: Duration,
    pub(crate) keepalive: Duration,
}

impl DtlsSendLoop<'_> {
    /// Returns once every sender handle is gone or a write fails.
    pub(crate) fn run<W: std::io::Write>(&self, stream: &mut W, rx: &HueFrameRx) {
        let mut last_sent_at = Instant::now()
            .checked_sub(self.min_interval)
            .unwrap_or_else(Instant::now);
        // The easing time constant is one tick, so a step never lags the
        // newest target by much more than one packet.
        let mut easing = HueEasing::new(self.channels.len(), self.min_interval);
        let mut frame = Vec::new();

        loop {
            // Still gliding: the next tick is due whether or not a frame comes.
            let wait = if easing.settled() {
                self.keepalive
            } else {
                (last_sent_at + self.min_interval).saturating_duration_since(Instant::now())
            };
            let waited = match rx.recv_timeout(wait) {
                Ok(update) => Some(update),
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => None,
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
            };

            let elapsed = Instant::now().saturating_duration_since(last_sent_at);
            if elapsed < self.min_interval {
                thread::sleep(self.min_interval - elapsed);
            }

            // Taken after the pacing sleep, not before it: a frame that arrived
            // during the sleep is up to 50 ms newer than the one that woke us.
            let latest = rx.try_recv().ok().or(waited);
            if let Some(mut update) = latest {
                clip_channels_to_gamut(
                    self.channels,
                    &mut update.channel_colors,
                    self.light_metadata,
                );
                easing.retarget(&update.channel_colors, update.brightness, update.motion);
            }

            let (colors, brightness) = easing.step(Instant::now());
            encode_huestream_frame(self.area_id, self.channels, colors, brightness, &mut frame);
            if stream.write_all(&frame).is_err() {
                if dtls_write_failed_during_stop(self.deactivate_token, rx) {
                    // A stop's deactivate PUT ends the bridge session under a
                    // frame already in flight. Expected, not a fault.
                    debug!("DTLS write failed while the stream was being stopped.");
                } else {
                    error!("DTLS write failed, stopping entertainment stream.");
                }
                break;
            }

            // Increment packet counter for telemetry.
            self.packet_counter.fetch_add(1, AtomicOrdering::Relaxed);

            last_sent_at = Instant::now();
        }
    }
}

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
    abandoned: Arc<AtomicBool>,
) -> Result<(HueColorSender, ShutdownSignal, Option<String>), String> {
    let (color_sender, rx) = HueColorSender::with_mailbox(channels.len());

    // Activate entertainment mode via HTTPS before starting DTLS.
    activate_entertainment_config(&client, &bridge_ip, &username, &area_id)?;

    // Establish DTLS connection. On failure the area is already activated and
    // the sender thread that owns cleanup never spawns, so roll the activation
    // back here or the bridge keeps `active_streamer` until it is restarted.
    let mut dtls_stream = match connect_dtls(&bridge_ip, &username, &client_key) {
        Ok(stream) => stream,
        Err(err) => {
            if let Err(cleanup_err) =
                deactivate_with_token(&deactivate_token, &client, &bridge_ip, &username, &area_id)
            {
                warn!(
                    "DTLS bring-up failed and the rollback deactivate also failed \
                     ({cleanup_err}) — bridge may hold active_streamer for area {area_id}"
                );
            }
            return Err(err);
        }
    };

    // A handshake landing after the caller's 8 s deadline has no owner: nothing
    // would ever stop the sender it spawns, and that sender's cleanup would PUT
    // `action: stop` on an area a LATER session may already have claimed.
    if abandoned.load(AtomicOrdering::Acquire) {
        use openssl::ssl::ShutdownState;
        warn!("DTLS handshake completed after the caller abandoned it; tearing the session down.");
        dtls_stream.set_shutdown(ShutdownState::RECEIVED);
        let _ = dtls_stream.shutdown();
        drop(dtls_stream);
        return Err("DTLS_HANDSHAKE_ABANDONED".to_string());
    }

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
        // Per-light metadata cache (gamut_type / archetype). Read by the
        // frame builder on every send for per-bulb gamut clipping.
        DtlsSendLoop {
            area_id: &area_id,
            channels: &channels,
            light_metadata: &light_metadata,
            packet_counter: &packet_counter,
            deactivate_token: &deactivate_token,
            min_interval: Duration::from_millis(HUE_SENDER_MIN_INTERVAL_MS),
            keepalive: HUE_DTLS_KEEPALIVE,
        }
        .run(&mut dtls_stream, &rx);

        // Emit DTLS `close_notify` before dropping the socket so the
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

    Ok((color_sender, shutdown, cipher_name))
}
