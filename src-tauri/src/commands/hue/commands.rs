//! Tauri command surface for the Hue entertainment runtime.
//!
//! Carved out of the original `hue_stream_lifecycle.rs`. This module owns
//! the seven `#[tauri::command]` entry points (`start_hue_stream`, `stop_hue_stream`, `restart_hue_stream`,
//! `set_hue_solid_color`, `get_hue_stream_status`, `get_hue_area_channels`,
//! `simulate_hue_fault`).
//! All call sites use the data plane and runtime state machine that now
//! live in sibling submodules `frame`, `dtls`, `sender`, `state_store`,
//! `retry`, and `reconnect`.
//!
//! `lib.rs` registers these commands from `commands::hue::commands` directly.

use std::collections::HashMap;
use std::sync::atomic::AtomicU32;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use log::{error, warn};
// Reachable only from the `#[cfg(debug_assertions)]` arm of `simulate_hue_fault`,
// so an ungated import is an unused-import error under `clippy --release`.
#[cfg(debug_assertions)]
use log::info;
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
    adopt_light_snapshot, restore_lights, take_light_restore_for_abandoned_start,
    take_light_restore_for_other_area, HueLightRestore, HUE_LIGHT_RESTORE_BUDGET,
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
    mut request: StartHueStreamRequest,
    runtime_state: State<'_, HueRuntimeStateStore>,
) -> Result<HueRuntimeCommandResult, String> {
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

    let gate = start_gate_evidence(&request, &readiness);

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

    let build = production_sender(&request);
    Ok(bring_up_stream(
        &runtime_state.runtime_arc(),
        &request,
        result,
        BringUpKind::Start,
        build,
    )
    .await)
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
            restore_lights_off_thread(other, Instant::now() + HUE_LIGHT_RESTORE_BUDGET).await;
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
            settle_abandoned_start(spawned, restore).await;
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
async fn settle_abandoned_start(spawned: SpawnedHueSender, restore: HueLightRestore) {
    let SpawnedHueSender {
        color_sender,
        shutdown_signal,
        ..
    } = spawned;
    drop(color_sender);
    let _ = tokio::task::spawn_blocking(move || {
        wait_for_shutdown(&shutdown_signal, Duration::from_secs(HUE_STOP_TIMEOUT_SECS));
        restore_lights(&restore, Instant::now() + HUE_LIGHT_RESTORE_BUDGET);
    })
    .await;
}

async fn restore_lights_off_thread(restore: HueLightRestore, deadline: Instant) {
    let _ = tokio::task::spawn_blocking(move || restore_lights(&restore, deadline)).await;
}

/// Stop the Hue entertainment stream with a bounded wait for the background
/// sender thread to exit, then put the area's lights back the way they were
/// before the session first streamed. If the thread does not shut down within
/// `HUE_STOP_TIMEOUT_SECS`, the command reports `HUE_STOP_TIMEOUT_PARTIAL`
/// with an action hint to retry.
///
/// Every caller of this command ends Hue output (Off, Hue deselected, a mode
/// without Hue, a refused start, a test lease giving back what it opened), so
/// it always restores. Transient stops — reconnect, restart of the same area —
/// never come through here. See docs/architecture/hue.md.
///
/// `async` so the blocking work runs on the blocking pool: a sync command runs
/// on the main thread, and the deactivate, sender wait and restore would
/// freeze the window.
#[tauri::command]
pub async fn stop_hue_stream(
    trigger_source: Option<HueRuntimeTriggerSource>,
    runtime_state: State<'_, HueRuntimeStateStore>,
) -> Result<HueRuntimeCommandResult, String> {
    let trigger = trigger_source.unwrap_or(HueRuntimeTriggerSource::System);
    let runtime = runtime_state.runtime_arc();
    let in_flight = Arc::clone(&runtime_state.stop_in_flight).lock_owned().await;
    let stopped = tokio::task::spawn_blocking(move || {
        let _in_flight = in_flight;
        stop_hue_runtime(&runtime, trigger, None)
    })
    .await;
    Ok(stopped.unwrap_or_else(|_join_err| {
        error!("stop_hue_stream task panicked; reporting the runtime as it stands.");
        make_result(&acquire_hue_runtime(&runtime_state.runtime))
    }))
}

/// The quit path's stop (`lib.rs` `[shutdown]` step 2). Same stop and restore
/// as the command, but the deactivate PUT, the sender wait and the restore all
/// end by `deadline`, so a slow bridge cannot run into the shutdown watchdog.
pub fn stop_hue_stream_before_exit(
    runtime_state: &HueRuntimeStateStore,
    deadline: Instant,
) -> HueRuntimeCommandResult {
    stop_hue_runtime(
        &runtime_state.runtime,
        HueRuntimeTriggerSource::System,
        Some(deadline),
    )
}

/// Blocking body of every stop. `deadline` bounds the whole call when given;
/// without one each step keeps its own ceiling.
pub(crate) fn stop_hue_runtime(
    runtime: &Arc<Mutex<HueRuntimeOwner>>,
    trigger: HueRuntimeTriggerSource,
    deadline: Option<Instant>,
) -> HueRuntimeCommandResult {
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
    if let Some((ip, username, area_id, token)) = dtls_deactivate {
        let request_timeout =
            remaining(Duration::from_millis(HUE_HTTP_TIMEOUT_MS)).max(Duration::from_millis(100));
        if let Ok(client) =
            blocking_client_with_timeout(&trust_for_app_key(&username), request_timeout)
        {
            let _ = deactivate_with_token(&token, &client, &ip, &username, &area_id);
        }
    }

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

    // 4. Put the lights back. Logged, never fatal: a refusal or an unreachable
    //    bridge leaves them as the bridge restored them (colour back, on).
    if let Some(restore) = light_restore {
        let restore_deadline =
            deadline.unwrap_or_else(|| Instant::now() + HUE_LIGHT_RESTORE_BUDGET);
        restore_lights(&restore, restore_deadline);
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
        return Ok(make_result(&owner));
    }

    // Fallback: active_stream was None at step 1, but step 4c of start_hue_stream
    // may have stored the context by now. Re-acquire the lock and attempt a flush.
    let mut owner = acquire_hue_runtime(&runtime_state.runtime);
    flush_pending_solid_color(&mut owner);
    Ok(make_result(&owner))
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

    use serde_json::{json, Value};
    use tauri::Manager;

    use super::super::frame::HueColorSender;
    use super::super::retry::start_with_evidence;
    use super::super::sender::{new_shutdown_signal, signal_shutdown_complete, DeactivateToken};
    use super::super::state_store::test_helpers::strict_gate_ready;
    use super::super::test_bridge::{light_json, FakeHue, Reply};
    use super::*;

    const AREA: &str = "area-1";
    const STOP_PUT: &str = "/clip/v2/resource/entertainment_configuration/";
    const LIGHT_PUT: &str = "/clip/v2/resource/light/";

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
        let light_put = hue.bridge.puts_to(LIGHT_PUT);
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
        let puts = hue.bridge.puts_to(LIGHT_PUT);
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
        let deadline = started + Duration::from_millis(800);
        let result = tokio::task::spawn_blocking(move || {
            stop_hue_stream_before_exit(&app.state::<HueRuntimeStateStore>(), deadline)
        })
        .await
        .unwrap();

        assert_eq!(result.status.code, "HUE_STREAM_STOPPED");
        // Ignoring the deadline costs a full 1.5 s request timeout on top.
        assert!(
            started.elapsed() < Duration::from_millis(1_300),
            "{:?}",
            started.elapsed()
        );
        assert_eq!(
            hue.light_puts().len(),
            1,
            "an unanswered request means the bridge is gone; the rest are not tried"
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
        FakeHue::start_applying_puts(&[(AREA, &ids)], &lights, |_| {
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
