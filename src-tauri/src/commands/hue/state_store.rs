//! Hue runtime state store, DTOs, and the in-memory ownership model.
//!
//! Carved out of the original `hue_stream_lifecycle.rs` during the v1.5 G8
//! split. This module owns:
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

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use log::error;
use serde::{Deserialize, Serialize};

use super::frame::{HueAreaChannel, HueColorSender};
use super::sender::ShutdownSignal;

// ---------------------------------------------------------------------------
// Retry policy tunables (consumed by retry.rs)
// ---------------------------------------------------------------------------

pub(crate) const DEFAULT_RETRY_MAX_ATTEMPTS: u8 = 3;
pub(crate) const DEFAULT_RETRY_BASE_MS: u64 = 400;
pub(crate) const DEFAULT_RETRY_CAP_MS: u64 = 2_000;

// ---------------------------------------------------------------------------
// State machine enums
// ---------------------------------------------------------------------------

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

#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct StartHueStreamRequest {
    pub bridge_ip: String,
    pub username: String,
    pub client_key: String,
    pub area_id: String,
    pub trigger_source: Option<HueRuntimeTriggerSource>,
    /// Optional per-channel region overrides indexed by channel index.
    /// Each entry is a region string: "left", "right", "top", "bottom", or "center".
    /// `None` entries use the auto-detected region.
    pub channel_region_overrides: Option<Vec<Option<String>>>,
}

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

#[derive(Clone, Debug)]
pub struct HueRuntimeGateEvidence {
    pub bridge_configured: bool,
    pub credentials_valid: bool,
    pub area_selected: bool,
    pub readiness_current: bool,
    pub ready: bool,
    pub auth_invalid_evidence: bool,
}

// ---------------------------------------------------------------------------
// Retry policy struct (definition + Default impl) — consumed by retry.rs
// ---------------------------------------------------------------------------

#[cfg_attr(not(test), allow(dead_code))]
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
    pub(crate) last_status: HueRuntimeStatus,
    /// Most recent solid color successfully sent to the bridge.
    /// Persists across reconnects so the UI can restore the last applied color.
    pub(crate) last_solid_color: Option<HueSolidColorSnapshot>,
    #[cfg_attr(not(test), allow(dead_code))]
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
}

#[derive(Clone, Debug)]
pub(crate) struct HueActiveStreamContext {
    pub(crate) bridge_ip: String,
    pub(crate) username: String,
    #[allow(dead_code)]
    pub(crate) client_key: String,
    pub(crate) area_id: String,
    pub(crate) channels: Vec<HueAreaChannel>,
    pub(crate) color_sender: HueColorSender,
    /// Whether this context uses real DTLS streaming (true) or HTTP fallback (false).
    pub(crate) uses_dtls: bool,
    /// Fires when the background sender thread exits. Used by `stop_hue_stream`
    /// to wait for graceful shutdown before reporting success or timeout.
    pub(crate) shutdown_signal: ShutdownSignal,
    /// Per-light archetype + gamut_type cache keyed by CLIP v2 light id.
    /// Pre-fetched at activation time (W1-C3a) and read lock-free by the
    /// DTLS frame builder hot path (W1-C3b) for per-bulb gamut clipping.
    /// Missing entries fall back to `HueGamutType::Other` (no clipping).
    #[allow(dead_code)] // read by the sender thread + frame builder, not the runtime owner
    pub(crate) light_metadata: Arc<HashMap<String, super::sender::HueLightMetadata>>,
}

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
            last_status: status_with(
                HueRuntimeState::Idle,
                "HUE_STREAM_IDLE",
                "Hue runtime is idle.",
                None,
                HueRuntimeTriggerSource::System,
            ),
            last_solid_color: None,
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
        }
    }
}

pub struct HueRuntimeStateStore {
    pub(crate) runtime: Arc<Mutex<HueRuntimeOwner>>,
}

impl Default for HueRuntimeStateStore {
    fn default() -> Self {
        Self {
            runtime: Arc::new(Mutex::new(HueRuntimeOwner::default())),
        }
    }
}

impl HueRuntimeStateStore {
    pub fn runtime_arc(&self) -> Arc<Mutex<HueRuntimeOwner>> {
        Arc::clone(&self.runtime)
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

/// If a solid color was queued while the stream context was not ready, attempt
/// to flush it now.  Called whenever we hold the lock and the context may have
/// just become available (e.g. after status_refresh_with_evidence confirms the
/// stream is healthy, or on a periodic get_hue_stream_status poll).
pub(crate) fn flush_pending_solid_color(owner: &mut HueRuntimeOwner) {
    if owner.last_status.code != "HUE_COLOR_QUEUED_PENDING_STREAM" {
        return;
    }
    if let (Some(color), Some(stream)) =
        (owner.last_solid_color.clone(), owner.active_stream.as_ref())
    {
        if !stream.channels.is_empty() {
            stream
                .color_sender
                .try_send(color.r, color.g, color.b, color.brightness);
            owner.last_status = status_with(
                owner.state.clone(),
                "HUE_COLOR_APPLIED",
                "Queued solid color flushed after stream context became ready.",
                None,
                HueRuntimeTriggerSource::System,
            );
        }
    }
}

// ---------------------------------------------------------------------------
// Lock-free output context snapshot + apply helpers
// ---------------------------------------------------------------------------

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
    // Also check persistent sender (covers app-startup solid-only mode).
    if let Some(persistent) = owner.persistent_sender.as_ref() {
        if !persistent.channels.is_empty() {
            return Some(super::frame::channels_to_info(&persistent.channels));
        }
    }
    None
}

#[cfg(test)]
pub(crate) mod test_helpers {
    //! Shared test fixtures for the v1.5 G8 split. Each submodule's
    //! `#[cfg(test)] mod tests` block reaches in here so the fixtures live
    //! in one place and stay in lockstep with `HueRuntimeOwner` /
    //! `HueActiveStreamContext` field changes.

    use std::sync::Arc;

    use super::super::frame::{HueAreaChannel, HueColorSender, HueColorUpdate, HueScreenRegion};
    use super::super::sender::new_shutdown_signal;
    use super::{HueActiveStreamContext, HueRuntimeGateEvidence};

    pub(crate) fn strict_gate_ready() -> HueRuntimeGateEvidence {
        HueRuntimeGateEvidence {
            bridge_configured: true,
            credentials_valid: true,
            area_selected: true,
            readiness_current: true,
            ready: true,
            auth_invalid_evidence: false,
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
        }
    }

    /// Helper: build a dummy `HueActiveStreamContext` for tests that need one
    /// without spawning a real background thread.
    pub(crate) fn dummy_active_stream_context() -> HueActiveStreamContext {
        let (tx, _rx) = std::sync::mpsc::sync_channel::<HueColorUpdate>(1);
        HueActiveStreamContext {
            bridge_ip: "192.168.1.2".to_string(),
            username: "username".to_string(),
            client_key: String::new(),
            area_id: "area".to_string(),
            channels: vec![HueAreaChannel {
                channel_id: 0,
                light_ids: vec!["light-1".to_string()],
                screen_region: HueScreenRegion::Center,
                position_x: 0.0,
                position_y: 0.0,
            }],
            color_sender: HueColorSender {
                tx: Arc::new(tx),
                channel_count: 1,
            },
            uses_dtls: false,
            shutdown_signal: new_shutdown_signal(),
            light_metadata: Arc::new(std::collections::HashMap::new()),
        }
    }
}
