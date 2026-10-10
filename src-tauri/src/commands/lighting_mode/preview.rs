//! The LED twin's feed: the preview state a worker carries and the
//! edge-signal event it emits while the preview session's twin is open.

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, Emitter, EventTarget, Manager, Runtime};

use super::config::LightingModeConfig;
use super::runtime::LightingRuntimeState;
use crate::commands::preview::PreviewSessionState;
use crate::commands::test_pattern::{TestPatternConfig, TestPatternLiveSlot};

/// LED preview runtime state carried alongside the lighting worker.
#[derive(Default)]
pub(super) struct PreviewRuntime {
    /// Synthetic test-pattern request consumed by the frame-source factory on
    /// the next ambilight (re)start. `Some` ⇒ build a `SyntheticFrameSource`.
    pub(super) pending_test_pattern: Option<TestPatternConfig>,
    /// The synthetic pattern currently driving the worker (status reporting).
    pub(super) active_test_pattern: Option<TestPatternConfig>,
    /// The session's `twin_open` flag. Cloned into each worker so a twin
    /// opened *after* the worker starts turns the feed on without a restart.
    pub(super) preview_gate: Option<Arc<AtomicBool>>,
    /// The mode a running test pattern interrupted, for its stop to restore.
    /// Written and cleared under the runtime lock: a user's mode change drops
    /// it in the same critical section that replaces the test, so a stop that
    /// races it cannot revive the pre-test mode over the user's choice.
    pub(super) test_prior: Option<LightingModeConfig>,
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
// The twin is the only listener, so the worker builds and emits this only
// while the session's twin is open (`PreviewSessionState::twin_open`).

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

/// Build the edge-signal emitter. Sends to the session's twin only (read each
/// tick, so a twin opened mid-run starts receiving without a worker restart);
/// the main window has no listener.
pub(super) fn build_edge_emitter<R: Runtime>(app: &AppHandle<R>) -> EdgeSignalEmitter {
    let app_handle = app.clone();
    Arc::new(move |payload: EdgeSignalPayload| {
        let Some(label) = app_handle
            .try_state::<PreviewSessionState>()
            .and_then(|session| session.twin_label())
        else {
            return;
        };
        let _ = app_handle.emit_to(
            EventTarget::webview_window(label.as_str()),
            EDGE_SIGNAL_EVENT,
            payload,
        );
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
    /// Whether a synthetic test pattern drives the worker. Recovers from a
    /// poisoned lock rather than propagating: a stop must still learn it.
    pub fn test_pattern_active(&self) -> bool {
        let owner = self.runtime.lock().unwrap_or_else(|e| e.into_inner());
        owner.preview.active_test_pattern.is_some()
    }
}
