//! Entertainment-configuration activate/deactivate over CLIP v2, the
//! deactivate dedupe token, and the shutdown-signal primitive both senders
//! use to report thread exit. Carved out of `sender.rs`.

use std::sync::atomic::{AtomicBool, Ordering as AtomicOrdering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use log::warn;
use reqwest::blocking::Client as BlockingClient;
use serde_json::json;

use super::super::super::hue_http::classify_hue_response_blocking;
use super::super::area_cache::invalidate_hue_area_cache;
use super::super::transport::{read_body_blocking, send_error_text};

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

// Deactivate dedupe token — coordinates three call sites that
// can race to PUT the same "stop". See docs/architecture/hue.md.

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

    /// Returns `true` for one *in-flight* PUT at a time. The winner performs
    /// the deactivation; every later caller observes `false` and skips it.
    pub(crate) fn try_acquire(&self) -> bool {
        self.in_flight
            .compare_exchange(false, true, AtomicOrdering::AcqRel, AtomicOrdering::Acquire)
            .is_ok()
    }

    /// Hand the token back after a PUT that did not land. What the token
    /// dedupes is *concurrent* PUTs; keeping it burned after a failure means
    /// no later caller ever retries and the bridge holds `active_streamer`.
    pub(crate) fn release(&self) {
        self.in_flight.store(false, AtomicOrdering::Release);
    }

    /// Is a deactivate PUT in flight, or did one land? The sender reads it to
    /// tell its own teardown apart from a real write failure.
    pub(crate) fn was_acquired(&self) -> bool {
        self.in_flight.load(AtomicOrdering::Acquire)
    }
}

/// Best-effort, dedupe-aware wrapper around `deactivate_entertainment_config`.
/// The first caller through the token performs the PUT; later callers are
/// no-ops and return `Ok(())`. This is the only entry point any of the three
/// shutdown call sites should use — direct calls to
/// `deactivate_entertainment_config` bypass the dedupe and reintroduce the
/// double-PUT race the token exists to close.
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
    let outcome = deactivate_entertainment_config(client, bridge_ip, username, area_id);
    settle_deactivate(token, area_id, outcome)
}

/// Split out from `deactivate_with_token` so the release-and-log rule is
/// testable without a bridge. Four of the six call sites discard this `Result`,
/// so the log has to live here or a failure leaves no trace at all.
pub(super) fn settle_deactivate(
    token: &DeactivateToken,
    area_id: &str,
    outcome: Result<(), String>,
) -> Result<(), String> {
    if let Err(err) = &outcome {
        token.release();
        warn!(
            "Deactivate PUT failed for area {area_id} ({err}); token released so a \
             later caller can retry — the bridge may hold active_streamer until one does"
        );
    }
    outcome
}

// ---------------------------------------------------------------------------
// Entertainment configuration activate/deactivate via CLIP v2
// ---------------------------------------------------------------------------

/// PUT /clip/v2/resource/entertainment_configuration/{area_id}
/// body: { "action": "start" }
///
/// This tells the bridge to enter entertainment mode for the given area.
/// Must be called BEFORE starting the DTLS stream.
pub(super) fn activate_entertainment_config(
    client: &BlockingClient,
    bridge_ip: &str,
    username: &str,
    area_id: &str,
) -> Result<(), String> {
    let endpoint =
        format!("https://{bridge_ip}/clip/v2/resource/entertainment_configuration/{area_id}");
    let sent = client
        .put(&endpoint)
        .header("hue-application-key", username)
        .json(&json!({ "action": "start" }))
        .send();

    // The area's `status.active` just changed (or may have, on a transport
    // error where the bridge still processed the PUT). Any snapshot taken
    // before this point now describes a state that no longer exists.
    invalidate_hue_area_cache();

    let response = sent.map_err(|e| {
        format!(
            "ENTERTAINMENT_ACTIVATE_SEND_FAILED: {}",
            send_error_text(&e)
        )
    })?;

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
/// callers bypass the dedupe primitive and risk re-introducing
/// the double-PUT race.
pub(crate) fn deactivate_entertainment_config(
    client: &BlockingClient,
    bridge_ip: &str,
    username: &str,
    area_id: &str,
) -> Result<(), String> {
    let endpoint =
        format!("https://{bridge_ip}/clip/v2/resource/entertainment_configuration/{area_id}");
    let sent = client
        .put(&endpoint)
        .header("hue-application-key", username)
        .json(&json!({ "action": "stop" }))
        .send();

    invalidate_hue_area_cache();

    let response = sent.map_err(|e| {
        format!(
            "ENTERTAINMENT_DEACTIVATE_SEND_FAILED: {}",
            send_error_text(&e)
        )
    })?;

    let status = response.status();
    if !status.is_success() {
        let body = read_body_blocking(response).unwrap_or_default();
        return Err(format!(
            "ENTERTAINMENT_DEACTIVATE_FAILED: HTTP {status} — {body}"
        ));
    }
    Ok(())
}
