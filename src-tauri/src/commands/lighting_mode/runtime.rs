//! The managed runtime: who owns the running worker, the capture factory it is
//! built from, and the locks a transition takes.

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

use log::info;

use super::config::LightingModeConfig;
use super::live::{AmbilightLiveSettings, RoomGeometryLive};
use super::outputs;
use super::preview::PreviewRuntime;
use super::snapshot::LightingSnapshotCell;
use super::tuning::TuningCell;
use crate::commands::ambilight_capture::{
    create_live_frame_source_at, AmbilightCaptureError, AmbilightFrameSource,
};
use crate::commands::led_calibration::LedCalibrationConfig;
use crate::commands::led_output::LedOutputBridge;
use crate::commands::test_pattern::{
    create_synthetic_frame_source, TestPatternConfig, TestPatternLiveSlot,
};

/// Request passed to the frame-source factory on worker start.
/// Carries both the display selection hint and the LED calibration config
/// so the factory signature stays stable as v1.5/v2.0 sinks add fields.
#[derive(Clone, Debug)]
pub struct AmbilightCaptureRequest {
    pub display_id: Option<String>,
    /// Per-LED strip calibration, read only by the synthetic test-pattern
    /// source; the live worker takes its calibration from
    /// `LightingModeConfig` directly.
    pub led_calibration: Option<LedCalibrationConfig>,
    /// v1.6 LED Preview — when `Some`, the frame-source factory builds a
    /// `SyntheticFrameSource` (test mode) instead of live screen capture.
    pub test_pattern: Option<TestPatternConfig>,
    /// Animation phase carried across the worker rebuild a pattern tweak forces.
    pub pattern_phase: Option<Arc<AtomicU32>>,
    /// Pattern + speed the source re-reads per frame, so a colour drag retunes.
    pub pattern_live: Option<TestPatternLiveSlot>,
    /// Shortest gap the OS is asked to leave between frames: `capture_interval_for`.
    pub frame_interval: Duration,
}

type AmbilightFrameSourceFactory = dyn Fn(AmbilightCaptureRequest) -> Result<Box<dyn AmbilightFrameSource>, AmbilightCaptureError>
    + Send
    + Sync;

pub(super) struct LightingWorkerRuntime {
    pub(super) cancel: Arc<AtomicBool>,
    pub(super) handle: JoinHandle<()>,
    /// Holds the frame source alongside the worker thread.
    ///
    /// The worker thread captures a clone of this Arc. When the thread exits it
    /// drops its clone (refcount → 1). Then `stop()` drops `self`, which drops
    /// this field (refcount → 0) from the calling thread — the Tauri command
    /// thread. This ensures `SCStream::stop_capture` is never called from the
    /// worker thread, preventing a macOS crash on rapid mode switches.
    pub(super) _frame_source: Arc<Mutex<Box<dyn AmbilightFrameSource>>>,
}

impl LightingWorkerRuntime {
    pub(super) fn stop(self) {
        let t0 = std::time::Instant::now();
        self.cancel.store(true, Ordering::Relaxed);
        let _ = self.handle.join();
        let join_ms = t0.elapsed().as_millis();
        info!("[stop-worker] join completed in {join_ms}ms");
        // `_frame_source` drops here — from the calling (command) thread,
        // after the worker thread has already released its Arc clone.
        // MacOSLiveFrameSource::Drop spawns a thread to call stop_capture()
        // so this drop is non-blocking.
    }
}

pub(crate) struct LightingRuntimeOwner {
    pub(super) active_mode: LightingModeConfig,
    /// Port name for the currently active LED session. Cleared in
    /// `stop_previous`, which deliberately leaves the cached serial handle
    /// open — reopening the port toggles DTR and resets the MCU.
    pub(super) active_port: Option<String>,
    pub(super) worker: Option<LightingWorkerRuntime>,
    /// Shared settings for the currently running ambilight worker.
    /// Updated in-place when only ambilight settings change, avoiding worker restart.
    pub(super) ambilight_live: Option<Arc<AmbilightLiveSettings>>,
    /// Room geometry cell of the running ambilight worker; fresh per worker.
    pub(super) room_geometry_live: Option<Arc<RoomGeometryLive>>,
    pub(super) output_bridge: LedOutputBridge,
    pub(super) frame_source_factory: Arc<AmbilightFrameSourceFactory>,
    /// v1.6 LED Preview — synthetic test request + shared enrichment gate.
    pub(super) preview: PreviewRuntime,
    /// `LightingRuntimeState::closing`, read under the runtime lock.
    pub(super) closing: Arc<AtomicBool>,
    /// Set for one apply by the settings refresh of a mode already on Hue, so
    /// a reconnecting stream does not refuse the strip its new settings.
    pub(super) hue_gate_waived: bool,
}

impl Default for LightingRuntimeOwner {
    fn default() -> Self {
        Self {
            active_mode: LightingModeConfig::default(),
            active_port: None,
            worker: None,
            ambilight_live: None,
            room_geometry_live: None,
            output_bridge: LedOutputBridge::default(),
            preview: Default::default(),
            frame_source_factory: Arc::new(|req: AmbilightCaptureRequest| {
                if let Some(test) = req.test_pattern {
                    Ok(create_synthetic_frame_source(
                        test,
                        req.led_calibration,
                        req.pattern_phase,
                        req.pattern_live,
                    ))
                } else {
                    create_live_frame_source_at(req.display_id.as_deref(), req.frame_interval)
                }
            }),
            closing: Arc::default(),
            hue_gate_waived: false,
        }
    }
}

/// Tauri-managed holder for the lighting mode state machine — active mode,
/// the running worker (if any), live-tunable settings, and the output bridge.
pub struct LightingRuntimeState {
    pub(super) runtime: Mutex<LightingRuntimeOwner>,
    /// The mode commands' turn order — see `run_mode_transition`.
    pub(super) transitions: tokio::sync::Mutex<()>,
    /// Set first by the quit path. A mode start checks it under the runtime
    /// lock, so no worker comes up after the quit's own stop has run.
    closing: Arc<AtomicBool>,
    /// What runs, for readers that must never wait on `runtime`.
    pub(crate) snapshot: Arc<LightingSnapshotCell>,
    pub(crate) outputs: outputs::OutputsState,
    pub(crate) tuning: Arc<TuningCell>,
}

impl Default for LightingRuntimeState {
    fn default() -> Self {
        Self::with_owner(LightingRuntimeOwner::default())
    }
}

impl LightingRuntimeState {
    fn with_owner(mut owner: LightingRuntimeOwner) -> Self {
        let closing = Arc::new(AtomicBool::new(false));
        owner.closing = Arc::clone(&closing);
        Self {
            runtime: Mutex::new(owner),
            transitions: tokio::sync::Mutex::new(()),
            closing,
            snapshot: Arc::default(),
            outputs: outputs::OutputsState::default(),
            tuning: Arc::default(),
        }
    }

    /// Step 1 of the quit calls this before it stops anything.
    pub fn mark_closing(&self) {
        self.closing.store(true, Ordering::SeqCst);
    }

    pub fn is_closing(&self) -> bool {
        self.closing.load(Ordering::SeqCst)
    }
}

#[cfg(test)]
impl LightingRuntimeState {
    /// A runtime over a test owner — fake capture, recording serial bridge.
    pub(crate) fn for_tests(owner: LightingRuntimeOwner) -> Self {
        Self::with_owner(owner)
    }

    /// Swaps the serial write path, so an IPC test sees every write — and
    /// every port open — a mode change would make.
    pub(crate) fn replace_output_bridge_for_tests(&self, bridge: LedOutputBridge) {
        self.runtime
            .lock()
            .expect("lighting runtime lock poisoned")
            .output_bridge = bridge;
    }

    /// Takes the mode commands' turn, as a command in flight would hold it.
    pub(crate) fn hold_transition_for_tests(&self) -> tokio::sync::MutexGuard<'_, ()> {
        self.transitions.blocking_lock()
    }

    /// Holds the runtime lock, as a worker join mid-transition does.
    pub(crate) fn hold_runtime_for_tests(&self) -> std::sync::MutexGuard<'_, LightingRuntimeOwner> {
        self.runtime
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}
