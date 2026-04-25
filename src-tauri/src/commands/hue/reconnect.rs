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
//! All behaviour (200 ms shutdown poll, ~1 s post-deactivation grace,
//! retry-budget exhaustion → `Failed`, user-override veto) is preserved
//! exactly.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use log::info;

use super::frame::HueAreaChannel;
use super::sender::{
    apply_channel_region_overrides, build_hue_sender_with_counter, deactivate_entertainment_config,
    fetch_area_channels, fetch_light_metadata_for_channels, hue_http_client, is_shutdown_signaled,
    new_shutdown_signal, no_op_sender, HueLightMetadata, ShutdownSignal,
};
use super::frame::HueColorSender;
use super::state_store::{
    acquire_hue_runtime, make_result, status_with, HueActiveStreamContext,
    HuePersistentSender, HueRuntimeActionHint, HueRuntimeOwner, HueRuntimeState,
    HueRuntimeTriggerSource, StartHueStreamRequest,
};
use super::super::hue_onboarding::check_hue_stream_readiness;
use super::retry::register_transient_fault;

// ---------------------------------------------------------------------------
// Active-stream-context store
// ---------------------------------------------------------------------------

/// Store an already-spawned sender into the runtime owner.  This function only
/// touches in-memory fields — no I/O — so it is safe to call under the lock.
pub(crate) fn store_active_stream_context(
    owner: &mut HueRuntimeOwner,
    request: &StartHueStreamRequest,
    channels: Vec<HueAreaChannel>,
    color_sender: HueColorSender,
    uses_dtls: bool,
    shutdown_signal: ShutdownSignal,
    light_metadata: Arc<HashMap<String, HueLightMetadata>>,
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
    );
}

#[allow(clippy::too_many_arguments)] // adding light_metadata to the active-stream-context store crosses the 7-arg threshold; collapsing into a struct here would split the mutation boundary (HueRuntimeOwner) from the fresh-spawn payload and obscure which fields each caller controls
pub(crate) fn store_active_stream_context_with_cipher(
    owner: &mut HueRuntimeOwner,
    request: &StartHueStreamRequest,
    channels: Vec<HueAreaChannel>,
    color_sender: HueColorSender,
    uses_dtls: bool,
    shutdown_signal: ShutdownSignal,
    cipher_name: Option<String>,
    light_metadata: Arc<HashMap<String, HueLightMetadata>>,
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
        light_metadata,
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
                || matches!(
                    owner.state,
                    HueRuntimeState::Idle | HueRuntimeState::Stopping
                )
            {
                return;
            }
            // If already Failed or Reconnecting from another path, don't double-trigger.
            if matches!(
                owner.state,
                HueRuntimeState::Failed | HueRuntimeState::Reconnecting
            ) {
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
        info!(
            "Reconnect monitor: waiting {}ms before reconnect attempt.",
            backoff_ms
        );
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
    use super::frame::HueColorUpdate;

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
    let (color_sender, uses_dtls, shutdown_signal, cipher_name) =
        tokio::task::spawn_blocking(move || {
            build_hue_sender_with_counter(&req, ch, meta_for_sender, packet_counter)
        })
        .await
        .unwrap_or_else(|_| (no_op_sender(), false, new_shutdown_signal(), None));

    // Suppress unused-import warning; HueColorUpdate is referenced indirectly
    // through HueColorSender's mpsc::SyncSender<HueColorUpdate> generic.
    let _ = std::marker::PhantomData::<HueColorUpdate>;

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
            light_metadata: Arc::clone(&light_metadata),
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
    }

    // Spawn new monitor for the new connection.
    spawn_reconnect_monitor(shutdown_signal, Arc::clone(runtime), request.clone());

    Ok(true)
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
}
