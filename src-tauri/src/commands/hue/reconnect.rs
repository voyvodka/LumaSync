//! Reconnect monitor + abort guard + active-stream-context plumbing.
//!
//! Carved out of the original `hue_stream_lifecycle.rs`. This module owns:
//!
//! - `StartAbortGuard` — RAII guard that flips the runtime to `Failed` if
//!   `start_hue_stream`/`restart_hue_stream` exit before the active-stream
//!   context is stored.
//! - `spawn_hue_sender_with` — builds the sender wired to the owner's packet
//!   counter, so telemetry sees the packets it sends.
//! - `store_active_stream_context` — the in-memory writer that hands a
//!   freshly-spawned sender into `HueRuntimeOwner` and resets the
//!   per-session telemetry counters.
//! - `spawn_reconnect_monitor` — the Tokio task that polls a
//!   `ShutdownSignal` and reacts to background sender thread exits with a
//!   bounded retry ladder.
//! - `internal_restart_stream` — the lock-aware restart pipeline used by
//!   the reconnect monitor to bring up a new DTLS session without going
//!   through the public `restart_hue_stream` Tauri command.
//!
//! The historical 1 s sleep that followed the
//! reconnect-path deactivation has been removed. Both root causes
//! (missing DTLS `close_notify`, double deactivate PUT) are now fixed at
//! the source — the sender thread emits `close_notify` before drop, and
//! `DeactivateToken` guarantees a single PUT regardless of which call
//! site (sender thread / foreground stop / reconnect monitor) wins the
//! race.

use std::collections::HashMap;
use std::sync::atomic::AtomicU32;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use log::info;

use super::super::hue_onboarding::{
    check_hue_stream_readiness_with_freshness, ActiveStreamerView, HueStreamReadinessResponse,
    ACTIVE_STREAMER_REASON,
};
use super::area_cache::HueReadFreshness;
use super::commands::HUE_STOP_TIMEOUT_SECS;
use super::frame::HueAreaChannel;
use super::retry::{next_backoff_ms, register_area_taken_over, register_transient_fault};
use super::sender::{
    apply_channel_placements, build_hue_sender, deactivate_with_token, fetch_area_channels,
    fetch_light_metadata_for_channels, wait_for_shutdown, DeactivateToken, HueLightMetadata,
    ShutdownSignal, SpawnedHueSender,
};
use super::state_store::{
    acquire_hue_runtime, flush_pending_solid_color, status_with, HueActiveStreamContext,
    HuePersistentSender, HueRuntimeActionHint, HueRuntimeOwner, HueRuntimeState,
    HueRuntimeTriggerSource, StartHueStreamRequest,
};
use super::transport::blocking_client_for_key;

// ---------------------------------------------------------------------------
// Active-stream-context store
// ---------------------------------------------------------------------------

/// Builds a sender for a request; `build_hue_sender` outside tests.
pub(crate) type HueSenderBuild = Arc<
    dyn Fn(
            &StartHueStreamRequest,
            Vec<HueAreaChannel>,
            Arc<HashMap<String, HueLightMetadata>>,
            Arc<AtomicU32>,
        ) -> SpawnedHueSender
        + Send
        + Sync,
>;

/// What a reconnect takes from outside the runtime: the readiness gate and
/// the sender it builds. A test answers readiness itself, because a loopback
/// test bridge cannot pass the address guard readiness runs first.
#[derive(Clone)]
pub(crate) struct ReconnectDeps {
    readiness: ReconnectReadiness,
    build: HueSenderBuild,
}

#[derive(Clone, Copy)]
enum ReconnectReadiness {
    Bridge,
    #[cfg(test)]
    AssumeReady,
    #[cfg(test)]
    Answer(fn() -> HueStreamReadinessResponse),
}

impl ReconnectDeps {
    pub(crate) fn production() -> Self {
        Self {
            readiness: ReconnectReadiness::Bridge,
            build: Arc::new(|request, channels, light_metadata, packet_counter| {
                build_hue_sender(request, channels, light_metadata, packet_counter)
            }),
        }
    }

    #[cfg(test)]
    pub(crate) fn assume_ready(build: HueSenderBuild) -> Self {
        Self {
            readiness: ReconnectReadiness::AssumeReady,
            build,
        }
    }
}

/// Build the sender on a blocking thread — DTLS handshake / HTTP activate
/// create and drop a `reqwest::blocking::Client`, which panics on a Tokio
/// worker. `Err` means the build task panicked.
pub(crate) async fn spawn_hue_sender_with<F>(
    runtime: &Arc<Mutex<HueRuntimeOwner>>,
    build: F,
) -> Result<SpawnedHueSender, tokio::task::JoinError>
where
    F: FnOnce(Arc<AtomicU32>) -> SpawnedHueSender + Send + 'static,
{
    let packet_counter = Arc::clone(&acquire_hue_runtime(runtime).packet_send_count);
    tokio::task::spawn_blocking(move || build(packet_counter)).await
}

/// Store an already-spawned sender into the runtime owner.  This function only
/// touches in-memory fields — no I/O — so it is safe to call under the lock.
pub(crate) fn store_active_stream_context(
    owner: &mut HueRuntimeOwner,
    request: &StartHueStreamRequest,
    channels: Vec<HueAreaChannel>,
    spawned: SpawnedHueSender,
) {
    let SpawnedHueSender {
        color_sender,
        uses_dtls,
        shutdown_signal,
        cipher_name,
        deactivate_token,
    } = spawned;

    // Keep a persistent clone that survives stream stop/start cycles.
    if !channels.is_empty() {
        owner.persistent_sender = Some(HuePersistentSender {
            area_id: request.area_id.clone(),
            channels: channels.clone(),
            sender: color_sender.clone(),
        });
    }

    owner.set_active_stream(Some(HueActiveStreamContext {
        bridge_ip: request.bridge_ip.clone(),
        username: request.username.clone(),
        area_id: request.area_id.clone(),
        channels,
        color_sender,
        uses_dtls,
        shutdown_signal,
        deactivate_token,
    }));

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
            owner.set_active_stream(None);
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

/// Did the dead-sender probe count this death before the monitor claimed it?
/// The probe takes the dead stream down as it counts, and nothing else leaves
/// a `Reconnecting` runtime with no stream while no restart is in flight.
fn the_probe_counted_this_death(owner: &HueRuntimeOwner) -> bool {
    owner.state == HueRuntimeState::Reconnecting && owner.active_stream.is_none()
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
    /// Another app streams the area now. Waiting out the budget cannot win it
    /// back, and "retries exhausted" would name the wrong cause.
    TakenOver(String),
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
///
/// `deactivate_token` is the watched session's own, for a DTLS session (the
/// only kind that activates the area). The monitor keeps it rather than
/// reading it off `active_stream`, which the dead-sender probe or a failed
/// attempt's first step may already have cleared: until a deactivate PUT for
/// that session has landed, the bridge may still name it the area's streamer.
pub(crate) fn spawn_reconnect_monitor(
    shutdown_signal: ShutdownSignal,
    deactivate_token: Option<Arc<DeactivateToken>>,
    runtime: Arc<Mutex<HueRuntimeOwner>>,
    request: StartHueStreamRequest,
) {
    spawn_reconnect_monitor_with(
        shutdown_signal,
        deactivate_token,
        runtime,
        request,
        ReconnectDeps::production(),
    );
}

pub(crate) fn spawn_reconnect_monitor_with(
    shutdown_signal: ShutdownSignal,
    deactivate_token: Option<Arc<DeactivateToken>>,
    runtime: Arc<Mutex<HueRuntimeOwner>>,
    request: StartHueStreamRequest,
    deps: ReconnectDeps,
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
        let (_in_progress_guard, mut death_counted) = {
            let mut owner = acquire_hue_runtime(&runtime);
            match try_claim_reconnect(&mut owner) {
                ReconnectClaim::Proceed => (
                    ReconnectInProgressGuard {
                        runtime: Arc::clone(&runtime),
                    },
                    the_probe_counted_this_death(&owner),
                ),
                ReconnectClaim::Abort => return,
            }
        };

        // Bounded by `register_transient_fault`, which owns the budget and
        // exits the ladder through `Failed`. One death spends one slot.
        let mut fault_detail = "DTLS sender thread exited unexpectedly".to_string();
        loop {
            let backoff_ms = {
                let mut owner = acquire_hue_runtime(&runtime);
                owner.session_reconnect_total += 1;
                if std::mem::take(&mut death_counted) {
                    next_backoff_ms(&owner.retry_policy, owner.reconnect_attempt)
                } else {
                    let result = register_transient_fault(
                        &mut owner,
                        &fault_detail,
                        HueRuntimeTriggerSource::System,
                    );

                    if owner.state == HueRuntimeState::Failed {
                        info!("Reconnect monitor: retry budget exhausted, entering Failed state.");
                        return;
                    }

                    result.status.next_attempt_ms.unwrap_or(400)
                }
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
            match internal_restart_stream(&runtime, &request, &deps, deactivate_token.as_ref())
                .await
            {
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
                RestartOutcome::TakenOver(detail) => {
                    info!("Reconnect monitor: another app streams the area now; giving up.");
                    let mut owner = acquire_hue_runtime(&runtime);
                    register_area_taken_over(&mut owner, &detail);
                    return;
                }
            }
        }
    });
}

/// Why readiness refused a reconnect. Only the streamer sentinel alone reads
/// as a take-over: an area that also lost its channels would not come back
/// once the other app let go either. And only once our own session has let
/// go: until a deactivate PUT for it has landed, the streamer the bridge names
/// may be that session, which the bridge holds for about ten seconds.
fn restart_refused(
    readiness: &HueStreamReadinessResponse,
    our_session_may_hold_the_area: bool,
) -> RestartOutcome {
    let detail = format!(
        "Readiness check failed during reconnect: {}",
        readiness.status.message
    );
    let reasons = &readiness.readiness.reasons;
    if !our_session_may_hold_the_area && reasons.len() == 1 && reasons[0] == ACTIVE_STREAMER_REASON
    {
        RestartOutcome::TakenOver(detail)
    } else {
        RestartOutcome::Retryable(detail)
    }
}

fn a_stop_overtook_the_reconnect(owner: &HueRuntimeOwner) -> bool {
    owner.user_override_pending
        || matches!(owner.state, HueRuntimeState::Idle | HueRuntimeState::Failed)
}

/// A reconnect a stop overtook after its build: nothing will store or stop
/// its sender, and the build activated the area. Dropping the handle ends the
/// sender, which deactivates the area itself before it signals. Awaited, so
/// `reconnect_in_progress` clears only once the area is given back — the
/// stop waits on that flag before it restores or switches off the lights.
async fn settle_abandoned_reconnect(spawned: SpawnedHueSender) {
    let SpawnedHueSender {
        color_sender,
        shutdown_signal,
        ..
    } = spawned;
    drop(color_sender);
    let _ = tokio::task::spawn_blocking(move || {
        wait_for_shutdown(&shutdown_signal, Duration::from_secs(HUE_STOP_TIMEOUT_SECS))
    })
    .await;
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
    deps: &ReconnectDeps,
    session_token: Option<&Arc<DeactivateToken>>,
) -> RestartOutcome {
    // 1. Clear the dead stream, then deactivate its session.
    {
        let mut owner = acquire_hue_runtime(runtime);
        owner.set_active_stream(None);
        owner.persistent_sender = None;
    }

    // Best-effort, dedupe-aware DTLS deactivation outside the lock. If the
    // sender thread's own PUT landed, this call is a fast in-process no-op;
    // if that PUT, or an earlier attempt's, failed, the token was handed
    // back and this one sends it again.
    //
    // The historical 1 s sleep that used to follow this block was a
    // band-aid for the bridge "phantom active streamer" symptom caused by
    // the missing close_notify alert + double-deactivate race. Both root
    // causes are now fixed (sender emits close_notify before drop, and the
    // dedupe token guarantees a single PUT) so the sleep is gone.
    if let Some(token) = session_token.cloned() {
        let (ip, username, area_id) = (
            request.bridge_ip.clone(),
            request.username.clone(),
            request.area_id.clone(),
        );
        let _ = tokio::task::spawn_blocking(move || {
            if let Ok(client) = blocking_client_for_key(&username) {
                let _ = deactivate_with_token(&token, &client, &ip, &username, &area_id);
            }
        })
        .await;
    }
    let our_session_may_hold_the_area = session_token.is_some_and(|token| !token.was_acquired());

    // 2. Readiness check (async, no lock held). Forced: this is the
    // pre-restart gate and the deactivate above just mutated the area.
    let readiness = match deps.readiness {
        ReconnectReadiness::Bridge => Some(
            check_hue_stream_readiness_with_freshness(
                request.bridge_ip.clone(),
                request.username.clone(),
                request.area_id.clone(),
                HueReadFreshness::Force,
                ActiveStreamerView::Foreign,
            )
            .await,
        ),
        #[cfg(test)]
        ReconnectReadiness::AssumeReady => None,
        #[cfg(test)]
        ReconnectReadiness::Answer(answer) => Some(answer()),
    };
    if let Some(readiness) = readiness {
        if !readiness.readiness.ready {
            // Deliberately NOT relaxed for `ACTIVE_STREAMER` the way the health
            // poll is: a busy area may be a foreign client's, and we must not
            // hijack it. Whose it is only decides how the attempt ends.
            return restart_refused(&readiness, our_session_may_hold_the_area);
        }
    }

    // 3. Set state to Starting. A stop reads `Starting` under a claimed
    //    reconnect as "may hold the area" and waits for it (`stop_hue_runtime`).
    {
        let mut owner = acquire_hue_runtime(runtime);
        if a_stop_overtook_the_reconnect(&owner) {
            return RestartOutcome::Abandoned;
        }
        owner.state = HueRuntimeState::Starting;
    }

    // 4. Fetch channels.
    let mut channels = fetch_area_channels(&request.bridge_ip, &request.username, &request.area_id)
        .await
        .unwrap_or_default();
    if let Some(placements) = &request.channel_placements {
        apply_channel_placements(&mut channels, placements);
    }

    // 4b. Pre-fetch per-light archetype + gamut metadata. Graceful:
    //     any per-light fetch failure simply omits that light from the cache
    //     so the frame builder treats it as `HueGamutType::Other` (no clip).
    let light_metadata = Arc::new(
        fetch_light_metadata_for_channels(&request.bridge_ip, &request.username, &channels).await,
    );

    // The build activates the area; a stop that landed during the fetches
    // must not see it activated only to be given back.
    if a_stop_overtook_the_reconnect(&acquire_hue_runtime(runtime)) {
        return RestartOutcome::Abandoned;
    }

    // 5. Spawn sender (blocking), wired to the owner's packet counter.
    // A panicked spawn must not be stored as a live context: its shutdown
    // signal would never fire and the next monitor would wait on it forever.
    let build = Arc::clone(&deps.build);
    let (req, sender_channels) = (request.clone(), channels.clone());
    let Ok(spawned) = spawn_hue_sender_with(runtime, move |packet_counter| {
        build(&req, sender_channels, light_metadata, packet_counter)
    })
    .await
    else {
        return RestartOutcome::Retryable(
            "Sender spawn task panicked during reconnect".to_string(),
        );
    };
    let shutdown_signal = Arc::clone(&spawned.shutdown_signal);
    let uses_dtls = spawned.uses_dtls;
    let next_token = uses_dtls.then(|| Arc::clone(&spawned.deactivate_token));

    // 6. Store context and spawn new monitor.
    let abandoned = {
        let mut owner = acquire_hue_runtime(runtime);
        if a_stop_overtook_the_reconnect(&owner) {
            Some(spawned)
        } else {
            store_active_stream_context(&mut owner, request, channels, spawned);
            owner.state = HueRuntimeState::Running;
            owner.last_status = if uses_dtls {
                status_with(
                    HueRuntimeState::Running,
                    "HUE_STREAM_RUNNING_DTLS",
                    "Hue entertainment stream active via DTLS (reconnected).",
                    None,
                    HueRuntimeTriggerSource::System,
                )
            } else {
                status_with(
                    HueRuntimeState::Running,
                    "HUE_STREAM_RUNNING",
                    "Hue stream running (reconnected).",
                    None,
                    HueRuntimeTriggerSource::System,
                )
            };
            flush_pending_solid_color(&mut owner);
            None
        }
    };
    if let Some(spawned) = abandoned {
        settle_abandoned_reconnect(spawned).await;
        return RestartOutcome::Abandoned;
    }

    // Spawn new monitor for the new connection.
    spawn_reconnect_monitor_with(
        shutdown_signal,
        next_token,
        Arc::clone(runtime),
        request.clone(),
        deps.clone(),
    );

    RestartOutcome::Restarted
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::sync::atomic::Ordering;
    use std::time::Duration;

    use super::super::super::runtime_telemetry::collect_hue_telemetry;
    use super::super::frame::{HueColorSender, HueScreenRegion};
    use super::super::retry::start_with_evidence;
    use super::super::sender::new_shutdown_signal;
    use super::super::state_store::test_helpers::strict_gate_ready;
    use super::super::state_store::HueRuntimeStateStore;
    use super::super::test_bridge::{Reply, TestBridge};

    fn test_request() -> StartHueStreamRequest {
        StartHueStreamRequest {
            bridge_ip: "192.168.1.2".to_string(),
            username: "hue-user".to_string(),
            client_key: String::new(),
            area_id: "living-room".to_string(),
            trigger_source: Some(HueRuntimeTriggerSource::ModeControl),
            channel_placements: None,
        }
    }

    fn readiness(code: &str, reasons: &[&str]) -> HueStreamReadinessResponse {
        HueStreamReadinessResponse {
            status: crate::commands::status::CommandStatus::new(code, "not ready", None),
            readiness: super::super::super::hue_onboarding::HueStreamReadiness {
                ready: false,
                reasons: reasons.iter().map(|r| r.to_string()).collect(),
            },
        }
    }

    #[test]
    fn a_reconnect_refused_only_by_another_streamer_is_a_take_over() {
        let taken = restart_refused(
            &readiness("HUE_STREAM_NOT_READY", &[ACTIVE_STREAMER_REASON]),
            false,
        );
        assert!(matches!(taken, RestartOutcome::TakenOver(_)), "{taken:?}");

        let ours = restart_refused(
            &readiness("HUE_STREAM_NOT_READY", &[ACTIVE_STREAMER_REASON]),
            true,
        );
        assert!(matches!(ours, RestartOutcome::Retryable(_)), "{ours:?}");

        let emptied = restart_refused(
            &readiness(
                "HUE_STREAM_NOT_READY",
                &[ACTIVE_STREAMER_REASON, "no channels"],
            ),
            false,
        );
        assert!(
            matches!(emptied, RestartOutcome::Retryable(_)),
            "{emptied:?}"
        );

        let silent = restart_refused(
            &readiness("HUE_STREAM_READINESS_FAILED", &["no answer"]),
            false,
        );
        assert!(matches!(silent, RestartOutcome::Retryable(_)), "{silent:?}");
    }

    fn held_by_a_streamer() -> HueStreamReadinessResponse {
        readiness("HUE_STREAM_NOT_READY", &[ACTIVE_STREAMER_REASON])
    }

    fn never_built() -> HueSenderBuild {
        Arc::new(|_request, _channels, _metadata, _counter| {
            panic!("a refused reconnect must not build a sender")
        })
    }

    /// A reconnect whose dead stream the probe already took down: what is
    /// left of the session is the token the monitor kept.
    fn runtime_reconnecting_without_a_stream() -> Arc<Mutex<HueRuntimeOwner>> {
        let runtime = Arc::new(Mutex::new(HueRuntimeOwner::default()));
        {
            let mut owner = acquire_hue_runtime(&runtime);
            let _ = start_with_evidence(
                &mut owner,
                &strict_gate_ready(),
                HueRuntimeTriggerSource::ModeControl,
            );
            let _ = register_transient_fault(
                &mut owner,
                "DTLS sender thread exited unexpectedly",
                HueRuntimeTriggerSource::System,
            );
        }
        runtime
    }

    /// A DTLS session whose deactivate PUT never landed stays the area's
    /// streamer on the bridge for about ten seconds. A reconnect reading the
    /// area held then is reading itself: it must not blame another app, and
    /// every attempt must send the deactivate again, stream context or not.
    #[tokio::test]
    async fn a_reconnect_does_not_take_its_own_unreleased_session_for_another_app() {
        let bridge = TestBridge::start(|method, _path, _body| {
            if method == "PUT" {
                Reply::json(503, serde_json::json!({}))
            } else {
                Reply::json(404, serde_json::json!({}))
            }
        });
        let mut request = test_request();
        request.bridge_ip = bridge.authority.clone();
        let runtime = runtime_reconnecting_without_a_stream();
        let token = DeactivateToken::new();
        let deps = ReconnectDeps {
            readiness: ReconnectReadiness::Answer(held_by_a_streamer),
            build: never_built(),
        };

        for attempt in 1..=2 {
            let outcome = internal_restart_stream(&runtime, &request, &deps, Some(&token)).await;
            assert!(
                matches!(outcome, RestartOutcome::Retryable(_)),
                "attempt {attempt}: {outcome:?}"
            );
        }

        let puts = bridge.puts_to("/clip/v2/resource/entertainment_configuration/living-room");
        assert_eq!(puts.len(), 2, "{puts:?}");
    }

    /// Once our own deactivate has landed, a held area can only be another
    /// app's: that is still a take-over.
    #[tokio::test]
    async fn a_reconnect_after_its_session_let_go_reads_a_held_area_as_taken_over() {
        let bridge = TestBridge::start(|method, _path, _body| {
            if method == "PUT" {
                Reply::ok()
            } else {
                Reply::json(404, serde_json::json!({}))
            }
        });
        let mut request = test_request();
        request.bridge_ip = bridge.authority.clone();
        let runtime = runtime_reconnecting_without_a_stream();
        let token = DeactivateToken::new();
        let deps = ReconnectDeps {
            readiness: ReconnectReadiness::Answer(held_by_a_streamer),
            build: never_built(),
        };

        let outcome = internal_restart_stream(&runtime, &request, &deps, Some(&token)).await;

        assert!(
            matches!(outcome, RestartOutcome::TakenOver(_)),
            "{outcome:?}"
        );
        assert_eq!(
            bridge
                .puts_to("/clip/v2/resource/entertainment_configuration/living-room")
                .len(),
            1
        );
    }

    fn test_channels() -> Vec<HueAreaChannel> {
        vec![HueAreaChannel {
            channel_id: 0,
            light_ids: vec!["light-1".to_string()],
            screen_region: HueScreenRegion::Center,
            position_x: 0.0,
            position_y: 0.0,
            position_z: None,
        }]
    }

    fn dummy_color_sender() -> HueColorSender {
        HueColorSender::with_mailbox(1).0
    }

    #[test]
    fn start_success_persists_active_stream_context_for_status_refresh() {
        let mut owner = HueRuntimeOwner::default();
        let request = test_request();

        let _ = start_with_evidence(
            &mut owner,
            &strict_gate_ready(),
            HueRuntimeTriggerSource::ModeControl,
        );
        store_active_stream_context(
            &mut owner,
            &request,
            test_channels(),
            SpawnedHueSender {
                color_sender: dummy_color_sender(),
                ..SpawnedHueSender::inert()
            },
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

    /// A freshly started stream — not only a reconnected one — must report the
    /// packets its sender thread sends and the cipher its handshake negotiated.
    /// The builder stand-in keeps the counter it was handed and bumps it after
    /// the context is stored, the way the real sender thread does.
    #[tokio::test]
    async fn spawned_sender_packets_and_cipher_reach_telemetry() {
        let store = HueRuntimeStateStore::default();
        let runtime = store.runtime_arc();
        let handed_counter: Arc<Mutex<Option<Arc<AtomicU32>>>> = Arc::new(Mutex::new(None));

        let slot = Arc::clone(&handed_counter);
        let spawned = spawn_hue_sender_with(&runtime, move |packet_counter| {
            *slot.lock().unwrap() = Some(packet_counter);
            SpawnedHueSender {
                color_sender: dummy_color_sender(),
                uses_dtls: true,
                shutdown_signal: new_shutdown_signal(),
                cipher_name: Some("PSK-AES128-GCM-SHA256".to_string()),
                deactivate_token: DeactivateToken::new(),
            }
        })
        .await
        .expect("builder task");

        {
            let mut owner = acquire_hue_runtime(&runtime);
            store_active_stream_context(&mut owner, &test_request(), test_channels(), spawned);
            owner.packet_rate_sampled_at = Some(Instant::now() - Duration::from_secs(1));
        }
        handed_counter
            .lock()
            .unwrap()
            .as_ref()
            .expect("builder received a counter")
            .fetch_add(20, Ordering::Relaxed);

        let telemetry = collect_hue_telemetry(&store).expect("hue telemetry");
        assert!(
            telemetry.packet_rate > 0.0,
            "packets sent by the sender thread never reached telemetry"
        );
        assert_eq!(
            telemetry.dtls_cipher.as_deref(),
            Some("PSK-AES128-GCM-SHA256")
        );
    }

    /// When the sender thread already drained the token (close_notify
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

    /// One sender death spends one slot of the budget. The monitor wakes on
    /// the death and counts it; the dead-sender probe landing in its backoff
    /// used to count it again — and take the deactivate parameters the
    /// restart's first step needs.
    #[tokio::test]
    async fn the_probe_leaves_a_death_the_monitor_has_claimed_to_the_monitor() {
        use super::super::commands::refresh_hue_stream_status;
        use super::super::sender::signal_shutdown_complete;
        use super::super::state_store::test_helpers::dummy_active_stream_context;

        let store = HueRuntimeStateStore::default();
        let runtime = store.runtime_arc();
        {
            let mut owner = acquire_hue_runtime(&runtime);
            let _ = start_with_evidence(
                &mut owner,
                &strict_gate_ready(),
                HueRuntimeTriggerSource::ModeControl,
            );
            let context = dummy_active_stream_context();
            signal_shutdown_complete(&context.shutdown_signal);
            owner.set_active_stream(Some(context));
            assert_eq!(try_claim_reconnect(&mut owner), ReconnectClaim::Proceed);
            let _ = register_transient_fault(
                &mut owner,
                "DTLS sender thread exited unexpectedly",
                HueRuntimeTriggerSource::System,
            );
        }

        let _ = refresh_hue_stream_status(&store, false).await;

        let owner = acquire_hue_runtime(&runtime);
        assert_eq!(owner.reconnect_attempt, 1, "one death was counted twice");
        assert!(owner.active_stream.is_some());
    }

    /// The other order: the probe sees the death before the monitor claims
    /// it. The monitor must not count it again, so a budget of three still
    /// allows the second restart after a first one that failed.
    #[tokio::test]
    async fn a_death_the_probe_counted_first_is_not_counted_again_by_the_monitor() {
        use super::super::commands::refresh_hue_stream_status;
        use super::super::sender::signal_shutdown_complete;
        use super::super::state_store::test_helpers::dummy_active_stream_context;
        use super::super::test_bridge::{light_json, FakeHue, Reply};

        let hue = FakeHue::start(
            &[("living-room", &["light-1"])],
            &[("light-1", light_json(true, 100.0, None, (0.6, 0.3)))],
            |_| Reply::ok(),
        );
        let mut request = test_request();
        request.bridge_ip = hue.bridge.authority.clone();

        let store = HueRuntimeStateStore::default();
        let runtime = store.runtime_arc();
        let dead = {
            let mut owner = acquire_hue_runtime(&runtime);
            let _ = start_with_evidence(
                &mut owner,
                &strict_gate_ready(),
                HueRuntimeTriggerSource::ModeControl,
            );
            let context = dummy_active_stream_context();
            let signal = Arc::clone(&context.shutdown_signal);
            owner.set_active_stream(Some(context));
            signal
        };
        signal_shutdown_complete(&dead);
        let _ = refresh_hue_stream_status(&store, false).await;
        assert_eq!(acquire_hue_runtime(&runtime).reconnect_attempt, 1);

        let builds = Arc::new(AtomicU32::new(0));
        let build: HueSenderBuild = {
            let builds = Arc::clone(&builds);
            Arc::new(move |_request, channels, _metadata, _counter| {
                assert!(
                    builds.fetch_add(1, Ordering::SeqCst) > 0,
                    "the first restart attempt fails"
                );
                SpawnedHueSender {
                    color_sender: HueColorSender::with_mailbox(channels.len()).0,
                    shutdown_signal: new_shutdown_signal(),
                    ..SpawnedHueSender::inert()
                }
            })
        };
        spawn_reconnect_monitor_with(
            dead,
            None,
            Arc::clone(&runtime),
            request,
            ReconnectDeps::assume_ready(build),
        );

        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let state = acquire_hue_runtime(&runtime).state.clone();
            if matches!(state, HueRuntimeState::Running | HueRuntimeState::Failed) {
                break;
            }
            assert!(Instant::now() < deadline, "the reconnect never settled");
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        let mut owner = acquire_hue_runtime(&runtime);
        assert_eq!(
            owner.state,
            HueRuntimeState::Running,
            "{}",
            owner.last_status.code
        );
        assert_eq!(builds.load(Ordering::SeqCst), 2);

        // The test runtime waits for the new monitor's blocking wait on drop.
        let live = owner
            .active_stream
            .as_ref()
            .map(|s| Arc::clone(&s.shutdown_signal));
        let _ = super::super::retry::stop_with_timeout(
            &mut owner,
            false,
            HueRuntimeTriggerSource::ModeControl,
        );
        drop(owner);
        if let Some(live) = live {
            signal_shutdown_complete(&live);
        }
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

    /// A reconnect deactivates the area like a stop does, but Hue output has
    /// not ended: it must neither put the lights back nor read them again (they
    /// show our stream, or the bridge's "restored but on" state, by now).
    /// Readiness refuses the loopback bridge, so the attempt ends Retryable
    /// right after the part of the reconnect that looks like a stop.
    #[tokio::test]
    async fn a_reconnect_neither_restores_nor_resnapshots_the_lights() {
        use super::super::light_restore::{HueLightRestore, HueLightSnapshot, HueLightState};
        use super::super::state_store::test_helpers::dummy_active_stream_context;
        use super::super::test_bridge::{light_json, FakeHue, Reply};

        let hue = FakeHue::start(
            &[("living-room", &["light-1"])],
            &[("light-1", light_json(true, 100.0, None, (0.6, 0.3)))],
            |_| Reply::ok(),
        );
        let mut request = test_request();
        request.bridge_ip = hue.bridge.authority.clone();

        let store = HueRuntimeStateStore::default();
        let runtime = store.runtime_arc();
        let token = {
            let mut owner = acquire_hue_runtime(&runtime);
            let _ = start_with_evidence(
                &mut owner,
                &strict_gate_ready(),
                HueRuntimeTriggerSource::ModeControl,
            );
            let mut context = dummy_active_stream_context();
            context.bridge_ip = request.bridge_ip.clone();
            context.area_id = request.area_id.clone();
            context.uses_dtls = true;
            let token = Arc::clone(&context.deactivate_token);
            owner.active_stream = Some(context);
            owner.light_restore = Some(HueLightRestore {
                bridge_ip: request.bridge_ip.clone(),
                username: request.username.clone(),
                area_id: request.area_id.clone(),
                lights: vec![HueLightSnapshot {
                    light_id: "light-1".to_string(),
                    state: HueLightState {
                        on: false,
                        brightness: Some(30.0),
                        color: None,
                    },
                }],
            });
            token
        };

        let outcome = internal_restart_stream(
            &runtime,
            &request,
            &ReconnectDeps::production(),
            Some(&token),
        )
        .await;

        assert!(
            matches!(outcome, RestartOutcome::Retryable(_)),
            "{outcome:?}"
        );
        let requests = hue.bridge.requests();
        assert_eq!(requests.len(), 1, "{requests:?}");
        assert_eq!(requests[0].method, "PUT");
        assert!(requests[0]
            .path
            .ends_with("/entertainment_configuration/living-room"));
        let owner = acquire_hue_runtime(&runtime);
        let held = owner.light_restore.as_ref().expect("snapshot survives");
        assert!(!held.lights[0].state.on);
    }

    /// A stream that dropped and reconnected, then Off. The bridge puts its
    /// own post-stream state on the lights at the drop and again after the
    /// stop; the session's first snapshot has to be what the lights end on.
    #[tokio::test]
    async fn after_a_reconnect_the_stop_still_outlasts_the_bridges_post_stream_state() {
        use super::super::commands::stop_hue_runtime;
        use super::super::light_restore::{
            parse_light_state, reads_as, HueLightRestore, HueLightSnapshot, HueLightsAfterStop,
        };
        use super::super::sender::signal_shutdown_complete;
        use super::super::state_store::test_helpers::dummy_active_stream_context;
        use super::super::test_bridge::{light_json, FakeHue, Reply};

        // As read off a BSB002 (2026-09-24): before the stream, and what the
        // bridge put on both lights after every drop or stop.
        let before = light_json(true, 56.92, Some(446), (0.5190, 0.4152));
        let post_stream = light_json(true, 30.83, Some(367), (0.4583, 0.4099));
        let hue = FakeHue::start(
            &[("living-room", &["left", "right"])],
            &[("left", before.clone()), ("right", before.clone())],
            |_| Reply::ok(),
        );
        hue.after_stop_bridge_sets(
            Duration::from_millis(300),
            &[("left", post_stream.clone()), ("right", post_stream)],
        );
        let mut request = test_request();
        request.bridge_ip = hue.bridge.authority.clone();
        let snapshot = parse_light_state(&before).unwrap();

        let store = HueRuntimeStateStore::default();
        let runtime = store.runtime_arc();
        let token = {
            let mut owner = acquire_hue_runtime(&runtime);
            let _ = start_with_evidence(
                &mut owner,
                &strict_gate_ready(),
                HueRuntimeTriggerSource::ModeControl,
            );
            let mut context = dummy_active_stream_context();
            context.bridge_ip = request.bridge_ip.clone();
            context.username = request.username.clone();
            context.area_id = request.area_id.clone();
            context.uses_dtls = true;
            let token = Arc::clone(&context.deactivate_token);
            owner.active_stream = Some(context);
            owner.light_restore = Some(HueLightRestore {
                bridge_ip: request.bridge_ip.clone(),
                username: request.username.clone(),
                area_id: request.area_id.clone(),
                lights: ["left", "right"]
                    .into_iter()
                    .map(|light| HueLightSnapshot {
                        light_id: light.to_string(),
                        state: snapshot.clone(),
                    })
                    .collect(),
            });
            token
        };
        let build: HueSenderBuild = Arc::new(|_request, channels, _metadata, _counter| {
            let (color_sender, rx) = HueColorSender::with_mailbox(channels.len());
            let shutdown = new_shutdown_signal();
            let signal = Arc::clone(&shutdown);
            std::thread::spawn(move || {
                while rx.recv().is_ok() {}
                signal_shutdown_complete(&signal);
            });
            SpawnedHueSender {
                color_sender,
                uses_dtls: true,
                shutdown_signal: shutdown,
                cipher_name: None,
                deactivate_token: DeactivateToken::new(),
            }
        });

        let outcome = internal_restart_stream(
            &runtime,
            &request,
            &ReconnectDeps::assume_ready(build),
            Some(&token),
        )
        .await;
        assert!(matches!(outcome, RestartOutcome::Restarted), "{outcome:?}");
        tokio::time::sleep(Duration::from_millis(500)).await;
        let drifted = parse_light_state(&hue.light("left")).unwrap();
        assert!(
            !reads_as(&snapshot, &drifted),
            "the drop should have left the bridge's own state on the lights"
        );
        assert!(
            hue.light_puts().is_empty(),
            "a reconnect is not a stop and restores nothing"
        );

        let stop_runtime = Arc::clone(&runtime);
        let stopped = tokio::task::spawn_blocking(move || {
            stop_hue_runtime(
                &stop_runtime,
                HueRuntimeTriggerSource::ModeControl,
                None,
                HueLightsAfterStop::Restore,
            )
        })
        .await
        .unwrap();
        tokio::time::sleep(Duration::from_millis(800)).await;

        assert_eq!(stopped.status.code, "HUE_STREAM_STOPPED");
        for light in ["left", "right"] {
            let now = parse_light_state(&hue.light(light)).unwrap();
            assert!(
                reads_as(&snapshot, &now),
                "{light} was left as the bridge put it: {now:?}"
            );
        }
        assert!(acquire_hue_runtime(&runtime).light_restore.is_none());
    }

    /// Off while a reconnect is building its sender, the area already
    /// activated. The stop found no stream to wait for, its switch-off gave up
    /// on the held area after the watch window, and the abandoned reconnect's
    /// sender then gave the area back — and the bridge switched the lamps on.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn off_during_a_reconnects_build_still_switches_the_lights_off() {
        use std::sync::atomic::AtomicBool;

        use super::super::commands::stop_hue_runtime;
        use super::super::light_restore::{
            parse_light_state, HueLightRestore, HueLightSnapshot, HueLightsAfterStop,
        };
        use super::super::sender::signal_shutdown_complete;
        use super::super::test_bridge::{light_json, FakeHue};

        let before = light_json(true, 56.92, Some(446), (0.5190, 0.4152));
        let post_stream = light_json(true, 30.83, Some(367), (0.4583, 0.4099));
        let hue = FakeHue::start(
            &[("living-room", &["left", "right"])],
            &[("left", before.clone()), ("right", before.clone())],
            |_| Reply::ok(),
        );
        hue.after_stop_bridge_sets(
            Duration::from_millis(300),
            &[("left", post_stream.clone()), ("right", post_stream)],
        );
        let mut request = test_request();
        request.bridge_ip = hue.bridge.authority.clone();
        let snapshot = parse_light_state(&before).unwrap();

        let runtime = runtime_reconnecting_without_a_stream();
        let guard = {
            let mut owner = acquire_hue_runtime(&runtime);
            owner.light_restore = Some(HueLightRestore {
                bridge_ip: request.bridge_ip.clone(),
                username: request.username.clone(),
                area_id: request.area_id.clone(),
                lights: ["left", "right"]
                    .into_iter()
                    .map(|light| HueLightSnapshot {
                        light_id: light.to_string(),
                        state: snapshot.clone(),
                    })
                    .collect(),
            });
            assert_eq!(try_claim_reconnect(&mut owner), ReconnectClaim::Proceed);
            ReconnectInProgressGuard {
                runtime: Arc::clone(&runtime),
            }
        };

        // As the real builder does it: the area is activated before a
        // handshake that, straight after a drop, can take seconds.
        let building = Arc::new(AtomicBool::new(false));
        let build: HueSenderBuild = {
            let building = Arc::clone(&building);
            Arc::new(move |request, channels, _metadata, _counter| {
                let client = blocking_client_for_key(&request.username).expect("client");
                let area = format!(
                    "https://{}/clip/v2/resource/entertainment_configuration/{}",
                    request.bridge_ip, request.area_id
                );
                client
                    .put(&area)
                    .json(&serde_json::json!({ "action": "start" }))
                    .send()
                    .expect("activate");
                building.store(true, Ordering::SeqCst);
                std::thread::sleep(Duration::from_millis(2_000));

                let (color_sender, rx) = HueColorSender::with_mailbox(channels.len());
                let shutdown = new_shutdown_signal();
                let token = DeactivateToken::new();
                let (signal, held, req) =
                    (Arc::clone(&shutdown), Arc::clone(&token), request.clone());
                std::thread::spawn(move || {
                    while rx.recv().is_ok() {}
                    let _ = deactivate_with_token(
                        &held,
                        &client,
                        &req.bridge_ip,
                        &req.username,
                        &req.area_id,
                    );
                    signal_shutdown_complete(&signal);
                });
                SpawnedHueSender {
                    color_sender,
                    uses_dtls: true,
                    shutdown_signal: shutdown,
                    cipher_name: None,
                    deactivate_token: token,
                }
            })
        };

        let reconnect = {
            let (runtime, request) = (Arc::clone(&runtime), request.clone());
            tokio::spawn(async move {
                let _guard = guard;
                internal_restart_stream(
                    &runtime,
                    &request,
                    &ReconnectDeps::assume_ready(build),
                    None,
                )
                .await
            })
        };
        let deadline = Instant::now() + Duration::from_secs(10);
        while !building.load(Ordering::SeqCst) {
            assert!(
                Instant::now() < deadline,
                "the reconnect never began its build"
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }

        let stop_runtime = Arc::clone(&runtime);
        let stopped = tokio::task::spawn_blocking(move || {
            stop_hue_runtime(
                &stop_runtime,
                HueRuntimeTriggerSource::ModeControl,
                None,
                HueLightsAfterStop::TurnOff,
            )
        })
        .await
        .unwrap();
        let outcome = reconnect.await.unwrap();
        tokio::time::sleep(Duration::from_millis(800)).await;

        assert_eq!(stopped.status.code, "HUE_STREAM_STOPPED");
        assert!(matches!(outcome, RestartOutcome::Abandoned), "{outcome:?}");
        for light in ["left", "right"] {
            assert_eq!(
                hue.light(light)["on"]["on"],
                serde_json::json!(false),
                "{light} was left on: {}",
                hue.light(light)
            );
        }
    }
}
