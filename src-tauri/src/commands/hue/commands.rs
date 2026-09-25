//! Tauri command surface for the Hue entertainment runtime.
//!
//! Carved out of the original `hue_stream_lifecycle.rs`. This module owns
//! the six `#[tauri::command]` entry points (`start_hue_stream`, `restart_hue_stream`,
//! `set_hue_solid_color`, `get_hue_stream_status`, `get_hue_area_channels`,
//! `simulate_hue_fault`); a stop goes through the lighting transaction
//! (`stop_hue_stream_on`).
//! All call sites use the data plane and runtime state machine that now
//! live in sibling submodules `frame`, `dtls`, `sender`, `state_store`,
//! `retry`, and `reconnect`.
//!
//! `lib.rs` registers these commands from `commands::hue::commands` directly.

use std::collections::HashMap;
use std::sync::atomic::AtomicU32;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use log::{error, info, warn};
use serde::{Deserialize, Serialize};
use tauri::State;

use super::super::hue_onboarding::{
    check_hue_stream_readiness_with_freshness, ActiveStreamerView, AreaListError,
    HueStreamReadinessResponse, ACTIVE_STREAMER_REASON,
};
use super::super::status::CommandStatus;
use super::area_cache::HueReadFreshness;
use super::credential_store::effective_hue_app_key;
use super::frame::{HueAreaChannel, HueAreaChannelInfo};
use super::light_restore::{
    adopt_light_snapshot, restore_lights, switch_on_lights, take_light_restore_for_abandoned_start,
    take_light_restore_for_other_area, HueLightRestore, HueLightsAfterStop,
    HUE_LIGHT_RESTORE_BUDGET, HUE_LIGHT_SWITCH_ON_BUDGET,
};
use super::reconnect::{
    spawn_hue_sender_with, spawn_reconnect_monitor, store_active_stream_context, StartAbortGuard,
};
use super::retry::{
    register_transient_fault, start_with_evidence, status_refresh_with_evidence, stop_with_timeout,
};
#[cfg(debug_assertions)]
use super::sender::signal_shutdown_complete;
use super::sender::{
    apply_channel_placements, build_hue_sender, deactivate_with_token, fetch_area_channels,
    fetch_lights_for_channels, is_shutdown_signaled, wait_for_shutdown, HueLightFetch,
    HueLightMetadata, SpawnedHueSender,
};
use super::state_store::{
    acquire_hue_runtime, channels_to_info_via_owner, commit_solid_color, flush_pending_solid_color,
    make_result, queue_solid_color, status_with, HueRuntimeActionHint, HueRuntimeCommandResult,
    HueRuntimeGateEvidence, HueRuntimeOwner, HueRuntimeState, HueRuntimeStateStore,
    HueRuntimeTriggerSource, HueSolidColorSnapshot, SetHueSolidColorRequest, StartHueStreamRequest,
};
use super::transport::{
    blocking_client_for_key, blocking_client_with_timeout, is_valid_bridge_addr, trust_for_app_key,
    HUE_HTTP_TIMEOUT_MS,
};

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Tauri-command-only constants
// ---------------------------------------------------------------------------

/// Maximum time (in seconds) to wait for the sender thread to shut down
/// before reporting a partial-stop timeout.
const HUE_STOP_TIMEOUT_SECS: u64 = 3;

/// A stop with a deadline aims every wait at this much before it: a request
/// timed out on the deadline itself still has to unwind, and the call
/// returned past it. docs/architecture/hue.md ("Quit").
const HUE_STOP_DEADLINE_RESERVE: Duration = Duration::from_millis(100);

/// Below this much time left the deactivate is not sent: it could not land.
const HUE_STOP_MIN_REQUEST_WINDOW: Duration = Duration::from_millis(50);

// Every `Result` below is structural, never a throwing surface — coded failures
// ride the status object. Tauri *requires* it of an `async` command taking a
// reference: dropping it fails the `AsyncCommandMustReturnResult` bound.

// ---------------------------------------------------------------------------
// Tauri command: list channel metadata for the selected entertainment area
// ---------------------------------------------------------------------------

/// Response for `get_hue_area_channels` — status plus the resolved channels.
/// `channels` is empty on every failure arm; `status.code` is the discriminator.
#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct HueAreaChannelListResponse {
    pub status: CommandStatus,
    pub channels: Vec<HueAreaChannelInfo>,
}

/// Sole constructor for this command's status, so the contract verifier can
/// harvest the emitted code set from one call shape.
fn area_channels_status(code: &str, message: &str, details: Option<String>) -> CommandStatus {
    CommandStatus {
        code: code.to_string(),
        message: message.to_string(),
        details,
    }
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
) -> Result<HueAreaChannelListResponse, String> {
    if !is_valid_bridge_addr(&bridge_ip) {
        return Ok(HueAreaChannelListResponse {
            status: area_channels_status(
                "HUE_AREA_CHANNELS_FAILED",
                "Could not load Hue entertainment channels for the selected area.",
                Some(format!(
                    "`{bridge_ip}` is not a local-network bridge address."
                )),
            ),
            channels: Vec::new(),
        });
    }
    // Fast path: reuse channels already resolved by the running stream (brief lock, no I/O).
    if let Some(channels) = channels_to_info_via_owner(&runtime_state, &area_id) {
        return Ok(ok_or_empty(channels));
    }
    // Slow path: fetch directly from bridge (no lock held). An empty `username`
    // means "resolve from the OS keychain".
    let username = effective_hue_app_key(&username);
    Ok(
        match fetch_area_channels(&bridge_ip, &username, &area_id).await {
            Ok(channels) => ok_or_empty(super::frame::channels_to_info(&channels)),
            Err(AreaListError::AuthInvalid) => {
                warn!("Hue area channel fetch rejected with 403 type=1 — re-pair required");
                HueAreaChannelListResponse {
                    status: area_channels_status(
                        "AUTH_INVALID_RE_PAIR_REQUIRED",
                        "Hue bridge rejected our credentials. Re-pair the bridge to continue.",
                        Some("Bridge returned HTTP 403 with unauthorized-user error.".to_string()),
                    ),
                    channels: Vec::new(),
                }
            }
            // Empty `channels` here is not "there are none" — the caller is
            // required to keep the list it already had. See `HUE_AREA_CHANNELS_STATUS`.
            Err(AreaListError::Unreachable(message)) => {
                warn!("Hue bridge unreachable while loading channels for {area_id}: {message}");
                HueAreaChannelListResponse {
                    status: area_channels_status(
                        "HUE_AREA_CHANNELS_UNREACHABLE",
                        "Could not reach the Hue bridge. Showing the last known channels.",
                        Some(message),
                    ),
                    channels: Vec::new(),
                }
            }
            Err(AreaListError::Other(message)) => {
                warn!("Failed to load Hue area channels for {area_id}: {message}");
                HueAreaChannelListResponse {
                    status: area_channels_status(
                        "HUE_AREA_CHANNELS_FAILED",
                        "Could not load Hue entertainment channels for the selected area.",
                        Some(message),
                    ),
                    channels: Vec::new(),
                }
            }
        },
    )
}

fn ok_or_empty(channels: Vec<HueAreaChannelInfo>) -> HueAreaChannelListResponse {
    if channels.is_empty() {
        return HueAreaChannelListResponse {
            status: area_channels_status(
                "HUE_AREA_CHANNELS_EMPTY",
                "The selected Hue entertainment area has no channels.",
                Some(
                    "Add lights to the Entertainment Area in the Hue app, then refresh."
                        .to_string(),
                ),
            ),
            channels,
        };
    }
    HueAreaChannelListResponse {
        status: area_channels_status("HUE_AREA_CHANNELS_OK", "Hue area channels loaded.", None),
        channels,
    }
}

/// Readiness answered with a refusal of our key — the re-pair evidence.
fn is_auth_rejection(readiness_code: &str) -> bool {
    readiness_code.starts_with("AUTH_INVALID_") || readiness_code == "HUE_CREDENTIAL_INVALID"
}

/// Wire tokens for why readiness said no; see `readiness_blockers` on the evidence.
fn readiness_blockers(readiness: &HueStreamReadinessResponse) -> Vec<String> {
    if readiness.readiness.ready {
        return Vec::new();
    }
    let mut blockers = vec![readiness.status.code.clone()];
    if readiness
        .readiness
        .reasons
        .iter()
        .any(|reason| reason == ACTIVE_STREAMER_REASON)
    {
        blockers.push(ACTIVE_STREAMER_REASON.to_string());
    }
    blockers
}

/// Gate evidence for `start_hue_stream` and `restart_hue_stream`, shared so
/// the two cannot drift apart.
fn start_gate_evidence(
    request: &StartHueStreamRequest,
    readiness: &HueStreamReadinessResponse,
) -> HueRuntimeGateEvidence {
    HueRuntimeGateEvidence {
        bridge_configured: !request.bridge_ip.trim().is_empty(),
        credentials_valid: !request.username.trim().is_empty(),
        area_selected: !request.area_id.trim().is_empty(),
        readiness_current: readiness.status.code != "HUE_STREAM_READINESS_FAILED",
        ready: readiness.readiness.ready,
        auth_invalid_evidence: is_auth_rejection(&readiness.status.code),
        readiness_blockers: readiness_blockers(readiness),
    }
}

/// Start the Hue entertainment stream for the given bridge/area — checks
/// readiness, spawns the DTLS or HTTP sender, and stores the resulting
/// stream context.
#[tauri::command]
pub async fn start_hue_stream(
    request: StartHueStreamRequest,
    runtime_state: State<'_, HueRuntimeStateStore>,
) -> Result<HueRuntimeCommandResult, String> {
    Ok(start_hue_stream_on(runtime_state.inner(), request, &|| false).await)
}

/// Body of `start_hue_stream`, over the store rather than a Tauri `State`, so
/// the lighting transaction's Hue driver runs the very same start. `closing` is
/// read once readiness has answered and before anything is brought up: a start
/// the quit overtook must not open a stream the quit's Hue step already passed.
pub(crate) async fn start_hue_stream_on(
    runtime_state: &HueRuntimeStateStore,
    mut request: StartHueStreamRequest,
    closing: &(dyn Fn() -> bool + Sync),
) -> HueRuntimeCommandResult {
    let _wake = super::health::WakeOnDrop;
    // MUST precede the readiness call and the `credentials_valid` evidence —
    // every downstream reader, including the stored `ActiveHueStream`, takes
    // the key from this one field. See docs/architecture/hue.md.
    request.username = effective_hue_app_key(&request.username);

    // A stop still restoring lights leaves the runtime `Idle`; reading the
    // area now would snapshot a half-restored state.
    runtime_state.wait_for_stop_to_settle().await;

    let trigger = request
        .trigger_source
        .clone()
        .unwrap_or(HueRuntimeTriggerSource::ModeControl);

    // 1. Async readiness check -- no lock held during network I/O.
    // Forced: this gates a start, so it must not run off a snapshot taken
    // before whatever the user did to get here.
    let readiness = check_hue_stream_readiness_with_freshness(
        request.bridge_ip.clone(),
        request.username.clone(),
        request.area_id.clone(),
        HueReadFreshness::Force,
        ActiveStreamerView::Foreign,
    )
    .await;

    if closing() {
        return make_result(&acquire_hue_runtime(&runtime_state.runtime));
    }

    let gate = start_gate_evidence(&request, &readiness);

    // 2. Lock briefly for state decision only.
    let result = {
        let mut owner = acquire_hue_runtime(&runtime_state.runtime);
        let result = start_with_evidence(&mut owner, &gate, trigger);
        // If the stream was already active (NOOP), return early without re-fetching
        // channels. Re-fetching while the stream is live can fail and would overwrite
        // the working channel/sender state with empty data, breaking solid color.
        if result.status.code == "HUE_START_NOOP_ALREADY_ACTIVE" {
            return result;
        }
        result
    }; // lock released before async I/O

    let build = production_sender(&request);
    bring_up_stream(
        &runtime_state.runtime_arc(),
        &request,
        result,
        BringUpKind::Start,
        build,
    )
    .await
}

/// Which command is bringing a stream up. Only the no-lights wording differs.
#[derive(Clone, Copy)]
enum BringUpKind {
    Start,
    Restart,
}

/// `build_hue_sender` for this request, in the shape `bring_up_stream` takes.
fn production_sender(
    request: &StartHueStreamRequest,
) -> impl FnOnce(
    Vec<HueAreaChannel>,
    Arc<HashMap<String, HueLightMetadata>>,
    Arc<AtomicU32>,
) -> SpawnedHueSender
       + Send
       + 'static {
    let request = request.clone();
    move |channels, light_metadata, packet_counter| {
        build_hue_sender(&request, channels, light_metadata, packet_counter)
    }
}

/// Everything after the start gate, shared by `start_hue_stream` and
/// `restart_hue_stream`. `build` spawns the sender; it is a parameter so a
/// test can drive this whole path against a local bridge without a DTLS peer
/// or the OS keychain.
async fn bring_up_stream<B>(
    runtime: &Arc<Mutex<HueRuntimeOwner>>,
    request: &StartHueStreamRequest,
    result: HueRuntimeCommandResult,
    kind: BringUpKind,
    build: B,
) -> HueRuntimeCommandResult
where
    B: FnOnce(
            Vec<HueAreaChannel>,
            Arc<HashMap<String, HueLightMetadata>>,
            Arc<AtomicU32>,
        ) -> SpawnedHueSender
        + Send
        + 'static,
{
    // Abort guard: if we exit before step 4c stores the context, roll back to Failed.
    let mut abort_guard = StartAbortGuard::new(Arc::clone(runtime));

    // A snapshot held for another bridge or area belongs to a session that
    // ended without a stop. Its lights go back before this area is read, so a
    // light in both areas is snapshotted in its real state.
    if result.active {
        let other = take_light_restore_for_other_area(
            &mut acquire_hue_runtime(runtime),
            &request.bridge_ip,
            &request.area_id,
        );
        if let Some(other) = other {
            // Nothing of this start is on the bridge yet, so nothing to
            // paint under: `Starting` here is this start's own state.
            let _ = tokio::task::spawn_blocking(move || {
                restore_lights(&other, Instant::now() + HUE_LIGHT_RESTORE_BUDGET, &|| false)
            })
            .await;
        }
    }

    // 3. Async channel fetch -- no lock held.
    let mut channels = if result.active {
        fetch_area_channels(&request.bridge_ip, &request.username, &request.area_id)
            .await
            .unwrap_or_default()
    } else {
        Vec::new()
    };
    if let Some(placements) = &request.channel_placements {
        apply_channel_placements(&mut channels, placements);
    }

    // 4a. Lock briefly for race-condition guard only.
    let has_no_lights = result.active && channels.is_empty();
    {
        let owner = acquire_hue_runtime(runtime);
        if matches!(
            owner.state,
            HueRuntimeState::Idle | HueRuntimeState::Stopping | HueRuntimeState::Failed
        ) {
            abort_guard.disarm();
            return make_result(&owner);
        }
    } // lock released before blocking I/O

    // 4a-bis. Pre-fetch per-light archetype + gamut metadata, and the
    //         lights' state from the same GETs. The sender activates the area
    //         next, so this is the last read before we touch the lights: the
    //         restore's snapshot point. Graceful: failures fall back to
    //         `HueGamutType::Other` (no clip) and to not restoring that light.
    let lights = if result.active {
        fetch_lights_for_channels(&request.bridge_ip, &request.username, &channels).await
    } else {
        HueLightFetch::default()
    };
    let light_metadata = Arc::new(lights.metadata);
    let captured = HueLightRestore {
        bridge_ip: request.bridge_ip.clone(),
        username: request.username.clone(),
        area_id: request.area_id.clone(),
        lights: lights.states,
    };

    // 4a-ter. Switch on the lights that read off (after Off, every one of them)
    //         while the area is not yet ours: the bridge is not documented to
    //         do it for a stream. `captured` keeps them "off", so the session's
    //         restore puts them back off. See docs/architecture/hue.md.
    if result.active {
        let switch_on = captured.off_lights_switched_on();
        if !switch_on.lights.is_empty() {
            let probe = Arc::clone(runtime);
            let _ = tokio::task::spawn_blocking(move || {
                switch_on_lights(
                    &switch_on,
                    Instant::now() + HUE_LIGHT_SWITCH_ON_BUDGET,
                    &|| a_stop_overtook_the_start(&probe),
                )
            })
            .await;
        }
    }

    // 4b. Spawn the sender, wired to the owner's packet counter.
    let spawned = if result.active {
        let sender_channels = channels.clone();
        spawn_hue_sender_with(runtime, move |packet_counter| {
            build(sender_channels, light_metadata, packet_counter)
        })
        .await
        .unwrap_or_else(|_join_err| {
            error!("build_hue_sender task panicked, using no-op sender.");
            SpawnedHueSender::inert()
        })
    } else {
        SpawnedHueSender::inert()
    };

    // 4c. Re-acquire lock to store the spawned sender context.
    let stored = {
        let mut owner = acquire_hue_runtime(runtime);

        // Second race-condition guard: a stop may have arrived while we were
        // spawning the sender.
        if matches!(
            owner.state,
            HueRuntimeState::Idle | HueRuntimeState::Stopping | HueRuntimeState::Failed
        ) {
            abort_guard.disarm();
            // That stop found no context to deactivate and no snapshot to
            // restore; the sender may already have taken the area. Settled
            // below, once the lock is released.
            let result = make_result(&owner);
            let restore = take_light_restore_for_abandoned_start(&mut owner, captured);
            Err((result, spawned, restore))
        } else {
            store_active_stream_context(&mut owner, request, channels, spawned);
            adopt_light_snapshot(&mut owner, captured);
            abort_guard.disarm();

            if has_no_lights {
                owner.last_status = match kind {
                    BringUpKind::Start => status_with(
                        HueRuntimeState::Running,
                        "HUE_STREAM_RUNNING_NO_LIGHTS",
                        "Hue runtime started but no color-addressable lights were resolved for the selected area.",
                        Some("Revalidate area members and restart Hue runtime.".to_string()),
                        HueRuntimeTriggerSource::System,
                    ),
                    BringUpKind::Restart => status_with(
                        HueRuntimeState::Running,
                        "HUE_STREAM_RUNNING_NO_LIGHTS",
                        "Hue runtime restarted but no color-addressable lights were resolved for the selected area.",
                        Some("Revalidate area members and retry.".to_string()),
                        HueRuntimeTriggerSource::System,
                    ),
                };
                owner.last_status.action_hint = Some(HueRuntimeActionHint::Revalidate);
                return make_result(&owner);
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

            Ok(make_result(&owner))
        }
    };
    let final_result = match stored {
        Ok(result) => result,
        Err((result, spawned, restore)) => {
            settle_abandoned_start(runtime, spawned, restore).await;
            return result;
        }
    };

    // Spawn reconnect monitor to detect sender thread exit and trigger bounded retry.
    {
        let owner = acquire_hue_runtime(runtime);
        if let Some(ref stream) = owner.active_stream {
            spawn_reconnect_monitor(
                Arc::clone(&stream.shutdown_signal),
                Arc::clone(runtime),
                request.clone(),
            );
        }
    }

    final_result
}

/// A start that a stop overtook: nothing will ever store or stop its sender,
/// and it may have activated the area. Dropping the handle ends the sender,
/// which deactivates the area itself before it signals; then the lights go back.
async fn settle_abandoned_start(
    runtime: &Arc<Mutex<HueRuntimeOwner>>,
    spawned: SpawnedHueSender,
    restore: HueLightRestore,
) {
    let SpawnedHueSender {
        color_sender,
        shutdown_signal,
        ..
    } = spawned;
    drop(color_sender);
    let runtime = Arc::clone(runtime);
    let _ = tokio::task::spawn_blocking(move || {
        wait_for_shutdown(&shutdown_signal, Duration::from_secs(HUE_STOP_TIMEOUT_SECS));
        restore_lights(&restore, Instant::now() + HUE_LIGHT_RESTORE_BUDGET, &|| {
            a_newer_session_began(&runtime)
        });
    })
    .await;
}

/// A start switching lights on stops once a stop has taken the runtime back.
fn a_stop_overtook_the_start(runtime: &Arc<Mutex<HueRuntimeOwner>>) -> bool {
    matches!(
        acquire_hue_runtime(runtime).state,
        HueRuntimeState::Idle | HueRuntimeState::Stopping | HueRuntimeState::Failed
    )
}

/// A stop leaves the runtime `Idle`; any of these means a start has begun
/// since, and a restore still running must not write under it. The
/// transaction's stop has its own gate (`stop_in_flight`) that already holds
/// starts back; an abandoned start's restore and the quit path have no such
/// gate.
fn a_newer_session_began(runtime: &Arc<Mutex<HueRuntimeOwner>>) -> bool {
    matches!(
        acquire_hue_runtime(runtime).state,
        HueRuntimeState::Starting | HueRuntimeState::Running | HueRuntimeState::Reconnecting
    )
}

/// `stop_hue_stream_on` with the lights put back, as the stop tests drive it.
#[cfg(test)]
pub(crate) async fn stop_hue_stream(
    trigger_source: Option<HueRuntimeTriggerSource>,
    runtime_state: State<'_, HueRuntimeStateStore>,
) -> Result<HueRuntimeCommandResult, String> {
    let trigger = trigger_source.unwrap_or(HueRuntimeTriggerSource::System);
    Ok(stop_hue_stream_on(runtime_state.inner(), trigger, HueLightsAfterStop::Restore).await)
}

/// Stop the Hue entertainment stream with a bounded wait for the background
/// sender thread to exit, then give the area's lights what `lights` says: put
/// back the way they were before the session first streamed, or — for a
/// user's Off — switched off. If the thread does not shut down within
/// `HUE_STOP_TIMEOUT_SECS`, the stop reports `HUE_STOP_TIMEOUT_PARTIAL` with
/// an action hint to retry. The lighting transaction's Hue driver stops here,
/// so every stop holds `stop_in_flight` across the restore — or the
/// switch-off. Transient stops — reconnect, restart of the same area — never
/// come through here. See docs/architecture/hue.md.
///
/// `async` so the blocking work runs on the blocking pool: the deactivate,
/// sender wait and restore would otherwise block the caller's runtime thread.
pub(crate) async fn stop_hue_stream_on(
    runtime_state: &HueRuntimeStateStore,
    trigger: HueRuntimeTriggerSource,
    lights: HueLightsAfterStop,
) -> HueRuntimeCommandResult {
    let _wake = super::health::WakeOnDrop;
    let runtime = runtime_state.runtime_arc();
    let in_flight = Arc::clone(&runtime_state.stop_in_flight).lock_owned().await;
    let stopped = tokio::task::spawn_blocking(move || {
        let _in_flight = in_flight;
        stop_hue_runtime(&runtime, trigger, None, lights)
    })
    .await;
    stopped.unwrap_or_else(|_join_err| {
        error!("stop_hue_stream task panicked; reporting the runtime as it stands.");
        make_result(&acquire_hue_runtime(&runtime_state.runtime))
    })
}

/// The quit path's stop (`shutdown.rs` `[shutdown]` step 2). Same stop and
/// restore as `stop_hue_stream_on`, but the deactivate PUT, the sender wait and
/// the restore all end `HUE_STOP_DEADLINE_RESERVE` before `deadline`, so the
/// call returns by it and a slow bridge cannot run into the shutdown watchdog.
/// Quitting is not choosing Off: the lights always go back as they were.
pub fn stop_hue_stream_before_exit(
    runtime_state: &HueRuntimeStateStore,
    deadline: Instant,
) -> HueRuntimeCommandResult {
    stop_hue_runtime(
        &runtime_state.runtime,
        HueRuntimeTriggerSource::System,
        Some(deadline),
        HueLightsAfterStop::Restore,
    )
}

/// Blocking body of every stop. `deadline` bounds the whole call when given —
/// every step aims at `HUE_STOP_DEADLINE_RESERVE` before it; without one each
/// step keeps its own ceiling. `lights` says what the area's lights get once
/// the stream is down.
pub(crate) fn stop_hue_runtime(
    runtime: &Arc<Mutex<HueRuntimeOwner>>,
    trigger: HueRuntimeTriggerSource,
    deadline: Option<Instant>,
    lights: HueLightsAfterStop,
) -> HueRuntimeCommandResult {
    let deadline = deadline.map(|deadline| {
        deadline
            .checked_sub(HUE_STOP_DEADLINE_RESERVE)
            .unwrap_or(deadline)
    });
    let remaining = |ceiling: Duration| match deadline {
        Some(deadline) => ceiling.min(deadline.saturating_duration_since(Instant::now())),
        None => ceiling,
    };

    // 1. Brief lock: extract the shutdown signal and DTLS deactivation params,
    //    then initiate cleanup.  Dropping the active_stream (and thus the sender
    //    Arc) closes the mpsc channel, which unblocks the background thread's
    //    recv loop.  DTLS deactivation HTTP call happens AFTER the lock is released.
    let (maybe_shutdown, dtls_deactivate, light_restore) = {
        let mut owner = acquire_hue_runtime(runtime);

        // Grab the shutdown signal before stop_with_timeout drops active_stream.
        let signal = owner
            .active_stream
            .as_ref()
            .map(|s| Arc::clone(&s.shutdown_signal));

        // Extract DTLS deactivation params + dedupe token before active_stream
        // is cleared. The token is the coordination point: whichever of
        // {sender thread, foreground stop, reconnect monitor} acquires it
        // first performs the single PUT; later callers no-op.
        let dtls_deactivate = owner
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

        // Taken with or without a live stream: a `Failed` runtime has none,
        // and its lights still show what the session left them.
        let light_restore = owner.light_restore.take();

        // Perform synchronous cleanup (drop sender, reset state).
        // We pass `timed_out=false` initially; if the wait below times out
        // we will re-lock and update the status.
        let _ = stop_with_timeout(&mut owner, false, trigger.clone());

        (signal, dtls_deactivate, light_restore)
    }; // lock released -- background thread can now observe the channel close.

    // Best-effort, dedupe-aware DTLS deactivation outside the lock to avoid
    // blocking the mutex. If the sender thread's close_notify cleanup path
    // already drained the token, this call is a fast in-process no-op.
    let deactivate = |(ip, username, area_id, token): &(String, String, String, Arc<_>)| {
        let request_timeout = remaining(Duration::from_millis(HUE_HTTP_TIMEOUT_MS));
        if request_timeout < HUE_STOP_MIN_REQUEST_WINDOW {
            return Err("no time left before the deadline".to_string());
        }
        blocking_client_with_timeout(&trust_for_app_key(username), request_timeout)
            .and_then(|client| deactivate_with_token(token, &client, ip, username, area_id))
    };
    let our_deactivate_failed = dtls_deactivate
        .as_ref()
        .is_some_and(|params| deactivate(params).is_err());

    // 2. If there was an active stream, wait for the sender thread to confirm
    //    shutdown within HUE_STOP_TIMEOUT_SECS. The sender signals only after
    //    its own deactivate, so a confirmed shutdown also means the area has
    //    left entertainment — the order the restore below depends on.
    let shutdown_ok = maybe_shutdown.is_none_or(|shutdown_signal| {
        wait_for_shutdown(
            &shutdown_signal,
            remaining(Duration::from_secs(HUE_STOP_TIMEOUT_SECS)),
        )
    });

    // The deactivate above skips when the sender holds the token; if the
    // sender's PUT then failed it handed the token back, and nobody else will
    // send one. Without it the area stays in entertainment and the restore's
    // writes are overridden. Not after our own PUT failed: that bridge is
    // not answering, and a second try only doubles the wait.
    if let Some(params) = dtls_deactivate
        .as_ref()
        .filter(|params| !our_deactivate_failed && !params.3.was_acquired())
    {
        let _ = deactivate(params);
    }

    let result = {
        let mut owner = acquire_hue_runtime(runtime);
        if !shutdown_ok {
            // 3. Overwrite status to reflect the partial-stop timeout.
            owner.last_status = status_with(
                HueRuntimeState::Idle,
                "HUE_STOP_TIMEOUT_PARTIAL",
                "Hue runtime reached stop timeout; partial-stop cleanup reported.",
                Some("retry stop to ensure bridge state restore".to_string()),
                trigger,
            );
            owner.last_status.action_hint = Some(HueRuntimeActionHint::Retry);
        }
        make_result(&owner)
    };

    // 4. Put the lights back — or, for a user's Off, switch them off through
    //    the same writes and watch, so the bridge's own post-stream state
    //    cannot turn them back on. Logged, never fatal: a refusal or an
    //    unreachable bridge leaves them as the bridge restored them (colour
    //    back, on).
    if let Some(restore) = light_restore {
        let restore = match lights {
            HueLightsAfterStop::Restore => restore,
            HueLightsAfterStop::TurnOff => {
                info!(
                    "[hue-restore] area {}: Off chosen, switching {} light(s) off instead of restoring",
                    restore.area_id,
                    restore.lights.len()
                );
                restore.switched_off()
            }
        };
        let restore_deadline =
            deadline.unwrap_or_else(|| Instant::now() + HUE_LIGHT_RESTORE_BUDGET);
        restore_lights(&restore, restore_deadline, &|| {
            a_newer_session_began(runtime)
        });
    }

    result
}

/// Stop the current stream (if any) and start a fresh one for the given
/// request — used when an area/channel change requires a full reconnect.
///
/// Not a stop as far as the lights are concerned: the session's snapshot
/// stays held, so a restart of the same area keeps restoring the state from
/// before its first start. A restart onto another area restores the old one
/// in `bring_up_stream`.
#[tauri::command]
pub async fn restart_hue_stream(
    mut request: StartHueStreamRequest,
    runtime_state: State<'_, HueRuntimeStateStore>,
) -> Result<HueRuntimeCommandResult, String> {
    let _wake = super::health::WakeOnDrop;
    // Same ordering rule as `start_hue_stream` — resolve before any reader.
    request.username = effective_hue_app_key(&request.username);
    runtime_state.wait_for_stop_to_settle().await;

    let trigger = request
        .trigger_source
        .clone()
        .unwrap_or(HueRuntimeTriggerSource::DeviceSurface);

    // 1. Stop first -- brief lock, no I/O. Extract DTLS deactivation params
    //    + dedupe token before the lock is released so we can deactivate
    //    outside the lock without re-PUTing what the sender thread already did.
    let dtls_deactivate = {
        let mut owner = acquire_hue_runtime(&runtime_state.runtime);
        let dtls_deactivate = owner
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
        let _ = stop_with_timeout(&mut owner, false, trigger.clone());
        dtls_deactivate
    }; // lock released before async I/O

    // Best-effort, dedupe-aware DTLS deactivation outside the lock.
    if let Some((ip, username, area_id, token)) = dtls_deactivate {
        let _ = tokio::task::spawn_blocking(move || {
            if let Ok(client) = blocking_client_for_key(&username) {
                let _ = deactivate_with_token(&token, &client, &ip, &username, &area_id);
            }
        })
        .await;
    }

    // 2. Async readiness check -- no lock held. Forced: the deactivate above
    // just changed the area's state.
    let readiness = check_hue_stream_readiness_with_freshness(
        request.bridge_ip.clone(),
        request.username.clone(),
        request.area_id.clone(),
        HueReadFreshness::Force,
        ActiveStreamerView::Foreign,
    )
    .await;

    let gate = start_gate_evidence(&request, &readiness);

    // 3. Lock briefly for state decision.
    let result = {
        let mut owner = acquire_hue_runtime(&runtime_state.runtime);
        start_with_evidence(&mut owner, &gate, trigger)
    }; // lock released

    let build = production_sender(&request);
    Ok(bring_up_stream(
        &runtime_state.runtime_arc(),
        &request,
        result,
        BringUpKind::Restart,
        build,
    )
    .await)
}

/// Push a single solid color to every light in the active area, queuing it
/// for replay if no sender is currently ready to take it.
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
    let snapshot = HueSolidColorSnapshot {
        r: request.r,
        g: request.g,
        b: request.b,
        brightness,
    };

    // Fast path: active stream -- use the pre-warmed background sender.
    if let Some(active_stream) = owner.active_stream.as_ref() {
        if active_stream.channels.is_empty() {
            // Queue rather than drop: a Revalidate + restart resolves the
            // channel mapping and the flush replays this color.
            queue_solid_color(&mut owner, snapshot);
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
        commit_solid_color(&mut owner, snapshot);
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
            commit_solid_color(&mut owner, snapshot);
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

    // No sender could take the color. Record it in EVERY branch so the next
    // usable stream context replays it — a dropped request is invisible.
    let state_for_status = owner.state.clone();
    queue_solid_color(&mut owner, snapshot);

    if matches!(
        state_for_status,
        HueRuntimeState::Starting | HueRuntimeState::Running | HueRuntimeState::Reconnecting
    ) {
        owner.last_status = status_with(
            state_for_status,
            "HUE_COLOR_QUEUED_PENDING_STREAM",
            "Color queued — stream context not ready yet, will be flushed when stream starts.",
            None,
            trigger,
        );
    } else {
        owner.last_status = status_with(
            HueRuntimeState::Idle,
            "HUE_COLOR_APPLY_SKIPPED",
            "Hue color not applied — the runtime is not streaming. Color is queued and will be sent when the stream comes back.",
            Some("Start Hue runtime before sending color updates.".to_string()),
            trigger,
        );
        owner.last_status.action_hint = Some(HueRuntimeActionHint::Retry);
    }
    Ok(make_result(&owner))
}

/// Poll the current Hue runtime status, refreshing readiness against the
/// bridge when a stream is active.
#[tauri::command]
pub async fn get_hue_stream_status(
    runtime_state: State<'_, HueRuntimeStateStore>,
) -> Result<HueRuntimeCommandResult, String> {
    Ok(refresh_hue_stream_status(runtime_state.inner(), true)
        .await
        .result)
}

/// What one runtime refresh saw, for the health monitor (`health.rs`): the
/// status, the live stream's bridge and area, and the readiness answer when
/// the refresh asked the bridge.
pub(crate) struct HueStreamRefresh {
    pub(crate) result: HueRuntimeCommandResult,
    pub(crate) stream_area: Option<(String, String)>,
    pub(crate) readiness: Option<HueStreamReadinessResponse>,
}

/// Body of `get_hue_stream_status`, shared with the health monitor. With
/// `bridge_check` false it stays local: the dead-sender probe and the
/// pending-colour flush, no readiness round-trip.
pub(crate) async fn refresh_hue_stream_status(
    runtime_state: &HueRuntimeStateStore,
    bridge_check: bool,
) -> HueStreamRefresh {
    // 1. Check if stream is active and read params -- brief lock, no I/O.
    let (active_stream_params, stream_area) = {
        let owner = acquire_hue_runtime(&runtime_state.runtime);
        let stream_area = owner
            .active_stream
            .as_ref()
            .map(|stream| (stream.bridge_ip.clone(), stream.area_id.clone()));
        let params = if matches!(
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
        };
        (params, stream_area)
    }; // lock released before async I/O
    let refreshed = |result: HueRuntimeCommandResult,
                     readiness: Option<HueStreamReadinessResponse>| {
        HueStreamRefresh {
            result,
            stream_area: stream_area.clone(),
            readiness,
        }
    };

    // Non-blocking probe — if the background sender thread has already exited,
    // register a transient fault immediately without doing a network round-trip.
    if let Some((_, _, _, ref shutdown_signal)) = active_stream_params {
        if is_shutdown_signaled(shutdown_signal) {
            let mut owner = acquire_hue_runtime(&runtime_state.runtime);
            if matches!(
                owner.state,
                HueRuntimeState::Starting
                    | HueRuntimeState::Running
                    | HueRuntimeState::Reconnecting
            ) {
                // Clear dead stream/sender contexts so the next start can spawn fresh.
                owner.set_active_stream(None);
                owner.persistent_sender = None;
                return refreshed(
                    register_transient_fault(
                        &mut owner,
                        "DTLS sender thread exited unexpectedly.",
                        HueRuntimeTriggerSource::System,
                    ),
                    None,
                );
            }
            return refreshed(make_result(&owner), None);
        }
    }

    // 2. If stream is active, check readiness async -- no lock held.
    if let Some((bridge_ip, username, area_id, _)) = active_stream_params.filter(|_| bridge_check) {
        // During a health poll the area's active_streamer is us. The readiness
        // check treats a streamer as "not ready" to prevent hijacking a foreign
        // stream; `Ours` tells it this one is our own session, so it neither
        // blocks nor logs. The reconnect path deliberately does not do this.
        let readiness = check_hue_stream_readiness_with_freshness(
            bridge_ip,
            username,
            area_id,
            HueReadFreshness::Cached,
            ActiveStreamerView::Ours,
        )
        .await;
        let gate = HueRuntimeGateEvidence {
            bridge_configured: true,
            credentials_valid: true,
            area_selected: true,
            readiness_current: readiness.status.code != "HUE_STREAM_READINESS_FAILED",
            ready: readiness.readiness.ready,
            auth_invalid_evidence: is_auth_rejection(&readiness.status.code),
            readiness_blockers: readiness_blockers(&readiness),
        };
        // No "not ready" details on a healthy poll: leaking them into the
        // Running status reads as a misleading "Adjust Entertainment Area".
        let details = if readiness.readiness.ready {
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
        return refreshed(make_result(&owner), Some(readiness));
    }

    // Fallback: active_stream was None at step 1, but step 4c of start_hue_stream
    // may have stored the context by now. Re-acquire the lock and attempt a flush.
    let mut owner = acquire_hue_runtime(&runtime_state.runtime);
    flush_pending_solid_color(&mut owner);
    refreshed(make_result(&owner), None)
}

// ---------------------------------------------------------------------------
// simulate_hue_fault — debug-only command
// ---------------------------------------------------------------------------

/// Debug-only: force the active DTLS stream's shutdown signal to fire,
/// exercising the reconnect monitor without a real bridge fault.
///
/// Returns `CommandStatus` rather than `Result<_, String>` on purpose: a Hue
/// command never throws, so "no stream to fault" has to arrive as a coded
/// status the caller can branch on, not as a rejected promise. The codes are
/// declared in `HUE_DEBUG_COMMAND_CODES` in `src/shared/contracts/hue.ts`.
#[cfg(debug_assertions)]
#[tauri::command]
pub fn simulate_hue_fault(runtime_state: State<'_, HueRuntimeStateStore>) -> CommandStatus {
    let owner = acquire_hue_runtime(&runtime_state.runtime);
    if let Some(ref stream) = owner.active_stream {
        if stream.uses_dtls {
            // Fire shutdown signal to trigger reconnect monitor.
            signal_shutdown_complete(&stream.shutdown_signal);
            info!("simulate_hue_fault: shutdown signal fired for active DTLS stream.");
            return CommandStatus {
                code: "HUE_FAULT_SIMULATED".to_string(),
                message: "Shutdown signal fired on the active DTLS stream.".to_string(),
                details: None,
            };
        }
    }
    CommandStatus {
        code: "NO_ACTIVE_DTLS_STREAM".to_string(),
        message: "No active DTLS stream to fault.".to_string(),
        details: None,
    }
}

/// Release stub for `simulate_hue_fault` — always reports the debug-only
/// command as unavailable, as a coded status for the same reason as above.
#[cfg(not(debug_assertions))]
#[tauri::command]
pub fn simulate_hue_fault() -> CommandStatus {
    CommandStatus {
        code: "SIMULATE_NOT_AVAILABLE_IN_RELEASE".to_string(),
        message: "Fault simulation is available in debug builds only.".to_string(),
        details: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn channel(index: usize) -> HueAreaChannelInfo {
        HueAreaChannelInfo {
            index,
            channel_id: index as u8,
            light_ids: vec![format!("light-{index}")],
            position_x: 0.0,
            position_y: 0.0,
            position_z: None,
            light_count: 1,
            auto_region: "left".to_string(),
        }
    }

    fn request() -> StartHueStreamRequest {
        StartHueStreamRequest {
            bridge_ip: "192.168.1.180".to_string(),
            username: "app-key".to_string(),
            client_key: String::new(),
            area_id: "area-1".to_string(),
            trigger_source: None,
            channel_placements: None,
        }
    }

    fn readiness(code: &str, ready: bool, reasons: &[&str]) -> HueStreamReadinessResponse {
        use super::super::super::hue_onboarding::HueStreamReadiness;
        HueStreamReadinessResponse {
            status: CommandStatus {
                code: code.to_string(),
                message: String::new(),
                details: None,
            },
            readiness: HueStreamReadiness {
                ready,
                reasons: reasons.iter().map(|r| r.to_string()).collect(),
            },
        }
    }

    /// The three reasons a start can be refused must reach the state machine
    /// as three different pieces of evidence.
    #[test]
    fn a_start_gate_keeps_auth_busy_and_unreachable_apart() {
        let auth = start_gate_evidence(
            &request(),
            &readiness("AUTH_INVALID_RE_PAIR_REQUIRED", false, &["key refused"]),
        );
        assert!(auth.auth_invalid_evidence);

        let busy = start_gate_evidence(
            &request(),
            &readiness("HUE_STREAM_NOT_READY", false, &[ACTIVE_STREAMER_REASON]),
        );
        assert!(!busy.auth_invalid_evidence);
        assert!(busy.readiness_current);
        assert_eq!(
            busy.readiness_blockers,
            vec!["HUE_STREAM_NOT_READY", ACTIVE_STREAMER_REASON]
        );

        let unreachable = start_gate_evidence(
            &request(),
            &readiness("HUE_STREAM_READINESS_FAILED", false, &["no answer"]),
        );
        assert!(!unreachable.auth_invalid_evidence);
        assert!(!unreachable.readiness_current);
        assert_eq!(
            unreachable.readiness_blockers,
            vec!["HUE_STREAM_READINESS_FAILED"]
        );

        let ready = start_gate_evidence(&request(), &readiness("HUE_STREAM_READY", true, &[]));
        assert!(ready.readiness_blockers.is_empty());
    }

    #[test]
    fn empty_area_is_a_success_code_distinct_from_a_failed_fetch() {
        let empty = ok_or_empty(Vec::new());
        assert_eq!(empty.status.code, "HUE_AREA_CHANNELS_EMPTY");
        assert!(empty.channels.is_empty());
        assert_ne!(empty.status.code, "HUE_AREA_CHANNELS_FAILED");
    }

    #[test]
    fn resolved_channels_report_ok_and_survive_the_envelope() {
        let response = ok_or_empty(vec![channel(0), channel(1)]);
        assert_eq!(response.status.code, "HUE_AREA_CHANNELS_OK");
        assert_eq!(response.channels.len(), 2);
        assert_eq!(response.status.details, None);
    }
}

/// The light restore, driven through the real start pipeline and the real stop
/// command against a local HTTPS bridge. Readiness and the keychain read are
/// the only parts skipped: the gate result is fed in the way the commands feed
/// it, because `validate_bridge_addr` refuses a loopback bridge and the test
/// binary must not touch the OS keychain.
#[cfg(test)]
mod light_restore_flow {

    use std::sync::atomic::{AtomicBool, Ordering};

    use serde_json::{json, Value};
    use tauri::Manager;

    use super::super::frame::HueColorSender;
    use super::super::light_restore::{
        parse_light_state, reads_as, HueLightRestoreStop, HueLightSnapshot, HueLightState,
        HUE_LIGHT_RESTORE_WATCH,
    };
    use super::super::retry::start_with_evidence;
    use super::super::sender::{new_shutdown_signal, signal_shutdown_complete, DeactivateToken};
    use super::super::state_store::test_helpers::strict_gate_ready;
    use super::super::test_bridge::{light_json, FakeHue, Reply, TestBridge};
    use super::*;

    const AREA: &str = "area-1";
    const STOP_PUT: &str = "/clip/v2/resource/entertainment_configuration/";

    fn request(hue: &FakeHue, area_id: &str) -> StartHueStreamRequest {
        StartHueStreamRequest {
            bridge_ip: hue.bridge.authority.clone(),
            username: "app-key".to_string(),
            client_key: String::new(),
            area_id: area_id.to_string(),
            trigger_source: None,
            channel_placements: None,
        }
    }

    /// Stands in for `build_hue_sender`: a thread that drains frames and
    /// signals shutdown once every handle is gone, as the real sender does.
    fn fake_sender(
        uses_dtls: bool,
    ) -> impl FnOnce(
        Vec<HueAreaChannel>,
        Arc<HashMap<String, HueLightMetadata>>,
        Arc<AtomicU32>,
    ) -> SpawnedHueSender
           + Send
           + 'static {
        move |channels, _metadata, _counter| {
            let (color_sender, rx) = HueColorSender::with_mailbox(channels.len());
            let shutdown = new_shutdown_signal();
            let signal = Arc::clone(&shutdown);
            std::thread::spawn(move || {
                while rx.recv().is_ok() {}
                signal_shutdown_complete(&signal);
            });
            SpawnedHueSender {
                color_sender,
                uses_dtls,
                shutdown_signal: shutdown,
                cipher_name: None,
                deactivate_token: DeactivateToken::new(),
            }
        }
    }

    fn app() -> tauri::App<tauri::test::MockRuntime> {
        let app = tauri::test::mock_app();
        app.manage(HueRuntimeStateStore::default());
        app
    }

    fn runtime_of(app: &tauri::App<tauri::test::MockRuntime>) -> Arc<Mutex<HueRuntimeOwner>> {
        app.state::<HueRuntimeStateStore>().runtime_arc()
    }

    /// What `start_hue_stream` does once readiness has passed.
    async fn start(
        runtime: &Arc<Mutex<HueRuntimeOwner>>,
        request: &StartHueStreamRequest,
        kind: BringUpKind,
    ) -> HueRuntimeCommandResult {
        let result = start_with_evidence(
            &mut acquire_hue_runtime(runtime),
            &strict_gate_ready(),
            HueRuntimeTriggerSource::ModeControl,
        );
        bring_up_stream(runtime, request, result, kind, fake_sender(true)).await
    }

    fn held_light_on(runtime: &Arc<Mutex<HueRuntimeOwner>>, light_id: &str) -> Option<bool> {
        acquire_hue_runtime(runtime)
            .light_restore
            .as_ref()?
            .lights
            .iter()
            .find(|l| l.light_id == light_id)
            .map(|l| l.state.on)
    }

    fn one_area(lights: &[(&str, Value)]) -> FakeHue {
        let ids: Vec<&str> = lights.iter().map(|(id, _)| *id).collect();
        FakeHue::start(&[(AREA, &ids)], lights, |_| Reply::ok())
    }

    fn switch_off() -> Value {
        json!({ "on": { "on": false } })
    }

    /// Off before the stream, the lights read "on" once the bridge has put the
    /// colour back after `action: stop` — the restore must switch them off,
    /// and only after the stop PUT.
    #[tokio::test]
    async fn a_light_that_was_off_is_off_again_after_stop() {
        let hue = one_area(&[(
            "light-1",
            light_json(false, 30.83, Some(367), (0.4583, 0.4099)),
        )]);
        let app = app();
        let runtime = runtime_of(&app);

        let started = start(&runtime, &request(&hue, AREA), BringUpKind::Start).await;
        assert_eq!(started.status.code, "HUE_STREAM_RUNNING_DTLS");
        assert_eq!(held_light_on(&runtime, "light-1"), Some(false));
        assert!(
            hue.light_puts().is_empty(),
            "nothing restores while streaming"
        );

        let stopped = stop_hue_stream(None, app.state()).await.unwrap();
        assert_eq!(stopped.status.code, "HUE_STREAM_STOPPED");

        assert_eq!(
            hue.light_puts(),
            vec![("light-1".to_string(), switch_off())]
        );
        let stop_put = hue.bridge.puts_to(STOP_PUT);
        let light_put = hue.restore_requests();
        assert_eq!(stop_put[0].json(), json!({ "action": "stop" }));
        assert!(
            stop_put[0].at <= light_put[0].at,
            "restore ran before the area left entertainment"
        );
        assert!(acquire_hue_runtime(&runtime).light_restore.is_none());
    }

    #[tokio::test]
    async fn a_light_in_ct_mode_gets_its_colour_temperature_back() {
        let hue = one_area(&[(
            "light-1",
            light_json(true, 30.83, Some(367), (0.4583, 0.4099)),
        )]);
        let app = app();
        let runtime = runtime_of(&app);
        start(&runtime, &request(&hue, AREA), BringUpKind::Start).await;

        stop_hue_stream(None, app.state()).await.unwrap();

        assert_eq!(
            hue.light_puts(),
            vec![(
                "light-1".to_string(),
                json!({
                    "on": { "on": true },
                    "dimming": { "brightness": 30.83 },
                    "color_temperature": { "mirek": 367 }
                })
            )]
        );
    }

    #[tokio::test]
    async fn a_light_in_xy_mode_gets_its_colour_point_back() {
        let hue = one_area(&[("light-1", light_json(true, 64.0, None, (0.1532, 0.0475)))]);
        let app = app();
        let runtime = runtime_of(&app);
        start(&runtime, &request(&hue, AREA), BringUpKind::Start).await;

        stop_hue_stream(None, app.state()).await.unwrap();

        assert_eq!(
            hue.light_puts(),
            vec![(
                "light-1".to_string(),
                json!({
                    "on": { "on": true },
                    "dimming": { "brightness": 64.0 },
                    "color": { "xy": { "x": 0.1532, "y": 0.0475 } }
                })
            )]
        );
    }

    /// A restart of the same area reads the lights again, and by then they
    /// show the bridge's post-stream state. The first snapshot must win.
    #[tokio::test]
    async fn a_restart_of_the_same_area_keeps_the_first_snapshot() {
        let hue = one_area(&[("light-1", light_json(false, 30.0, Some(367), (0.45, 0.41)))]);
        let app = app();
        let runtime = runtime_of(&app);
        let request = request(&hue, AREA);
        start(&runtime, &request, BringUpKind::Start).await;

        hue.set_light("light-1", light_json(true, 100.0, None, (0.6, 0.3)));
        let _ = stop_with_timeout(
            &mut acquire_hue_runtime(&runtime),
            false,
            HueRuntimeTriggerSource::DeviceSurface,
        );
        let restarted = start(&runtime, &request, BringUpKind::Restart).await;
        assert!(restarted.active);
        assert!(hue.light_puts().is_empty(), "a restart is not a stop");
        assert_eq!(held_light_on(&runtime, "light-1"), Some(false));

        stop_hue_stream(None, app.state()).await.unwrap();
        assert_eq!(
            hue.light_puts(),
            vec![("light-1".to_string(), switch_off())]
        );
    }

    /// Moving to another area ends output on the old one: its lights go back
    /// before the new area is read.
    #[tokio::test]
    async fn a_start_onto_another_area_restores_the_old_one_first() {
        let hue = FakeHue::start(
            &[("area-1", &["light-1"]), ("area-2", &["light-2"])],
            &[
                ("light-1", light_json(false, 30.0, Some(367), (0.45, 0.41))),
                ("light-2", light_json(true, 50.0, Some(250), (0.40, 0.39))),
            ],
            |_| Reply::ok(),
        );
        let app = app();
        let runtime = runtime_of(&app);
        start(&runtime, &request(&hue, "area-1"), BringUpKind::Start).await;
        let _ = stop_with_timeout(
            &mut acquire_hue_runtime(&runtime),
            false,
            HueRuntimeTriggerSource::DeviceSurface,
        );
        // `restart_hue_stream` deactivates and reads readiness here; the old
        // session's reconnect monitor sees `Idle` meanwhile and lets go. With
        // no gap it would find the new start's `Starting` and claim a
        // reconnect in the middle of it.
        tokio::time::sleep(Duration::from_millis(50)).await;

        start(&runtime, &request(&hue, "area-2"), BringUpKind::Restart).await;

        assert_eq!(
            hue.light_puts(),
            vec![("light-1".to_string(), switch_off())]
        );
        let requests = hue.bridge.requests();
        let restored_at = requests
            .iter()
            .position(|r| r.method == "PUT" && r.path.ends_with("/light/light-1"))
            .unwrap();
        let area_2_read_at = requests
            .iter()
            .position(|r| r.method == "GET" && r.path.ends_with("/light/light-2"))
            .unwrap();
        assert!(restored_at < area_2_read_at);
        assert_eq!(held_light_on(&runtime, "light-2"), Some(true));
        assert_eq!(held_light_on(&runtime, "light-1"), None);

        stop_hue_stream(None, app.state()).await.unwrap();
    }

    /// A mode change that keeps Hue reaches `start_hue_stream` on a running
    /// runtime, which answers NOOP before anything is read or written.
    #[tokio::test]
    async fn a_mode_change_that_keeps_hue_neither_restores_nor_rereads() {
        let hue = one_area(&[("light-1", light_json(false, 30.0, Some(367), (0.45, 0.41)))]);
        let app = app();
        let runtime = runtime_of(&app);
        start(&runtime, &request(&hue, AREA), BringUpKind::Start).await;
        let requests_before = hue.bridge.requests().len();
        hue.set_light("light-1", light_json(true, 100.0, None, (0.6, 0.3)));

        let again = start_with_evidence(
            &mut acquire_hue_runtime(&runtime),
            &strict_gate_ready(),
            HueRuntimeTriggerSource::ModeControl,
        );
        assert_eq!(again.status.code, "HUE_START_NOOP_ALREADY_ACTIVE");
        assert_eq!(hue.bridge.requests().len(), requests_before);
        assert_eq!(held_light_on(&runtime, "light-1"), Some(false));

        stop_hue_stream(None, app.state()).await.unwrap();
    }

    /// A stop that lands while the sender is being built finds nothing to
    /// deactivate or restore. The start that loses the race must restore.
    #[tokio::test]
    async fn a_stop_that_overtakes_a_start_still_restores_the_lights() {
        let hue = one_area(&[("light-1", light_json(false, 30.0, Some(367), (0.45, 0.41)))]);
        let app = app();
        let runtime = runtime_of(&app);
        let result = start_with_evidence(
            &mut acquire_hue_runtime(&runtime),
            &strict_gate_ready(),
            HueRuntimeTriggerSource::ModeControl,
        );
        let racing = Arc::clone(&runtime);
        let build = move |channels, metadata, counter| {
            let _ = stop_with_timeout(
                &mut acquire_hue_runtime(&racing),
                false,
                HueRuntimeTriggerSource::ModeControl,
            );
            fake_sender(true)(channels, metadata, counter)
        };

        let result = bring_up_stream(
            &runtime,
            &request(&hue, AREA),
            result,
            BringUpKind::Start,
            build,
        )
        .await;

        assert!(!result.active);
        assert!(acquire_hue_runtime(&runtime).active_stream.is_none());
        assert_eq!(
            hue.light_puts(),
            vec![("light-1".to_string(), switch_off())]
        );
    }

    fn three_lights() -> [(&'static str, Value); 3] {
        [
            ("light-1", light_json(false, 30.0, Some(367), (0.45, 0.41))),
            ("light-2", light_json(true, 40.0, Some(300), (0.44, 0.40))),
            ("light-3", light_json(true, 50.0, None, (0.30, 0.30))),
        ]
    }

    fn three_light_area<P>(put_light: P) -> FakeHue
    where
        P: Fn(&str) -> Reply + Send + Sync + 'static,
    {
        FakeHue::start(
            &[(AREA, &["light-1", "light-2", "light-3"])],
            &three_lights(),
            put_light,
        )
    }

    /// The quit path restores every light inside its deadline on a bridge
    /// that answers, paced to the light budget.
    #[tokio::test]
    async fn the_quit_path_restores_inside_its_deadline() {
        let hue = three_light_area(|_| Reply::ok());
        let app = app();
        let runtime = runtime_of(&app);
        start(&runtime, &request(&hue, AREA), BringUpKind::Start).await;

        let started = Instant::now();
        let deadline = started + Duration::from_millis(1_500);
        let result = tokio::task::spawn_blocking(move || {
            stop_hue_stream_before_exit(&app.state::<HueRuntimeStateStore>(), deadline)
        })
        .await
        .unwrap();

        assert_eq!(result.status.code, "HUE_STREAM_STOPPED");
        assert!(Instant::now() <= deadline, "{:?}", started.elapsed());
        let puts = hue.restore_requests();
        assert_eq!(puts.len(), 3);
        // ~10 requests/s: three restores span two ~100 ms slots. Measured on
        // the server side, so a TLS handshake's jitter is allowed for.
        let span = puts[2].at.duration_since(puts[0].at);
        assert!(span >= Duration::from_millis(150), "{span:?}");
    }

    /// A bridge that stops answering mid-quit cannot hold the exit: the stop
    /// returns at its deadline with the lights it could not reach left alone.
    #[tokio::test]
    async fn the_quit_path_gives_up_on_a_silent_bridge_at_its_deadline() {
        let hue = three_light_area(|_| Reply::ok().after(Duration::from_secs(3)));
        let app = app();
        let runtime = runtime_of(&app);
        start(&runtime, &request(&hue, AREA), BringUpKind::Start).await;

        let started = Instant::now();
        // The restore's own per-request ceiling: whenever the first PUT goes
        // out, the deadline ends it, not that ceiling — and a slow runner
        // still has most of it left to send that PUT at all.
        let deadline = started + Duration::from_millis(1_500);
        let result = tokio::task::spawn_blocking(move || {
            stop_hue_stream_before_exit(&app.state::<HueRuntimeStateStore>(), deadline)
        })
        .await
        .unwrap();

        assert_eq!(result.status.code, "HUE_STREAM_STOPPED");
        assert!(Instant::now() <= deadline, "{:?}", started.elapsed());
        assert_eq!(
            hue.light_puts().len(),
            1,
            "an unanswered request means the bridge is gone; the rest are not tried"
        );
    }

    /// A watch read the bridge is slow to answer straddles the deadline. Its
    /// timeout used to end on the deadline itself, so the call returned past
    /// it every time — by however long a timed-out request takes to unwind.
    #[tokio::test]
    async fn the_quit_path_ends_inside_its_deadline_when_a_watch_read_straddles_it() {
        let hue = three_light_area(|_| Reply::ok());
        let app = app();
        let runtime = runtime_of(&app);
        start(&runtime, &request(&hue, AREA), BringUpKind::Start).await;
        hue.answer_bulk_light_reads_after(Duration::from_secs(3));

        // One watch window from now: however long the stop takes to reach
        // the watch, the deadline ends it rather than its own window, and
        // the stop has ~1.1 s to get there. A 1 s deadline left a slow
        // runner's three paced PUTs no room to start the watch at all.
        let deadline = Instant::now() + HUE_LIGHT_RESTORE_WATCH;
        let (result, returned_at) = tokio::task::spawn_blocking(move || {
            let result =
                stop_hue_stream_before_exit(&app.state::<HueRuntimeStateStore>(), deadline);
            (result, Instant::now())
        })
        .await
        .unwrap();

        assert_eq!(result.status.code, "HUE_STREAM_STOPPED");
        assert_eq!(hue.light_puts().len(), 3);
        let last_put = hue.restore_requests().last().map(|put| put.at);
        assert!(
            hue.bridge
                .requests()
                .iter()
                .any(|r| r.method == "GET" && r.path == "/clip/v2/resource/light"),
            "the watch never read the lights; last restore PUT {:?} before the deadline",
            last_put.map(|at| deadline.saturating_duration_since(at))
        );
        assert!(
            returned_at <= deadline,
            "returned {:?} past the deadline",
            returned_at - deadline
        );
    }

    /// A refused key ends the restore at the first light and the stop still
    /// reports a clean stop — logged, never fatal.
    #[tokio::test]
    async fn a_bridge_refusing_the_key_ends_the_restore_without_failing_the_stop() {
        let hue = three_light_area(|_| {
            Reply::json(
                403,
                json!({ "errors": [{ "description": "unauthorized user" }] }),
            )
        });
        let app = app();
        let runtime = runtime_of(&app);
        start(&runtime, &request(&hue, AREA), BringUpKind::Start).await;

        let started = Instant::now();
        let stopped = stop_hue_stream(None, app.state()).await.unwrap();

        assert_eq!(stopped.status.code, "HUE_STREAM_STOPPED");
        assert_eq!(hue.light_puts().len(), 1);
        assert!(started.elapsed() < Duration::from_secs(1));
    }

    /// A light the bridge rejects on its merits (deleted, say) is skipped; the
    /// others are still restored.
    #[tokio::test]
    async fn a_light_the_bridge_rejects_does_not_stop_the_others() {
        let hue = three_light_area(|id| {
            if id == "light-1" {
                Reply::json(404, json!({ "errors": [{ "description": "not found" }] }))
            } else {
                Reply::ok()
            }
        });
        let app = app();
        let runtime = runtime_of(&app);
        start(&runtime, &request(&hue, AREA), BringUpKind::Start).await;

        stop_hue_stream(None, app.state()).await.unwrap();

        let ids: Vec<String> = hue.light_puts().into_iter().map(|(id, _)| id).collect();
        assert_eq!(ids, vec!["light-1", "light-2", "light-3"]);
    }

    // ── a start arriving while a stop is still restoring ─────────────────

    /// Three lights, off before the stream; each restore PUT takes 150 ms to
    /// answer and, like a real bridge, changes what the next GET reports.
    fn slow_restoring_area() -> FakeHue {
        let lights = [
            ("light-1", light_json(false, 30.0, Some(367), (0.45, 0.41))),
            ("light-2", light_json(false, 40.0, Some(300), (0.44, 0.40))),
            ("light-3", light_json(false, 50.0, None, (0.30, 0.30))),
        ];
        let ids: Vec<&str> = lights.iter().map(|(id, _)| *id).collect();
        FakeHue::start(&[(AREA, &ids)], &lights, |_| {
            Reply::ok().after(Duration::from_millis(150))
        })
    }

    /// The bridge's post-stream state: colour back, every lamp on.
    fn lights_left_on(hue: &FakeHue) {
        for (id, light) in [
            ("light-1", light_json(true, 30.0, Some(367), (0.45, 0.41))),
            ("light-2", light_json(true, 40.0, Some(300), (0.44, 0.40))),
            ("light-3", light_json(true, 50.0, None, (0.30, 0.30))),
        ] {
            hue.set_light(id, light);
        }
    }

    async fn once_the_restore_has_begun(hue: &FakeHue) {
        let deadline = Instant::now() + Duration::from_secs(5);
        while hue.light_puts().is_empty() {
            assert!(Instant::now() < deadline, "the stop never began restoring");
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    }

    /// The runtime reads `Idle` for the whole restore, so a start issued
    /// then used to snapshot the lights the restore had not reached yet —
    /// still on — and its own stop later switched them back on.
    #[tokio::test]
    async fn a_start_during_a_stops_restore_snapshots_the_restored_lights() {
        let hue = slow_restoring_area();
        let app = app();
        let runtime = runtime_of(&app);
        start(&runtime, &request(&hue, AREA), BringUpKind::Start).await;
        lights_left_on(&hue);

        let store = app.state::<HueRuntimeStateStore>();
        let (stopped, _) = tokio::join!(stop_hue_stream(None, app.state()), async {
            once_the_restore_has_begun(&hue).await;
            // What `start_hue_stream` does before it reads the bridge.
            store.wait_for_stop_to_settle().await;
            start(&runtime, &request(&hue, AREA), BringUpKind::Start).await;
        });

        let snapshot: Vec<_> = ["light-1", "light-2", "light-3"]
            .into_iter()
            .map(|light| (light, held_light_on(&runtime, light)))
            .collect();
        // Ended before asserting, so a failure does not leave the second
        // session's reconnect monitor blocking the runtime's shutdown.
        stop_hue_stream(None, app.state()).await.unwrap();

        assert_eq!(stopped.unwrap().status.code, "HUE_STREAM_STOPPED");
        for (light, on) in snapshot {
            assert_eq!(on, Some(false), "{light} was snapshotted mid-restore");
        }
    }

    // Readiness refuses a loopback address, so the command under test ends at
    // its gate without touching the bridge; only when it finishes counts. One
    // that waited finishes after the restore has sent all three PUTs.

    #[tokio::test]
    async fn start_hue_stream_waits_for_a_stop_in_flight() {
        let hue = slow_restoring_area();
        let app = app();
        let runtime = runtime_of(&app);
        start(&runtime, &request(&hue, AREA), BringUpKind::Start).await;
        lights_left_on(&hue);

        let (_, sent) = tokio::join!(stop_hue_stream(None, app.state()), async {
            once_the_restore_has_begun(&hue).await;
            start_hue_stream(request(&hue, AREA), app.state())
                .await
                .unwrap();
            hue.light_puts().len()
        });

        assert_eq!(sent, 3, "the start ran inside the restore");
    }

    #[tokio::test]
    async fn restart_hue_stream_waits_for_a_stop_in_flight() {
        let hue = slow_restoring_area();
        let app = app();
        let runtime = runtime_of(&app);
        start(&runtime, &request(&hue, AREA), BringUpKind::Start).await;
        lights_left_on(&hue);

        let (_, sent) = tokio::join!(stop_hue_stream(None, app.state()), async {
            once_the_restore_has_begun(&hue).await;
            restart_hue_stream(request(&hue, AREA), app.state())
                .await
                .unwrap();
            hue.light_puts().len()
        });

        assert_eq!(sent, 3, "the restart ran inside the restore");
    }

    // ── the bridge's own post-stream state landing after ours ────────────

    /// Both lights before the stream, as read off a BSB002 on 2026-09-24.
    fn before_stream() -> Value {
        light_json(true, 56.92, Some(446), (0.5190, 0.4152))
    }

    /// What that bridge put on both lights a few hundred ms after every stop,
    /// on top of a restore it had already acknowledged.
    fn bridge_post_stream() -> Value {
        light_json(true, 30.83, Some(367), (0.4583, 0.4099))
    }

    fn measured_bridge() -> FakeHue {
        let hue = FakeHue::start(
            &[(AREA, &["left", "right"])],
            &[("left", before_stream()), ("right", before_stream())],
            |_| Reply::ok(),
        );
        hue.after_our_restore_bridge_sets(
            Duration::from_millis(400),
            &[
                ("left", bridge_post_stream()),
                ("right", bridge_post_stream()),
            ],
        );
        hue
    }

    fn reads_as_before_stream(hue: &FakeHue, light: &str) -> bool {
        let want = parse_light_state(&before_stream()).unwrap();
        parse_light_state(&hue.light(light)).is_some_and(|have| reads_as(&want, &have))
    }

    /// Past the bridge's post-stream write, however the stop ended.
    async fn once_the_bridge_is_done() {
        tokio::time::sleep(Duration::from_millis(800)).await;
    }

    /// Reads of every light the watch made after the last light PUT. One
    /// means it ended on the read that found every re-written light holding,
    /// rather than polling on to the end of its window — counted, not timed,
    /// so a slow runner's requests cannot make an early end look late.
    fn watch_reads_after_the_last_write(hue: &FakeHue) -> usize {
        let last_write = hue
            .bridge
            .puts_to("/clip/v2/resource/light/")
            .last()
            .expect("the stop wrote the lights")
            .at;
        hue.bridge
            .requests()
            .iter()
            .filter(|r| r.method == "GET" && r.path == "/clip/v2/resource/light")
            .filter(|r| r.at > last_write)
            .count()
    }

    /// The bridge acknowledges `action: stop`, takes our restore, and then
    /// puts its own state on the lights anyway. The restore has to be the
    /// last write.
    #[tokio::test]
    async fn the_restore_outlasts_the_bridges_own_post_stream_state() {
        let hue = measured_bridge();
        let app = app();
        let runtime = runtime_of(&app);
        start(&runtime, &request(&hue, AREA), BringUpKind::Start).await;

        let stopped = stop_hue_stream(None, app.state()).await.unwrap();
        once_the_bridge_is_done().await;

        assert_eq!(stopped.status.code, "HUE_STREAM_STOPPED");
        for light in ["left", "right"] {
            assert!(
                reads_as_before_stream(&hue, light),
                "{light} was left as the bridge put it: {}",
                hue.light(light)
            );
        }
        // Once per light, and once more after the bridge undid it.
        assert_eq!(hue.light_puts().len(), 4, "{:?}", hue.light_puts());
        // Every light written again and read back holding ends the watch
        // before its window does.
        assert_eq!(watch_reads_after_the_last_write(&hue), 1);
    }

    /// The stop skips its own `action: stop` while the sender holds the token.
    /// When the sender's PUT then fails it hands the token back, and the stop
    /// has to send one itself before restoring — or the area stays in
    /// entertainment and overrides every restore write.
    #[tokio::test]
    async fn a_stop_sends_the_deactivate_the_sender_failed_to_land() {
        let hue = one_area(&[("light-1", light_json(false, 30.0, Some(367), (0.45, 0.41)))]);
        let app = app();
        let runtime = runtime_of(&app);
        let result = start_with_evidence(
            &mut acquire_hue_runtime(&runtime),
            &strict_gate_ready(),
            HueRuntimeTriggerSource::ModeControl,
        );
        let build = |channels: Vec<HueAreaChannel>, _metadata, _counter| {
            let (color_sender, rx) = HueColorSender::with_mailbox(channels.len());
            let shutdown = new_shutdown_signal();
            let signal = Arc::clone(&shutdown);
            // Taken up front, so the stop's own deactivate always finds it
            // held — as it does when the sender's PUT is already on its way.
            let token = DeactivateToken::new();
            assert!(token.try_acquire());
            let held = Arc::clone(&token);
            std::thread::spawn(move || {
                while rx.recv().is_ok() {}
                // That PUT fails, and the token goes back.
                std::thread::sleep(Duration::from_millis(100));
                held.release();
                signal_shutdown_complete(&signal);
            });
            SpawnedHueSender {
                color_sender,
                uses_dtls: true,
                shutdown_signal: shutdown,
                cipher_name: None,
                deactivate_token: token,
            }
        };
        bring_up_stream(
            &runtime,
            &request(&hue, AREA),
            result,
            BringUpKind::Start,
            build,
        )
        .await;
        let stopped = stop_hue_stream(None, app.state()).await.unwrap();

        assert_eq!(stopped.status.code, "HUE_STREAM_STOPPED");
        let stop_puts = hue.bridge.puts_to(STOP_PUT);
        let light_puts = hue.restore_requests();
        assert_eq!(
            stop_puts.len(),
            1,
            "nobody took the area out of entertainment"
        );
        assert!(stop_puts[0].at <= light_puts[0].at);
    }

    /// The quit path gets the same restore inside its own deadline.
    #[tokio::test]
    async fn the_quit_path_restore_outlasts_the_bridges_post_stream_state() {
        let hue = measured_bridge();
        let app = app();
        let runtime = runtime_of(&app);
        start(&runtime, &request(&hue, AREA), BringUpKind::Start).await;

        let started = Instant::now();
        // `[shutdown]` step 2's deadline when step 1 is quick.
        let deadline = started + Duration::from_millis(3_200);
        let result = tokio::task::spawn_blocking(move || {
            stop_hue_stream_before_exit(&app.state::<HueRuntimeStateStore>(), deadline)
        })
        .await
        .unwrap();
        assert!(Instant::now() <= deadline, "{:?}", started.elapsed());
        once_the_bridge_is_done().await;

        assert_eq!(result.status.code, "HUE_STREAM_STOPPED");
        for light in ["left", "right"] {
            assert!(
                reads_as_before_stream(&hue, light),
                "{light} was left as the bridge put it: {}",
                hue.light(light)
            );
        }
    }

    /// A start issued while a stop is still watching waits for it, reads the
    /// lights as they were before the stream, and nothing of the stop's
    /// restore lands once it has begun.
    #[tokio::test]
    async fn a_start_right_after_stop_waits_out_the_watch_and_is_never_painted_over() {
        let hue = measured_bridge();
        let app = app();
        let runtime = runtime_of(&app);
        start(&runtime, &request(&hue, AREA), BringUpKind::Start).await;

        let store = app.state::<HueRuntimeStateStore>();
        let (stopped, puts_when_the_start_began) =
            tokio::join!(stop_hue_stream(None, app.state()), async {
                once_the_restore_has_begun(&hue).await;
                store.wait_for_stop_to_settle().await;
                let puts = hue.light_puts().len();
                start(&runtime, &request(&hue, AREA), BringUpKind::Start).await;
                puts
            });
        once_the_bridge_is_done().await;
        let puts_while_streaming = hue.light_puts().len();
        let held: Vec<Option<HueLightState>> = ["left", "right"]
            .into_iter()
            .map(|light| {
                acquire_hue_runtime(&runtime)
                    .light_restore
                    .as_ref()?
                    .lights
                    .iter()
                    .find(|l| l.light_id == light)
                    .map(|l| l.state.clone())
            })
            .collect();
        stop_hue_stream(None, app.state()).await.unwrap();

        assert_eq!(stopped.unwrap().status.code, "HUE_STREAM_STOPPED");
        assert_eq!(
            puts_while_streaming, puts_when_the_start_began,
            "the stop's restore wrote under the new session"
        );
        let want = parse_light_state(&before_stream()).unwrap();
        for state in held {
            let state = state.expect("the new session holds a snapshot");
            assert!(reads_as(&want, &state), "snapshotted {state:?}");
        }
    }

    /// Another app took the area after ours ended (here: while the runtime
    /// sat `Failed`). Its lights belong to that stream, so nothing is written.
    #[tokio::test]
    async fn a_restore_leaves_an_area_another_app_streams_to() {
        let hue = measured_bridge();
        let app = app();
        let runtime = runtime_of(&app);
        start(&runtime, &request(&hue, AREA), BringUpKind::Start).await;
        {
            let mut owner = acquire_hue_runtime(&runtime);
            owner.set_active_stream(None);
            owner.persistent_sender = None;
            owner.state = HueRuntimeState::Failed;
        }
        hue.another_app_streams(AREA, &["left", "right"]);

        let stopped = stop_hue_stream(None, app.state()).await.unwrap();

        assert_eq!(stopped.status.code, "HUE_STREAM_STOPPED");
        assert!(hue.light_puts().is_empty(), "{:?}", hue.light_puts());
        assert!(acquire_hue_runtime(&runtime).light_restore.is_none());
    }

    fn restore_of(bridge: &TestBridge, lights: &[&str]) -> HueLightRestore {
        HueLightRestore {
            bridge_ip: bridge.authority.clone(),
            username: "app-key".to_string(),
            area_id: AREA.to_string(),
            lights: lights
                .iter()
                .map(|light| HueLightSnapshot {
                    light_id: light.to_string(),
                    state: parse_light_state(&before_stream()).unwrap(),
                })
                .collect(),
        }
    }

    /// A bridge whose area read answers `first` once and `then` after that.
    fn area_answering(first: Reply, then: fn() -> Reply) -> TestBridge {
        let first = Mutex::new(Some(first));
        TestBridge::start(move |method, path, _| {
            if method == "GET" && path.contains("entertainment_configuration") {
                return first.lock().unwrap().take().unwrap_or_else(then);
            }
            Reply::ok()
        })
    }

    fn streamed_by_another_app() -> Reply {
        Reply::json(
            200,
            json!({ "errors": [], "data": [{
                "id": AREA,
                "status": "active",
                "active_streamer": { "rid": "another-app", "rtype": "auth_v1" }
            }] }),
        )
    }

    fn unreadable() -> Reply {
        Reply::text(200, "<html>not the bridge's JSON</html>".to_string())
    }

    /// The flake behind #486's "another app" test: a read of the area that
    /// could not be understood — a garbled body, or a first read cut off by
    /// the window on a loaded machine — was taken for "free", and the restore
    /// wrote under the other app's stream. Only a read that says free may.
    #[tokio::test]
    async fn a_restore_never_takes_an_unreadable_area_read_for_free() {
        let bridge = area_answering(unreadable(), streamed_by_another_app);
        let restore = restore_of(&bridge, &["left", "right"]);

        let report = tokio::task::spawn_blocking(move || {
            restore_lights(&restore, Instant::now() + HUE_LIGHT_RESTORE_BUDGET, &|| {
                false
            })
        })
        .await
        .unwrap();

        assert_eq!(report.stopped, Some(HueLightRestoreStop::AreaTaken));
        assert!(bridge.puts_to("/clip/v2/resource/light/").is_empty());
    }

    #[tokio::test]
    async fn a_restore_that_never_gets_a_readable_area_answer_writes_nothing() {
        let bridge = area_answering(unreadable(), unreadable);
        let restore = restore_of(&bridge, &["left"]);

        let report = tokio::task::spawn_blocking(move || {
            restore_lights(&restore, Instant::now() + HUE_LIGHT_RESTORE_BUDGET, &|| {
                false
            })
        })
        .await
        .unwrap();

        assert_eq!(report.stopped, Some(HueLightRestoreStop::AreaUnknown));
        assert!(bridge.puts_to("/clip/v2/resource/light/").is_empty());
    }

    /// An area the bridge no longer has is streamed by nobody: its lights are
    /// still the user's to put back.
    #[tokio::test]
    async fn a_restore_writes_when_the_area_is_gone() {
        let bridge = area_answering(
            Reply::json(404, json!({ "errors": [{ "description": "not found" }] })),
            unreadable,
        );
        let restore = restore_of(&bridge, &["left"]);

        let report = tokio::task::spawn_blocking(move || {
            restore_lights(&restore, Instant::now() + HUE_LIGHT_RESTORE_BUDGET, &|| {
                false
            })
        })
        .await
        .unwrap();

        assert_eq!(report.restored, 1);
    }

    // ── a start switching off lights on ──────────────────────────────────

    /// After Off every lamp of the area is off, and the bridge is not
    /// documented to switch a lamp on for a stream. The start does, before it
    /// activates the area, for the lamps that read off only — and the session
    /// still remembers them off, so its restore puts them back off.
    #[tokio::test]
    async fn a_start_switches_on_the_off_lights_and_the_restore_puts_them_back_off() {
        let hue = FakeHue::start(
            &[(AREA, &["off-lamp", "on-lamp"])],
            &[
                ("off-lamp", light_json(false, 30.0, Some(367), (0.45, 0.41))),
                ("on-lamp", light_json(true, 60.0, Some(300), (0.44, 0.40))),
            ],
            |_| Reply::ok(),
        );
        let app = app();
        let runtime = runtime_of(&app);
        let result = start_with_evidence(
            &mut acquire_hue_runtime(&runtime),
            &strict_gate_ready(),
            HueRuntimeTriggerSource::ModeControl,
        );
        let activated_at = Arc::new(Mutex::new(None));
        let at = Arc::clone(&activated_at);
        let build = move |channels, metadata, counter| {
            *at.lock().unwrap() = Some(Instant::now());
            fake_sender(true)(channels, metadata, counter)
        };
        let started = bring_up_stream(
            &runtime,
            &request(&hue, AREA),
            result,
            BringUpKind::Start,
            build,
        )
        .await;

        assert_eq!(started.status.code, "HUE_STREAM_RUNNING_DTLS");
        assert_eq!(hue.switch_ons(), vec!["off-lamp".to_string()]);
        assert_eq!(hue.light("off-lamp")["on"]["on"], json!(true));
        let switched_at = hue
            .bridge
            .puts_to("/clip/v2/resource/light/off-lamp")
            .first()
            .map(|r| r.at)
            .unwrap();
        assert!(switched_at <= activated_at.lock().unwrap().unwrap());
        assert_eq!(held_light_on(&runtime, "off-lamp"), Some(false));

        stop_hue_stream(None, app.state()).await.unwrap();

        assert_eq!(hue.light("off-lamp")["on"]["on"], json!(false));
        assert_eq!(hue.light("on-lamp")["on"]["on"], json!(true));
    }

    #[tokio::test]
    async fn a_start_switches_nothing_on_when_every_light_is_on() {
        let hue = one_area(&[("light-1", before_stream())]);
        let app = app();
        let runtime = runtime_of(&app);

        start(&runtime, &request(&hue, AREA), BringUpKind::Start).await;

        assert!(hue.switch_ons().is_empty());
        stop_hue_stream(None, app.state()).await.unwrap();
    }

    /// Another app holding the area owns its lamps, off ones included.
    #[tokio::test]
    async fn a_start_leaves_off_lights_alone_when_another_app_holds_the_area() {
        let hue = one_area(&[("light-1", light_json(false, 30.0, Some(367), (0.45, 0.41)))]);
        hue.another_app_streams(AREA, &[]);
        let app = app();
        let runtime = runtime_of(&app);

        start(&runtime, &request(&hue, AREA), BringUpKind::Start).await;

        assert!(hue.switch_ons().is_empty());
        assert_eq!(hue.light("light-1")["on"]["on"], json!(false));
        stop_hue_stream(None, app.state()).await.unwrap();
    }

    /// Whatever a restore is doing, once a newer session has begun it writes
    /// nothing more — the watch included, though the bridge undid the lights.
    #[tokio::test]
    async fn a_restore_stops_writing_once_a_newer_session_began() {
        let hue = measured_bridge();
        let restore = HueLightRestore {
            bridge_ip: hue.bridge.authority.clone(),
            username: "app-key".to_string(),
            area_id: AREA.to_string(),
            lights: ["left", "right"]
                .into_iter()
                .map(|light| HueLightSnapshot {
                    light_id: light.to_string(),
                    state: parse_light_state(&before_stream()).unwrap(),
                })
                .collect(),
        };
        for light in ["left", "right"] {
            hue.set_light(light, bridge_post_stream());
        }
        let newer = Arc::new(AtomicBool::new(false));

        let (report, _) = tokio::join!(
            {
                let newer = Arc::clone(&newer);
                tokio::task::spawn_blocking(move || {
                    restore_lights(&restore, Instant::now() + HUE_LIGHT_RESTORE_BUDGET, &|| {
                        newer.load(Ordering::SeqCst)
                    })
                })
            },
            async {
                while hue.light_puts().len() < 2 {
                    tokio::time::sleep(Duration::from_millis(5)).await;
                }
                newer.store(true, Ordering::SeqCst);
                // The bridge's post-stream state lands under the new session.
                for light in ["left", "right"] {
                    hue.set_light(light, bridge_post_stream());
                }
            }
        );

        let report = report.unwrap();
        assert_eq!(report.stopped, Some(HueLightRestoreStop::Superseded));
        assert_eq!(report.reapplied, 0);
        assert_eq!(hue.light_puts().len(), 2);
    }

    // ── a user's Off: the lights switched off, not restored ───────────────

    async fn user_off(app: &tauri::App<tauri::test::MockRuntime>) -> HueRuntimeCommandResult {
        stop_hue_stream_on(
            app.state::<HueRuntimeStateStore>().inner(),
            HueRuntimeTriggerSource::ModeControl,
            HueLightsAfterStop::TurnOff,
        )
        .await
    }

    fn reads_off(hue: &FakeHue, light: &str) -> bool {
        hue.light(light)["on"]["on"] == json!(false)
    }

    /// The measured bridge switches both lamps back on a few hundred ms after
    /// the stop. Off has to outlast that the way the restore does, and every
    /// write it makes is a switch-off.
    #[tokio::test]
    async fn off_switches_every_light_off_and_outlasts_the_bridges_post_stream_state() {
        let hue = measured_bridge();
        let app = app();
        let runtime = runtime_of(&app);
        start(&runtime, &request(&hue, AREA), BringUpKind::Start).await;

        let stopped = user_off(&app).await;
        once_the_bridge_is_done().await;

        assert_eq!(stopped.status.code, "HUE_STREAM_STOPPED");
        for light in ["left", "right"] {
            assert!(
                reads_off(&hue, light),
                "{light} was left as the bridge put it: {}",
                hue.light(light)
            );
        }
        let puts = hue.light_puts();
        // Once per light, and once more after the bridge switched it back on.
        assert_eq!(puts.len(), 4, "{puts:?}");
        assert!(
            puts.iter().all(|(_, body)| *body == switch_off()),
            "{puts:?}"
        );
        assert_eq!(watch_reads_after_the_last_write(&hue), 1);
        assert!(acquire_hue_runtime(&runtime).light_restore.is_none());
    }

    /// Off from a lamp that was already off before the stream: the snapshot
    /// said "off", and so does Off.
    #[tokio::test]
    async fn off_and_restore_agree_on_a_light_that_was_off() {
        let hue = one_area(&[("light-1", light_json(false, 30.0, Some(367), (0.45, 0.41)))]);
        let app = app();
        let runtime = runtime_of(&app);
        start(&runtime, &request(&hue, AREA), BringUpKind::Start).await;

        user_off(&app).await;

        assert_eq!(
            hue.light_puts(),
            vec![("light-1".to_string(), switch_off())]
        );
    }

    /// Off with no session to end has no lights to write: the stop a user's
    /// Off always sends a configured bridge must not reach it.
    #[tokio::test]
    async fn off_with_nothing_streaming_writes_nothing() {
        let hue = one_area(&[("light-1", before_stream())]);
        let app = app();
        let runtime = runtime_of(&app);
        start(&runtime, &request(&hue, AREA), BringUpKind::Start).await;
        stop_hue_stream(None, app.state()).await.unwrap();
        let requests = hue.bridge.requests().len();

        let stopped = user_off(&app).await;

        assert_eq!(stopped.status.code, "HUE_STREAM_STOPPED");
        assert_eq!(hue.bridge.requests().len(), requests);
    }

    /// Another app holding the area owns its lights, Off or not.
    #[tokio::test]
    async fn off_leaves_an_area_another_app_streams_to() {
        let hue = measured_bridge();
        let app = app();
        let runtime = runtime_of(&app);
        start(&runtime, &request(&hue, AREA), BringUpKind::Start).await;
        {
            let mut owner = acquire_hue_runtime(&runtime);
            owner.set_active_stream(None);
            owner.persistent_sender = None;
            owner.state = HueRuntimeState::Failed;
        }
        hue.another_app_streams(AREA, &["left", "right"]);

        user_off(&app).await;

        assert!(hue.light_puts().is_empty(), "{:?}", hue.light_puts());
    }

    /// Ambilight straight after Off: the start waits out Off's watch, so no
    /// switch-off lands under the new stream, and the new session reads the
    /// lamps as Off left them.
    #[tokio::test]
    async fn a_start_right_after_off_is_never_switched_off_under() {
        let hue = measured_bridge();
        let app = app();
        let runtime = runtime_of(&app);
        start(&runtime, &request(&hue, AREA), BringUpKind::Start).await;

        let store = app.state::<HueRuntimeStateStore>();
        let (_, puts_when_the_start_began) = tokio::join!(user_off(&app), async {
            once_the_restore_has_begun(&hue).await;
            store.wait_for_stop_to_settle().await;
            let puts = hue.light_puts().len();
            start(&runtime, &request(&hue, AREA), BringUpKind::Start).await;
            puts
        });
        once_the_bridge_is_done().await;
        let puts_while_streaming = hue.light_puts().len();
        let held: Vec<Option<bool>> = ["left", "right"]
            .into_iter()
            .map(|light| held_light_on(&runtime, light))
            .collect();
        stop_hue_stream(None, app.state()).await.unwrap();

        assert_eq!(
            puts_while_streaming, puts_when_the_start_began,
            "Off wrote under the new session"
        );
        assert_eq!(held, vec![Some(false), Some(false)]);
    }

    /// Quitting is not choosing Off, whatever the setting says: the quit path
    /// puts the lights back.
    #[tokio::test]
    async fn quitting_while_streaming_still_restores() {
        let hue = measured_bridge();
        let app = app();
        let runtime = runtime_of(&app);
        start(&runtime, &request(&hue, AREA), BringUpKind::Start).await;

        let deadline = Instant::now() + Duration::from_millis(3_200);
        tokio::task::spawn_blocking(move || {
            stop_hue_stream_before_exit(&app.state::<HueRuntimeStateStore>(), deadline)
        })
        .await
        .unwrap();
        once_the_bridge_is_done().await;

        for light in ["left", "right"] {
            assert!(reads_as_before_stream(&hue, light), "{}", hue.light(light));
        }
    }

    #[tokio::test]
    async fn area_channels_refuse_an_address_off_the_local_network() {
        let app = app();
        // Only addresses that fail without leaving the machine, should the
        // guard ever be dropped.
        for address in ["127.0.0.1", "0.0.0.0", "999.1.1.1"] {
            let response =
                get_hue_area_channels(address.into(), String::new(), AREA.into(), app.state())
                    .await
                    .unwrap();
            assert_eq!(
                response.status.code, "HUE_AREA_CHANNELS_FAILED",
                "{address}"
            );
            assert!(response.channels.is_empty());
        }
    }
}
