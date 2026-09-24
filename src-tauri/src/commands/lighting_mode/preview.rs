//! The LED twin overlay's feed: the preview state a worker carries, the
//! edge-signal event it emits while a twin is open, and the preview status.

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, Emitter, EventTarget, Manager, Runtime, State};

use super::config::LightingModeKind;
use super::runtime::LightingRuntimeState;
use crate::commands::led_preview::{
    build_preview_status, LedPreviewStatus, LedTwinState, PreviewModeSnapshot,
};
use crate::commands::test_pattern::{TestPatternConfig, TestPatternLiveSlot};

/// v1.6 LED Preview runtime state carried alongside the lighting worker.
#[derive(Default)]
pub(super) struct PreviewRuntime {
    /// Synthetic test-pattern request consumed by the frame-source factory on
    /// the next ambilight (re)start. `Some` ⇒ build a `SyntheticFrameSource`.
    pub(super) pending_test_pattern: Option<TestPatternConfig>,
    /// The synthetic pattern currently driving the worker (status reporting).
    pub(super) active_test_pattern: Option<TestPatternConfig>,
    /// Shared `LedTwinState` preview-active flag. Cloned into each LIVE worker
    /// so a twin overlay opened *after* the worker starts can flip enrichment
    /// on without a worker restart.
    pub(super) preview_gate: Option<Arc<AtomicBool>>,
    /// Animation phase (f32 bits) shared with the running `SyntheticFrameSource`.
    /// Carried across the rebuilds that a calibration or geometry change still
    /// forces, so the animation never restarts from zero.
    pub(super) pattern_phase: Arc<AtomicU32>,
    /// Pattern + speed of the running synthetic source. Writing it retunes the
    /// test in place; `None` means no synthetic worker is up.
    pub(super) pattern_live: Option<TestPatternLiveSlot>,
}

/// Per-worker twin-feed context — decides whether the worker builds and emits
/// the edge-signal this tick, and what it stamps on it.
#[derive(Clone)]
pub struct PreviewEmitContext {
    pub gate: PreviewGate,
    /// `"test"` (synthetic) or `"live"` (real capture).
    pub source: &'static str,
    /// Active synthetic pattern tag when `source == "test"`.
    pub pattern: Option<&'static str>,
    /// Display the frame belongs to (live only; synthetic is display-agnostic).
    pub display_id: Option<String>,
}

/// Gate deciding whether the worker emits the edge-signal each tick.
#[derive(Clone)]
pub enum PreviewGate {
    /// Always enrich — the synthetic test pattern is itself the preview.
    Always,
    /// Enrich only while the shared flag is set (live twin opened/closed at
    /// runtime).
    Shared(Arc<AtomicBool>),
}

impl PreviewEmitContext {
    pub(super) fn should_enrich(&self) -> bool {
        match &self.gate {
            PreviewGate::Always => true,
            PreviewGate::Shared(flag) => flag.load(Ordering::Relaxed),
        }
    }
}

// ---------------------------------------------------------------------------
// Edge signal — per-LED feed for the LED twin overlay
// ---------------------------------------------------------------------------
//
// The twin overlay is the only listener, so the worker builds and emits this
// only while a twin is open (`LedTwinState::preview_active`).

/// `PREVIEW_EVENTS.EDGE_SIGNAL` in `src/shared/contracts/preview.ts`. Defined
/// in `crate::events`; re-exported here since this is the emit site.
pub use crate::events::EDGE_SIGNAL_EVENT;
/// ~30 Hz: at the top pattern speed a slower cadence lets the comet head travel
/// further per frame than its own tail, leaving visible gaps in the twin.
pub const EDGE_SIGNAL_PREVIEW_INTERVAL_MS: u64 = 33;

/// Payload for the `ambilight://edge-signal` event — the per-LED strip buffer
/// the twin overlay mirrors, plus the sparse Hue channel colours.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EdgeSignalPayload {
    pub leds: Vec<[u8; 3]>,
    pub led_count: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hue_channels: Option<Vec<[u8; 3]>>,
    pub source: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pattern: Option<&'static str>,
    pub seq: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_id: Option<String>,
}

/// Thread-safe emitter the worker hands each twin frame to, so the worker
/// doesn't depend on the Tauri runtime type parameter.
pub type EdgeSignalEmitter = Arc<dyn Fn(EdgeSignalPayload) + Send + Sync>;

/// Build the edge-signal emitter. Sends to the open twin-overlay windows only
/// (read from `LedTwinState` each tick, so a twin opened mid-run starts
/// receiving without a worker restart); the main window has no listener.
pub(super) fn build_edge_emitter<R: Runtime>(app: &AppHandle<R>) -> EdgeSignalEmitter {
    let app_handle = app.clone();
    Arc::new(move |payload: EdgeSignalPayload| {
        let Some(twin_state) = app_handle.try_state::<LedTwinState>() else {
            return;
        };
        for label in twin_state.twin_labels_snapshot() {
            let _ = app_handle.emit_to(
                EventTarget::webview_window(label.as_str()),
                EDGE_SIGNAL_EVENT,
                payload.clone(),
            );
        }
    })
}

/// Decide whether — and how — the worker feeds the twin overlay.
pub(super) fn build_preview_emit_context(
    is_test: bool,
    test_pattern: Option<&TestPatternConfig>,
    preview_gate: Option<Arc<AtomicBool>>,
    display_id: Option<String>,
) -> Option<PreviewEmitContext> {
    if is_test {
        Some(PreviewEmitContext {
            // Only twin overlays read the buffer, so a test with no twin open
            // must not pay for an N-LED Vec + JSON every tick.
            gate: match preview_gate {
                Some(flag) => PreviewGate::Shared(flag),
                None => PreviewGate::Always,
            },
            source: "test",
            pattern: test_pattern.map(|cfg| cfg.kind.tag()),
            // Synthetic frames are display-agnostic — no per-display filter.
            display_id: None,
        })
    } else {
        preview_gate.map(|flag| PreviewEmitContext {
            gate: PreviewGate::Shared(flag),
            source: "live",
            pattern: None,
            display_id,
        })
    }
}

impl LightingRuntimeState {
    /// Snapshot the lighting-side preview status. Recovers from a poisoned
    /// lock rather than propagating (status reads must not fail).
    pub fn preview_snapshot(&self) -> PreviewModeSnapshot {
        let owner = self.runtime.lock().unwrap_or_else(|e| e.into_inner());
        let active_pattern = owner
            .preview
            .active_test_pattern
            .as_ref()
            .map(|cfg| cfg.kind.clone());
        let test_active = active_pattern.is_some();
        let source = if test_active {
            "test"
        } else if owner.active_mode.kind == LightingModeKind::Ambilight && owner.worker.is_some() {
            "live"
        } else {
            "idle"
        };
        PreviewModeSnapshot {
            test_active,
            source,
            active_pattern,
        }
    }
}

/// Combined snapshot for the LED Preview UI — whether a test pattern or live
/// ambilight is the current preview source, plus twin-overlay window state.
#[tauri::command]
pub fn get_led_preview_status(
    runtime_state: State<'_, LightingRuntimeState>,
    led_twin_state: State<'_, LedTwinState>,
) -> Result<LedPreviewStatus, String> {
    let snapshot = runtime_state.preview_snapshot();
    Ok(build_preview_status(snapshot, led_twin_state.inner()))
}
