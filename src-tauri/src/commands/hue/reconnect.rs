//! Reconnect monitor + abort guard + active-stream-context plumbing.
//!
//! Carved out of the original `hue_stream_lifecycle.rs` during the v1.5 G8
//! split. This module owns:
//!
//! - `StartAbortGuard` — RAII guard that flips the runtime to `Failed` if
//!   `start_hue_stream`/`restart_hue_stream` exit before the active-stream
//!   context is stored.
//! - `store_active_stream_context` (+ `_with_cipher` variant) — the
//!   in-memory writer that hands a freshly-spawned sender into
//!   `HueRuntimeOwner` and resets the per-session telemetry counters.
//! - `spawn_reconnect_monitor` — the Tokio task that polls a
//!   `ShutdownSignal` and reacts to background sender thread exits with a
//!   bounded retry ladder.
//! - `internal_restart_stream` — the lock-aware restart pipeline used by
//!   the reconnect monitor to bring up a new DTLS session without going
//!   through the public `restart_hue_stream` Tauri command.
//!
//! v1.5.2 A1.3 update: the historical 1 s sleep that followed the
//! reconnect-path deactivation has been removed. Both root causes
//! (missing DTLS `close_notify`, double deactivate PUT) are now fixed at
//! the source — the sender thread emits `close_notify` before drop, and
//! `DeactivateToken` guarantees a single PUT regardless of which call
//! site (sender thread / foreground stop / reconnect monitor) wins the
//! race.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use log::info;

use super::super::hue_onboarding::check_hue_stream_readiness_with_freshness;
use super::area_cache::HueReadFreshness;
use super::frame::HueAreaChannel;
use super::frame::HueColorSender;
use super::retry::register_transient_fault;
use super::sender::{
    apply_channel_region_overrides, build_hue_sender_with_counter, deactivate_with_token,
    fetch_area_channels, fetch_light_metadata_for_channels, hue_http_client, wait_for_shutdown,
    DeactivateToken, HueLightMetadata, ShutdownSignal,
};
use super::state_store::{
    acquire_hue_runtime, flush_pending_solid_color, make_result, status_with,
    HueActiveStreamContext, HuePersistentSender, HueRuntimeActionHint, HueRuntimeOwner,
    HueRuntimeState, HueRuntimeTriggerSource, StartHueStreamRequest,
};

// ---------------------------------------------------------------------------
// Active-stream-context store
// ---------------------------------------------------------------------------

/// Store an already-spawned sender into the runtime owner.  This function only
/// touches in-memory fields — no I/O — so it is safe to call under the lock.
#[allow(clippy::too_many_arguments)] // light_metadata + deactivate_token push the arity past 7; collapsing into a struct hides the per-call-site distinction between fresh-spawn payload and runtime owner mutation
pub(crate) fn store_active_stream_context(
    owner: &mut HueRuntimeOwner,
    request: &StartHueStreamRequest,
    channels: Vec<HueAreaChannel>,
    color_sender: HueColorSender,
    uses_dtls: bool,
    shutdown_signal: ShutdownSignal,
    light_metadata: Arc<HashMap<String, HueLightMetadata>>,
    deactivate_token: Arc<DeactivateToken>,
) {
    store_active_stream_context_with_cipher(
        owner,
        request,
        channels,
        color_sender,
        uses_dtls,
        shutdown_signal,
        None,
        light_metadata,
        deactivate_token,
    );
}

#[allow(clippy::too_many_arguments)] // light_metadata + deactivate_token push the active-stream-context store past 7 args; collapsing into a struct here would split the mutation boundary (HueRuntimeOwner) from the fresh-spawn payload and obscure which fields each caller controls
pub(crate) fn store_active_stream_context_with_cipher(
    owner: &mut HueRuntimeOwner,
    request: &StartHueStreamRequest,
    channels: Vec<HueAreaChannel>,
    color_sender: HueColorSender,
    uses_dtls: bool,
    shutdown_signal: ShutdownSignal,
    cipher_name: Option<String>,
    light_metadata: Arc<HashMap<String, HueLightMetadata>>,
    deactivate_token: Arc<DeactivateToken>,
) {
    // Keep a persistent clone that survives stream stop/start cycles.
    if !channels.is_empty() {
        owner.persistent_sender = Some(HuePersistentSender {
            area_id: request.area_id.clone(),
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
        light_metadata,
        deactivate_token,
    });

    // Update telemetry tracking fields.
    owner.stream_started_at = Some(Instant::now());
    owner.reconnect_attempt = 0;
    owner
        .packet_send_count
        .store(0, std::sync::atomic::Ordering::Relaxed);
    owner.packet_rate_sampled_at = Some(Instant::now());
    owner.packet_rate_last_count = 0;
    if uses_dtls {
        owner.dtls_cipher = cipher_name;
        owner.dtls_connected_at = Some(Instant::now());
    }
}

// ---------------------------------------------------------------------------
// RAII abort guard for the start/restart pipelines
// ---------------------------------------------------------------------------

/// RAII guard that resets the Hue runtime to `Failed` if `start_hue_stream`
/// exits without successfully completing step 4c.  Call `.disarm()` once
/// `store_active_stream_context` has been called.
pub(crate) struct StartAbortGuard {
    runtime: Arc<Mutex<HueRuntimeOwner>>,
    armed: bool,
}

impl StartAbortGuard {
    pub(crate) fn new(runtime: Arc<Mutex<HueRuntimeOwner>>) -> Self {
        Self {
            runtime,
            armed: true,
        }
    }
    pub(crate) fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for StartAbortGuard {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        let mut owner = acquire_hue_runtime(&self.runtime);
        if matches!(
            owner.state,
            HueRuntimeState::Starting | HueRuntimeState::Running
        ) {
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

// ---------------------------------------------------------------------------
// Reconnect-in-progress RAII guard
// ---------------------------------------------------------------------------

/// Clears `HueRuntimeOwner::reconnect_in_progress` when the reconnect monitor
/// leaves its restart critical section, on EVERY exit path (early backoff
/// return, readiness give-up, successful restart, or panic). Pairs with the
/// atomic check-and-set the monitor performs to claim the restart, so a
/// status-poll/monitor race can never leave the flag stuck `true` and block
/// all future self-healing reconnects.
struct ReconnectInProgressGuard {
    runtime: Arc<Mutex<HueRuntimeOwner>>,
}

impl Drop for ReconnectInProgressGuard {
    fn drop(&mut self) {
        let mut owner = acquire_hue_runtime(&self.runtime);
        owner.reconnect_in_progress = false;
    }
}

/// Outcome of the monitor's atomic restart-claim decision.
#[derive(Debug, PartialEq, Eq)]
enum ReconnectClaim {
    /// The monitor may proceed to restart; `reconnect_in_progress` was set.
    Proceed,
    /// The monitor must bail without restarting (intentional stop, exhausted
    /// `Failed` runtime, or another restart already in flight).
    Abort,
}

/// Atomic check-and-set that decides whether the reconnect monitor should
/// drive a restart. Performed under the runtime lock so a status-poll/monitor
/// race can never launch two restarts.
///
/// Returns `Abort` (and does NOT set the flag) when:
/// - a user stop is pending or the runtime is `Idle`/`Stopping` (user wins),
/// - the runtime is `Failed` (exhausted budget self-aborts),
/// - a restart is already in flight (`reconnect_in_progress == true`).
///
/// Otherwise sets `reconnect_in_progress = true` and returns `Proceed`. The
/// guard deliberately does NOT treat `state == Reconnecting` as a reason to
/// abort: the status poll marks the runtime `Reconnecting` for the UI without
/// launching a restart, and the monitor must still be able to heal that case.
fn try_claim_reconnect(owner: &mut HueRuntimeOwner) -> ReconnectClaim {
    if owner.user_override_pending
        || matches!(
            owner.state,
            HueRuntimeState::Idle | HueRuntimeState::Stopping
        )
    {
        return ReconnectClaim::Abort;
    }
    // A genuinely exhausted runtime must STILL self-abort — never let the
    // monitor restart a Failed runtime.
    if owner.state == HueRuntimeState::Failed {
        return ReconnectClaim::Abort;
    }
    // If another monitor already claimed the restart, bail (no restart storm).
    if owner.reconnect_in_progress {
        return ReconnectClaim::Abort;
    }
    owner.reconnect_in_progress = true;
    ReconnectClaim::Proceed
}

/// Should the monitor stop waiting on a shutdown signal that may never fire?
/// Mirrors [`try_claim_reconnect`]'s abort set, so bailing here only ever
/// short-circuits a wait whose claim would have been refused anyway.
fn monitor_wait_is_pointless(owner: &HueRuntimeOwner) -> bool {
    owner.user_override_pending
        || matches!(
            owner.state,
            HueRuntimeState::Idle | HueRuntimeState::Stopping | HueRuntimeState::Failed
        )
}

/// How long each blocking chunk of the shutdown wait lasts. Only bounds how
/// often the liveness re-check runs; the condvar still wakes instantly on a
/// real signal.
const MONITOR_WAIT_CHUNK: Duration = Duration::from_secs(5);

/// Outcome of one `internal_restart_stream` attempt.
///
/// The distinction is the point: `Retryable` must re-arm the monitor (a
/// readiness blip that heals on its own used to dead-end self-healing after a
/// single attempt), while `Abandoned` must not (a user stop or a terminal
/// runtime state is a decision, not a failure).
#[derive(Debug)]
enum RestartOutcome {
    /// A fresh sender is running and has armed its own monitor.
    Restarted,
    /// Failed for a reason that may clear; consume another retry-budget slot.
    Retryable(String),
    /// User stop or terminal runtime state — exit without re-arming.
    Abandoned,
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
pub(crate) fn spawn_reconnect_monitor(
    shutdown_signal: ShutdownSignal,
    runtime: Arc<Mutex<HueRuntimeOwner>>,
    request: StartHueStreamRequest,
) {
    tokio::spawn(async move {
        // Block on the condvar the signal was built around instead of polling
        // it five times a second. Chunked so a signal that can never fire
        // cannot pin a blocking-pool thread for the life of the process.
        let signalled = {
            let signal = Arc::clone(&shutdown_signal);
            let probe = Arc::clone(&runtime);
            tokio::task::spawn_blocking(move || loop {
                if wait_for_shutdown(&signal, MONITOR_WAIT_CHUNK) {
                    return true;
                }
                if monitor_wait_is_pointless(&acquire_hue_runtime(&probe)) {
                    return false;
                }
            })
            .await
        };
        if !matches!(signalled, Ok(true)) {
            return;
        }

        // Sender thread has exited — check if this is an intentional stop and,
        // in the SAME lock acquisition, atomically claim the restart.
        //
        // Why one lock block: the status poll (`get_hue_stream_status`) may
        // have already flipped `state` to `Reconnecting` via
        // `register_transient_fault` to surface `TRANSIENT_RETRY_SCHEDULED` to
        // the UI — WITHOUT launching any restart. The old guard returned early
        // on `state == Reconnecting`, which dead-ended the monitor and left the
        // runtime stuck in `Reconnecting` with `active_stream = None` forever.
        // The double-trigger guard is now the `reconnect_in_progress` flag, set
        // here and cleared by `ReconnectInProgressGuard` on every exit path.
        let _in_progress_guard = {
            let mut owner = acquire_hue_runtime(&runtime);
            match try_claim_reconnect(&mut owner) {
                ReconnectClaim::Proceed => ReconnectInProgressGuard {
                    runtime: Arc::clone(&runtime),
                },
                ReconnectClaim::Abort => return,
            }
        };

        // Bounded by `register_transient_fault`, which owns the budget and
        // exits the ladder through `Failed`.
        let mut fault_detail = "DTLS sender thread exited unexpectedly".to_string();
        loop {
            let backoff_ms = {
                let mut owner = acquire_hue_runtime(&runtime);
                let result = register_transient_fault(
                    &mut owner,
                    &fault_detail,
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
            info!("Reconnect monitor: waiting {backoff_ms}ms before reconnect attempt.");
            tokio::time::sleep(Duration::from_millis(backoff_ms)).await;

            // Check state again before attempting reconnect.
            if monitor_wait_is_pointless(&acquire_hue_runtime(&runtime)) {
                return;
            }

            // Attempt restart using internal logic.
            info!("Reconnect monitor: attempting stream restart.");
            match internal_restart_stream(&runtime, &request).await {
                RestartOutcome::Restarted => {
                    let mut owner = acquire_hue_runtime(&runtime);
                    owner.session_reconnect_success += 1;
                    info!("Reconnect monitor: stream restarted successfully.");
                    // New monitor is spawned by the restart flow.
                    return;
                }
                RestartOutcome::Abandoned => {
                    info!("Reconnect monitor: restart abandoned — user stop or terminal state.");
                    return;
                }
                RestartOutcome::Retryable(detail) => {
                    info!("Reconnect monitor: restart attempt failed ({detail}); re-arming.");
                    fault_detail = detail;
                }
            }
        }
    });
}

/// Internal stream restart logic for the reconnect monitor.
/// Replicates the core logic of restart_hue_stream but accepts
/// Arc<Mutex<HueRuntimeOwner>> directly instead of Tauri State<>.
///
/// Fault registration belongs to the caller: this fn reports *why* an attempt
/// ended and the monitor decides whether that spends a retry-budget slot.
async fn internal_restart_stream(
    runtime: &Arc<Mutex<HueRuntimeOwner>>,
    request: &StartHueStreamRequest,
) -> RestartOutcome {
    use super::frame::HueColorUpdate;

    // 1. Extract current stream info + dedupe token, then clear state.
    let dtls_deactivate = {
        let mut owner = acquire_hue_runtime(runtime);
        let deactivate = owner
            .active_stream
            .as_ref()
            .filter(|s| s.uses_dtls)
            .map(|s| {
                (
                    s.bridge_ip.clone(),
                    s.username.clone(),
                    s.area_id.clone(),
                    Arc::clone(&s.deactivate_token),
                )
            });
        owner.active_stream = None;
        owner.persistent_sender = None;
        deactivate
    };

    // Best-effort, dedupe-aware DTLS deactivation outside the lock. If the
    // sender thread already drained the token (close_notify cleanup path),
    // this call is a fast in-process no-op.
    //
    // A1.3: the historical 1 s sleep that used to follow this block was a
    // band-aid for the bridge "phantom active streamer" symptom caused by
    // the missing close_notify alert + double-deactivate race. Both root
    // causes are now fixed (sender emits close_notify before drop, and the
    // dedupe token guarantees a single PUT) so the sleep is gone.
    if let Some((ip, username, area_id, token)) = dtls_deactivate {
        let _ = tokio::task::spawn_blocking(move || {
            if let Ok(client) = hue_http_client() {
                let _ = deactivate_with_token(&token, &client, &ip, &username, &area_id);
            }
        })
        .await;
    }

    // 2. Readiness check (async, no lock held). Forced: this is the
    // pre-restart gate and the deactivate above just mutated the area.
    let readiness = check_hue_stream_readiness_with_freshness(
        request.bridge_ip.clone(),
        request.username.clone(),
        request.area_id.clone(),
        HueReadFreshness::Force,
    )
    .await;

    if !readiness.readiness.ready {
        // Deliberately NOT relaxed for `ACTIVE_STREAMER` the way the health
        // poll is: our own stream is already deactivated by this point, so a
        // busy area means a foreign client owns it and we must not hijack.
        return RestartOutcome::Retryable(format!(
            "Readiness check failed during reconnect: {}",
            readiness.status.message
        ));
    }

    // 3. Set state to Starting.
    {
        let mut owner = acquire_hue_runtime(runtime);
        if owner.user_override_pending
            || matches!(owner.state, HueRuntimeState::Idle | HueRuntimeState::Failed)
        {
            return RestartOutcome::Abandoned;
        }
        owner.state = HueRuntimeState::Starting;
    }

    // 4. Fetch channels.
    let mut channels = fetch_area_channels(&request.bridge_ip, &request.username, &request.area_id)
        .await
        .unwrap_or_default();
    if let Some(overrides) = &request.channel_region_overrides {
        apply_channel_region_overrides(&mut channels, overrides);
    }

    // 4b. Pre-fetch per-light archetype + gamut metadata (W1-C3a). Graceful:
    //     any per-light fetch failure simply omits that light from the cache
    //     so the frame builder treats it as `HueGamutType::Other` (no clip).
    let light_metadata = Arc::new(
        fetch_light_metadata_for_channels(&request.bridge_ip, &request.username, &channels).await,
    );

    // 5. Spawn sender (blocking), passing the owner's packet counter.
    let req = request.clone();
    let ch = channels.clone();
    let meta_for_sender = Arc::clone(&light_metadata);
    let packet_counter = {
        let owner = acquire_hue_runtime(runtime);
        Arc::clone(&owner.packet_send_count)
    };
    // A panicked spawn must not be stored as a live context: its shutdown
    // signal would never fire and the next monitor would wait on it forever.
    let Ok((color_sender, uses_dtls, shutdown_signal, cipher_name, deactivate_token)) =
        tokio::task::spawn_blocking(move || {
            build_hue_sender_with_counter(&req, ch, meta_for_sender, packet_counter)
        })
        .await
    else {
        return RestartOutcome::Retryable(
            "Sender spawn task panicked during reconnect".to_string(),
        );
    };

    // Suppress unused-import warning; HueColorUpdate is referenced indirectly
    // through HueColorSender's mpsc::SyncSender<HueColorUpdate> generic.
    let _ = std::marker::PhantomData::<HueColorUpdate>;

    // 6. Store context and spawn new monitor.
    {
        let mut owner = acquire_hue_runtime(runtime);
        if owner.user_override_pending
            || matches!(owner.state, HueRuntimeState::Idle | HueRuntimeState::Failed)
        {
            return RestartOutcome::Abandoned;
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
            light_metadata: Arc::clone(&light_metadata),
            deactivate_token: Arc::clone(&deactivate_token),
        };
        if !channels.is_empty() {
            owner.persistent_sender = Some(HuePersistentSender {
                area_id: request.area_id.clone(),
                channels: channels.clone(),
                sender: color_sender.clone(),
            });
        }
        owner.active_stream = Some(stream_ctx);
        owner.state = HueRuntimeState::Running;
        owner.reconnect_attempt = 0;
        owner.stream_started_at = Some(Instant::now());
        owner
            .packet_send_count
            .store(0, std::sync::atomic::Ordering::Relaxed);
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
        flush_pending_solid_color(&mut owner);
    }

    // Spawn new monitor for the new connection.
    spawn_reconnect_monitor(shutdown_signal, Arc::clone(runtime), request.clone());

    RestartOutcome::Restarted
}

// `make_result` is re-imported to silence "unused" warnings if some retry
// path of this module is later shortened — kept available because both
// `register_transient_fault` and `register_auth_invalid` already produce
// `HueRuntimeCommandResult` values that callers in this module discard.
#[allow(dead_code)]
fn _silence_make_result(owner: &HueRuntimeOwner) {
    let _ = make_result(owner);
}

#[cfg(test)]
mod tests {
    use super::*;

    use super::super::frame::{HueColorUpdate, HueScreenRegion};
    use super::super::retry::start_with_evidence;
    use super::super::sender::new_shutdown_signal;
    use super::super::state_store::test_helpers::strict_gate_ready;

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

        let _ = start_with_evidence(
            &mut owner,
            &strict_gate_ready(),
            HueRuntimeTriggerSource::ModeControl,
        );
        let (tx, _rx) = std::sync::mpsc::sync_channel::<HueColorUpdate>(1);
        let dummy_sender = HueColorSender {
            tx: Arc::new(tx),
            channel_count: 1,
        };
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
            Arc::new(std::collections::HashMap::new()),
            DeactivateToken::new(),
        );

        let active_stream = owner.active_stream.as_ref().expect("active stream context");
        assert_eq!(active_stream.bridge_ip, "192.168.1.2");
        assert_eq!(active_stream.username, "hue-user");
        assert_eq!(active_stream.area_id, "living-room");
        assert_eq!(active_stream.channels.len(), 1);
        assert_eq!(
            active_stream.channels[0].light_ids,
            vec!["light-1".to_string()]
        );
    }

    /// A1.3: when the sender thread already drained the token (close_notify
    /// path), the reconnect-monitor's deactivate call must observe the
    /// in-flight bit and skip the redundant PUT. This test covers the
    /// dedupe primitive contract directly — the network path is not
    /// exercised because `deactivate_with_token` short-circuits before
    /// touching the HTTP client.
    #[test]
    fn reconnect_monitor_deactivate_no_ops_when_already_done() {
        let token = DeactivateToken::new();
        // Simulate the sender thread winning the race first.
        assert!(token.try_acquire(), "sender thread should win first");

        // Now the reconnect monitor's call must be a no-op.
        // We exercise this by calling try_acquire again (the same primitive
        // backs deactivate_with_token's short-circuit).
        assert!(
            !token.try_acquire(),
            "reconnect monitor must observe the in-flight bit and skip the PUT"
        );
        assert!(token.was_acquired());
    }

    /// Race resolution (the v1.5.x stall fix): a status poll
    /// (`get_hue_stream_status`) can win the race and call
    /// `register_transient_fault`, flipping the runtime to `Reconnecting` and
    /// clearing `active_stream`, BEFORE the monitor's next tick. The monitor
    /// must still be able to claim and drive the restart — it must NOT
    /// dead-end on `state == Reconnecting`. Previously this stranded the
    /// runtime in `Reconnecting` forever.
    #[test]
    fn monitor_still_claims_restart_after_status_poll_sets_reconnecting() {
        let mut owner = HueRuntimeOwner::default();
        let _ = start_with_evidence(
            &mut owner,
            &strict_gate_ready(),
            HueRuntimeTriggerSource::ModeControl,
        );

        // Simulate the status-poll branch: register a transient fault (sets
        // Reconnecting + TRANSIENT_RETRY_SCHEDULED for the UI) and clear the
        // dead stream context, but DO NOT spawn a restart or arm a monitor.
        let poll = register_transient_fault(
            &mut owner,
            "DTLS sender thread exited unexpectedly.",
            HueRuntimeTriggerSource::System,
        );
        owner.active_stream = None;
        owner.persistent_sender = None;

        // UI-facing status must still surface Reconnecting / scheduled retry.
        assert_eq!(poll.status.state, HueRuntimeState::Reconnecting);
        assert_eq!(poll.status.code, "TRANSIENT_RETRY_SCHEDULED");
        assert!(!owner.reconnect_in_progress);

        // The monitor's guard must now PROCEED (not abort on Reconnecting).
        assert_eq!(try_claim_reconnect(&mut owner), ReconnectClaim::Proceed);
        assert!(
            owner.reconnect_in_progress,
            "claim must mark the restart in flight"
        );
    }

    /// Single-restart-per-fault guarantee: once a restart is in flight, a
    /// second claim (e.g. a duplicate/raced monitor) must abort. No storm.
    #[test]
    fn second_claim_aborts_while_restart_in_flight() {
        let mut owner = HueRuntimeOwner::default();
        let _ = start_with_evidence(
            &mut owner,
            &strict_gate_ready(),
            HueRuntimeTriggerSource::ModeControl,
        );
        let _ = register_transient_fault(
            &mut owner,
            "DTLS sender thread exited unexpectedly.",
            HueRuntimeTriggerSource::System,
        );

        assert_eq!(try_claim_reconnect(&mut owner), ReconnectClaim::Proceed);
        // A racing monitor sees the flag and bails without launching anything.
        assert_eq!(try_claim_reconnect(&mut owner), ReconnectClaim::Abort);
        assert!(owner.reconnect_in_progress);
    }

    /// The RAII guard must clear the flag on drop so the next genuine fault can
    /// re-claim a restart (otherwise self-healing would block permanently).
    #[test]
    fn in_progress_guard_clears_flag_on_drop() {
        let runtime = Arc::new(Mutex::new(HueRuntimeOwner::default()));
        let guard = {
            let mut owner = acquire_hue_runtime(&runtime);
            let _ = start_with_evidence(
                &mut owner,
                &strict_gate_ready(),
                HueRuntimeTriggerSource::ModeControl,
            );
            assert_eq!(try_claim_reconnect(&mut owner), ReconnectClaim::Proceed);
            assert!(owner.reconnect_in_progress);
            ReconnectInProgressGuard {
                runtime: Arc::clone(&runtime),
            }
        };
        // While the guard is alive the flag stays set...
        assert!(acquire_hue_runtime(&runtime).reconnect_in_progress);
        // ...and dropping it clears the flag so the next fault can re-claim.
        drop(guard);
        assert!(!acquire_hue_runtime(&runtime).reconnect_in_progress);
    }

    /// Must-preserve (a): a genuinely exhausted `Failed` runtime must STILL
    /// self-abort — the monitor must never restart a Failed runtime.
    #[test]
    fn failed_runtime_self_aborts_and_does_not_claim() {
        let mut owner = HueRuntimeOwner {
            state: HueRuntimeState::Failed,
            ..HueRuntimeOwner::default()
        };

        assert_eq!(try_claim_reconnect(&mut owner), ReconnectClaim::Abort);
        assert!(
            !owner.reconnect_in_progress,
            "Failed runtime must not claim a restart"
        );
    }

    /// F12: the monitor now blocks on the condvar instead of polling it, so
    /// its bail-out predicate must not be wider than the claim it protects —
    /// otherwise a wait would abandon a runtime that could still be healed.
    #[test]
    fn monitor_wait_bail_out_never_outruns_the_reconnect_claim() {
        for state in [
            HueRuntimeState::Idle,
            HueRuntimeState::Stopping,
            HueRuntimeState::Failed,
            HueRuntimeState::Starting,
            HueRuntimeState::Running,
            HueRuntimeState::Reconnecting,
        ] {
            for user_override_pending in [false, true] {
                let mut owner = HueRuntimeOwner {
                    state: state.clone(),
                    user_override_pending,
                    ..HueRuntimeOwner::default()
                };
                let bails = monitor_wait_is_pointless(&owner);
                let aborts = try_claim_reconnect(&mut owner) == ReconnectClaim::Abort;
                assert!(
                    !bails || aborts,
                    "monitor abandons {state:?} (override={user_override_pending}) \
                     but the claim would have proceeded"
                );
            }
        }
    }

    /// Must-preserve (b): a user stop (`user_override_pending`) must win —
    /// the monitor must abort and never claim a restart.
    #[test]
    fn user_stop_wins_over_reconnect_claim() {
        let mut owner = HueRuntimeOwner::default();
        let _ = start_with_evidence(
            &mut owner,
            &strict_gate_ready(),
            HueRuntimeTriggerSource::ModeControl,
        );
        owner.user_override_pending = true;
        owner.state = HueRuntimeState::Stopping;

        assert_eq!(try_claim_reconnect(&mut owner), ReconnectClaim::Abort);
        assert!(!owner.reconnect_in_progress);
    }
}
