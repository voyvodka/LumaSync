//! Tauri command surface for the Hue entertainment runtime.
//!
//! Carved out of the original `hue_stream_lifecycle.rs` during the v1.5 G8
//! split. This module owns the seven `#[tauri::command]` entry points
//! (`start_hue_stream`, `stop_hue_stream`, `restart_hue_stream`,
//! `set_hue_solid_color`, `get_hue_stream_status`, `get_hue_area_channels`,
//! `simulate_hue_fault`) and the `to_legacy_status` legacy compat helper.
//! All call sites use the data plane and runtime state machine that now
//! live in sibling submodules `frame`, `dtls`, `sender`, `state_store`,
//! `retry`, and `reconnect`.
//!
//! `lib.rs` registers these commands through the
//! `super::hue_stream_lifecycle::*` re-export shim — that path remains
//! stable so the Tauri `invoke_handler!` registration list is unchanged.


use std::sync::Arc;
use std::time::Duration;

use log::{error, info};
use tauri::State;

use super::reconnect::{
    spawn_reconnect_monitor, store_active_stream_context, StartAbortGuard,
};
use super::retry::{
    register_transient_fault, start_with_evidence, status_refresh_with_evidence, stop_with_timeout,
};
use super::sender::{
    build_hue_sender, deactivate_entertainment_config, fetch_area_channels,
    fetch_light_metadata_for_channels, hue_http_client, is_shutdown_signaled, new_shutdown_signal,
    signal_shutdown_complete, wait_for_shutdown, apply_channel_region_overrides, no_op_sender,
};
use super::frame::HueAreaChannelInfo;
use super::state_store::{
    acquire_hue_runtime, channels_to_info_via_owner, flush_pending_solid_color, make_result,
    status_with, HueRuntimeActionHint, HueRuntimeCommandResult, HueRuntimeGateEvidence,
    HueRuntimeState, HueRuntimeStateStore, HueRuntimeTriggerSource, HueRuntimeStatus,
    HueSolidColorSnapshot, SetHueSolidColorRequest, StartHueStreamRequest,
};
use super::super::hue_onboarding::{check_hue_stream_readiness, CommandStatus};

// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// Tauri-command-only constants
// ---------------------------------------------------------------------------

/// Maximum time (in seconds) to wait for the sender thread to shut down
/// before reporting a partial-stop timeout.
const HUE_STOP_TIMEOUT_SECS: u64 = 3;

// ---------------------------------------------------------------------------
// Tauri command: list channel metadata for the selected entertainment area
// ---------------------------------------------------------------------------

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
    if let Some(info) = channels_to_info_via_owner(&runtime_state, &area_id) {
        return Ok(info);
    }
    // Slow path: fetch directly from bridge (no lock held).
    let channels = fetch_area_channels(&bridge_ip, &username, &area_id).await?;
    Ok(super::frame::channels_to_info(&channels))
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
        if matches!(
            owner.state,
            HueRuntimeState::Idle | HueRuntimeState::Stopping | HueRuntimeState::Failed
        ) {
            abort_guard.disarm();
            return Ok(make_result(&owner));
        }
    } // lock released before blocking I/O

    // 4a-bis. Pre-fetch per-light archetype + gamut metadata (W1-C3a).
    //         Graceful: failures fall back to `HueGamutType::Other` (no clip).
    let light_metadata = if result.active {
        Arc::new(
            fetch_light_metadata_for_channels(&request.bridge_ip, &request.username, &channels)
                .await,
        )
    } else {
        Arc::new(std::collections::HashMap::new())
    };

    // 4b. Spawn sender on a blocking thread — DTLS handshake / HTTP activate
    //     create/drop a reqwest::blocking::Client which panics on Tokio workers.
    let (color_sender, uses_dtls, shutdown_signal) = if result.active {
        let req = request.clone();
        let ch = channels.clone();
        let meta_for_sender = Arc::clone(&light_metadata);
        tokio::task::spawn_blocking(move || build_hue_sender(&req, ch, meta_for_sender))
            .await
            .unwrap_or_else(|_join_err| {
                error!("build_hue_sender task panicked, using no-op sender.");
                (no_op_sender(), false, new_shutdown_signal())
            })
    } else {
        (no_op_sender(), false, new_shutdown_signal())
    };

    // 4c. Re-acquire lock to store the spawned sender context.
    let final_result = {
        let mut owner = acquire_hue_runtime(&runtime_state.runtime);

        // Second race-condition guard: a stop may have arrived while we were
        // spawning the sender.
        if matches!(
            owner.state,
            HueRuntimeState::Idle | HueRuntimeState::Stopping | HueRuntimeState::Failed
        ) {
            abort_guard.disarm();
            return Ok(make_result(&owner));
        }

        store_active_stream_context(
            &mut owner,
            &request,
            channels,
            color_sender,
            uses_dtls,
            shutdown_signal,
            Arc::clone(&light_metadata),
        );
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
        let dtls_deactivate = owner
            .active_stream
            .as_ref()
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
        let shutdown_ok =
            wait_for_shutdown(&shutdown_signal, Duration::from_secs(HUE_STOP_TIMEOUT_SECS));

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
        let dtls_deactivate = owner
            .active_stream
            .as_ref()
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
        })
        .await;
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
        if matches!(
            owner.state,
            HueRuntimeState::Idle | HueRuntimeState::Stopping | HueRuntimeState::Failed
        ) {
            abort_guard.disarm();
            return Ok(make_result(&owner));
        }
    } // lock released before blocking I/O

    // 5a-bis. Pre-fetch per-light archetype + gamut metadata (W1-C3a).
    let light_metadata = if result.active {
        Arc::new(
            fetch_light_metadata_for_channels(&request.bridge_ip, &request.username, &channels)
                .await,
        )
    } else {
        Arc::new(std::collections::HashMap::new())
    };

    // 5b. Spawn sender on a blocking thread — same rationale as start_hue_stream 4b.
    let (color_sender, uses_dtls, shutdown_signal) = if result.active {
        let req = request.clone();
        let ch = channels.clone();
        let meta_for_sender = Arc::clone(&light_metadata);
        tokio::task::spawn_blocking(move || build_hue_sender(&req, ch, meta_for_sender))
            .await
            .unwrap_or_else(|_join_err| {
                error!("build_hue_sender task panicked, using no-op sender.");
                (no_op_sender(), false, new_shutdown_signal())
            })
    } else {
        (no_op_sender(), false, new_shutdown_signal())
    };

    // 5c. Re-acquire lock to store the spawned sender context.
    let final_result = {
        let mut owner = acquire_hue_runtime(&runtime_state.runtime);

        if matches!(
            owner.state,
            HueRuntimeState::Idle | HueRuntimeState::Stopping | HueRuntimeState::Failed
        ) {
            abort_guard.disarm();
            return Ok(make_result(&owner));
        }

        store_active_stream_context(
            &mut owner,
            &request,
            channels,
            color_sender,
            uses_dtls,
            shutdown_signal,
            Arc::clone(&light_metadata),
        );
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
    if matches!(
        owner.state,
        HueRuntimeState::Starting | HueRuntimeState::Running | HueRuntimeState::Reconnecting
    ) {
        // Stream is starting but context not ready yet — record the color for later flush
        owner.last_solid_color = Some(HueSolidColorSnapshot {
            r: request.r,
            g: request.g,
            b: request.b,
            brightness,
        });
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
                HueRuntimeState::Starting
                    | HueRuntimeState::Running
                    | HueRuntimeState::Reconnecting
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


// ---------------------------------------------------------------------------
// Hue zone authoring commands (v1.5 W1-A3 — logical-grouping zones)
// ---------------------------------------------------------------------------
//
// Pure-data commands: they validate the supplied draft against the
// caller-supplied current state (`existing_zones` / `channels`) and
// return the mutated arrays plus a `CommandStatus` carrying a stable
// `HUE_ZONE_*` code from `src/shared/contracts/hue.ts`. Persistence is
// the frontend's responsibility — it round-trips the result back through
// `save_room_map`.

#[tauri::command]
pub fn create_hue_zone(
    request: super::zone::CreateZoneRequest,
) -> super::zone::ZoneCommandResult {
    super::zone::create_zone(request)
}

#[tauri::command]
pub fn update_hue_zone(
    request: super::zone::UpdateZoneRequest,
) -> super::zone::ZoneCommandResult {
    super::zone::update_zone(request)
}

#[tauri::command]
pub fn delete_hue_zone(
    request: super::zone::DeleteZoneRequest,
) -> super::zone::ZoneCommandResult {
    super::zone::delete_zone(request)
}

#[tauri::command]
pub fn assign_channel_to_zone(
    request: super::zone::AssignChannelRequest,
) -> super::zone::ZoneCommandResult {
    super::zone::assign_channel_to_zone(request)
}
