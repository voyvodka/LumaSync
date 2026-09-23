//! Hue runtime state store, DTOs, and the in-memory ownership model.
//!
//! Carved out of the original `hue_stream_lifecycle.rs`. This module owns:
//!
//! - The wire-visible request/response/status DTOs (`StartHueStreamRequest`,
//!   `SetHueSolidColorRequest`, `HueRuntimeStatus`,
//!   `HueRuntimeCommandResult`, `HueSolidColorSnapshot`, etc.) — every
//!   `serde(rename_all = "camelCase")` shape is preserved exactly.
//! - The runtime state machine enums (`HueRuntimeState`,
//!   `HueRuntimeTriggerSource`, `HueRuntimeActionHint`).
//! - `HueRuntimeOwner` (the locked-behind-`Mutex` runtime body),
//!   `HueRuntimeStateStore` (the Tauri-managed handle), and the
//!   `acquire_hue_runtime` helper that recovers from poison guards.
//! - `HueActiveStreamContext` (live DTLS/HTTP session params) and
//!   `HueActiveOutputContext` (the lock-free snapshot used by the
//!   ambilight worker).
//! - `flush_pending_solid_color`, `status_with`, `make_result` —
//!   small in-memory helpers that mutate the owner.
//!
//! Field visibilities on `HueRuntimeOwner` and `HueActiveStreamContext`
//! are kept at `pub(crate)` so `runtime_telemetry.rs` can read uptime,
//! packet counters, cipher, error codes, and reconnect tallies without a
//! getter API surface — same crate-wide access as before the split.

use std::sync::{Arc, Mutex};
use std::time::Instant;

use log::error;
use serde::{Deserialize, Serialize};

use super::credential_store::REDACTED;
use super::frame::{HueAreaChannel, HueColorSender};
use super::light_restore::HueLightRestore;
use super::sender::{is_shutdown_signaled, DeactivateToken, ShutdownSignal};

// ---------------------------------------------------------------------------
// Retry policy tunables (consumed by retry.rs)
// ---------------------------------------------------------------------------

pub(crate) const DEFAULT_RETRY_MAX_ATTEMPTS: u8 = 3;
pub(crate) const DEFAULT_RETRY_BASE_MS: u64 = 400;
pub(crate) const DEFAULT_RETRY_CAP_MS: u64 = 2_000;

// ---------------------------------------------------------------------------
// State machine enums
// ---------------------------------------------------------------------------

/// State machine driving the Hue entertainment stream lifecycle, from idle
/// through starting/running to a terminal `Failed`.
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

// ---------------------------------------------------------------------------
// Wire-visible DTOs
// ---------------------------------------------------------------------------

/// Coded status describing the current (or most recent) Hue runtime state,
/// returned by every stream-lifecycle command.
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

/// Parameters needed to start (or restart) the Hue entertainment stream for
/// a given bridge and area.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartHueStreamRequest {
    pub bridge_ip: String,
    pub username: String,
    pub client_key: String,
    pub area_id: String,
    pub trigger_source: Option<HueRuntimeTriggerSource>,
    /// The user's own placements for this area. Sparse and addressed by the
    /// bridge's `channel_id` — a positional array would reintroduce the ordinal
    /// this replaced. Absent ⇒ every channel keeps the bridge's position.
    pub channel_placements: Option<Vec<HueChannelPlacementOverride>>,
}

impl std::fmt::Debug for StartHueStreamRequest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("StartHueStreamRequest")
            .field("bridge_ip", &self.bridge_ip)
            .field("username", &REDACTED)
            .field("client_key", &REDACTED)
            .field("area_id", &self.area_id)
            .field("trigger_source", &self.trigger_source)
            .field("channel_placements", &self.channel_placements)
            .finish()
    }
}

/// One channel's locally authored position. The screen region is never carried:
/// it is re-derived from the position so there is one writable source.
#[derive(Clone, Serialize, Deserialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HueChannelPlacementOverride {
    pub channel_id: u8,
    pub position_x: f32,
    pub position_y: f32,
    /// Absent on snapshots and requests written before height was carried, and
    /// whenever the local height is not known to be real — the bridge's own
    /// `z` is kept then.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub position_z: Option<f32>,
}

/// Requested solid color + optional brightness to push to every light in
/// the active area.
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

/// Evidence collected before a stream-lifecycle transition is allowed to
/// proceed, gating the runtime against half-configured state.
#[derive(Clone, Debug)]
pub struct HueRuntimeGateEvidence {
    pub bridge_configured: bool,
    pub credentials_valid: bool,
    pub area_selected: bool,
    pub readiness_current: bool,
    pub ready: bool,
    pub auth_invalid_evidence: bool,
    /// Why readiness said no, as wire tokens: the readiness `status.code` and,
    /// when a foreign session holds the area, `HUE_STREAM_NOT_READY_ACTIVE_STREAMER`.
    /// Appended to a gate-blocked status's `details` so the frontend can tell
    /// a busy area from an unreachable bridge without a new code.
    pub readiness_blockers: Vec<String>,
}

// ---------------------------------------------------------------------------
// Retry policy struct (definition + Default impl) — consumed by retry.rs
// ---------------------------------------------------------------------------

#[derive(Clone, Debug)]
pub(crate) struct HueRetryPolicy {
    pub(crate) max_attempts: u8,
    pub(crate) base_backoff_ms: u64,
    pub(crate) cap_backoff_ms: u64,
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

// ---------------------------------------------------------------------------
// Runtime ownership types
// ---------------------------------------------------------------------------

/// Persists even when the stream is Idle so that solid-color commands keep
/// working without requiring an active streaming session.
pub(crate) struct HuePersistentSender {
    /// Which area `channels` belongs to. Without it the cache could answer a
    /// question about another area with these channels — see
    /// `channels_to_info_via_owner`.
    pub(crate) area_id: String,
    pub(crate) channels: Vec<HueAreaChannel>,
    /// Shares the same `Arc<SyncSender>` with `HueActiveStreamContext` while
    /// the stream is running. When the stream stops, this is the sole owner
    /// keeping the background thread alive.
    pub(crate) sender: HueColorSender,
}

pub(crate) struct HueRuntimeOwner {
    pub(crate) state: HueRuntimeState,
    pub(crate) active_stream: Option<HueActiveStreamContext>,
    /// Retained across stream stop/start cycles so that solid-color updates
    /// succeed even when the runtime is temporarily Idle.
    pub(crate) persistent_sender: Option<HuePersistentSender>,
    pub(crate) reconnect_attempt: u8,
    pub(crate) user_override_pending: bool,
    /// True while the reconnect monitor is actively driving a restart
    /// (`internal_restart_stream`). Set under the runtime lock in the same
    /// atomic check-and-set the monitor uses to claim the restart, and
    /// cleared once that restart resolves (success or give-up).
    ///
    /// This is the monitor's *only* double-trigger guard. It must NOT be
    /// conflated with `state == Reconnecting`: the status poll
    /// (`get_hue_stream_status`) also marks the runtime `Reconnecting` via
    /// `register_transient_fault` to surface `TRANSIENT_RETRY_SCHEDULED` to
    /// the UI, but does so WITHOUT launching a restart. If the monitor keyed
    /// its guard off `Reconnecting`, a status poll winning the race would
    /// dead-end the monitor and strand the runtime in `Reconnecting` with
    /// `active_stream = None` forever. Keying off this flag lets the monitor
    /// still perform the restart in that case.
    pub(crate) reconnect_in_progress: bool,
    pub(crate) last_status: HueRuntimeStatus,
    /// Most recent solid color the user asked for. Persists across reconnects
    /// so the UI can restore it; set on every `set_hue_solid_color` call,
    /// whether or not the color actually reached the bridge.
    pub(crate) last_solid_color: Option<HueSolidColorSnapshot>,
    /// Set whenever a solid-color request could NOT be delivered (no stream
    /// context, no resolved lights, runtime idle/failed). Cleared the moment
    /// the color is handed to a sender. Drives `flush_pending_solid_color`.
    ///
    /// Deliberately separate from `last_solid_color`: the previous
    /// implementation gated the flush on `last_status.code`, which every
    /// subsequent status write (e.g. `HUE_STREAM_RUNNING_DTLS` on start, or
    /// `status_refresh_with_evidence` on each health poll) silently
    /// invalidated — so a queued color was never flushed on the DTLS path.
    pub(crate) pending_solid_color: Option<HueSolidColorSnapshot>,
    pub(crate) retry_policy: HueRetryPolicy,
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
    /// The area's lights as they were before this session first streamed.
    /// Survives reconnects, restarts of the same area and a `Failed` runtime;
    /// only a stop (or a start onto another area) takes it. See `light_restore`.
    pub(crate) light_restore: Option<HueLightRestore>,
}

#[derive(Clone)]
pub(crate) struct HueActiveStreamContext {
    pub(crate) bridge_ip: String,
    pub(crate) username: String,
    pub(crate) area_id: String,
    pub(crate) channels: Vec<HueAreaChannel>,
    pub(crate) color_sender: HueColorSender,
    /// Whether this context uses real DTLS streaming (true) or HTTP fallback (false).
    pub(crate) uses_dtls: bool,
    /// Fires when the background sender thread exits. Used by `stop_hue_stream`
    /// to wait for graceful shutdown before reporting success or timeout.
    pub(crate) shutdown_signal: ShutdownSignal,
    /// One-shot dedupe primitive for the entertainment-configuration
    /// deactivation PUT. Shared by the sender thread (drains it during
    /// `close_notify` cleanup), the foreground `stop_hue_stream` Tauri
    /// command, and the reconnect monitor — whoever calls
    /// `try_acquire` first wins and performs the single PUT; later
    /// callers no-op. Introduced to fix the duplicate-PUT
    /// race that produced "phantom active streamer" 403s.
    pub(crate) deactivate_token: Arc<DeactivateToken>,
}

impl std::fmt::Debug for HueActiveStreamContext {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HueActiveStreamContext")
            .field("bridge_ip", &self.bridge_ip)
            .field("username", &REDACTED)
            .field("area_id", &self.area_id)
            .field("channels", &self.channels)
            .field("color_sender", &self.color_sender)
            .field("uses_dtls", &self.uses_dtls)
            .field("shutdown_signal", &self.shutdown_signal)
            .field("deactivate_token", &self.deactivate_token)
            .finish()
    }
}

/// Lock-free snapshot of the channels + sender needed to push color, read by
/// the ambilight worker without touching the runtime mutex.
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
            reconnect_in_progress: false,
            last_status: status_with(
                HueRuntimeState::Idle,
                "HUE_STREAM_IDLE",
                "Hue runtime is idle.",
                None,
                HueRuntimeTriggerSource::System,
            ),
            last_solid_color: None,
            pending_solid_color: None,
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
            light_restore: None,
        }
    }
}

/// Tauri-managed handle wrapping the mutex-guarded `HueRuntimeOwner`.
pub struct HueRuntimeStateStore {
    pub(crate) runtime: Arc<Mutex<HueRuntimeOwner>>,
    /// Held by `stop_hue_stream` from its first lock until the light restore
    /// has finished. The runtime reads `Idle` for all of that, so without it a
    /// start could snapshot lights the restore had not reached yet and later
    /// write that half-restored state back. See docs/architecture/hue.md.
    pub(crate) stop_in_flight: Arc<tokio::sync::Mutex<()>>,
}

impl Default for HueRuntimeStateStore {
    fn default() -> Self {
        Self::with_runtime(HueRuntimeOwner::default())
    }
}

impl HueRuntimeStateStore {
    pub(crate) fn with_runtime(owner: HueRuntimeOwner) -> Self {
        Self {
            runtime: Arc::new(Mutex::new(owner)),
            stop_in_flight: Arc::new(tokio::sync::Mutex::new(())),
        }
    }

    /// Clone the shared runtime handle for use outside the Tauri `State<>`
    /// extractor (e.g. background tasks like the reconnect monitor).
    pub fn runtime_arc(&self) -> Arc<Mutex<HueRuntimeOwner>> {
        Arc::clone(&self.runtime)
    }

    /// Wait for a stop in flight, restore included, to finish. Starts call
    /// this before anything reads the bridge; it does not hold anything, so a
    /// later stop can still overtake the start it let through.
    pub(crate) async fn wait_for_stop_to_settle(&self) {
        drop(self.stop_in_flight.lock().await);
    }
}

// ---------------------------------------------------------------------------
// Lock-acquisition + status-construction helpers
// ---------------------------------------------------------------------------

/// Acquire the Hue runtime mutex, recovering from poison if a previous holder
/// panicked.  This ensures a single panic inside the lock does not permanently
/// brick the Hue subsystem for the rest of the application lifetime.
pub(crate) fn acquire_hue_runtime(
    runtime: &Mutex<HueRuntimeOwner>,
) -> std::sync::MutexGuard<'_, HueRuntimeOwner> {
    runtime.lock().unwrap_or_else(|poison| {
        error!("Hue runtime mutex was poisoned — recovering from poison guard.");
        poison.into_inner()
    })
}

pub(crate) fn status_with(
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

pub(crate) fn make_result(owner: &HueRuntimeOwner) -> HueRuntimeCommandResult {
    HueRuntimeCommandResult {
        active: matches!(
            owner.state,
            HueRuntimeState::Starting | HueRuntimeState::Running | HueRuntimeState::Reconnecting
        ),
        status: owner.last_status.clone(),
        last_solid_color: owner.last_solid_color.clone(),
    }
}

/// Record a solid-color request that could not be delivered so
/// `flush_pending_solid_color` can replay it once the stream is usable.
pub(crate) fn queue_solid_color(owner: &mut HueRuntimeOwner, color: HueSolidColorSnapshot) {
    owner.last_solid_color = Some(color.clone());
    owner.pending_solid_color = Some(color);
}

/// Record a solid-color request that WAS handed to a sender.
pub(crate) fn commit_solid_color(owner: &mut HueRuntimeOwner, color: HueSolidColorSnapshot) {
    owner.last_solid_color = Some(color);
    owner.pending_solid_color = None;
}

/// If a solid color was queued while the stream context was not ready, attempt
/// to flush it now.  Called whenever we hold the lock and the context may have
/// just become available (stream start, stream restart, reconnect, or a
/// periodic `get_hue_stream_status` poll).
///
/// Returns `true` when a queued color was handed to the sender.
pub(crate) fn flush_pending_solid_color(owner: &mut HueRuntimeOwner) -> bool {
    let Some(color) = owner.pending_solid_color.clone() else {
        return false;
    };
    let Some(stream) = owner.active_stream.as_ref() else {
        return false;
    };
    if stream.channels.is_empty() {
        return false;
    }
    stream
        .color_sender
        .try_send(color.r, color.g, color.b, color.brightness);
    owner.pending_solid_color = None;
    owner.last_solid_color = Some(color);
    // Never clobber a stream-lifecycle code: the frontend's `isHueStartCodeOk`
    // keys off it, so overwriting would make a good start read as "not started".
    if owner.last_status.code.starts_with("HUE_COLOR_") {
        owner.last_status = status_with(
            owner.state.clone(),
            "HUE_COLOR_APPLIED",
            "Queued solid color flushed after stream context became ready.",
            None,
            HueRuntimeTriggerSource::System,
        );
    }
    true
}

// ---------------------------------------------------------------------------
// Lock-free output context snapshot + apply helpers
// ---------------------------------------------------------------------------

/// Take a lock-free snapshot of the active stream's output context, if a
/// stream is currently running.
pub fn snapshot_hue_output_context(
    runtime_state: &HueRuntimeStateStore,
) -> Result<Option<HueActiveOutputContext>, String> {
    let owner = acquire_hue_runtime(&runtime_state.runtime);

    Ok(owner
        .active_stream
        .as_ref()
        .map(|stream| HueActiveOutputContext {
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
    context
        .color_sender
        .try_send_channels(channel_colors, brightness);
    Ok(())
}

/// Lock-only fast-path lookup of channel info from the runtime owner. Returns
/// `Some(info)` if the active stream or persistent sender already has channel
/// data for the requested area; the caller falls back to `fetch_area_channels`
/// only when this returns `None`. Centralised here so the Tauri command stays
/// free of `runtime.lock()` boilerplate.
/// Does a live stream of THIS process hold this bridge's area? Read by the
/// readiness poll so the bridge's `active_streamer` for our own running stream
/// is not reported as a foreign client holding the area.
///
/// Deliberately narrow: `Running` with a sender that has not exited. A session
/// left on the bridge by an earlier process (an unclean exit) holds the area
/// under the same application key, and must keep reading as busy — nobody has
/// shown the bridge accepts a fresh start over it.
pub(crate) fn streams_area(
    runtime_state: &HueRuntimeStateStore,
    bridge_ip: &str,
    area_id: &str,
) -> bool {
    let owner = acquire_hue_runtime(&runtime_state.runtime);
    owner.state == HueRuntimeState::Running
        && owner.active_stream.as_ref().is_some_and(|stream| {
            stream.bridge_ip == bridge_ip
                && stream.area_id == area_id
                && !is_shutdown_signaled(&stream.shutdown_signal)
        })
}

pub(crate) fn channels_to_info_via_owner(
    runtime_state: &HueRuntimeStateStore,
    area_id: &str,
) -> Option<Vec<super::frame::HueAreaChannelInfo>> {
    let owner = acquire_hue_runtime(&runtime_state.runtime);
    if let Some(stream) = owner.active_stream.as_ref() {
        if stream.area_id == area_id && !stream.channels.is_empty() {
            return Some(super::frame::channels_to_info(&stream.channels));
        }
    }
    // Also check persistent sender (covers app-startup solid-only mode). The
    // area check is load-bearing: the frontend persists channel overrides keyed
    // by the area id it asked for, so a wrong answer here survives restart.
    if let Some(persistent) = owner.persistent_sender.as_ref() {
        if persistent.area_id == area_id && !persistent.channels.is_empty() {
            return Some(super::frame::channels_to_info(&persistent.channels));
        }
    }
    None
}

#[cfg(test)]
pub(crate) mod test_helpers {
    //! Shared test fixtures for the `commands::hue` submodules. Each one's
    //! `#[cfg(test)] mod tests` block reaches in here so the fixtures live
    //! in one place and stay in lockstep with `HueRuntimeOwner` /
    //! `HueActiveStreamContext` field changes.

    use std::sync::Arc;

    use super::super::frame::{HueAreaChannel, HueColorSender, HueColorUpdate, HueScreenRegion};
    use super::super::sender::{new_shutdown_signal, DeactivateToken};
    use super::{HueActiveStreamContext, HueRuntimeGateEvidence};

    pub(crate) fn strict_gate_ready() -> HueRuntimeGateEvidence {
        HueRuntimeGateEvidence {
            bridge_configured: true,
            credentials_valid: true,
            area_selected: true,
            readiness_current: true,
            ready: true,
            auth_invalid_evidence: false,
            readiness_blockers: Vec::new(),
        }
    }

    pub(crate) fn strict_gate_missing_readiness() -> HueRuntimeGateEvidence {
        HueRuntimeGateEvidence {
            bridge_configured: true,
            credentials_valid: true,
            area_selected: true,
            readiness_current: false,
            ready: false,
            auth_invalid_evidence: false,
            readiness_blockers: vec!["HUE_STREAM_READINESS_FAILED".to_string()],
        }
    }

    /// Helper: build a dummy `HueActiveStreamContext` for tests that need one
    /// without spawning a real background thread.
    pub(crate) fn dummy_active_stream_context() -> HueActiveStreamContext {
        let (tx, _rx) = std::sync::mpsc::sync_channel::<HueColorUpdate>(1);
        HueActiveStreamContext {
            bridge_ip: "192.168.1.2".to_string(),
            username: "username".to_string(),
            area_id: "area".to_string(),
            channels: vec![HueAreaChannel {
                channel_id: 0,
                light_ids: vec!["light-1".to_string()],
                screen_region: HueScreenRegion::Center,
                position_x: 0.0,
                position_y: 0.0,
                position_z: None,
            }],
            color_sender: HueColorSender {
                tx: Arc::new(tx),
                channel_count: 1,
            },
            uses_dtls: false,
            shutdown_signal: new_shutdown_signal(),
            deactivate_token: DeactivateToken::new(),
        }
    }

    /// Same as `dummy_active_stream_context` but hands back the receiver so a
    /// test can assert what actually reached the sender thread.
    pub(crate) fn observable_active_stream_context() -> (
        HueActiveStreamContext,
        std::sync::mpsc::Receiver<HueColorUpdate>,
    ) {
        let (tx, rx) = std::sync::mpsc::sync_channel::<HueColorUpdate>(4);
        let mut ctx = dummy_active_stream_context();
        ctx.color_sender = HueColorSender {
            tx: Arc::new(tx),
            channel_count: 1,
        };
        (ctx, rx)
    }

    /// A persistent sender carrying one channel, tagged with `area_id`.
    pub(crate) fn dummy_persistent_sender(area_id: &str) -> super::HuePersistentSender {
        let (tx, _rx) = std::sync::mpsc::sync_channel::<HueColorUpdate>(1);
        super::HuePersistentSender {
            area_id: area_id.to_string(),
            channels: vec![HueAreaChannel {
                channel_id: 7,
                light_ids: vec!["light-persistent".to_string()],
                screen_region: HueScreenRegion::Center,
                position_x: 0.0,
                position_y: 0.0,
                position_z: None,
            }],
            sender: HueColorSender {
                tx: Arc::new(tx),
                channel_count: 1,
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::test_helpers::{
        dummy_active_stream_context, dummy_persistent_sender, observable_active_stream_context,
    };
    use super::*;

    fn snapshot(r: u8) -> HueSolidColorSnapshot {
        HueSolidColorSnapshot {
            r,
            g: 0,
            b: 0,
            brightness: 1.0,
        }
    }

    #[test]
    fn queue_records_pending_and_last_color() {
        let mut owner = HueRuntimeOwner::default();
        queue_solid_color(&mut owner, snapshot(10));

        assert_eq!(owner.pending_solid_color.as_ref().map(|c| c.r), Some(10));
        assert_eq!(owner.last_solid_color.as_ref().map(|c| c.r), Some(10));
    }

    #[test]
    fn commit_clears_pending() {
        let mut owner = HueRuntimeOwner::default();
        queue_solid_color(&mut owner, snapshot(10));
        commit_solid_color(&mut owner, snapshot(20));

        assert!(owner.pending_solid_color.is_none());
        assert_eq!(owner.last_solid_color.as_ref().map(|c| c.r), Some(20));
    }

    #[test]
    fn flush_is_a_no_op_without_a_pending_color() {
        let mut owner = HueRuntimeOwner::default();
        let (ctx, rx) = observable_active_stream_context();
        owner.active_stream = Some(ctx);

        assert!(!flush_pending_solid_color(&mut owner));
        assert!(rx.try_recv().is_err());
    }

    #[test]
    fn flush_sends_the_queued_color_once_a_stream_exists() {
        let mut owner = HueRuntimeOwner::default();
        queue_solid_color(&mut owner, snapshot(42));

        // No stream yet -- nothing to flush into, color stays pending.
        assert!(!flush_pending_solid_color(&mut owner));
        assert!(owner.pending_solid_color.is_some());

        let (ctx, rx) = observable_active_stream_context();
        owner.active_stream = Some(ctx);
        owner.state = HueRuntimeState::Running;

        assert!(flush_pending_solid_color(&mut owner));
        let update = rx.try_recv().expect("color reached the sender");
        assert_eq!(update.channel_colors[0], (42, 0, 0));
        assert!(owner.pending_solid_color.is_none());
        assert_eq!(owner.last_solid_color.as_ref().map(|c| c.r), Some(42));

        // Second flush must not re-send.
        assert!(!flush_pending_solid_color(&mut owner));
        assert!(rx.try_recv().is_err());
    }

    /// Regression: the flush used to be gated on
    /// `last_status.code == "HUE_COLOR_QUEUED_PENDING_STREAM"`, which every
    /// stream-lifecycle status write invalidated -- so a color queued during
    /// startup was never delivered on the DTLS path.
    #[test]
    fn flush_survives_an_intervening_stream_lifecycle_status_write() {
        let mut owner = HueRuntimeOwner::default();
        queue_solid_color(&mut owner, snapshot(7));
        owner.last_status = status_with(
            HueRuntimeState::Running,
            "HUE_STREAM_RUNNING_DTLS",
            "Hue entertainment stream active via DTLS.",
            None,
            HueRuntimeTriggerSource::System,
        );

        let (ctx, rx) = observable_active_stream_context();
        owner.active_stream = Some(ctx);
        owner.state = HueRuntimeState::Running;

        assert!(flush_pending_solid_color(&mut owner));
        assert_eq!(
            rx.try_recv()
                .expect("color reached the sender")
                .channel_colors[0],
            (7, 0, 0)
        );
        // The lifecycle code must survive: `isHueStartCodeOk` keys off it.
        assert_eq!(owner.last_status.code, "HUE_STREAM_RUNNING_DTLS");
    }

    #[test]
    fn flush_promotes_a_color_status_to_applied() {
        let mut owner = HueRuntimeOwner::default();
        queue_solid_color(&mut owner, snapshot(3));
        owner.last_status = status_with(
            HueRuntimeState::Idle,
            "HUE_COLOR_APPLY_SKIPPED",
            "skipped",
            None,
            HueRuntimeTriggerSource::ModeControl,
        );

        let (ctx, _rx) = observable_active_stream_context();
        owner.active_stream = Some(ctx);

        assert!(flush_pending_solid_color(&mut owner));
        assert_eq!(owner.last_status.code, "HUE_COLOR_APPLIED");
    }

    #[test]
    fn flush_skips_a_stream_with_no_channels() {
        let mut owner = HueRuntimeOwner::default();
        queue_solid_color(&mut owner, snapshot(5));
        let (mut ctx, rx) = observable_active_stream_context();
        ctx.channels.clear();
        owner.active_stream = Some(ctx);

        assert!(!flush_pending_solid_color(&mut owner));
        assert!(owner.pending_solid_color.is_some());
        assert!(rx.try_recv().is_err());
    }

    /// A stray `{:?}` in a log line must not print either key.
    #[test]
    fn key_carrying_runtime_structs_do_not_print_their_keys() {
        let request = StartHueStreamRequest {
            bridge_ip: "192.168.1.2".to_string(),
            username: "secret-app-key".to_string(),
            client_key: "secret-client-key".to_string(),
            area_id: "area".to_string(),
            trigger_source: None,
            channel_placements: None,
        };
        let mut context = dummy_active_stream_context();
        context.username = "secret-app-key".to_string();
        let restore = HueLightRestore {
            bridge_ip: "192.168.1.2".to_string(),
            username: "secret-app-key".to_string(),
            area_id: "area".to_string(),
            lights: Vec::new(),
        };
        for printed in [
            format!("{request:?}"),
            format!("{context:?}"),
            format!("{restore:?}"),
        ] {
            assert!(!printed.contains("secret-"), "{printed}");
            assert!(printed.contains("192.168.1.2"), "{printed}");
        }
    }
    // ---------------------------------------------------------------------
    // channels_to_info_via_owner — the cache answers an identity question, so
    // every arm has to prove it matched the area it was asked about.
    // ---------------------------------------------------------------------

    fn store_with(owner: HueRuntimeOwner) -> HueRuntimeStateStore {
        HueRuntimeStateStore::with_runtime(owner)
    }

    #[test]
    fn a_running_stream_owns_only_its_own_bridge_and_area() {
        let store = store_with(HueRuntimeOwner {
            state: HueRuntimeState::Running,
            active_stream: Some(dummy_active_stream_context()),
            ..Default::default()
        });

        assert!(streams_area(&store, "192.168.1.2", "area"));
        assert!(!streams_area(&store, "192.168.1.2", "another-area"));
        assert!(!streams_area(&store, "192.168.1.3", "area"));
    }

    /// Only a live stream of this process counts. A context in any other
    /// state — including mid-start and mid-reconnect — is not proof that the
    /// area's streamer is us.
    #[test]
    fn a_runtime_that_is_not_running_owns_nothing() {
        for state in [
            HueRuntimeState::Idle,
            HueRuntimeState::Starting,
            HueRuntimeState::Reconnecting,
            HueRuntimeState::Stopping,
            HueRuntimeState::Failed,
        ] {
            let store = store_with(HueRuntimeOwner {
                state: state.clone(),
                active_stream: Some(dummy_active_stream_context()),
                ..Default::default()
            });
            assert!(!streams_area(&store, "192.168.1.2", "area"), "{state:?}");
        }
    }

    /// A `Running` label over a sender that already exited is a stream this
    /// process no longer has; the bridge's streamer must read as foreign.
    #[test]
    fn a_running_label_over_an_exited_sender_owns_nothing() {
        let context = dummy_active_stream_context();
        super::super::sender::signal_shutdown_complete(&context.shutdown_signal);
        let store = store_with(HueRuntimeOwner {
            state: HueRuntimeState::Running,
            active_stream: Some(context),
            ..Default::default()
        });
        assert!(!streams_area(&store, "192.168.1.2", "area"));
    }

    /// A fresh process has no stream, so a session an earlier process left on
    /// the bridge keeps reading as busy (the boot retry relies on this).
    #[test]
    fn a_fresh_runtime_owns_nothing() {
        let store = HueRuntimeStateStore::default();
        assert!(!streams_area(&store, "192.168.1.2", "area"));
    }

    #[test]
    fn active_stream_answers_only_for_its_own_area() {
        let store = store_with(HueRuntimeOwner {
            active_stream: Some(dummy_active_stream_context()),
            ..Default::default()
        });

        assert!(channels_to_info_via_owner(&store, "area").is_some());
        assert!(channels_to_info_via_owner(&store, "another-area").is_none());
    }

    #[test]
    fn persistent_sender_answers_only_for_its_own_area() {
        let store = store_with(HueRuntimeOwner {
            persistent_sender: Some(dummy_persistent_sender("area-a")),
            ..Default::default()
        });

        assert!(channels_to_info_via_owner(&store, "area-a").is_some());
        assert!(channels_to_info_via_owner(&store, "area-b").is_none());
    }

    #[test]
    fn a_second_area_is_never_served_the_streaming_one_channels() {
        // Streaming area-a, the picker asks for area-b. The active-stream
        // arm declines, and the persistent-sender arm used to answer anyway —
        // whose channels the frontend then persists under area-b's id.
        let store = store_with(HueRuntimeOwner {
            active_stream: Some(dummy_active_stream_context()),
            persistent_sender: Some(dummy_persistent_sender("area")),
            ..Default::default()
        });

        assert!(channels_to_info_via_owner(&store, "area-b").is_none());
    }

    #[test]
    fn an_empty_channel_list_is_not_an_answer() {
        let mut persistent = dummy_persistent_sender("area-a");
        persistent.channels.clear();
        let store = store_with(HueRuntimeOwner {
            persistent_sender: Some(persistent),
            ..Default::default()
        });

        assert!(channels_to_info_via_owner(&store, "area-a").is_none());
    }
}
