//! The LED twin's feed on the worker side: the preview state a worker carries
//! and the frames it hands the preview session while a twin is subscribed.

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Arc;

use tauri::{AppHandle, Runtime};

use super::config::LightingModeConfig;
use super::latency::LatencySink;
use super::runtime::LightingRuntimeState;
use crate::commands::preview::SceneKind;
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
    /// The preview scene Ambilight runs for. Set and cleared with
    /// `session_prior` under the runtime lock, like `test_prior`: a user's mode
    /// change clears both in the critical section that replaces the scene.
    pub(super) scene: Option<SceneKind>,
    /// The mode the scene interrupted, for its stop to restore.
    pub(super) session_prior: Option<LightingModeConfig>,
    /// The running worker was started for a scene. Entering or leaving one
    /// rebuilds the worker rather than retuning it, so the history skip it was
    /// started with matches what it captures.
    pub(super) scene_worker: bool,
    /// Where the latency scene's measurement goes; `Some` only while it plays.
    pub(super) latency_sink: Option<LatencySink>,
    /// The running worker measures for the latency scene, so a switch to or
    /// from it rebuilds the worker rather than retuning it.
    pub(super) latency_worker: bool,
}

/// Per-worker twin-feed gate: whether the worker builds a twin frame this tick.
#[derive(Clone)]
pub struct PreviewEmitContext {
    gate: Arc<AtomicBool>,
}

impl PreviewEmitContext {
    pub(super) fn should_enrich(&self) -> bool {
        self.gate.load(Ordering::Relaxed)
    }
}

/// At most one twin frame per display refresh: the twin cannot draw faster.
pub const TWIN_FRAME_INTERVAL_MS: u64 = 16;

/// Hands the worker's frame — strip LEDs, then Hue lamps, as the twin draws
/// them — to the preview session. Without the Tauri runtime type parameter, so
/// the worker does not depend on it.
pub type TwinFrameSink = Arc<dyn Fn(&[[u8; 3]], &[[u8; 3]]) + Send + Sync>;

pub(super) fn build_twin_sink<R: Runtime>(app: &AppHandle<R>) -> TwinFrameSink {
    let app_handle = app.clone();
    Arc::new(move |leds: &[[u8; 3]], lamps: &[[u8; 3]]| {
        crate::commands::preview::feed::send_frame(&app_handle, leds, lamps);
    })
}

/// `None` without a session gate wired (the worker then builds no twin frame).
pub(super) fn build_preview_emit_context(
    preview_gate: Option<Arc<AtomicBool>>,
) -> Option<PreviewEmitContext> {
    preview_gate.map(|gate| PreviewEmitContext { gate })
}

/// What the twin needs from the running mode: the layout it runs, and the mode
/// itself when no worker runs to send frames (Solid, Off).
pub struct TwinModeView {
    pub layout: Option<crate::commands::led_calibration::LedCalibrationConfig>,
    pub still: Option<LightingModeConfig>,
    /// The running mode drives Hue, so the twin has lamps to place.
    pub drives_hue: bool,
    pub room_geometry: Option<crate::models::room_map::RoomGeometry>,
}

/// Where each Hue channel samples the screen, `(0, 0)` top-left, in `channels`
/// order — the room map's placements over the stream's channels, as the
/// worker's sample table puts them. `None` without a room map that places them.
pub fn hue_lamp_screen_points(
    channels: &[crate::commands::hue::frame::HueAreaChannel],
    geometry: Option<&crate::models::room_map::RoomGeometry>,
) -> Option<Vec<(f32, f32)>> {
    let geometry = geometry?;
    let mut placed = channels.to_vec();
    crate::commands::hue::sender::apply_channel_placements(&mut placed, &geometry.hue_placements);
    let samples = crate::commands::room_affinity::room_aware_hue_samples(geometry, &placed)?;
    Some(
        samples
            .iter()
            .map(|s| {
                (
                    ((s.sample_x + 1.0) / 2.0).clamp(0.0, 1.0),
                    ((1.0 - s.sample_y) / 2.0).clamp(0.0, 1.0),
                )
            })
            .collect(),
    )
}

impl LightingRuntimeState {
    pub fn twin_view(&self) -> TwinModeView {
        let owner = self.runtime.lock().unwrap_or_else(|e| e.into_inner());
        let targets = owner.active_mode.targets.as_deref().unwrap_or_default();
        TwinModeView {
            layout: owner.active_mode.led_calibration.clone(),
            still: owner.worker.is_none().then(|| owner.active_mode.clone()),
            drives_hue: owner.active_mode.kind != super::LightingModeKind::Off
                && targets.iter().any(|t| t == "hue"),
            room_geometry: owner.active_mode.room_geometry.clone(),
        }
    }

    /// Whether a preview scene owns the lights.
    pub fn scene_active(&self) -> bool {
        let owner = self.runtime.lock().unwrap_or_else(|e| e.into_inner());
        owner.preview.scene.is_some()
    }

    /// A scene's marker without its lights, for a test of what it refuses.
    #[cfg(test)]
    pub(crate) fn mark_scene_for_tests(&self, kind: SceneKind) {
        self.runtime
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .preview
            .scene = Some(kind);
    }

    /// A test pattern's marker without its worker, likewise.
    #[cfg(test)]
    pub(crate) fn mark_test_pattern_for_tests(&self, test: TestPatternConfig) {
        self.runtime
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .preview
            .active_test_pattern = Some(test);
    }

    /// Whether a synthetic test pattern drives the worker. Recovers from a
    /// poisoned lock rather than propagating: a stop must still learn it.
    pub fn test_pattern_active(&self) -> bool {
        let owner = self.runtime.lock().unwrap_or_else(|e| e.into_inner());
        owner.preview.active_test_pattern.is_some()
    }
}
