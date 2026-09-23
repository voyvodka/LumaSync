//! Lighting mode state machine — owns the Off/Solid/Ambilight transitions,
//! the ambilight capture→sample→correct→send worker thread, and the LED
//! test-pattern preview path that reuses the same worker plumbing.

use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, AtomicU8, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use log::{info, warn};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, EventTarget, Manager, Runtime, State};

use super::ambilight_capture::{
    create_live_frame_source, detect_black_borders, AmbilightCaptureError, AmbilightFrameSource,
    BlackBorderInsets, CapturedFrame, StaticFrameSource, BLACK_BORDER_THRESHOLD,
};
use super::ambilight_scene::{hue_default_screen_affinity, LightTopology};
use super::calibration::list_displays;
use super::device_connection::{ActiveSinkRegistry, SerialConnectionState};
use super::hue::state_store::{
    apply_hue_channels_with_context, apply_hue_color_with_context, snapshot_hue_output_context,
    HueActiveOutputContext, HueRuntimeStateStore,
};
use super::hue_intensity::{HueIntensityPreset, LightingSmoothingPreset};
use super::led_calibration::{
    build_led_sequence, derive_base_interval_ms_for, frame_wire_bytes, frame_wire_time_ms,
    link_max_fps, sample_frame_for_sequence, LedCalibrationConfig,
};
use super::led_output::{
    apply_color_correction_rgb, encode_packet_for_output, ColorCorrectionConfig, EncoderPlan,
    FirmwareProfile, LedChipType, LedColorOrder, LedOutputBridge, SerialSink, WirePixelLayout,
};
use super::led_preview::{
    build_preview_status, emit_preview_state_changed, LedPreviewStatus, LedTwinState,
    PreviewModeSnapshot,
};
use super::led_sink::LedSink;
use super::room_affinity::{room_aware_hue_samples, room_geometry_rejection};
use super::runtime_quality::{RuntimeFrameSlot, RuntimeQualityConfig, RuntimeQualityController};
use super::runtime_telemetry::{
    RuntimeTelemetrySnapshot, RuntimeTelemetryState, RuntimeTelemetryWindow, SharedRuntimeTelemetry,
};
use super::status::CommandStatus;
use super::test_pattern::{
    create_synthetic_frame_source, TestPatternConfig, TestPatternKind, TestPatternLive,
    TestPatternLiveSlot, TestPatternSpeed, DEFAULT_DISPLAY_ASPECT,
};
use super::wled_sink::{CorrectedWledSink, WledSinkConfig};
use crate::models::room_map::RoomGeometry;

mod frame_pipeline;
use frame_pipeline::{
    strip_topology_for, AmbilightFramePipeline, FramePipelineConfig, FrameSettings,
};

static ACTIVE_AMBILIGHT_WORKERS: AtomicUsize = AtomicUsize::new(0);
static SOLID_OUTPUT_ATTEMPTS: AtomicUsize = AtomicUsize::new(0);
static AMBILIGHT_FRAME_ATTEMPTS: AtomicUsize = AtomicUsize::new(0);
static AMBILIGHT_CAPTURE_ATTEMPTS: AtomicUsize = AtomicUsize::new(0);

// Test-only serial guard. `start_ambilight_worker` mutates the process-global
// `ACTIVE_AMBILIGHT_WORKERS` counter, and several tests across BOTH test
// modules below either spawn real worker threads or assert exact counter
// values. Under `cargo test`'s default thread-level parallelism those tests
// race on the shared counter (one test spawns a worker -> count==1 while
// another asserts count==0). This mutex serialises every worker-touching test
// so the global counter is guaranteed to start at 0 for each one. It lives at
// the parent-module scope so both `mod tests` and `mod lighting_mode_tests`
// share the SAME lock. `Mutex::new(())` is a const fn, so no lazy
// initialisation is needed. Test-execution ordering only -- zero production
// impact.
#[cfg(test)]
static WORKER_TEST_GUARD: std::sync::Mutex<()> = std::sync::Mutex::new(());

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
}

type AmbilightFrameSourceFactory = dyn Fn(AmbilightCaptureRequest) -> Result<Box<dyn AmbilightFrameSource>, AmbilightCaptureError>
    + Send
    + Sync;

#[derive(Clone, Default, Deserialize, Serialize, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum LightingModeKind {
    #[default]
    Off,
    Ambilight,
    Solid,
}

#[derive(Clone, Deserialize, Serialize, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SolidColorPayload {
    pub r: u8,
    pub g: u8,
    pub b: u8,
    pub brightness: f32,
}

/// Tunables for `LightingModeKind::Ambilight` — brightness plus the
/// sampling/smoothing knobs applied on top of raw screen capture.
#[derive(Clone, Deserialize, Serialize, PartialEq, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct AmbilightPayload {
    pub brightness: f32,
    /// Enable automatic letterbox / pillarbox detection.
    /// When true, black borders are detected every ~2.5 s and excluded from sampling.
    #[serde(default)]
    pub black_border_detection: bool,
    /// EWMAalpha for per-frame color smoothing. Range [0.05, 1.0].
    /// 1.0 = instant (no smoothing); lower values = slower, smoother transitions.
    /// Defaults to 0.35 when absent.
    #[serde(default)]
    pub smoothing_alpha: Option<f32>,
    /// Post-sampling color saturation factor. Range [0.5, 2.0].
    /// 1.0 = identity (no change); 0.5 ≈ half-saturated; 2.0 ≈ vivid.
    /// Defaults to 1.0 when absent.
    #[serde(default)]
    pub saturation: Option<f32>,
    /// Unified smoothing preset (v1.4 unification). When present, governs
    /// the EWMA coefficient for both USB and Hue output sinks. Takes
    /// priority over the deprecated `smoothing_alpha` continuous slider
    /// and `hue_intensity_preset`.
    #[serde(default)]
    pub lighting_smoothing_preset: Option<LightingSmoothingPreset>,
    /// Deprecated — use `lighting_smoothing_preset`. Kept for backward
    /// compatibility with pre-v1.4 payloads that still carry this field.
    /// Will be removed in v1.5.
    #[serde(default)]
    pub hue_intensity_preset: Option<HueIntensityPreset>,
}

/// Full desired-state payload for `set_lighting_mode` — mode selection plus
/// every per-mode and per-output setting needed to (re)start the worker.
#[derive(Clone, Deserialize, Serialize, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LightingModeConfig {
    #[serde(default)]
    pub kind: LightingModeKind,
    #[serde(default)]
    pub solid: Option<SolidColorPayload>,
    #[serde(default)]
    pub ambilight: Option<AmbilightPayload>,
    #[serde(default)]
    pub targets: Option<Vec<String>>,
    /// Capture display selected by the user (v1.4 Platform GAP 2).
    /// Absent ⇒ the ambilight worker falls back to the OS primary
    /// display. Matched against the stable `DisplayInfoPayload.id`
    /// produced by `list_displays`; a missing or unplugged id reverts
    /// to primary rather than failing the command.
    #[serde(default)]
    pub display_id: Option<String>,
    /// Per-LED calibration config (v1.4 USB per-LED sampling anchor).
    /// When set, the ambilight worker uses edge-based per-LED sampling
    /// (`build_led_sequence` + `sample_frame_for_sequence`).
    /// When absent, the worker falls back to single-zone sampling.
    #[serde(default)]
    pub led_calibration: Option<LedCalibrationConfig>,
    /// Per-channel color correction applied in the LED encoder (v1.4 G4).
    /// Absent ⇒ backend uses `ColorCorrectionConfig::default()` (gamma 2.2 / 6500 K / sat 1.0).
    /// Applies to USB output only — Hue sink is not affected.
    #[serde(default)]
    pub color_correction: Option<ColorCorrectionConfig>,
    /// Firmware encoding profile (v1.4 G11). Absent ⇒ `FirmwareProfile::default()` (LumaSyncV1).
    /// Changing this is a breaking wire-format change — only done via user-visible Firmware Profile
    /// setting; never switched silently.
    #[serde(default)]
    pub firmware_profile: Option<FirmwareProfile>,
    /// LED chip type (v1.5 G3). Absent ⇒ `LedChipType::default()` (WS2812B GRB).
    /// Changes bytes-per-pixel on the wire, so it also moves the serial timing
    /// budget — see `derive_base_interval_ms_for` / `frame_wire_time_ms`.
    #[serde(default)]
    pub chip_type: Option<LedChipType>,
    /// Host-side colour-order correction relative to the firmware (serial only).
    /// Absent ⇒ `Rgb`, the identity. Retuned live, not by a worker restart.
    /// Skipped when absent so the echoed mode stays byte-identical for everyone
    /// who never set it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color_order: Option<LedColorOrder>,
    /// Room-aware Hue sampling input (P3). Absent ⇒ no TV anchor, and the worker
    /// samples exactly as before. Skipped when absent so the echoed mode stays
    /// byte-identical for a user without a TV anchor.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub room_geometry: Option<RoomGeometry>,
}

impl Default for LightingModeConfig {
    fn default() -> Self {
        Self {
            kind: LightingModeKind::Off,
            solid: None,
            ambilight: None,
            targets: None,
            display_id: None,
            led_calibration: None,
            color_correction: None,
            firmware_profile: None,
            chip_type: None,
            color_order: None,
            room_geometry: None,
        }
    }
}

/// Response shape shared by `set_lighting_mode`, `stop_lighting`, and
/// `get_lighting_mode_status` — the mode now in effect plus a coded status.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LightingModeCommandResult {
    pub active: bool,
    pub mode: LightingModeConfig,
    pub status: CommandStatus,
    pub wled_advisory: Option<WledLiveFrameAdvisory>,
}

/// Non-fatal notice that the frame length and the bound WLED sink disagree.
///
/// Deliberately not a failure: WLED updates the first N LEDs of a short frame
/// and truncates a long one, so half a lit strip beats none. It exists because
/// "half my strip is dead" reads as a wiring fault, and the user goes looking
/// at solder joints long before suspecting a count mismatch.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WledLiveFrameAdvisory {
    pub code: String,
    pub message: String,
    pub frame_led_count: u16,
    pub sink_led_count: u16,
}

struct LightingWorkerRuntime {
    cancel: Arc<AtomicBool>,
    handle: JoinHandle<()>,
    /// Holds the frame source alongside the worker thread.
    ///
    /// The worker thread captures a clone of this Arc. When the thread exits it
    /// drops its clone (refcount → 1). Then `stop()` drops `self`, which drops
    /// this field (refcount → 0) from the calling thread — the Tauri command
    /// thread. This ensures `SCStream::stop_capture` is never called from the
    /// worker thread, preventing a macOS crash on rapid mode switches.
    _frame_source: Arc<Mutex<Box<dyn AmbilightFrameSource>>>,
}

impl LightingWorkerRuntime {
    fn stop(self) {
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

/// Live-tunable settings shared between the owner and the running ambilight worker.
///
/// Updated in-place when the user changes ambilight settings (brightness, black
/// border detection) while the mode is already active, so the worker never
/// needs to be stopped/restarted just for a setting tweak. This prevents
/// the macOS SCStream rapid stop/recreate cycle that causes crashes.
struct AmbilightLiveSettings {
    /// Brightness as f32 bit pattern stored in an AtomicU32.
    brightness: AtomicU32,
    black_border_detection: AtomicBool,
    /// Unified EWMA smoothing alpha as f32 bit pattern. Range [0.05, 1.0].
    /// Drives both USB and Hue output sinks — single source of truth.
    /// Populated from `LightingSmoothingPreset.coefficient()` when a preset
    /// is set; falls back to the raw `smoothing_alpha` slider value.
    smoothing_alpha: AtomicU32,
    /// Saturation factor as f32 bit pattern. Range [0.5, 2.0]. 1.0 = identity.
    saturation: AtomicU32,
    /// `LedColorOrder as u8`. Set from every apply, running or starting.
    color_order: AtomicU8,
}

impl AmbilightLiveSettings {
    fn new(
        brightness: f32,
        black_border_detection: bool,
        smoothing_alpha: f32,
        saturation: f32,
    ) -> Arc<Self> {
        let clamped_alpha = smoothing_alpha.clamp(0.05, 1.0);
        Arc::new(Self {
            brightness: AtomicU32::new(brightness.to_bits()),
            black_border_detection: AtomicBool::new(black_border_detection),
            smoothing_alpha: AtomicU32::new(clamped_alpha.to_bits()),
            saturation: AtomicU32::new(saturation.clamp(0.5, 2.0).to_bits()),
            color_order: AtomicU8::new(LedColorOrder::Rgb as u8),
        })
    }

    fn read_color_order(&self) -> LedColorOrder {
        LedColorOrder::from_u8(self.color_order.load(Ordering::Relaxed))
    }

    fn store_color_order(&self, order: LedColorOrder) {
        self.color_order.store(order as u8, Ordering::Relaxed);
    }

    fn read_brightness(&self) -> f32 {
        f32::from_bits(self.brightness.load(Ordering::Relaxed))
    }

    fn read_black_border_detection(&self) -> bool {
        self.black_border_detection.load(Ordering::Relaxed)
    }

    fn read_smoothing_alpha(&self) -> f32 {
        f32::from_bits(self.smoothing_alpha.load(Ordering::Relaxed))
    }

    fn read_saturation(&self) -> f32 {
        f32::from_bits(self.saturation.load(Ordering::Relaxed))
    }

    fn update(
        &self,
        brightness: f32,
        black_border_detection: bool,
        smoothing_alpha: f32,
        saturation: f32,
        smoothing_preset: Option<LightingSmoothingPreset>,
    ) {
        // Resolve unified alpha: preset takes priority over raw slider value.
        // Both USB and Hue sinks read `smoothing_alpha` — single source.
        let resolved_alpha = match smoothing_preset {
            Some(preset) => preset.coefficient(),
            None => smoothing_alpha.clamp(0.05, 1.0),
        };
        self.brightness
            .store(brightness.to_bits(), Ordering::Relaxed);
        self.black_border_detection
            .store(black_border_detection, Ordering::Relaxed);
        self.smoothing_alpha
            .store(resolved_alpha.clamp(0.05, 1.0).to_bits(), Ordering::Relaxed);
        self.saturation
            .store(saturation.clamp(0.5, 2.0).to_bits(), Ordering::Relaxed);
    }
}

/// Room geometry shared with the running ambilight worker, so a room-map drag
/// retunes Hue sampling in place — same role as `TestPatternLive`. The worker
/// reads `generation` once per frame and takes the lock only when it moved.
/// The generation is also stored under the lock, and that copy is the one the
/// worker records as seen: a relaxed load can run ahead of the data, and a
/// stale read then retries next frame instead of being marked current.
struct RoomGeometryLive {
    generation: AtomicU64,
    slot: Mutex<(u64, Option<RoomGeometry>)>,
}

impl RoomGeometryLive {
    fn new(geometry: Option<RoomGeometry>) -> Arc<Self> {
        Arc::new(Self {
            generation: AtomicU64::new(0),
            slot: Mutex::new((0, geometry)),
        })
    }

    fn publish(&self, geometry: Option<RoomGeometry>) {
        let mut slot = self.slot.lock().unwrap_or_else(|err| err.into_inner());
        let next = slot.0.wrapping_add(1);
        slot.0 = next;
        slot.1 = geometry;
        self.generation.store(next, Ordering::Relaxed);
    }

    fn generation(&self) -> u64 {
        self.generation.load(Ordering::Relaxed)
    }

    fn snapshot(&self) -> (u64, Option<RoomGeometry>) {
        let slot = self.slot.lock().unwrap_or_else(|err| err.into_inner());
        (slot.0, slot.1.clone())
    }
}

struct LightingRuntimeOwner {
    active_mode: LightingModeConfig,
    /// Port name for the currently active LED session. Cleared in
    /// `stop_previous`, which deliberately leaves the cached serial handle
    /// open — reopening the port toggles DTR and resets the MCU.
    active_port: Option<String>,
    worker: Option<LightingWorkerRuntime>,
    /// Shared settings for the currently running ambilight worker.
    /// Updated in-place when only ambilight settings change, avoiding worker restart.
    ambilight_live: Option<Arc<AmbilightLiveSettings>>,
    /// Room geometry cell of the running ambilight worker; fresh per worker.
    room_geometry_live: Option<Arc<RoomGeometryLive>>,
    output_bridge: LedOutputBridge,
    frame_source_factory: Arc<AmbilightFrameSourceFactory>,
    /// v1.6 LED Preview — synthetic test request + shared enrichment gate.
    preview: PreviewRuntime,
}

/// v1.6 LED Preview runtime state carried alongside the lighting worker.
#[derive(Default)]
struct PreviewRuntime {
    /// Synthetic test-pattern request consumed by the frame-source factory on
    /// the next ambilight (re)start. `Some` ⇒ build a `SyntheticFrameSource`.
    pending_test_pattern: Option<TestPatternConfig>,
    /// The synthetic pattern currently driving the worker (status reporting).
    active_test_pattern: Option<TestPatternConfig>,
    /// Shared `LedTwinState` preview-active flag. Cloned into each LIVE worker
    /// so a twin overlay opened *after* the worker starts can flip enrichment
    /// on without a worker restart.
    preview_gate: Option<Arc<AtomicBool>>,
    /// Animation phase (f32 bits) shared with the running `SyntheticFrameSource`.
    /// Carried across the rebuilds that a calibration or geometry change still
    /// forces, so the animation never restarts from zero.
    pattern_phase: Arc<AtomicU32>,
    /// Pattern + speed of the running synthetic source. Writing it retunes the
    /// test in place; `None` means no synthetic worker is up.
    pattern_live: Option<TestPatternLiveSlot>,
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
    fn should_enrich(&self) -> bool {
        match &self.gate {
            PreviewGate::Always => true,
            PreviewGate::Shared(flag) => flag.load(Ordering::Relaxed),
        }
    }
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
                    create_live_frame_source(req.display_id.as_deref())
                }
            }),
        }
    }
}

/// Tauri-managed holder for the lighting mode state machine — active mode,
/// the running worker (if any), live-tunable settings, and the output bridge.
#[derive(Default)]
pub struct LightingRuntimeState {
    runtime: Mutex<LightingRuntimeOwner>,
    /// The mode commands' turn order — see `run_mode_transition`.
    transitions: tokio::sync::Mutex<()>,
}

#[cfg(test)]
impl LightingRuntimeState {
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
}

fn command_status(code: &str, message: &str, details: Option<String>) -> CommandStatus {
    CommandStatus {
        code: code.to_string(),
        message: message.to_string(),
        details,
    }
}

fn make_result(mode: LightingModeConfig, status: CommandStatus) -> LightingModeCommandResult {
    LightingModeCommandResult {
        active: mode.kind != LightingModeKind::Off,
        mode,
        status,
        wled_advisory: None,
    }
}

/// Frame LEDs the mode will emit. Mirrors the worker's own derivation — the
/// 1-LED fallback when calibration is absent is the legacy behaviour, not a
/// mismatch worth reporting, so it is filtered out by the caller.
fn frame_led_count_for(mode: &LightingModeConfig) -> u16 {
    mode.led_calibration
        .as_ref()
        .map(|cal| cal.total_leds)
        .unwrap_or(1)
}

/// Compare the frame the mode will emit against the bound WLED sink.
fn wled_frame_advisory(
    mode: &LightingModeConfig,
    wled_sink: Option<&WledSinkConfig>,
) -> Option<WledLiveFrameAdvisory> {
    let sink = wled_sink?;
    if mode.kind == LightingModeKind::Off {
        return None;
    }
    let frame_led_count = frame_led_count_for(mode);
    if frame_led_count <= 1 || frame_led_count == sink.led_count {
        return None;
    }
    Some(WledLiveFrameAdvisory {
        code: "WLED_LIVE_LED_COUNT_MISMATCH".to_string(),
        message: "The calibrated strip length does not match the LED count reported by the WLED device; part of the strip will not track."
            .to_string(),
        frame_led_count,
        sink_led_count: sink.led_count,
    })
}

fn clamp_u8(value: Option<u8>, fallback: u8) -> u8 {
    value.unwrap_or(fallback)
}

fn clamp_brightness(value: Option<f32>, fallback: f32) -> f32 {
    value.unwrap_or(fallback).clamp(0.0, 1.0)
}

/// Pure parse-only helper. Extracted from `hydrate_led_calibration_from_disk`
/// so unit tests can exercise the JSON-shape contract without spinning up
/// a Tauri AppHandle. The IO-bound wrapper handles the file read; this
/// function owns only the deserialisation contract.
fn parse_led_calibration_from_shell_state(raw: &str) -> Option<LedCalibrationConfig> {
    let root: serde_json::Value = serde_json::from_str(raw).ok()?;
    // Top-level shape: `{ "shell-state": { ...persisted state... } }`.
    let calibration = root.get("shell-state")?.get("ledCalibration")?.clone();
    serde_json::from_value::<LedCalibrationConfig>(calibration).ok()
}

/// Read the raw persisted shell-state JSON file. The frontend `shellStore`
/// writes it via the
/// `tauri-plugin-store` instance whose default file name is
/// `<SHELL_STORE_KEY>.json` (currently `shell-state.json`). Reading the file
/// directly side-steps the plugin-store API surface — the store registers
/// itself lazily inside the Tauri runtime and we don't want to depend on
/// that registration order from a command handler. The trade-off is that
/// we accept the risk of a marginally stale read between an in-flight
/// `shellStore.save` and the next `set_lighting_mode` invoke; this matches
/// the existing windowLifecycle behaviour and is acceptable here because
/// LED calibration mutates only when the user explicitly saves it from
/// the calibration editor.
///
/// Resolution rules — applied in `set_lighting_mode` before
/// `apply_mode_change` runs:
///
/// 1. If the incoming payload already carries a calibration with
///    `total_leds > 1`, keep it — caller-wins.
/// 2. Otherwise read `<app_data_dir>/shell-state.json`, drill into
///    `["shell-state"]["ledCalibration"]`, and deserialise into a
///    `LedCalibrationConfig`. This is the user's persisted setup that
///    the frontend `savedCalibrationRef` should have stamped but
///    evidently does not on every code path.
/// 3. If both are absent, leave `None` so the existing legacy 1-LED
///    fallback inside `apply_mode_change` keeps the v1.3 firmware
///    compat path unchanged.
fn read_persisted_shell_state<R: Runtime>(app: &AppHandle<R>) -> Option<String> {
    let app_data_dir = app.path().app_data_dir().ok()?;
    std::fs::read_to_string(app_data_dir.join("shell-state.json")).ok()
}

/// Every payload hydrator, run by both mode entry points (`set_lighting_mode`
/// and `apply_and_broadcast`). One function so neither can run a subset: when
/// `set_lighting_mode` skipped the output stamps, an unstamped LED-control-popup
/// click restarted a running SK6812 worker onto the WS2812B encoder. `load`
/// is the shell-state reader, injected so the chain is testable without an
/// `AppHandle`; it is only called when a field is actually missing.
fn hydrate_mode_payload(payload: &mut LightingModeConfig, load: &dyn Fn() -> Option<String>) {
    maybe_hydrate_led_calibration(payload, load);
    maybe_hydrate_ambilight_settings(payload, load);
    maybe_hydrate_output_stamps(payload, load);
}

/// Apply backend-side calibration fallback to an incoming
/// `LightingModeConfig`. When the frontend payload is missing
/// `led_calibration` or carries a degenerate `total_leds <= 1`, we read
/// the persisted shell-state and inject the user's saved calibration so
/// the Solid + Ambilight encoders can size USB packets correctly.
///
/// This function is the **only** safety net for frontend payload drops
/// (a v1.5 hardware-repro bug where every Solid frame and every
/// ambilight worker iteration was emitting a 1-LED packet despite the
/// user having a 59-LED calibration on disk). Callers that already
/// own a fully-hydrated payload pay no observable cost — the function
/// short-circuits on the `total_leds > 1` check before touching disk.
fn maybe_hydrate_led_calibration(
    payload: &mut LightingModeConfig,
    load: &dyn Fn() -> Option<String>,
) {
    let payload_total_leds = payload
        .led_calibration
        .as_ref()
        .map(|cal| cal.total_leds)
        .unwrap_or(0);

    if payload_total_leds > 1 {
        return;
    }

    if let Some(persisted) = load().and_then(|raw| parse_led_calibration_from_shell_state(&raw)) {
        if persisted.total_leds > 1 {
            info!(
                "[set_lighting_mode] led_calibration fallback engaged — payload_total_leds={payload_total_leds} disk_total_leds={} (frontend payload missing or degenerate; using persisted shell-state)",
                persisted.total_leds
            );
            payload.led_calibration = Some(persisted);
            return;
        }
    }

    // No usable calibration anywhere. Log so the live diagnostic stream
    // makes the legacy 1-LED fallback path obvious in the terminal.
    if payload_total_leds <= 1 {
        info!(
            "[set_lighting_mode] led_calibration unavailable — payload_total_leds={payload_total_leds} disk_total_leds=0 (legacy 1-LED frame will be emitted)"
        );
    }
}

/// Pure parse-only helper for the persisted `lightingMode.ambilight`
/// payload (v1.5 H1 fix — bug H1). Mirrors the LED-calibration helper
/// above so unit tests can pin the JSON-shape contract without spinning
/// up a Tauri AppHandle.
///
/// The frontend `shellStore` writes the canonical layout:
///
/// ```json
/// {
///   "shell-state": {
///     "lightingMode": {
///       "kind": "ambilight",
///       "ambilight": { "brightness": 1, "saturation": 1.7, ... }
///     }
///   }
/// }
/// ```
fn parse_ambilight_from_shell_state(raw: &str) -> Option<AmbilightPayload> {
    let root: serde_json::Value = serde_json::from_str(raw).ok()?;
    let ambilight = root
        .get("shell-state")?
        .get("lightingMode")?
        .get("ambilight")?
        .clone();
    serde_json::from_value::<AmbilightPayload>(ambilight).ok()
}

/// Apply backend-side ambilight-settings fallback to an incoming
/// `LightingModeConfig` (v1.5 H1 fix — bug H1). Triggers ONLY when
/// `kind == Ambilight` and the payload's `ambilight` field is entirely
/// absent — frontend is source of truth for present-but-default values
/// (a deliberate slider commit at saturation 1.0 must round-trip
/// untouched). This narrow trigger keeps the safety net from masking
/// frontend bugs that would otherwise be visible.
///
/// The frontend `withAmbilightSettings` hydrator already stamps the
/// persisted payload onto every dispatch via `savedAmbilightRef`; this
/// helper is the matching backend recovery path so a single missed
/// frontend stamp (e.g. a future code path that bypasses the hydrator
/// chain) doesn't strip the user's settings down to backend defaults.
fn maybe_hydrate_ambilight_settings(
    payload: &mut LightingModeConfig,
    load: &dyn Fn() -> Option<String>,
) {
    if payload.kind != LightingModeKind::Ambilight {
        return;
    }
    if payload.ambilight.is_some() {
        // Caller-wins: frontend is source of truth for any
        // present-but-default value. Do NOT compare to defaults here.
        return;
    }
    if let Some(persisted) = load().and_then(|raw| parse_ambilight_from_shell_state(&raw)) {
        info!(
            "[set_lighting_mode] ambilight settings fallback engaged — payload.ambilight=None disk.ambilight=Some (frontend payload missing; using persisted shell-state)"
        );
        payload.ambilight = Some(persisted);
    }
}

/// Output stamps a caller may leave off a mode payload. The main window stamps
/// them (`withColorCorrectionAndFirmwareProfile`); the LED control popup does
/// not, and server-built configs have no payload to inherit from — so every
/// entry point hydrates them from the persisted shell state.
#[derive(Default)]
struct PersistedOutputStamps {
    color_correction: Option<ColorCorrectionConfig>,
    firmware_profile: Option<FirmwareProfile>,
    chip_type: Option<LedChipType>,
    color_order: Option<LedColorOrder>,
}

fn parse_output_stamps_from_shell_state(raw: &str) -> PersistedOutputStamps {
    let Ok(root) = serde_json::from_str::<serde_json::Value>(raw) else {
        return PersistedOutputStamps::default();
    };
    let Some(state) = root.get("shell-state") else {
        return PersistedOutputStamps::default();
    };
    let read = |key: &str| state.get(key).cloned();
    PersistedOutputStamps {
        color_correction: read("colorCorrection").and_then(|v| serde_json::from_value(v).ok()),
        firmware_profile: read("firmwareProfile").and_then(|v| serde_json::from_value(v).ok()),
        // The chip picker persists under `selectedChipType`, not `chipType`.
        chip_type: read("selectedChipType").and_then(|v| serde_json::from_value(v).ok()),
        color_order: read("ledColorOrder").and_then(|v| serde_json::from_value(v).ok()),
    }
}

/// Aspect (width / height) of the display the strip surrounds, used to weight
/// the synthetic frame's perimeter. Prefers the user's selected display so it
/// matches the twin overlay, then the primary one; falls back to 16:9.
fn resolve_display_aspect<R: Runtime>(app: &AppHandle<R>) -> f32 {
    let Ok(displays) = list_displays(app.clone()) else {
        return DEFAULT_DISPLAY_ASPECT;
    };
    let selected = app
        .path()
        .app_data_dir()
        .ok()
        .and_then(|dir| std::fs::read_to_string(dir.join("shell-state.json")).ok())
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
        .and_then(|root| {
            root.get("shell-state")?
                .get("selectedDisplayId")?
                .as_str()
                .map(str::to_string)
        });

    let target = selected
        .and_then(|id| displays.iter().find(|d| d.id == id))
        .or_else(|| displays.iter().find(|d| d.is_primary))
        .or_else(|| displays.first());

    match target {
        Some(d) if d.height > 0 => d.width as f32 / d.height as f32,
        _ => DEFAULT_DISPLAY_ASPECT,
    }
}

/// Fill any output stamp the caller left unset from the persisted shell state
/// (caller-wins: a stamp already on the payload is never overwritten).
///
/// Without this a synthetic test drives an SK6812 RGBW strip through the
/// WS2812B encoder and an Adalight controller through the LumaSync v1 header,
/// and drops the user's colour correction entirely — so the test lights
/// nothing, or the wrong colours, on exactly the hardware it exists to verify.
fn maybe_hydrate_output_stamps(
    payload: &mut LightingModeConfig,
    load: &dyn Fn() -> Option<String>,
) {
    if payload.color_correction.is_some()
        && payload.firmware_profile.is_some()
        && payload.chip_type.is_some()
        && payload.color_order.is_some()
    {
        return;
    }
    let Some(raw) = load() else {
        return;
    };
    let stamps = parse_output_stamps_from_shell_state(&raw);
    if payload.color_correction.is_none() {
        payload.color_correction = stamps.color_correction;
    }
    if payload.firmware_profile.is_none() {
        payload.firmware_profile = stamps.firmware_profile;
    }
    if payload.chip_type.is_none() {
        payload.chip_type = stamps.chip_type;
    }
    if payload.color_order.is_none() {
        payload.color_order = stamps.color_order;
    }
    info!(
        "[preview] output stamps hydrated — correction={} profile={:?} chip={:?} order={:?}",
        payload.color_correction.is_some(),
        payload.firmware_profile,
        payload.chip_type,
        payload.color_order,
    );
}

fn normalize_mode_config(config: LightingModeConfig) -> LightingModeConfig {
    let targets = config.targets.clone();
    let display_id = config.display_id.clone();
    let led_calibration = config.led_calibration.clone();
    let color_correction = config.color_correction.clone();
    let firmware_profile = config.firmware_profile;
    let chip_type = config.chip_type;
    let color_order = config.color_order;
    match config.kind {
        LightingModeKind::Off => LightingModeConfig {
            targets,
            display_id,
            color_correction,
            firmware_profile,
            chip_type,
            color_order,
            ..LightingModeConfig::default()
        },
        LightingModeKind::Ambilight => {
            let incoming = config.ambilight.unwrap_or_default();
            LightingModeConfig {
                kind: LightingModeKind::Ambilight,
                solid: None,
                ambilight: Some(AmbilightPayload {
                    brightness: clamp_brightness(Some(incoming.brightness), 1.0),
                    black_border_detection: incoming.black_border_detection,
                    smoothing_alpha: incoming.smoothing_alpha,
                    saturation: incoming.saturation,
                    lighting_smoothing_preset: incoming.lighting_smoothing_preset,
                    hue_intensity_preset: incoming.hue_intensity_preset,
                }),
                targets,
                display_id,
                led_calibration,
                color_correction,
                firmware_profile,
                chip_type,
                color_order,
                // Only the ambilight worker samples by room; Off and Solid drop it.
                room_geometry: config.room_geometry,
            }
        }
        LightingModeKind::Solid => {
            let solid = config.solid.unwrap_or(SolidColorPayload {
                r: 255,
                g: 255,
                b: 255,
                brightness: 1.0,
            });
            LightingModeConfig {
                kind: LightingModeKind::Solid,
                solid: Some(SolidColorPayload {
                    r: clamp_u8(Some(solid.r), 255),
                    g: clamp_u8(Some(solid.g), 255),
                    b: clamp_u8(Some(solid.b), 255),
                    brightness: clamp_brightness(Some(solid.brightness), 1.0),
                }),
                ambilight: None,
                targets,
                display_id,
                led_calibration,
                color_correction,
                firmware_profile,
                chip_type,
                color_order,
                room_geometry: None,
            }
        }
    }
}

fn push_trace(trace: &mut Option<&mut Vec<&'static str>>, step: &'static str) {
    if let Some(events) = trace.as_mut() {
        events.push(step);
    }
}

/// Records the newly active serial port, releasing the previous port's
/// cached session first if it differs. Same-port overwrites (a mode
/// restart on the port already in use) are left untouched — that is the
/// DTR invariant `stop_previous` also protects, see
/// docs/architecture/device-output.md (DTR reset). Only a genuine port
/// *switch* should release a handle, so an abandoned port can be opened by
/// another app (e.g. the Arduino IDE) instead of staying locked until
/// LumaSync quits.
fn set_active_port(owner: &mut LightingRuntimeOwner, new_port: String) {
    if owner.active_port.as_deref() != Some(new_port.as_str()) {
        if let Some(old_port) = owner.active_port.take() {
            owner.output_bridge.disconnect_session(&old_port);
        }
    }
    owner.active_port = Some(new_port);
}

fn stop_previous(owner: &mut LightingRuntimeOwner, trace: &mut Option<&mut Vec<&'static str>>) {
    push_trace(trace, "stop_previous");
    let t0 = std::time::Instant::now();
    owner.ambilight_live = None;
    owner.room_geometry_live = None;
    let had_worker = owner.worker.is_some();
    if let Some(worker) = owner.worker.take() {
        worker.stop();
    }
    // Do NOT close the cached serial port handle here — reopening the port
    // toggles DTR and resets the MCU before the packet lands. See
    // docs/architecture/device-output.md (DTR reset).
    // `active_port` is deliberately kept: it is the only record of which port
    // holds a cached session, and `set_active_port` needs it after this stop
    // to release that port when the next mode switches to a different one.
    let total_ms = t0.elapsed().as_millis();
    info!(
        "[stop_previous] completed in {total_ms}ms had_worker={had_worker} last_port={:?} (cached serial session preserved to avoid DTR-reset cycle)",
        owner.active_port
    );
}

/// Periodically caches detected black border insets for the ambilight worker.
///
/// Detection runs at most once every `UPDATE_INTERVAL` to avoid per-frame overhead.
/// When disabled all insets remain zero (full-frame sampling).
struct BlackBorderCache {
    insets: BlackBorderInsets,
    last_updated: Instant,
    enabled: bool,
}

impl BlackBorderCache {
    const UPDATE_INTERVAL: Duration = Duration::from_millis(2500);

    fn new(enabled: bool) -> Self {
        // Subtract the interval so the very first frame triggers a detection pass.
        let past = Instant::now()
            .checked_sub(Self::UPDATE_INTERVAL)
            .unwrap_or_else(Instant::now);
        Self {
            insets: BlackBorderInsets::default(),
            last_updated: past,
            enabled,
        }
    }

    fn set_enabled(&mut self, enabled: bool) {
        if self.enabled != enabled {
            self.enabled = enabled;
            if !enabled {
                self.insets = BlackBorderInsets::default();
            }
        }
    }

    fn update_if_due(&mut self, frame: &CapturedFrame) {
        if !self.enabled {
            self.insets = BlackBorderInsets::default();
            return;
        }
        if self.last_updated.elapsed() >= Self::UPDATE_INTERVAL {
            self.insets = detect_black_borders(frame, BLACK_BORDER_THRESHOLD);
            self.last_updated = Instant::now();
        }
    }

    fn insets(&self) -> &BlackBorderInsets {
        &self.insets
    }
}

/// Continuous position-based colour sampling for Hue entertainment channels.
///
/// Instead of mapping to 5 discrete regions (Top/Bottom/Left/Right/Center),
/// this uses the channel's exact (x, y) position to define a sampling window
/// on the screen. Channels at different positions always sample different areas,
/// even when positions are close together.
///
/// Coordinate system:
///   x: -1.0 (left edge) ... +1.0 (right edge)
///   y: -1.0 (bottom edge) ... +1.0 (top edge)
///
/// The sampling window is 30% of content area dimensions, centered on the
/// position. Sub-sampled every 8 pixels for speed.
fn sample_screen_position_avg(
    frame: &CapturedFrame,
    pos_x: f32,
    pos_y: f32,
    insets: &BlackBorderInsets,
) -> (u8, u8, u8) {
    let w = frame.width as usize;
    let h = frame.height as usize;
    if w == 0 || h == 0 || frame.pixels_rgb.is_empty() {
        return (0, 0, 0);
    }

    const WINDOW_FRAC: f32 = 0.30; // 30% of content dimension
    const STEP: usize = 8;

    // Content area bounds (excluding black borders).
    let ct = (h as f32 * insets.top) as usize;
    let cb = h
        .saturating_sub((h as f32 * insets.bottom) as usize)
        .max(ct + 1);
    let cl = (w as f32 * insets.left) as usize;
    let cr = w
        .saturating_sub((w as f32 * insets.right) as usize)
        .max(cl + 1);
    let cw = (cr - cl) as f32;
    let ch = (cb - ct) as f32;

    // Map Hue position [-1, +1] to content area.
    // x: -1 → left edge, +1 → right edge
    // y: +1 → top edge (screen row 0), -1 → bottom edge
    let norm_x = (pos_x.clamp(-1.0, 1.0) + 1.0) / 2.0; // [0, 1]
    let norm_y = (1.0 - pos_y.clamp(-1.0, 1.0)) / 2.0; // [0, 1], flipped for screen coords

    let center_col = cl as f32 + norm_x * cw;
    let center_row = ct as f32 + norm_y * ch;

    let half_w = (cw * WINDOW_FRAC / 2.0).max(1.0);
    let half_h = (ch * WINDOW_FRAC / 2.0).max(1.0);

    let row_start = (center_row - half_h).max(ct as f32) as usize;
    let row_end = (center_row + half_h).min(cb as f32) as usize;
    let col_start = (center_col - half_w).max(cl as f32) as usize;
    let col_end = (center_col + half_w).min(cr as f32) as usize;

    let mut sum_r = 0u32;
    let mut sum_g = 0u32;
    let mut sum_b = 0u32;
    let mut count = 0u32;

    let mut row = row_start;
    while row < row_end {
        let mut col = col_start;
        while col < col_end {
            if let Some(pixel) = frame.pixels_rgb.get(row * w + col) {
                sum_r += u32::from(pixel[0]);
                sum_g += u32::from(pixel[1]);
                sum_b += u32::from(pixel[2]);
                count += 1;
            }
            col += STEP;
        }
        row += STEP;
    }

    if count == 0 {
        return (0, 0, 0);
    }
    (
        (sum_r / count) as u8,
        (sum_g / count) as u8,
        (sum_b / count) as u8,
    )
}

// ---------------------------------------------------------------------------
// Edge signal — per-LED feed for the LED twin overlay
// ---------------------------------------------------------------------------
//
// The twin overlay is the only listener, so the worker builds and emits this
// only while a twin is open (`LedTwinState::preview_active`).

pub const EDGE_SIGNAL_EVENT: &str = "ambilight://edge-signal";
/// ~30 Hz: at the top pattern speed a slower cadence lets the comet head travel
/// further per frame than its own tail, leaving visible gaps in the twin.
pub const EDGE_SIGNAL_PREVIEW_INTERVAL_MS: u64 = 33;

/// Sampling box for live capture — deliberately wide so screen noise averages out.
pub const LIVE_SAMPLE_WINDOW: f32 = 0.05;
/// Sampling box for synthetic test frames. Must stay NARROWER than one LED's
/// pitch or neighbouring LEDs blend into each other and no LED can reach the
/// intensity the pattern asked for.
pub const SYNTHETIC_SAMPLE_WINDOW: f32 = 0.0125;

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

/// Apply luminance-preserving saturation to an RGB triple.
///
/// `factor`:
///   - 1.0  → identity (returns input unchanged)
///   - <1.0 → desaturate (pulls toward gray at luminance L)
///   - >1.0 → saturate (pushes away from gray)
///
/// Luminance formula: `L = 0.299·R + 0.587·G + 0.114·B` (Rec.601).
/// New channel: `C' = L + factor · (C - L)`, clamped to `[0, 255]`.
#[inline]
fn apply_saturation_rgb(rgb: (u8, u8, u8), factor: f32) -> (u8, u8, u8) {
    if (factor - 1.0).abs() < f32::EPSILON {
        return rgb;
    }
    let r = rgb.0 as f32;
    let g = rgb.1 as f32;
    let b = rgb.2 as f32;
    let l = 0.299 * r + 0.587 * g + 0.114 * b;
    let nr = l + factor * (r - l);
    let ng = l + factor * (g - l);
    let nb = l + factor * (b - l);
    (
        nr.round().clamp(0.0, 255.0) as u8,
        ng.round().clamp(0.0, 255.0) as u8,
        nb.round().clamp(0.0, 255.0) as u8,
    )
}

#[inline]
fn apply_saturation_inplace(colors: &mut [[u8; 3]], factor: f32) {
    if (factor - 1.0).abs() < f32::EPSILON {
        return;
    }
    for c in colors.iter_mut() {
        let (r, g, b) = apply_saturation_rgb((c[0], c[1], c[2]), factor);
        c[0] = r;
        c[1] = g;
        c[2] = b;
    }
}

struct AmbilightWorkerQualityState {
    controller: RuntimeQualityController,
}

impl AmbilightWorkerQualityState {
    fn new(config: RuntimeQualityConfig) -> Self {
        Self {
            controller: RuntimeQualityController::new(config),
        }
    }

    fn set_smoothing_alpha(&mut self, alpha: f32) {
        self.controller.set_smoothing_alpha(alpha);
    }

    fn queue_processed_frame(
        &mut self,
        slot: &mut RuntimeFrameSlot,
        sampled_frame: &[[u8; 3]],
    ) -> bool {
        slot.push(self.controller.smooth(sampled_frame))
    }

    fn try_send_latest<F>(
        &mut self,
        slot: &mut RuntimeFrameSlot,
        now: Instant,
        mut send_frame: F,
    ) -> Result<bool, String>
    where
        F: FnMut(&[[u8; 3]]) -> Result<(), String>,
    {
        if !self.controller.should_send_now(now) {
            return Ok(false);
        }

        let Some(frame) = slot.take_latest() else {
            return Ok(false);
        };

        send_frame(frame.as_slice())?;
        Ok(true)
    }

    fn observe_capture_and_send_cost(&mut self, capture_ms: f32, send_ms: f32) {
        self.controller.observe_timing(capture_ms, send_ms);
    }

    fn observed_cost_ms(&self) -> f32 {
        self.controller.observed_cost_ms()
    }

    fn last_smoothed(&self) -> &[[u8; 3]] {
        self.controller.last_smoothed()
    }

    fn current_send_interval(&self) -> Duration {
        self.controller.current_send_interval()
    }
}

// ---------------------------------------------------------------------------
// Hue per-channel EWMA smoother
// ---------------------------------------------------------------------------
// Maintains a smoothed (r, g, b) per Hue entertainment channel.  Operates
// independently from the USB LED smoothing (RuntimeQualityController) so that
// Hue-only and mixed modes both get correct temporal smoothing.

struct HueChannelSmoother {
    previous: Vec<(f32, f32, f32)>,
    /// Reusable buffer for the rounded u8 output — avoids per-frame allocation.
    result: Vec<(u8, u8, u8)>,
}

impl HueChannelSmoother {
    fn new() -> Self {
        Self {
            previous: Vec::new(),
            result: Vec::new(),
        }
    }

    /// Apply EWMA smoothing to incoming channel colors, returning a reference
    /// to an internal buffer (zero allocation on the steady-state path).
    ///
    /// `alpha` in `[0.05, 1.0]`:
    ///   - 1.0 = no smoothing (output equals input)
    ///   - 0.05 = very slow, gradual transitions
    fn smooth(&mut self, incoming: &[(u8, u8, u8)], alpha: f32) -> &[(u8, u8, u8)] {
        let a = alpha.clamp(0.05, 1.0);

        // Channel count changed → reset state (e.g. entertainment area switched).
        if self.previous.len() != incoming.len() {
            self.previous = incoming
                .iter()
                .map(|&(r, g, b)| (r as f32, g as f32, b as f32))
                .collect();
            self.result = incoming.to_vec();
            return &self.result;
        }

        // Reuse result buffer (same capacity across frames).
        self.result.resize(incoming.len(), (0, 0, 0));
        for (i, (prev, &(tr, tg, tb))) in self.previous.iter_mut().zip(incoming.iter()).enumerate()
        {
            prev.0 += a * (tr as f32 - prev.0);
            prev.1 += a * (tg as f32 - prev.1);
            prev.2 += a * (tb as f32 - prev.2);
            self.result[i] = (
                prev.0.round().clamp(0.0, 255.0) as u8,
                prev.1.round().clamp(0.0, 255.0) as u8,
                prev.2.round().clamp(0.0, 255.0) as u8,
            );
        }
        &self.result
    }
}

/// Below this many frames per second the ambient effect visibly steps, so the
/// serial budget is worth surfacing rather than silently absorbing.
const LINK_CONSTRAINED_FPS: f32 = 30.0;

/// Resolved 115 200-baud send budget for one calibrated strip.
///
/// Exists so the clamp arithmetic is unit-testable away from the worker.
#[derive(Clone, Copy, Debug, PartialEq)]
struct SerialSendBudget {
    /// Total on-wire size of one frame, header included.
    bytes_per_frame: usize,
    /// Interval the LED-count heuristic asks for, before the physical clamp.
    requested_ms: u64,
    /// Time the link physically needs to shift one frame — the hard floor.
    wire_ms: u64,
    link_max_fps: f32,
}

impl SerialSendBudget {
    fn for_strip(total_leds: u16, profile: FirmwareProfile, chip_type: LedChipType) -> Self {
        let bytes_per_pixel = WirePixelLayout::for_output(profile, chip_type).bytes_per_pixel();
        Self {
            bytes_per_frame: frame_wire_bytes(total_leds, bytes_per_pixel),
            requested_ms: derive_base_interval_ms_for(total_leds, bytes_per_pixel) as u64,
            wire_ms: frame_wire_time_ms(total_leds, bytes_per_pixel),
            link_max_fps: link_max_fps(total_leds, bytes_per_pixel),
        }
    }

    /// True when the LED-count heuristic asks for a rate the link cannot carry.
    /// Holds even for a 1 ms shortfall, so it drives the clamp, not the log.
    fn exceeds_link_budget(self) -> bool {
        self.requested_ms < self.wire_ms
    }

    /// True when the strip is long enough that 115 200 baud materially degrades
    /// the effect — worth telling the user about, unlike a 1 ms rounding clamp.
    /// ~126 LEDs on GRB, ~94 on RGBW.
    fn is_link_constrained(self) -> bool {
        self.link_max_fps < LINK_CONSTRAINED_FPS
    }

    fn into_quality_config(self, smoothing_alpha: f32) -> RuntimeQualityConfig {
        // `wire_ms` pins BOTH bounds: the 10 fps floor in the derive helper and
        // the 80 ms default cap each breach the baud budget on a long strip.
        let default_max_ms = RuntimeQualityConfig::default().max_interval_ms;
        RuntimeQualityConfig {
            base_interval_ms: self.requested_ms,
            min_interval_ms: self.wire_ms,
            max_interval_ms: default_max_ms.max(self.wire_ms),
            smoothing_alpha,
            ..RuntimeQualityConfig::default()
        }
    }
}

/// Worker-side handle for the resolved `UsbOutputPlan` — dispatches to
/// whichever concrete sink is active. `SerialSink` keeps applying colour
/// correction + brightness inside its own `send_frame` (wire header owns
/// brightness); `CorrectedWledSink` does the equivalent host-side since
/// DDP/WARLS have no brightness field.
enum ActiveUsbSink {
    Serial(SerialSink),
    // Boxed: `CorrectedWledSink` carries a `GammaLuts` (768 bytes) inline,
    // which would otherwise bloat every `ActiveUsbSink` (including the much
    // more common `Serial` variant) to match its size.
    Wled(Box<CorrectedWledSink>),
}

impl ActiveUsbSink {
    fn start(&mut self) -> Result<(), String> {
        match self {
            Self::Serial(s) => s.start(),
            Self::Wled(s) => s.start(),
        }
    }

    fn set_brightness(&mut self, brightness: f32) {
        match self {
            Self::Serial(s) => s.set_brightness(brightness),
            Self::Wled(s) => s.set_brightness(brightness),
        }
    }

    /// WLED owns its colour order on the device, so only serial reorders.
    fn set_color_order(&mut self, order: LedColorOrder) {
        match self {
            Self::Serial(s) => s.set_color_order(order),
            Self::Wled(_) => {}
        }
    }

    fn send_frame(&mut self, colors: &[[u8; 3]]) -> Result<(), String> {
        match self {
            Self::Serial(s) => s.send_frame(colors),
            Self::Wled(s) => s.send_frame(colors),
        }
    }

    fn stop(&mut self) -> Result<(), String> {
        match self {
            Self::Serial(s) => s.stop(),
            Self::Wled(s) => s.stop(),
        }
    }
}

/// Resolve the worker's send cadence for its resolved USB-channel sink.
///
/// Pure and side-effect free (besides logging) so the WLED-vs-serial budget
/// divergence is unit-testable without spinning up a worker thread: only a
/// real serial link is bound by the 115 200-baud budget; WLED rides UDP and
/// gets the same capture-paced defaults as a Hue-only session, and the
/// returned `SerialSendBudget` is `None` in both non-serial cases so the
/// caller's telemetry `link_max_fps` stays at its `0.0` "no serial link"
/// default.
fn resolve_quality_config(
    usb_plan: &Option<UsbOutputPlan>,
    total_leds: u16,
    profile: FirmwareProfile,
    chip_type: LedChipType,
    smoothing_alpha: f32,
) -> (RuntimeQualityConfig, Option<SerialSendBudget>) {
    match usb_plan {
        Some(UsbOutputPlan::Serial(_)) => {
            let budget = SerialSendBudget::for_strip(total_leds, profile, chip_type);
            if budget.is_link_constrained() {
                warn!(
                    "[ambilight-worker] strip exceeds the 115 200-baud budget — \
                     leds={total_leds} profile={profile:?} chip={chip_type:?} bytes_per_frame={} \
                     link_max_fps={:.1} (below {LINK_CONSTRAINED_FPS:.0}); \
                     send interval clamped to {}ms. Shorten the strip or split it \
                     across controllers for a smoother effect.",
                    budget.bytes_per_frame, budget.link_max_fps, budget.wire_ms
                );
            } else {
                info!(
                    "[ambilight-worker] serial budget — leds={total_leds} profile={profile:?} chip={chip_type:?} \
                     bytes_per_frame={} link_max_fps={:.1} send_interval={}ms clamped={}",
                    budget.bytes_per_frame,
                    budget.link_max_fps,
                    budget.requested_ms.max(budget.wire_ms),
                    budget.exceeds_link_budget()
                );
            }
            (budget.into_quality_config(smoothing_alpha), Some(budget))
        }
        Some(UsbOutputPlan::Wled(_)) => {
            // No baud budget to clamp against -- let capture-cost pacing
            // govern the rate via the plain defaults (~60 fps target).
            info!("[ambilight-worker] wled sink — unconstrained by a serial link budget");
            let config = RuntimeQualityConfig {
                smoothing_alpha,
                ..RuntimeQualityConfig::default()
            };
            (config, None)
        }
        None => {
            // Hue-only path. Bridge enforces 50 ms minimum (20 Hz); target
            // ~25 FPS capture to stay just above the send rate without
            // flooding the queue.
            let config = RuntimeQualityConfig {
                base_interval_ms: 40,
                min_interval_ms: 30,
                max_interval_ms: 100,
                smoothing_alpha,
                ..RuntimeQualityConfig::default()
            };
            (config, None)
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn start_ambilight_worker(
    output_bridge: LedOutputBridge,
    usb_plan: Option<UsbOutputPlan>,
    led_calibration: Option<LedCalibrationConfig>,
    live_settings: Arc<AmbilightLiveSettings>,
    frame_source: Box<dyn AmbilightFrameSource>,
    telemetry_snapshot: SharedRuntimeTelemetry,
    hue_output: Option<HueActiveOutputContext>,
    edge_signal_emitter: Option<EdgeSignalEmitter>,
    color_correction: ColorCorrectionConfig,
    firmware_profile: FirmwareProfile,
    chip_type: LedChipType,
    preview: Option<PreviewEmitContext>,
    room_geometry: Arc<RoomGeometryLive>,
) -> Result<LightingWorkerRuntime, String> {
    let mut frame_source = frame_source;
    // macOS SCStream (and Windows WGC) deliver the first frame asynchronously.
    // Retry for up to ~1 s to give the capture session time to warm up.
    let initial_frame = {
        const MAX_ATTEMPTS: u32 = 20;
        const RETRY_MS: u64 = 50;
        let mut last_err = String::new();
        let mut found = None;
        for _ in 0..MAX_ATTEMPTS {
            match frame_source.capture_frame() {
                Ok(frame) => {
                    found = Some(frame);
                    break;
                }
                Err(
                    crate::commands::ambilight_capture::AmbilightCaptureError::FrameUnavailable,
                ) => {
                    last_err = "AMBILIGHT_CAPTURE_FRAME_UNAVAILABLE".to_string();
                    thread::sleep(Duration::from_millis(RETRY_MS));
                }
                Err(other) => return Err(other.as_reason()),
            }
        }
        found.ok_or(last_err)?
    };
    // Per-LED calibration: build the strip sequence once at worker start.
    // Each iteration calls sample_frame_for_sequence to produce per-LED colours
    // from edge regions of the captured frame.
    // When led_calibration is absent we fall back to a minimal 1-LED sequence
    // so the legacy single-zone firmware path keeps working unchanged.
    let (led_sequence, led_counts, total_leds) = if let Some(ref cal) = led_calibration {
        let seq = build_led_sequence(cal);
        let counts = cal.counts.clone();
        let n = cal.total_leds;
        (seq, counts, n)
    } else {
        // Fallback: 1 LED centred on screen (backward-compat with v1.3 firmware).
        use super::led_calibration::LedSegmentCounts as Counts;
        let fallback_cal = LedCalibrationConfig {
            template_id: None,
            counts: Counts {
                top: 1,
                right: 0,
                bottom: 0,
                left: 0,
            },
            bottom_missing: 0,
            corner_ownership: "horizontal".to_string(),
            visual_preset: "subtle".to_string(),
            start_anchor: "top-start".to_string(),
            direction: "cw".to_string(),
            total_leds: 1,
        };
        (build_led_sequence(&fallback_cal), fallback_cal.counts, 1u16)
    };
    info!(
        "[start_ambilight_worker] led sequence resolved — total_leds={total_leds} sequence_len={} calibration_present={}",
        led_sequence.len(),
        led_calibration.is_some()
    );

    let hue_only = usb_plan.is_none() && hue_output.is_some();
    let initial_smoothing_alpha = live_settings.read_smoothing_alpha();
    let (quality_config, serial_budget) = resolve_quality_config(
        &usb_plan,
        total_leds,
        firmware_profile,
        chip_type,
        initial_smoothing_alpha,
    );
    let mut quality_state = AmbilightWorkerQualityState::new(quality_config);
    let mut frame_slot = RuntimeFrameSlot::new();
    let mut telemetry_window = RuntimeTelemetryWindow::new(Instant::now());
    // Deliberately gated on `serial_budget`, not `usb_plan` -- a WLED-only
    // session must report `link_max_fps: 0.0` / unconstrained, the same as
    // a Hue-only session (see contract note on `RuntimeTelemetrySnapshot`).
    if let Some(budget) = serial_budget {
        telemetry_window.set_link_budget(budget.link_max_fps, budget.is_link_constrained());
    }

    let mut initial_frame_source =
        StaticFrameSource::new(Arc::try_unwrap(initial_frame).unwrap_or_else(|arc| (*arc).clone()));
    // No border detection for the initial warmup frame — detection runs in the worker loop.
    let initial_raw = initial_frame_source
        .capture_frame()
        .map_err(|e| e.as_reason())?;
    AMBILIGHT_CAPTURE_ATTEMPTS.fetch_add(1, Ordering::SeqCst);
    // A synthetic test paints exact per-LED blocks; the live 0.05 box is wider
    // than the whole comet, so it averaged in unlit screen and dimmed the head.
    let sample_window = if preview.as_ref().is_some_and(|ctx| ctx.source == "test") {
        SYNTHETIC_SAMPLE_WINDOW
    } else {
        LIVE_SAMPLE_WINDOW
    };
    let initial_sampled =
        sample_frame_for_sequence(&initial_raw, &led_sequence, &led_counts, sample_window);
    telemetry_window.record_capture();
    if quality_state.queue_processed_frame(&mut frame_slot, initial_sampled.as_slice()) {
        telemetry_window.record_slot_overwrite();
    }

    // Built once at worker start; brightness and colour order are synced each
    // iteration via `set_brightness` / `set_color_order` before `send_frame`.
    let mut usb_sink: Option<ActiveUsbSink> = usb_plan.as_ref().map(|plan| match plan {
        UsbOutputPlan::Serial(port) => ActiveUsbSink::Serial(SerialSink::with_chip_type(
            output_bridge.clone(),
            Some(port.clone()),
            live_settings.read_brightness(),
            firmware_profile,
            color_correction.clone(),
            chip_type,
        )),
        UsbOutputPlan::Wled(cfg) => ActiveUsbSink::Wled(Box::new(CorrectedWledSink::new(
            cfg.build(),
            color_correction.clone(),
        ))),
    });
    if let Some(ref mut sink) = usb_sink {
        sink.start()?;
    }

    let send_started = Instant::now();
    if usb_sink.is_some() {
        let initial_brightness = live_settings.read_brightness();
        if let Some(ref mut sink) = usb_sink {
            sink.set_brightness(initial_brightness);
            sink.set_color_order(live_settings.read_color_order());
        }
        let initial_sent =
            quality_state.try_send_latest(&mut frame_slot, Instant::now(), |frame| {
                AMBILIGHT_FRAME_ATTEMPTS.fetch_add(1, Ordering::SeqCst);
                if let Some(ref mut s) = usb_sink {
                    s.send_frame(frame)
                } else {
                    Ok(())
                }
            })?;
        if initial_sent {
            telemetry_window.record_send();
        }
    }
    // Hue-only: no initial USB send needed, just apply Hue from capture
    quality_state.observe_capture_and_send_cost(0.0, send_started.elapsed().as_secs_f32() * 1000.0);
    telemetry_window.record_latency(quality_state.observed_cost_ms());
    telemetry_window.flush_if_due(Instant::now(), &telemetry_snapshot)?;

    let cancel = Arc::new(AtomicBool::new(false));
    let cancel_flag = Arc::clone(&cancel);

    // Wrap the frame source in Arc<Mutex<...>> so ownership stays on the command
    // thread. The worker receives only a clone (refcount=2). When the worker loop
    // exits it drops its clone (refcount→1). Then LightingWorkerRuntime::stop()
    // drops `self` from the command thread, dropping the last Arc (refcount→0) and
    // calling SCStream::stop_capture safely — never from the worker thread.
    let frame_source_arc: Arc<Mutex<Box<dyn AmbilightFrameSource>>> =
        Arc::new(Mutex::new(frame_source));
    let worker_source = Arc::clone(&frame_source_arc);

    let handle = thread::spawn(move || {
        ACTIVE_AMBILIGHT_WORKERS.fetch_add(1, Ordering::SeqCst);
        let has_hue = hue_output
            .as_ref()
            .map(|c| !c.channels.is_empty())
            .unwrap_or(false);
        info!(
            "[ambilight-worker] started — sink={:?} chip={:?} hue={} channels={}",
            usb_plan,
            chip_type,
            has_hue,
            hue_output.as_ref().map(|c| c.channels.len()).unwrap_or(0)
        );
        if let Some(ctx) = hue_output.as_ref() {
            for ch in &ctx.channels {
                let norm_x = (ch.position_x.clamp(-1.0, 1.0) + 1.0) / 2.0;
                let norm_y = (1.0 - ch.position_y.clamp(-1.0, 1.0)) / 2.0;
                info!("[ambilight-worker] hue ch#{} bridge_pos=({:.3},{:.3}) z={:?} screen_norm=({:.1}%,{:.1}%) region={:?}",
                    ch.channel_id, ch.position_x, ch.position_y, ch.position_z,
                    norm_x * 100.0, norm_y * 100.0, ch.screen_region);
            }
        }
        let mut hue_send_count = 0u32;
        // Mirror of `hue_send_count` for the USB sink so live-debug sessions
        // can confirm full-strip frames are reaching the wire (e.g. byte
        // count, led_count) without flooding stdout at 60 Hz.
        let mut usb_send_count = 0u32;
        // Scene-adaptive stage (docs/architecture/capture-and-pipeline.md). Off
        // for synthetic test frames, which must reach the strip exactly as
        // painted, and under LUMASYNC_AMBILIGHT_LEGACY=1 for A/B bisecting.
        let scene_enabled = preview.as_ref().is_none_or(|ctx| ctx.source != "test")
            && std::env::var("LUMASYNC_AMBILIGHT_LEGACY").map_or(true, |v| v != "1");
        let mut pipeline = AmbilightFramePipeline::new(FramePipelineConfig {
            led_sequence,
            led_counts,
            sample_window,
            scene_enabled,
            strip_topology: strip_topology_for(led_calibration.as_ref()),
            hue_channels: hue_output.as_ref().map(|ctx| ctx.channels.clone()),
            room_geometry,
            black_border_detection: live_settings.read_black_border_detection(),
            color_correction,
        });
        info!(
            "[ambilight-worker] scene-adaptive stage {}",
            if scene_enabled { "on" } else { "off" }
        );

        let mut capture_fail_count = 0u32;
        let mut last_edge_emit_at: Option<Instant> = None;
        // v1.6 LED Preview — monotonic frame seq + last per-Hue-channel colours
        // for the enriched edge-signal (only stamped while a preview is active).
        let mut edge_seq: u64 = 0;
        let mut last_hue_colors: Option<Vec<[u8; 3]>> = None;
        while !cancel_flag.load(Ordering::Relaxed) {
            let capture_started = Instant::now();
            let capture_result: Result<(Arc<CapturedFrame>, Vec<[u8; 3]>), String> =
                match worker_source.lock() {
                    Ok(mut src) => {
                        AMBILIGHT_CAPTURE_ATTEMPTS.fetch_add(1, Ordering::SeqCst);
                        src.capture_frame().map_err(|e| e.as_reason()).map(|frame| {
                            let colors = pipeline.sample_strip(&frame);
                            (frame, colors)
                        })
                    }
                    Err(_) => Err("AMBILIGHT_CAPTURE_FRAME_LOCK_FAILED".to_string()),
                };
            if let Err(ref e) = capture_result {
                capture_fail_count += 1;
                if capture_fail_count <= 5 || capture_fail_count.is_multiple_of(50) {
                    warn!("[ambilight-worker] capture failed #{capture_fail_count}: {e}");
                }
                // The success branch owns the only other flush, so without this
                // one a sustained outage freezes telemetry at the last good frame.
                telemetry_window.record_capture_error(e, Instant::now());
                let _ = telemetry_window.flush_if_due(Instant::now(), &telemetry_snapshot);
            }
            if let Ok((raw_frame, sampled)) = capture_result {
                // Sync live-tunable settings from shared atomic state (zero-cost on hot path).
                let brightness = live_settings.read_brightness();
                let color_order = live_settings.read_color_order();
                let settings = FrameSettings {
                    black_border_detection: live_settings.read_black_border_detection(),
                    alpha_ceiling: live_settings.read_smoothing_alpha(),
                    saturation: live_settings.read_saturation(),
                };
                // Compute only, Hue channels included; the sends below keep
                // their order (USB, then Hue).
                let step = pipeline.process(
                    &raw_frame,
                    sampled,
                    settings,
                    &mut quality_state,
                    &mut frame_slot,
                );
                let capture_ms = step
                    .analyzed_at
                    .duration_since(capture_started)
                    .as_secs_f32()
                    * 1000.0;
                telemetry_window.record_capture();
                if step.slot_overwritten {
                    telemetry_window.record_slot_overwrite();
                }

                let send_started = Instant::now();
                let send_ms = if usb_sink.is_some() {
                    // USB send path: sync brightness then dispatch via LedSink trait.
                    if let Some(ref mut sink) = usb_sink {
                        sink.set_brightness(brightness);
                        sink.set_color_order(color_order);
                    }
                    // Capture the per-frame led_count for the diagnostic log
                    // BEFORE handing the slice to the closure (the closure
                    // consumes &[[u8;3]] but we only want the count).
                    let mut last_usb_led_count: usize = 0;
                    match quality_state.try_send_latest(&mut frame_slot, Instant::now(), |frame| {
                        AMBILIGHT_FRAME_ATTEMPTS.fetch_add(1, Ordering::SeqCst);
                        last_usb_led_count = frame.len();
                        if let Some(ref mut s) = usb_sink {
                            s.send_frame(frame)
                        } else {
                            Ok(())
                        }
                    }) {
                        Ok(true) => {
                            telemetry_window.record_send();
                            // LumaSync v1 wire format: 5-byte header
                            // (magic + brightness + count_le) + RGB payload
                            // (3 bytes per LED) + 1-byte XOR. Adalight's
                            // 6-byte header without the brightness byte
                            // produces a slightly different total — the log
                            // assumes LumaSyncV1 (the production default)
                            // and is observability-only, not load-bearing.
                            let usb_bytes_estimate =
                                5usize + last_usb_led_count.saturating_mul(3) + 1;
                            usb_send_count += 1;
                            if usb_send_count <= 3 || usb_send_count.is_multiple_of(200) {
                                info!(
                                    "[ambilight-worker] usb update #{usb_send_count} — bytes={usb_bytes_estimate} led_count={last_usb_led_count}"
                                );
                            }
                            send_started.elapsed().as_secs_f32() * 1000.0
                        }
                        _ => 0.0,
                    }
                } else {
                    // Hue-only path: skip the USB quality gate entirely.
                    // The real Hue send happens below via apply_hue_channels_with_context,
                    // which has its own 50ms rate-limit in the DTLS sender thread.
                    // We just drain the slot to prevent indefinite overwrite accumulation.
                    let _ = frame_slot.take_latest();
                    0.0
                };

                // Hue update: sample raw screen regions, apply per-channel EWMA
                // smoothing (both in `pipeline.process`), then send every frame to
                // the bridge. Sending every frame (instead of delta-skipping) lets
                // the bridge's internal ~100ms hardware interpolation produce
                // smooth gradients.
                let enrich_preview = preview.as_ref().is_some_and(|ctx| ctx.should_enrich());

                if let (Some(context), Some(smoothed)) = (hue_output.as_ref(), step.hue_colors) {
                    hue_send_count += 1;
                    if hue_send_count <= 3 || hue_send_count.is_multiple_of(200) {
                        info!(
                            "[ambilight-worker] hue update #{hue_send_count} — colors: {:?}",
                            &smoothed[..smoothed.len().min(3)]
                        );
                    }
                    // Only the enriched edge-signal reads this; allocating it
                    // unconditionally burned a Vec per frame at up to 60 Hz.
                    if enrich_preview {
                        last_hue_colors =
                            Some(smoothed.iter().map(|&(r, g, b)| [r, g, b]).collect());
                    }
                    let _ = apply_hue_channels_with_context(context, smoothed.to_vec(), brightness);
                    telemetry_window.record_send();
                }

                quality_state.observe_capture_and_send_cost(capture_ms, send_ms);
                telemetry_window.record_latency(quality_state.observed_cost_ms());
                let _ = telemetry_window.flush_if_due(Instant::now(), &telemetry_snapshot);

                // Twin-overlay feed. With no twin open this is skipped whole —
                // no buffer, no serialisation, no IPC.
                let twin_feed = edge_signal_emitter
                    .as_ref()
                    .zip(preview.as_ref().filter(|_| enrich_preview));
                if let Some((emitter, ctx)) = twin_feed {
                    let now = Instant::now();
                    let due = last_edge_emit_at
                        .map(|prev| {
                            now.duration_since(prev)
                                >= Duration::from_millis(EDGE_SIGNAL_PREVIEW_INTERVAL_MS)
                        })
                        .unwrap_or(true);
                    if due {
                        let leds: Vec<[u8; 3]> = quality_state
                            .last_smoothed()
                            .iter()
                            .map(|&[r, g, b]| {
                                let (cr, cg, cb) = pipeline.correct_rgb((r, g, b));
                                [
                                    (cr as f32 * brightness).round().clamp(0.0, 255.0) as u8,
                                    (cg as f32 * brightness).round().clamp(0.0, 255.0) as u8,
                                    (cb as f32 * brightness).round().clamp(0.0, 255.0) as u8,
                                ]
                            })
                            .collect();
                        edge_seq = edge_seq.wrapping_add(1);
                        emitter(EdgeSignalPayload {
                            led_count: leds.len(),
                            leds,
                            hue_channels: last_hue_colors.clone(),
                            source: ctx.source,
                            pattern: ctx.pattern,
                            seq: edge_seq,
                            display_id: ctx.display_id.clone(),
                        });
                        last_edge_emit_at = Some(now);
                    }
                }
            }

            let interval_ms = quality_state.current_send_interval().as_millis() as u64;
            // USB mode: capture slightly faster than send to keep the slot fresh.
            // Hue-only mode: match capture rate to send rate (~20 Hz) to avoid
            // queue overwrite pressure (slot overwrites → "Critical" health).
            let sleep_ms = if hue_only {
                // Sleep for ~90% of the send interval. Capture cost (~4ms) fills
                // the remaining 10%, yielding capture FPS ≈ send FPS.
                (interval_ms * 9 / 10).clamp(15, 50)
            } else {
                (interval_ms / 2).clamp(5, 50)
            };
            thread::sleep(Duration::from_millis(sleep_ms));
        }

        // Stop the USB sink cleanly before the worker thread exits.
        if let Some(mut sink) = usb_sink {
            let _ = sink.stop();
        }

        ACTIVE_AMBILIGHT_WORKERS.fetch_sub(1, Ordering::SeqCst);
    });

    Ok(LightingWorkerRuntime {
        cancel,
        handle,
        _frame_source: frame_source_arc,
    })
}

/// Resolved output for the "usb" channel — serial and WLED are alternate
/// transports for the same logical LED-strip output, not separate targets
/// (see `ls-led-protocols`). Whichever sink `ActiveSinkRegistry` currently
/// holds wins; `None` falls back to `SerialConnectionState`.
#[derive(Clone, Debug)]
enum UsbOutputPlan {
    Serial(String),
    Wled(WledSinkConfig),
}

// Central state machine transition. 9-arg signature is retained to avoid
// disturbing the many existing call sites (several of which live in
// lib-tests that carry other outstanding compilation issues). Bundling
// these into a struct is tracked as a follow-up refactor rather than part
// of the clippy cleanup pass.
/// Wraps the mode change so the WLED length advisory is derived once, from the
/// mode that actually took effect. Attaching it per success branch would mean
/// every future branch has to remember to, and the ones that refuse a change
/// must not carry it at all.
#[allow(clippy::too_many_arguments)]
fn apply_mode_change(
    owner: &mut LightingRuntimeOwner,
    next_mode: LightingModeConfig,
    device_connected: bool,
    connected_port: Option<&str>,
    wled_sink: Option<WledSinkConfig>,
    hue_output: Option<HueActiveOutputContext>,
    telemetry_snapshot: Option<SharedRuntimeTelemetry>,
    edge_signal_emitter: Option<EdgeSignalEmitter>,
    trace: Option<&mut Vec<&'static str>>,
) -> LightingModeCommandResult {
    let mut result = apply_mode_change_inner(
        owner,
        next_mode,
        device_connected,
        connected_port,
        wled_sink,
        hue_output,
        telemetry_snapshot,
        edge_signal_emitter,
        trace,
    );
    result.wled_advisory = wled_frame_advisory(&result.mode, wled_sink.as_ref());
    result
}

#[allow(clippy::too_many_arguments)]
fn apply_mode_change_inner(
    owner: &mut LightingRuntimeOwner,
    next_mode: LightingModeConfig,
    device_connected: bool,
    connected_port: Option<&str>,
    // Snapshot of `ActiveSinkRegistry::active_wled_config()`. `Some` means a
    // WLED device is the most recently connected "usb"-channel sink and
    // takes priority over `connected_port` for this mode change.
    wled_sink: Option<WledSinkConfig>,
    hue_output: Option<HueActiveOutputContext>,
    telemetry_snapshot: Option<SharedRuntimeTelemetry>,
    edge_signal_emitter: Option<EdgeSignalEmitter>,
    trace: Option<&mut Vec<&'static str>>,
) -> LightingModeCommandResult {
    let normalized_next = normalize_mode_config(next_mode);

    // Universal calibration diagnostic — dump the led_calibration shape
    // visible to apply_mode_change for both Solid and Ambilight. The
    // frontend hydration path ought to stamp this, but a v1.5 hardware
    // bug surfaced as `led_count=1` on the wire despite a 59-LED
    // calibration sitting on disk. Logging here makes the live drag
    // session show whether the payload is actually carrying the
    // calibration into apply_mode_change or whether something between
    // frontend and the runtime is dropping it.
    info!(
        "[apply_mode_change] kind={:?} led_calibration_total_leds={} targets={:?}",
        normalized_next.kind,
        normalized_next
            .led_calibration
            .as_ref()
            .map(|c| c.total_leds as i32)
            .unwrap_or(-1),
        normalized_next.targets,
    );

    // Derive target flags from the requested targets list.
    // Empty/None targets = legacy behavior: USB is required (backward compat per D-10).
    let requested_targets = normalized_next.targets.clone().unwrap_or_default();
    let needs_usb = requested_targets.is_empty() || requested_targets.iter().any(|t| t == "usb");
    let needs_hue = requested_targets.iter().any(|t| t == "hue");
    // The caller snapshots whatever stream is live. A worker handed it while
    // not targeting Hue keeps a sender handle, and the Hue sender exits only
    // once every handle is gone — so removing Hue would leave it streaming
    // through the stop and its light restore. See docs/architecture/hue.md.
    let hue_output = hue_output.filter(|_| needs_hue);
    // v1.6 LED Preview — a synthetic test request bypasses the device/Hue
    // gates so it can run preview-only (twin + edge stream) with no sink.
    let is_test = owner.preview.pending_test_pattern.is_some();

    // Resolve the "usb" channel once. A registered WLED sink takes priority
    // over the serial-connection snapshot (see `UsbOutputPlan`). A serial plan
    // needs a port that is connected now: a name alone was never admitted by
    // `connect_serial_port`, and opening it would bypass the allowlist.
    // See docs/architecture/device-output.md.
    let serial_port = connected_port.filter(|_| device_connected);
    let usb_plan: Option<UsbOutputPlan> = match wled_sink {
        Some(cfg) => Some(UsbOutputPlan::Wled(cfg)),
        None => serial_port.map(|p| UsbOutputPlan::Serial(p.to_string())),
    };
    let usb_available = usb_plan.is_some();

    // USB gate: only applies when USB is a required target (per D-01).
    if normalized_next.kind != LightingModeKind::Off && needs_usb && !usb_available && !is_test {
        log::warn!(
            "[apply_mode_change] gated DEVICE_NOT_CONNECTED — kind={:?} requested_targets={:?} device_connected={device_connected}",
            normalized_next.kind, requested_targets,
        );
        return make_result(
            owner.active_mode.clone(),
            command_status(
                "DEVICE_NOT_CONNECTED",
                "Cannot apply lighting mode while device is disconnected.",
                Some("Connect a supported serial controller before changing mode.".to_string()),
            ),
        );
    }

    // Hue gate: when Hue target requested, Hue output context must be available (per D-03).
    if normalized_next.kind != LightingModeKind::Off
        && needs_hue
        && hue_output.is_none()
        && !is_test
    {
        return make_result(
            owner.active_mode.clone(),
            command_status(
                "HUE_NOT_READY",
                "Hue streaming is not available. Ensure bridge is paired and entertainment area is selected.",
                Some("HUE_RUNTIME_GATE_FAILED".to_string()),
            ),
        );
    }

    let mut trace = trace;

    // A running test retunes in place too: its pattern and speed sit in a cell the
    // frame source re-reads each frame, so only the frame geometry forces a rebuild.
    // Without it every colour commit was a full worker teardown.
    let preview_retune = match (
        owner.preview.pending_test_pattern.as_ref(),
        owner.preview.active_test_pattern.as_ref(),
    ) {
        (None, None) => true,
        (Some(next), Some(current)) => {
            owner.preview.pattern_live.is_some() && next.display_aspect == current.display_aspect
        }
        // Live→test needs a synthetic source built; test→live needs the real one back.
        _ => false,
    };

    // Fast path: ambilight already running and only settings changed (brightness,
    // black border detection, smoothing alpha) — update live atomics in-place
    // without stopping the worker or recreating SCStream.
    // NOTE: led_calibration, color_correction, firmware_profile and chip_type all force a worker
    // restart — each is read only when the encoder is built, so retuning atomics ignores them.
    // room_geometry deliberately does NOT: the worker re-reads it from `room_geometry_live`, so
    // it is written into that cell below instead — adding it here would restart per drag commit.
    // color_order does NOT either: the worker re-reads it from `ambilight_live` every frame, and a
    // restart would re-open capture for what is a byte shuffle.
    if normalized_next.kind == LightingModeKind::Ambilight
        && owner.active_mode.kind == LightingModeKind::Ambilight
        && owner.worker.is_some()
        && normalized_next.targets == owner.active_mode.targets
        && normalized_next.display_id == owner.active_mode.display_id
        && normalized_next.led_calibration == owner.active_mode.led_calibration
        && normalized_next.color_correction == owner.active_mode.color_correction
        && normalized_next.firmware_profile == owner.active_mode.firmware_profile
        && normalized_next.chip_type == owner.active_mode.chip_type
        && preview_retune
    {
        if let Some(live) = &owner.ambilight_live {
            let cfg = normalized_next
                .ambilight
                .as_ref()
                .cloned()
                .unwrap_or_default();
            // None-preservation: when the incoming payload omits saturation
            // or smoothing_alpha (e.g. brightness-only slider tweak from the
            // frontend), keep the currently running atomic value instead of
            // resetting to defaults. The previous unwrap_or(1.0)/(0.35) path
            // silently clobbered user-tuned values on every brightness move.
            let next_smoothing_alpha = cfg
                .smoothing_alpha
                .unwrap_or_else(|| live.read_smoothing_alpha());
            let next_saturation = cfg.saturation.unwrap_or_else(|| live.read_saturation());
            log::info!(
                "[ambilight-live-update] brightness={:.3} smoothing={:.3} saturation={:.3} black_border={} preset={:?}",
                cfg.brightness,
                next_smoothing_alpha,
                next_saturation,
                cfg.black_border_detection,
                cfg.lighting_smoothing_preset.or(cfg.hue_intensity_preset),
            );
            live.update(
                cfg.brightness,
                cfg.black_border_detection,
                next_smoothing_alpha,
                next_saturation,
                cfg.lighting_smoothing_preset.or(cfg.hue_intensity_preset),
            );
            // Unconditional: the atomic is the worker's only copy, so it must
            // follow every apply, including one that returns to the default.
            live.store_color_order(normalized_next.color_order.unwrap_or_default());
            if normalized_next.room_geometry != owner.active_mode.room_geometry {
                if let Some(cell) = &owner.room_geometry_live {
                    log::info!(
                        "[ambilight-live-update] room geometry {}",
                        if normalized_next.room_geometry.is_some() {
                            "updated"
                        } else {
                            "cleared"
                        }
                    );
                    cell.publish(normalized_next.room_geometry.clone());
                }
            }
            owner.active_mode = normalized_next;
            if let Some(next) = owner.preview.pending_test_pattern.take() {
                if let Some(slot) = owner.preview.pattern_live.as_ref() {
                    let mut cell = slot.lock().unwrap_or_else(|err| err.into_inner());
                    *cell = TestPatternLive::from_config(&next);
                }
                owner.preview.active_test_pattern = Some(next);
            }
            return make_result(
                owner.active_mode.clone(),
                command_status(
                    "AMBILIGHT_MODE_UPDATED",
                    "Ambilight settings updated in running worker.",
                    None,
                ),
            );
        }
    }

    stop_previous(owner, &mut trace);

    match normalized_next.kind {
        LightingModeKind::Off => {
            owner.active_mode = LightingModeConfig::default();
            owner.preview.active_test_pattern = None;
            owner.preview.pattern_live = None;
            make_result(
                owner.active_mode.clone(),
                command_status("LIGHTING_MODE_STOPPED", "Lighting runtime stopped.", None),
            )
        }
        LightingModeKind::Solid => {
            push_trace(&mut trace, "start_solid");
            let payload = normalized_next.solid.clone().unwrap_or(SolidColorPayload {
                r: 255,
                g: 255,
                b: 255,
                brightness: 1.0,
            });

            // USB solid output (only if USB target requested and a sink -- serial
            // or WLED -- is available)
            if needs_usb {
                let Some(plan) = usb_plan.clone() else {
                    owner.active_mode = LightingModeConfig::default();
                    return make_result(
                        owner.active_mode.clone(),
                        command_status(
                            "SOLID_MODE_APPLY_FAILED",
                            "Solid mode payload could not be applied.",
                            Some("LED_OUTPUT_PORT_UNAVAILABLE".to_string()),
                        ),
                    );
                };

                SOLID_OUTPUT_ATTEMPTS.fetch_add(1, Ordering::SeqCst);

                let solid_corrections =
                    normalized_next.color_correction.clone().unwrap_or_default();
                let solid_profile = normalized_next.firmware_profile.unwrap_or_default();
                let solid_chip = normalized_next.chip_type.unwrap_or_default();

                // Must paint EVERY LED, not just LED #0 (historical bug: a
                // 1-element slice left 58/59 LEDs dark). Falls back to a
                // 1-LED frame when no calibration is on record yet.
                log::info!(
                    "[apply_mode_change] solid led_calibration={}",
                    normalized_next
                        .led_calibration
                        .as_ref()
                        .map(|c| format!("Some(total_leds={})", c.total_leds))
                        .unwrap_or_else(|| "None".to_string())
                );
                let solid_led_count: usize = normalized_next
                    .led_calibration
                    .as_ref()
                    .map(|cal| cal.total_leds as usize)
                    .filter(|n| *n > 0)
                    .unwrap_or(1);
                let solid_triplets: Vec<[u8; 3]> =
                    vec![[payload.r, payload.g, payload.b]; solid_led_count];

                // Diagnostic: dump the post-correction RGB triplet that
                // actually goes onto the wire. Useful when investigating
                // "LED #0 is dark even though I picked a bright colour" —
                // exposes brightness clamps, gamma surprises, kelvin tints,
                // and saturation math without firing up a USB sniffer.
                let (corrected_r, corrected_g, corrected_b) = apply_color_correction_rgb(
                    (payload.r, payload.g, payload.b),
                    &solid_corrections,
                );
                let brightness_byte = (payload.brightness.clamp(0.0, 1.0) * 255.0).floor() as u8;

                // WLED has no on-wire brightness field, so `CorrectedWledSink`
                // scales it into the RGB values host-side; the serial path
                // keeps encoding brightness into the packet header as before.
                let send_result: Result<(), String> = match &plan {
                    UsbOutputPlan::Serial(port_name) => {
                        let solid_packet = encode_packet_for_output(
                            solid_profile,
                            solid_chip,
                            payload.brightness,
                            &solid_triplets,
                            &EncoderPlan::new(&solid_corrections)
                                .with_color_order(normalized_next.color_order.unwrap_or_default()),
                        );
                        owner
                            .output_bridge
                            .send_packet_to_port(port_name, &solid_packet)
                            .map_err(|error| error.as_reason())
                    }
                    UsbOutputPlan::Wled(cfg) => {
                        let mut sink = CorrectedWledSink::new(cfg.build(), solid_corrections);
                        sink.set_brightness(payload.brightness);
                        let result = sink.start().and_then(|_| sink.send_frame(&solid_triplets));
                        let _ = sink.stop();
                        result
                    }
                };

                if let Err(reason) = send_result {
                    warn!(
                        "[apply_mode_change] solid USB send FAILED — sink={plan:?} led_count={solid_led_count} reason={reason}"
                    );
                    owner.active_mode = LightingModeConfig::default();
                    return make_result(
                        owner.active_mode.clone(),
                        command_status(
                            "SOLID_MODE_APPLY_FAILED",
                            "Solid mode payload could not be applied.",
                            Some(reason),
                        ),
                    );
                }

                info!(
                    "[apply_mode_change] solid USB frame sent — sink={plan:?} led_count={solid_led_count} brightness_byte={brightness_byte} input=({}, {}, {}) corrected=({corrected_r}, {corrected_g}, {corrected_b})",
                    payload.r,
                    payload.g,
                    payload.b,
                );

                if let UsbOutputPlan::Serial(port_name) = &plan {
                    set_active_port(owner, port_name.clone());
                }
            }

            // Hue solid output (if hue target requested and context available)
            let mut hue_skip_reason: Option<String> = None;
            if needs_hue {
                match hue_output.as_ref() {
                    Some(context) => {
                        let hue_corrections =
                            normalized_next.color_correction.clone().unwrap_or_default();
                        let (hr, hg, hb) = apply_color_correction_rgb(
                            (payload.r, payload.g, payload.b),
                            &hue_corrections,
                        );
                        if let Err(reason) =
                            apply_hue_color_with_context(context, hr, hg, hb, payload.brightness)
                        {
                            warn!("[apply_mode_change] solid Hue send SKIPPED — reason={reason}");
                            hue_skip_reason = Some(reason);
                        }
                    }
                    None => {
                        // Only reachable on the preview/test path; the Hue gate
                        // above rejects a missing context for real modes.
                        warn!("[apply_mode_change] solid Hue send SKIPPED — no output context");
                        hue_skip_reason = Some("HUE_OUTPUT_CONTEXT_MISSING".to_string());
                    }
                }
            }

            owner.active_mode = normalized_next;
            owner.preview.active_test_pattern = None;
            owner.preview.pattern_live = None;
            let status = match hue_skip_reason {
                Some(reason) => command_status(
                    "SOLID_MODE_HUE_OUTPUT_SKIPPED",
                    "Solid mode applied, but the Hue output was skipped.",
                    Some(reason),
                ),
                None => command_status(
                    "SOLID_MODE_APPLIED",
                    "Solid mode applied successfully.",
                    None,
                ),
            };
            make_result(owner.active_mode.clone(), status)
        }
        LightingModeKind::Ambilight => {
            push_trace(&mut trace, "start_ambilight");

            // v1.6 LED Preview — consume any pending synthetic-test request.
            let test_pattern = owner.preview.pending_test_pattern.take();

            let ambilight_cfg = normalized_next
                .ambilight
                .as_ref()
                .cloned()
                .unwrap_or_default();
            let live_settings = AmbilightLiveSettings::new(
                ambilight_cfg.brightness,
                ambilight_cfg.black_border_detection,
                ambilight_cfg.smoothing_alpha.unwrap_or(0.35),
                ambilight_cfg.saturation.unwrap_or(1.0),
            );
            // Seed the Hue branch alpha from the intensity preset when set.
            // `update` below is the only path that honors the preset, so
            // re-apply it immediately so the first frame after start already
            // uses the user's chosen response curve.
            live_settings.update(
                ambilight_cfg.brightness,
                ambilight_cfg.black_border_detection,
                ambilight_cfg.smoothing_alpha.unwrap_or(0.35),
                ambilight_cfg.saturation.unwrap_or(1.0),
                ambilight_cfg
                    .lighting_smoothing_preset
                    .or(ambilight_cfg.hue_intensity_preset),
            );
            live_settings.store_color_order(normalized_next.color_order.unwrap_or_default());

            info!("[apply_mode_change] starting ambilight — needs_usb={needs_usb} needs_hue={needs_hue} hue_output={}", hue_output.is_some());

            // Fresh per worker: the old cell belongs to the source being torn
            // down, and handing it on would let a stale write reach it.
            let pattern_live = test_pattern
                .as_ref()
                .map(|cfg| Arc::new(Mutex::new(TestPatternLive::from_config(cfg))));

            let frame_source = {
                let req = AmbilightCaptureRequest {
                    display_id: normalized_next.display_id.clone(),
                    led_calibration: normalized_next.led_calibration.clone(),
                    test_pattern: test_pattern.clone(),
                    pattern_phase: Some(Arc::clone(&owner.preview.pattern_phase)),
                    pattern_live: pattern_live.clone(),
                };
                match (owner.frame_source_factory)(req) {
                    Ok(source) => {
                        info!("[apply_mode_change] frame_source created OK");
                        source
                    }
                    Err(reason) => {
                        warn!(
                            "[apply_mode_change] frame_source FAILED: {}",
                            reason.as_reason()
                        );
                        owner.active_mode = LightingModeConfig::default();
                        return make_result(
                            owner.active_mode.clone(),
                            command_status(
                                "AMBILIGHT_MODE_START_FAILED",
                                "Ambilight runtime could not start.",
                                Some(reason.as_reason()),
                            ),
                        );
                    }
                }
            };

            // Resolve the sink for the worker: only pass one if USB is a required target
            let usb_plan_for_worker: Option<UsbOutputPlan> = if needs_usb {
                match usb_plan.clone() {
                    Some(plan) => Some(plan),
                    // v1.6 LED Preview: a synthetic test runs preview-only (no
                    // USB sink) when no device is connected — no gate.
                    None if is_test => None,
                    None => {
                        owner.active_mode = LightingModeConfig::default();
                        return make_result(
                            owner.active_mode.clone(),
                            command_status(
                                "AMBILIGHT_MODE_START_FAILED",
                                "Ambilight runtime could not start.",
                                Some("LED_OUTPUT_PORT_UNAVAILABLE".to_string()),
                            ),
                        );
                    }
                }
            } else {
                None
            };

            let corrections = normalized_next.color_correction.clone().unwrap_or_default();
            let profile = normalized_next.firmware_profile.unwrap_or_default();
            let chip = normalized_next.chip_type.unwrap_or_default();
            let preview_ctx = build_preview_emit_context(
                is_test,
                test_pattern.as_ref(),
                owner.preview.preview_gate.clone(),
                normalized_next.display_id.clone(),
            );
            let room_geometry_live = RoomGeometryLive::new(normalized_next.room_geometry.clone());

            match start_ambilight_worker(
                owner.output_bridge.clone(),
                usb_plan_for_worker,
                normalized_next.led_calibration.clone(),
                Arc::clone(&live_settings),
                frame_source,
                telemetry_snapshot
                    .unwrap_or_else(|| Arc::new(Mutex::new(RuntimeTelemetrySnapshot::default()))),
                hue_output,
                edge_signal_emitter,
                corrections,
                profile,
                chip,
                preview_ctx,
                Arc::clone(&room_geometry_live),
            ) {
                Ok(worker) => {
                    owner.worker = Some(worker);
                    owner.ambilight_live = Some(live_settings);
                    owner.room_geometry_live = Some(room_geometry_live);
                    owner.active_mode = normalized_next;
                    owner.preview.active_test_pattern = test_pattern;
                    owner.preview.pattern_live = pattern_live;
                    if let Some(p) = serial_port {
                        set_active_port(owner, p.to_string());
                    }
                    make_result(
                        owner.active_mode.clone(),
                        command_status(
                            "AMBILIGHT_MODE_STARTED",
                            "Ambilight runtime started with frame output pipeline.",
                            None,
                        ),
                    )
                }
                Err(reason) => {
                    owner.active_mode = LightingModeConfig::default();
                    make_result(
                        owner.active_mode.clone(),
                        command_status(
                            "AMBILIGHT_MODE_START_FAILED",
                            "Ambilight runtime could not start.",
                            Some(reason),
                        ),
                    )
                }
            }
        }
    }
}

/// Apply a full `LightingModeConfig` from the frontend: hydrates missing
/// calibration, ambilight settings and output stamps (colour correction,
/// firmware profile, chip type) from persisted shell-state, then starts,
/// reconfigures, or stops the worker to match the requested mode. Broadcasts
/// `LIGHTING_MODE_CHANGED_EVENT` and the preview snapshot on every call.
#[tauri::command]
pub async fn set_lighting_mode<R: Runtime>(
    app: AppHandle<R>,
    payload: LightingModeConfig,
) -> Result<LightingModeCommandResult, String> {
    run_mode_transition(app, move |app| set_lighting_mode_blocking(app, payload)).await
}

fn set_lighting_mode_blocking<R: Runtime>(
    app: &AppHandle<R>,
    mut payload: LightingModeConfig,
) -> Result<LightingModeCommandResult, String> {
    let runtime_state = app.state::<LightingRuntimeState>();
    let connection_state = app.state::<SerialConnectionState>();
    let sink_registry = app.state::<ActiveSinkRegistry>();
    let hue_runtime_state = app.state::<HueRuntimeStateStore>();
    let telemetry_state = app.state::<RuntimeTelemetryState>();
    let led_twin_state = app.state::<LedTwinState>();
    let t_cmd = std::time::Instant::now();
    let incoming_total_leds = payload
        .led_calibration
        .as_ref()
        .map(|cal| cal.total_leds)
        .unwrap_or(0);
    info!(
        "[set_lighting_mode] invoked kind={:?} payload_led_calibration_total_leds={incoming_total_leds}",
        payload.kind
    );

    // Backend-side calibration safety net (v1.5 hardware repro fix).
    //
    // Frontend hydrators (`withLedCalibration` in App.tsx) stamp the
    // persisted calibration onto every outgoing payload, but a v1.5
    // regression on real hardware showed that some code paths still
    // arrive here without it (live observed: `led_count=1` despite a
    // 59-LED calibration sitting on disk). Rather than chasing every
    // frontend hydration site, reload the persisted shell-state when
    // the payload arrives without a usable calibration and reuse the
    // saved value. The frontend remains the source of truth; this is a
    // pure recovery path that fires only when the payload is missing
    // or carries `total_leds <= 1`.
    //
    // Backend-side ambilight settings safety net (v1.5 H1 fix).
    //
    // Frontend `withAmbilightSettings` (App.tsx) stamps the persisted
    // ambilight payload onto every outgoing dispatch via
    // `savedAmbilightRef`, but a missed-stamp regression would otherwise
    // strip the user's saturation / blackBorderDetection / smoothing
    // preset down to backend defaults. The trigger is narrow — only when
    // `kind == Ambilight` AND `payload.ambilight` is entirely absent —
    // because the frontend is source of truth for present-but-default
    // values (a deliberate slider commit at saturation 1.0 must round-
    // trip without backend interference).
    //
    // Output stamps (colour correction, firmware profile, chip type) follow
    // the same caller-wins rule; the LED control popup sends none of them.
    hydrate_mode_payload(&mut payload, &|| read_persisted_shell_state(app));

    let connection_snapshot = connection_state
        .last_status
        .lock()
        .map(|status| status.clone())
        .map_err(|error| format!("LIGHTING_CONNECTION_STATE_LOCK_FAILED: {error}"))?;

    let lock_t = std::time::Instant::now();
    let mut owner = runtime_state
        .runtime
        .lock()
        .map_err(|error| format!("LIGHTING_RUNTIME_STATE_LOCK_FAILED: {error}"))?;
    let lock_ms = lock_t.elapsed().as_millis();
    if lock_ms > 10 {
        info!("[set_lighting_mode] runtime lock waited {lock_ms}ms");
    }

    let hue_output = snapshot_hue_output_context(&hue_runtime_state)?;

    // v1.6 LED Preview — clear any stale synthetic-test request, wire the
    // shared gate so a twin opened mid-run starts receiving without a worker
    // restart, and send the edge-signal to every active twin overlay.
    owner.preview.pending_test_pattern = None;
    owner.preview.preview_gate = Some(led_twin_state.preview_active());
    // v1.6 LED Preview — record whether a synthetic test was running
    // BEFORE apply_mode_change clears it, so a live mode change that
    // supersedes the test can drop the captured prior mode below.
    let superseded_test = owner.preview.active_test_pattern.is_some();
    let edge_emitter = Some(build_edge_emitter(app));
    let wled_sink = sink_registry.active_wled_config();

    let result = apply_mode_change(
        &mut owner,
        payload,
        connection_snapshot.connected,
        connection_snapshot.port_name.as_deref(),
        wled_sink,
        hue_output,
        Some(telemetry_state.shared_snapshot()),
        edge_emitter,
        None,
    );
    // Release the runtime lock before broadcasting so a re-entrant
    // mode-change listener cannot deadlock on it.
    drop(owner);
    let _ = app.emit(
        LIGHTING_MODE_CHANGED_EVENT,
        LightingModeChangedPayload {
            config: result.mode.clone(),
            active: result.active,
        },
    );
    // v1.6 LED Preview — a live mode change supersedes any active synthetic
    // test (apply_mode_change just cleared it). Drop the captured prior mode
    // so a late/racing Stop cannot revive the pre-test mode over the user's
    // new selection.
    if superseded_test {
        let _ = led_twin_state.take_prior_mode();
    }
    // The control popup + twin overlays derive `testActive` / `source`
    // SOLELY from preview://state-changed, so broadcast the refreshed
    // preview snapshot on every mode change — not just on test start/stop.
    emit_preview_state_changed(app);
    info!(
        "[set_lighting_mode] completed in {}ms",
        t_cmd.elapsed().as_millis()
    );
    Ok(result)
}

/// Force the lighting mode to `Off`, stopping any running worker.
#[tauri::command]
pub async fn stop_lighting<R: Runtime>(
    app: AppHandle<R>,
) -> Result<LightingModeCommandResult, String> {
    run_mode_transition(app, |app| stop_lighting_blocking(app)).await
}

/// Body of `stop_lighting`. Also used on the app shutdown path, so it resolves
/// `LedTwinState` best-effort via the `AppHandle` rather than requiring it as a
/// managed-state argument. The shutdown path calls it directly, outside the
/// transition queue: quit must never wait behind a queued mode change, and
/// the runtime lock still serialises it against the one in flight.
pub fn stop_lighting_blocking<R: Runtime>(
    app: &AppHandle<R>,
) -> Result<LightingModeCommandResult, String> {
    let runtime_state = app.state::<LightingRuntimeState>();
    let (result, superseded_test) = {
        let mut owner = runtime_state
            .runtime
            .lock()
            .map_err(|error| format!("LIGHTING_RUNTIME_STATE_LOCK_FAILED: {error}"))?;
        // v1.6 LED Preview — capture whether a synthetic test was running
        // BEFORE apply_mode_change clears it.
        let superseded_test = owner.preview.active_test_pattern.is_some();
        let result = apply_mode_change(
            &mut owner,
            LightingModeConfig::default(),
            true,
            None,
            None,
            None,
            None,
            None,
            None,
        );
        (result, superseded_test)
    };
    let _ = app.emit(
        LIGHTING_MODE_CHANGED_EVENT,
        LightingModeChangedPayload {
            config: result.mode.clone(),
            active: result.active,
        },
    );
    // v1.6 LED Preview — stopping all lighting supersedes any active test;
    // drop the captured prior mode so a late Stop cannot revive it. This
    // command is also called from the shutdown path, so resolve the twin
    // state best-effort via the AppHandle rather than a State<'_, _> arg.
    if superseded_test {
        if let Some(twin_state) = app.try_state::<LedTwinState>() {
            let _ = twin_state.take_prior_mode();
        }
    }
    // Keep the control popup + twin overlays in sync — they derive
    // `testActive` / `source` solely from preview://state-changed.
    emit_preview_state_changed(app);
    Ok(result)
}

/// Read-only snapshot of the current lighting mode, for the frontend to
/// reconcile against on load without triggering a mode change.
#[tauri::command]
pub fn get_lighting_mode_status(
    runtime_state: State<'_, LightingRuntimeState>,
) -> Result<LightingModeCommandResult, String> {
    let owner = runtime_state
        .runtime
        .lock()
        .map_err(|error| format!("LIGHTING_RUNTIME_STATE_LOCK_FAILED: {error}"))?;

    Ok(make_result(
        owner.active_mode.clone(),
        command_status(
            "LIGHTING_MODE_STATUS_OK",
            "Lighting mode status read successfully.",
            None,
        ),
    ))
}

// ---------------------------------------------------------------------------
// v1.6 LED Preview — mode-change broadcast + synthetic test pattern commands
// ---------------------------------------------------------------------------

/// Tauri event broadcast app-wide whenever the active lighting mode changes,
/// so preview surfaces (and any window other than the issuer) reconcile.
pub const LIGHTING_MODE_CHANGED_EVENT: &str = "lighting://mode-changed";

/// Payload for `LIGHTING_MODE_CHANGED_EVENT` — the new mode and whether it
/// is active, broadcast to every window (not just the command's caller).
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LightingModeChangedPayload {
    pub config: LightingModeConfig,
    pub active: bool,
}

const LED_TEST_PATTERN_STARTED: &str = "LED_TEST_PATTERN_STARTED";
const LED_TEST_PATTERN_PREVIEW_ONLY: &str = "LED_TEST_PATTERN_PREVIEW_ONLY";
const LED_TEST_PATTERN_STOPPED: &str = "LED_TEST_PATTERN_STOPPED";
const LED_TEST_PATTERN_INVALID_PARAMS: &str = "LED_TEST_PATTERN_INVALID_PARAMS";
const LED_TEST_PATTERN_NO_CALIBRATION: &str = "LED_TEST_PATTERN_NO_CALIBRATION";
const LED_TEST_PATTERN_RUNTIME_ERROR: &str = "LED_TEST_PATTERN_RUNTIME_ERROR";

/// Build the edge-signal emitter. Sends to the open twin-overlay windows only
/// (read from `LedTwinState` each tick, so a twin opened mid-run starts
/// receiving without a worker restart); the main window has no listener.
fn build_edge_emitter<R: Runtime>(app: &AppHandle<R>) -> EdgeSignalEmitter {
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
fn build_preview_emit_context(
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

/// `Err` prefix when the blocking half of a mode command dies before answering.
const LIGHTING_TRANSITION_WORKER_FAILED: &str = "LIGHTING_TRANSITION_WORKER_FAILED";

/// Runs a mode command's blocking body off the main thread, one command at a
/// time and in arrival order. The body joins workers, opens capture and waits
/// out serial settles, which froze the UI for seconds as a sync command. The
/// queue replaces the ordering the main thread used to give for free: a fair
/// async mutex, because a std one wakes queued drag commits in any order and
/// the last value could lose. See docs/architecture/capture-and-pipeline.md.
async fn run_mode_transition<R, T, F>(app: AppHandle<R>, body: F) -> Result<T, String>
where
    R: Runtime,
    T: Send + 'static,
    F: FnOnce(&AppHandle<R>) -> Result<T, String> + Send + 'static,
{
    let state = app.state::<LightingRuntimeState>();
    let _turn = state.transitions.lock().await;
    let worker_app = app.clone();
    tauri::async_runtime::spawn_blocking(move || body(&worker_app))
        .await
        .unwrap_or_else(|error| Err(format!("{LIGHTING_TRANSITION_WORKER_FAILED}: {error}")))
}

/// Apply a mode transition and broadcast `lighting://mode-changed`. Shared by
/// the synthetic-test start/stop commands; `set_lighting_mode` inlines the
/// equivalent flow with its own hydration logging.
#[allow(clippy::too_many_arguments)]
fn apply_and_broadcast<R: Runtime>(
    app: &AppHandle<R>,
    mut payload: LightingModeConfig,
    runtime_state: &LightingRuntimeState,
    connection_state: &SerialConnectionState,
    hue_runtime_state: &HueRuntimeStateStore,
    telemetry_state: &RuntimeTelemetryState,
    twin_state: &LedTwinState,
    test_pattern: Option<TestPatternConfig>,
    // Without this snapshot the "usb" channel collapses to the serial one, so a
    // WLED-only session runs preview-only and its restore is gated on stop.
    wled_sink: Option<WledSinkConfig>,
) -> Result<LightingModeCommandResult, String> {
    hydrate_mode_payload(&mut payload, &|| read_persisted_shell_state(app));

    let connection_snapshot = connection_state
        .last_status
        .lock()
        .map(|status| status.clone())
        .map_err(|error| format!("LIGHTING_CONNECTION_STATE_LOCK_FAILED: {error}"))?;

    let edge_emitter = Some(build_edge_emitter(app));

    let result = {
        let mut owner = runtime_state
            .runtime
            .lock()
            .map_err(|error| format!("LIGHTING_RUNTIME_STATE_LOCK_FAILED: {error}"))?;
        let hue_output = snapshot_hue_output_context(hue_runtime_state)?;
        owner.preview.pending_test_pattern = test_pattern;
        owner.preview.preview_gate = Some(twin_state.preview_active());
        apply_mode_change(
            &mut owner,
            payload,
            connection_snapshot.connected,
            connection_snapshot.port_name.as_deref(),
            wled_sink,
            hue_output,
            Some(telemetry_state.shared_snapshot()),
            edge_emitter,
            None,
        )
    };

    let _ = app.emit(
        LIGHTING_MODE_CHANGED_EVENT,
        LightingModeChangedPayload {
            config: result.mode.clone(),
            active: result.active,
        },
    );

    Ok(result)
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

/// Request payload for `start_led_test_pattern` — which synthetic pattern to
/// run, at what speed/brightness, and which output channels to drive.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartLedTestPatternPayload {
    pub pattern: TestPatternKind,
    pub brightness: f32,
    #[serde(default)]
    pub speed: Option<TestPatternSpeed>,
    #[serde(default)]
    pub targets: Option<Vec<String>>,
    /// Layout to size the frame with. LED Setup sends its unsaved editor
    /// state here; absent falls through to `maybe_hydrate_led_calibration`.
    #[serde(default)]
    pub led_calibration: Option<LedCalibrationConfig>,
}

/// Result of `start_led_test_pattern` / `stop_led_test_pattern` — whether the
/// pattern is running and whether it fell back to preview-only (no connected
/// output sink).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LedTestPatternResult {
    pub active: bool,
    pub preview_only: bool,
    pub status: CommandStatus,
}

/// Start a synthetic LED test pattern (spiral, chase, etc.) for the LED
/// Preview feature — resolves available output targets, requires a real
/// strip calibration to size the pattern, and captures the prior live mode
/// so `stop_led_test_pattern` can restore it.
#[tauri::command]
pub async fn start_led_test_pattern<R: Runtime>(
    app: AppHandle<R>,
    payload: StartLedTestPatternPayload,
) -> Result<LedTestPatternResult, String> {
    run_mode_transition(app, move |app| {
        start_led_test_pattern_blocking(app, payload)
    })
    .await
}

fn start_led_test_pattern_blocking<R: Runtime>(
    app: &AppHandle<R>,
    payload: StartLedTestPatternPayload,
) -> Result<LedTestPatternResult, String> {
    let runtime_state = app.state::<LightingRuntimeState>();
    let connection_state = app.state::<SerialConnectionState>();
    let hue_runtime_state = app.state::<HueRuntimeStateStore>();
    let telemetry_state = app.state::<RuntimeTelemetryState>();
    let led_twin_state = app.state::<LedTwinState>();
    let sink_registry = app.state::<ActiveSinkRegistry>();
    if !payload.brightness.is_finite() || !(0.0..=1.0).contains(&payload.brightness) {
        return Ok(LedTestPatternResult {
            active: false,
            preview_only: false,
            status: command_status(
                LED_TEST_PATTERN_INVALID_PARAMS,
                "Test pattern brightness must be within 0..1.",
                None,
            ),
        });
    }
    if matches!(payload.pattern, TestPatternKind::ChannelProbe { slot } if slot > 2) {
        return Ok(LedTestPatternResult {
            active: false,
            preview_only: false,
            status: command_status(
                LED_TEST_PATTERN_INVALID_PARAMS,
                "Channel probe slot must be 0, 1 or 2.",
                None,
            ),
        });
    }

    let test_config = TestPatternConfig {
        kind: payload.pattern.clone(),
        brightness: payload.brightness,
        speed: payload.speed.unwrap_or_default(),
        display_aspect: resolve_display_aspect(app),
    };

    // Resolve sink availability up front to choose targets + report
    // preview-only without re-deriving it from apply_mode_change.
    let device_connected = connection_state
        .last_status
        .lock()
        .map(|status| status.output_port().is_some())
        .map_err(|error| format!("LIGHTING_CONNECTION_STATE_LOCK_FAILED: {error}"))?;
    let wled_sink = sink_registry.active_wled_config();
    let hue_available = snapshot_hue_output_context(hue_runtime_state.inner())?
        .map(|ctx| !ctx.channels.is_empty())
        .unwrap_or(false);

    let requested = payload.targets.clone().unwrap_or_default();
    let want_usb = requested.is_empty() || requested.iter().any(|t| t == "usb");
    let want_hue = requested.iter().any(|t| t == "hue");
    // A registered WLED sink IS the "usb" channel — see `UsbOutputPlan`.
    let use_usb = (device_connected || wled_sink.is_some()) && want_usb;
    let use_hue = hue_available && want_hue;
    let preview_only = !use_usb && !use_hue;

    let mut targets: Vec<String> = Vec::new();
    if use_usb {
        targets.push("usb".to_string());
    }
    if use_hue {
        targets.push("hue".to_string());
    }

    let mut config = LightingModeConfig {
        kind: LightingModeKind::Ambilight,
        solid: None,
        ambilight: Some(AmbilightPayload {
            brightness: payload.brightness,
            // Unsmoothed, unsaturated: the default 0.35 EWMA smears the chase
            // band across neighbours, which is the ordering it exists to prove.
            smoothing_alpha: Some(1.0),
            saturation: Some(1.0),
            ..AmbilightPayload::default()
        }),
        targets: Some(targets),
        display_id: None,
        led_calibration: payload.led_calibration.clone(),
        color_correction: None,
        firmware_profile: None,
        chip_type: None,
        color_order: test_pattern_color_order(&payload.pattern),
        room_geometry: None,
    };

    // A synthetic test needs a real strip layout to size its frame. Resolve
    // the effective calibration up front: with no usable calibration the
    // worker would silently degrade to a single-LED twin (one dot) while the
    // chase band is sized for FALLBACK_TOTAL_LEDS — a misleading single-dot
    // preview. Route the user to the calibration flow with a coded status
    // instead. (Never throws — coded status on the Ok result.)
    maybe_hydrate_led_calibration(&mut config, &|| read_persisted_shell_state(app));
    let effective_total_leds = config
        .led_calibration
        .as_ref()
        .map(|cal| cal.total_leds)
        .unwrap_or(0);
    if effective_total_leds <= 1 {
        return Ok(LedTestPatternResult {
            active: false,
            preview_only: false,
            status: command_status(
                LED_TEST_PATTERN_NO_CALIBRATION,
                "No LED calibration is available to size the test pattern.",
                None,
            ),
        });
    }

    // Capture the live mode to restore on stop — but never overwrite a real
    // prior mode with a test mode if we are already previewing.
    {
        let prior = {
            let owner = runtime_state
                .runtime
                .lock()
                .map_err(|error| format!("LIGHTING_RUNTIME_STATE_LOCK_FAILED: {error}"))?;
            if owner.preview.active_test_pattern.is_some() {
                None
            } else {
                // Fresh run — rewind the animation. A tweak to an already
                // running pattern keeps its phase instead.
                owner
                    .preview
                    .pattern_phase
                    .store(0f32.to_bits(), Ordering::Relaxed);
                Some(owner.active_mode.clone())
            }
        };
        if let Some(prior_mode) = prior {
            led_twin_state.set_prior_mode(prior_mode);
        }
    }

    let result = apply_and_broadcast(
        app,
        config,
        runtime_state.inner(),
        connection_state.inner(),
        hue_runtime_state.inner(),
        telemetry_state.inner(),
        led_twin_state.inner(),
        Some(test_config),
        wled_sink,
    )?;

    emit_preview_state_changed(app);

    let outcome = if is_ambilight_start_ok(&result.status.code) {
        let code = if preview_only {
            LED_TEST_PATTERN_PREVIEW_ONLY
        } else {
            LED_TEST_PATTERN_STARTED
        };
        LedTestPatternResult {
            active: true,
            preview_only,
            status: command_status(code, "LED test pattern started.", None),
        }
    } else {
        LedTestPatternResult {
            active: false,
            preview_only,
            status: command_status(
                LED_TEST_PATTERN_RUNTIME_ERROR,
                "LED test pattern could not start.",
                Some(format!("{}: {}", result.status.code, result.status.message)),
            ),
        }
    };
    Ok(outcome)
}

/// The colour order a test pattern pins, overriding the saved one (caller-wins
/// hydration keeps it). A channel probe lights one wire slot so the user can
/// say which colour appears, which only means something when nothing reorders
/// the slots. Every other pattern keeps the saved order, like any output.
fn test_pattern_color_order(kind: &TestPatternKind) -> Option<LedColorOrder> {
    match kind {
        TestPatternKind::ChannelProbe { .. } => Some(LedColorOrder::Rgb),
        _ => None,
    }
}

/// A test pattern reaches the lights through either arm of `apply_mode_change`:
/// a fresh worker, or the in-place retune a running test takes. Accepting only
/// the former reported every change after the first as a failed start.
fn is_ambilight_start_ok(code: &str) -> bool {
    code == "AMBILIGHT_MODE_STARTED" || code == "AMBILIGHT_MODE_UPDATED"
}

/// The pre-test mode with its output stamps and calibration re-read from disk.
/// The snapshot dates from test start and hydration is caller-wins, so stale
/// values would revert a chip / profile / correction change made mid-test and
/// the calibration editor's save-then-stop. The snapshot's layout survives only
/// when disk has none, instead of dropping to the legacy 1-LED frame.
fn restore_mode_after_test(
    prior: Option<LightingModeConfig>,
    load: &dyn Fn() -> Option<String>,
) -> LightingModeConfig {
    let mut restore = prior.unwrap_or_default();
    restore.chip_type = None;
    restore.firmware_profile = None;
    restore.color_correction = None;
    restore.color_order = None;
    if let Some(snapshot_calibration) = restore.led_calibration.take() {
        maybe_hydrate_led_calibration(&mut restore, load);
        if restore.led_calibration.is_none() {
            restore.led_calibration = Some(snapshot_calibration);
        }
    }
    restore
}

/// Stop the running LED test pattern and restore the mode that was active
/// before it started (or force `Off` if that restore itself gets gated by a
/// disconnected sink, so the synthetic worker never gets stranded running).
#[tauri::command]
pub async fn stop_led_test_pattern<R: Runtime>(
    app: AppHandle<R>,
) -> Result<LedTestPatternResult, String> {
    run_mode_transition(app, |app| stop_led_test_pattern_blocking(app)).await
}

fn stop_led_test_pattern_blocking<R: Runtime>(
    app: &AppHandle<R>,
) -> Result<LedTestPatternResult, String> {
    let runtime_state = app.state::<LightingRuntimeState>();
    let connection_state = app.state::<SerialConnectionState>();
    let hue_runtime_state = app.state::<HueRuntimeStateStore>();
    let telemetry_state = app.state::<RuntimeTelemetryState>();
    let led_twin_state = app.state::<LedTwinState>();
    let sink_registry = app.state::<ActiveSinkRegistry>();
    let wled_sink = sink_registry.active_wled_config();
    let restore = restore_mode_after_test(led_twin_state.take_prior_mode(), &|| {
        read_persisted_shell_state(app)
    });
    let mut result = apply_and_broadcast(
        app,
        restore,
        runtime_state.inner(),
        connection_state.inner(),
        hue_runtime_state.inner(),
        telemetry_state.inner(),
        led_twin_state.inner(),
        None,
        wled_sink,
    )?;

    // A gated restore (DEVICE_NOT_CONNECTED / HUE_NOT_READY) returns before
    // `apply_mode_change` tears the previous worker down, so the synthetic
    // pattern would keep running with no way to stop it. Fall back to Off.
    if runtime_state.preview_snapshot().test_active {
        warn!(
            "[stop_led_test_pattern] restore gated ({}) — forcing Off so the synthetic worker stops",
            result.status.code
        );
        result = apply_and_broadcast(
            app,
            LightingModeConfig::default(),
            runtime_state.inner(),
            connection_state.inner(),
            hue_runtime_state.inner(),
            telemetry_state.inner(),
            led_twin_state.inner(),
            None,
            wled_sink,
        )?;
    }

    led_twin_state.recompute();
    emit_preview_state_changed(app);
    Ok(LedTestPatternResult {
        active: result.active,
        preview_only: false,
        status: command_status(LED_TEST_PATTERN_STOPPED, "LED test pattern stopped.", None),
    })
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

/// Per-channel Hue inputs the worker holds between frames: where each channel
/// samples the screen, and what the scene stage relates it by. Rebuilt only when
/// the room geometry generation moves, never per frame.
struct HueSampleTable {
    topology: LightTopology,
    affinity: Vec<f32>,
    sample_points: Vec<(f32, f32)>,
}

impl HueSampleTable {
    fn empty() -> Self {
        Self {
            topology: LightTopology::Points(Vec::new()),
            affinity: Vec::new(),
            sample_points: Vec::new(),
        }
    }
}

/// `None` geometry, or geometry that fails validation, is exactly the legacy
/// table. With geometry, the room map's placements are overlaid onto the
/// stream's channels by `channel_id` first, because the stream's copy is fixed
/// at stream start and the room map's is the one a drag moves.
fn hue_sample_table(
    channels: &[crate::commands::hue::frame::HueAreaChannel],
    geometry: Option<&RoomGeometry>,
) -> HueSampleTable {
    if let Some(geometry) = geometry {
        let mut placed = channels.to_vec();
        crate::commands::hue::sender::apply_channel_placements(
            &mut placed,
            &geometry.hue_placements,
        );
        if let Some(samples) = room_aware_hue_samples(geometry, &placed) {
            info!(
                "[room-geometry] applied — channels={} placements={}",
                placed.len(),
                geometry.hue_placements.len()
            );
            let (topology, _) = hue_topology_and_affinity(&placed);
            return HueSampleTable {
                topology,
                affinity: samples.iter().map(|s| s.affinity).collect(),
                sample_points: samples.iter().map(|s| (s.sample_x, s.sample_y)).collect(),
            };
        }
        warn!(
            "[room-geometry] rejected — {}; sampling by the bridge positions instead",
            room_geometry_rejection(geometry).unwrap_or("invalid geometry")
        );
    }
    let (topology, affinity) = hue_topology_and_affinity(channels);
    HueSampleTable {
        topology,
        affinity,
        sample_points: channels
            .iter()
            .map(|ch| (ch.position_x, ch.position_y))
            .collect(),
    }
}

/// Legacy scene-stage inputs for the Hue set, from `x`/`y` alone: depth stands
/// in for screen vertical and a channel's height is not read. The room-aware
/// path (`hue_sample_table` with geometry) is the only reader of height.
fn hue_topology_and_affinity(
    channels: &[crate::commands::hue::frame::HueAreaChannel],
) -> (LightTopology, Vec<f32>) {
    (
        LightTopology::Points(
            channels
                .iter()
                .map(|ch| (ch.position_x, ch.position_y))
                .collect(),
        ),
        channels
            .iter()
            .map(|ch| hue_default_screen_affinity(ch.position_y))
            .collect(),
    )
}

#[cfg(test)]
mod frame_pipeline_tests;

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};
    use std::thread;
    use std::time::{Duration, Instant};

    use std::sync::atomic::Ordering;

    use crate::commands::ambilight_capture::{
        AmbilightCaptureError, AmbilightFrameSource, CapturedFrame,
    };
    use crate::commands::led_output::{LedOutputBridge, LedOutputError, LedPacketSender};
    use crate::commands::runtime_quality::{RuntimeFrameSlot, RuntimeQualityConfig};
    use crate::commands::runtime_telemetry::RuntimeTelemetrySnapshot;
    use crate::commands::wled_sink::{WledProtocol, WledSinkConfig};

    use super::{
        apply_mode_change, resolve_quality_config, set_active_port, start_ambilight_worker,
        stop_previous, AmbilightLiveSettings, AmbilightPayload, AmbilightWorkerQualityState,
        FirmwareProfile, LedChipType, LedColorOrder, LightingModeConfig, LightingModeKind,
        LightingRuntimeOwner, SerialSendBudget, SolidColorPayload, UsbOutputPlan,
        ACTIVE_AMBILIGHT_WORKERS, AMBILIGHT_CAPTURE_ATTEMPTS, AMBILIGHT_FRAME_ATTEMPTS,
        SOLID_OUTPUT_ATTEMPTS,
    };

    // -----------------------------------------------------------------------
    // SerialSendBudget — the 115 200-baud clamp (F5)
    // -----------------------------------------------------------------------

    #[test]
    fn send_budget_never_sends_faster_than_the_wire() {
        for leds in [1u16, 30, 60, 100, 200, 320, 1000, 4000] {
            for chip in [LedChipType::Ws2812bGrb, LedChipType::Sk6812Rgbw] {
                let config = SerialSendBudget::for_strip(leds, FirmwareProfile::LumaSyncV1, chip)
                    .into_quality_config(0.35);
                let wire_ms =
                    SerialSendBudget::for_strip(leds, FirmwareProfile::LumaSyncV1, chip).wire_ms;
                let controller = AmbilightWorkerQualityState::new(config.clone());
                let interval = controller.current_send_interval().as_millis() as u64;
                assert!(
                    interval >= wire_ms,
                    "leds={leds} chip={chip:?}: interval {interval}ms is below the {wire_ms}ms wire floor",
                );
                assert!(
                    config.max_interval_ms >= config.min_interval_ms,
                    "leds={leds} chip={chip:?}: max cap must never sit below the wire floor",
                );
            }
        }
    }

    #[test]
    fn send_budget_flags_every_overrun_however_small() {
        // 60 GRB LEDs: 186 B/frame, 16 ms requested vs 17 ms wire — the 16 ms
        // hard floor in the derive helper already overruns here.
        assert!(SerialSendBudget::for_strip(
            60,
            FirmwareProfile::LumaSyncV1,
            LedChipType::Ws2812bGrb
        )
        .exceeds_link_budget());
        // 100 GRB LEDs: 27 ms requested vs 27 ms wire — exactly at budget.
        assert!(!SerialSendBudget::for_strip(
            100,
            FirmwareProfile::LumaSyncV1,
            LedChipType::Ws2812bGrb
        )
        .exceeds_link_budget());
        let rgbw =
            SerialSendBudget::for_strip(100, FirmwareProfile::LumaSyncV1, LedChipType::Sk6812Rgbw);
        assert_eq!(rgbw.bytes_per_frame, 406);
        assert_eq!(rgbw.wire_ms, 36);
        // 4000 LEDs: the 10 fps floor asks for 100 ms, the wire needs ~1.04 s.
        let long =
            SerialSendBudget::for_strip(4000, FirmwareProfile::LumaSyncV1, LedChipType::Ws2812bGrb);
        assert!(long.exceeds_link_budget());
        assert_eq!(long.requested_ms, 100);
        assert_eq!(long.wire_ms, 1043);
    }

    #[test]
    fn link_constrained_reports_degradation_not_rounding() {
        // A 60-LED strip is clamped by 1 ms (16 → 17) but still runs ~59 fps —
        // reporting that as a problem would cry wolf on the commonest setup.
        let common =
            SerialSendBudget::for_strip(60, FirmwareProfile::LumaSyncV1, LedChipType::Ws2812bGrb);
        assert!(common.exceeds_link_budget());
        assert!(!common.is_link_constrained());

        // 200 LEDs runs at ~19 fps — genuinely degraded, worth telling the user.
        assert!(SerialSendBudget::for_strip(
            200,
            FirmwareProfile::LumaSyncV1,
            LedChipType::Ws2812bGrb
        )
        .is_link_constrained());
        // Same LED count, opposite verdict: RGBW's extra byte per pixel drops
        // 100 LEDs from ~37.6 fps to ~28.4 fps.
        assert!(!SerialSendBudget::for_strip(
            100,
            FirmwareProfile::LumaSyncV1,
            LedChipType::Ws2812bGrb
        )
        .is_link_constrained());
        assert!(SerialSendBudget::for_strip(
            100,
            FirmwareProfile::LumaSyncV1,
            LedChipType::Sk6812Rgbw
        )
        .is_link_constrained());
    }

    #[test]
    fn send_budget_lifts_the_default_cap_above_the_wire_floor() {
        // The 80 ms default `max_interval_ms` would otherwise clamp a long
        // strip's interval BELOW its physical floor — permanent backpressure
        // against the 500 ms serial write timeout.
        let default_cap = RuntimeQualityConfig::default().max_interval_ms;
        assert_eq!(default_cap, 80);

        let long =
            SerialSendBudget::for_strip(4000, FirmwareProfile::LumaSyncV1, LedChipType::Ws2812bGrb);
        let config = long.into_quality_config(0.35);
        assert_eq!(config.min_interval_ms, 1043);
        assert_eq!(config.max_interval_ms, 1043);

        let short =
            SerialSendBudget::for_strip(60, FirmwareProfile::LumaSyncV1, LedChipType::Ws2812bGrb);
        assert_eq!(short.into_quality_config(0.35).max_interval_ms, default_cap);
    }

    #[test]
    fn send_budget_widens_for_rgbw_at_the_same_led_count() {
        let grb =
            SerialSendBudget::for_strip(150, FirmwareProfile::LumaSyncV1, LedChipType::Ws2812bGrb);
        let rgbw =
            SerialSendBudget::for_strip(150, FirmwareProfile::LumaSyncV1, LedChipType::Sk6812Rgbw);
        assert!(rgbw.wire_ms > grb.wire_ms);
        assert!(rgbw.link_max_fps < grb.link_max_fps);
        assert!(
            rgbw.into_quality_config(0.35).min_interval_ms
                > grb.into_quality_config(0.35).min_interval_ms
        );
    }

    /// Adalight has no RGBW frame, so an SK6812 strip under it ships three
    /// bytes a pixel; budgeting four capped it a quarter below the link.
    #[test]
    fn send_budget_sizes_adalight_sk6812_by_the_three_byte_frame_it_sends() {
        let ada_rgbw =
            SerialSendBudget::for_strip(164, FirmwareProfile::Adalight, LedChipType::Sk6812Rgbw);
        let grb =
            SerialSendBudget::for_strip(164, FirmwareProfile::LumaSyncV1, LedChipType::Ws2812bGrb);
        assert_eq!(ada_rgbw, grb);
        assert_eq!(ada_rgbw.bytes_per_frame, 164 * 3 + 6);
        assert!(ada_rgbw.link_max_fps > 23.0);
    }

    #[test]
    fn send_budget_floor_holds_when_observed_cost_is_negligible() {
        // Pressure adaptation only ever widens the interval; the floor is what
        // stops a cheap capture from driving the link past its budget.
        let mut controller = AmbilightWorkerQualityState::new(
            SerialSendBudget::for_strip(200, FirmwareProfile::LumaSyncV1, LedChipType::Ws2812bGrb)
                .into_quality_config(0.35),
        );
        controller.observe_capture_and_send_cost(0.1, 0.1);
        assert_eq!(controller.current_send_interval().as_millis() as u64, 53);
    }

    #[derive(Default)]
    struct FakeLedSender {
        writes: Mutex<Vec<(String, Vec<u8>)>>,
        disconnected: Mutex<Vec<String>>,
    }

    impl FakeLedSender {
        fn disconnected_ports(&self) -> Vec<String> {
            self.disconnected
                .lock()
                .expect("disconnected lock poisoned")
                .clone()
        }
    }

    impl LedPacketSender for FakeLedSender {
        fn send(&self, port_name: &str, packet: &[u8]) -> Result<(), LedOutputError> {
            self.writes
                .lock()
                .expect("writes lock poisoned")
                .push((port_name.to_string(), packet.to_vec()));
            Ok(())
        }

        fn disconnect_session(&self, port_name: &str) {
            self.disconnected
                .lock()
                .expect("disconnected lock poisoned")
                .push(port_name.to_string());
        }
    }

    struct FakeFrameSource {
        frame: CapturedFrame,
        fail_with_unavailable: bool,
    }

    impl AmbilightFrameSource for FakeFrameSource {
        fn capture_frame(&mut self) -> Result<Arc<CapturedFrame>, AmbilightCaptureError> {
            if self.fail_with_unavailable {
                return Err(AmbilightCaptureError::FrameUnavailable);
            }
            Ok(Arc::new(self.frame.clone()))
        }
    }

    fn owner_with_fake_sender() -> LightingRuntimeOwner {
        LightingRuntimeOwner {
            active_mode: LightingModeConfig::default(),
            active_port: None,
            worker: None,
            ambilight_live: None,
            room_geometry_live: None,
            output_bridge: LedOutputBridge::from_sender(Arc::new(FakeLedSender::default())),
            preview: Default::default(),
            frame_source_factory: Arc::new(|_req: super::AmbilightCaptureRequest| {
                Ok(Box::new(FakeFrameSource {
                    frame: CapturedFrame {
                        width: 2,
                        height: 2,
                        pixels_rgb: vec![[10, 20, 30], [40, 50, 60], [70, 80, 90], [100, 110, 120]],
                    },
                    fail_with_unavailable: false,
                }))
            }),
        }
    }

    fn owner_with_unavailable_capture() -> LightingRuntimeOwner {
        LightingRuntimeOwner {
            active_mode: LightingModeConfig::default(),
            active_port: None,
            worker: None,
            ambilight_live: None,
            room_geometry_live: None,
            output_bridge: LedOutputBridge::from_sender(Arc::new(FakeLedSender::default())),
            preview: Default::default(),
            frame_source_factory: Arc::new(|_req: super::AmbilightCaptureRequest| {
                Ok(Box::new(FakeFrameSource {
                    frame: CapturedFrame {
                        width: 1,
                        height: 1,
                        pixels_rgb: vec![[0, 0, 0]],
                    },
                    fail_with_unavailable: true,
                }))
            }),
        }
    }

    fn ambilight_mode() -> LightingModeConfig {
        LightingModeConfig {
            kind: LightingModeKind::Ambilight,
            solid: None,
            ambilight: Some(AmbilightPayload {
                brightness: 0.8,
                ..Default::default()
            }),
            targets: None,
            display_id: None,
            led_calibration: None,
            color_correction: None,
            firmware_profile: None,
            chip_type: None,
            color_order: None,
            room_geometry: None,
        }
    }

    fn solid_mode() -> LightingModeConfig {
        LightingModeConfig {
            kind: LightingModeKind::Solid,
            solid: Some(SolidColorPayload {
                r: 32,
                g: 64,
                b: 128,
                brightness: 0.6,
            }),
            ambilight: None,
            targets: None,
            display_id: None,
            led_calibration: None,
            color_correction: None,
            firmware_profile: None,
            chip_type: None,
            color_order: None,
            room_geometry: None,
        }
    }

    fn wait_for_worker_count(target: usize) {
        for _ in 0..10 {
            if ACTIVE_AMBILIGHT_WORKERS.load(Ordering::SeqCst) == target {
                return;
            }
            thread::sleep(Duration::from_millis(5));
        }
    }

    /// Serialise a worker-touching test against the process-global
    /// `ACTIVE_AMBILIGHT_WORKERS` counter. Hold the returned guard for the
    /// whole test body so the next test only starts once this one has drained
    /// its workers back to zero. Recovers from poisoning so a panic in one
    /// guarded test does not cascade into spurious failures elsewhere.
    fn acquire_worker_test_guard() -> std::sync::MutexGuard<'static, ()> {
        super::WORKER_TEST_GUARD
            .lock()
            .unwrap_or_else(|e| e.into_inner())
    }

    fn shared_runtime_telemetry() -> Arc<Mutex<RuntimeTelemetrySnapshot>> {
        Arc::new(Mutex::new(RuntimeTelemetrySnapshot::default()))
    }

    /// Mirrors `owner_with_fake_sender` but exposes the recorder `Arc` so a
    /// test can inspect (or assert the absence of) serial writes.
    fn owner_with_recording_sender() -> (LightingRuntimeOwner, Arc<FakeLedSender>) {
        let recorder: Arc<FakeLedSender> = Arc::new(FakeLedSender::default());
        let owner = LightingRuntimeOwner {
            active_mode: LightingModeConfig::default(),
            active_port: None,
            worker: None,
            ambilight_live: None,
            room_geometry_live: None,
            output_bridge: LedOutputBridge::from_sender(recorder.clone()),
            preview: Default::default(),
            frame_source_factory: Arc::new(|_req: super::AmbilightCaptureRequest| {
                Ok(Box::new(FakeFrameSource {
                    frame: CapturedFrame {
                        width: 2,
                        height: 2,
                        pixels_rgb: vec![[10, 20, 30], [40, 50, 60], [70, 80, 90], [100, 110, 120]],
                    },
                    fail_with_unavailable: false,
                }))
            }),
        };
        (owner, recorder)
    }

    // -----------------------------------------------------------------------
    // set_active_port — release the old port's cached session only on switch
    // -----------------------------------------------------------------------

    #[test]
    fn set_active_port_preserves_same_port_but_releases_a_different_one() {
        let (mut owner, recorder) = owner_with_recording_sender();

        set_active_port(&mut owner, "COM_A".to_string());
        assert_eq!(owner.active_port.as_deref(), Some("COM_A"));
        assert!(
            recorder.disconnected_ports().is_empty(),
            "first-ever port assignment has nothing to release"
        );

        // Same port again — a mode restart on the port already in use. The
        // cached session must be left alone (DTR invariant).
        set_active_port(&mut owner, "COM_A".to_string());
        assert!(
            recorder.disconnected_ports().is_empty(),
            "re-assigning the SAME port must not release its cached session"
        );

        // A genuine switch — COM_A's cached session must be released so
        // another app (e.g. the Arduino IDE) can open it, and COM_B becomes
        // the new active port without being touched itself.
        set_active_port(&mut owner, "COM_B".to_string());
        assert_eq!(owner.active_port.as_deref(), Some("COM_B"));
        assert_eq!(
            recorder.disconnected_ports(),
            vec!["COM_A".to_string()],
            "switching ports must release exactly the abandoned one"
        );
    }

    /// Loopback would fail `connect_wled_sink`'s SSRF guard, but these tests
    /// exercise dispatch logic downstream of it -- a real `send_to` against
    /// loopback still succeeds with no listener.
    fn wled_config_fixture(led_count: u16) -> WledSinkConfig {
        WledSinkConfig {
            ip: "127.0.0.1".parse().expect("valid IPv4"),
            port: 4048,
            led_count,
            protocol: WledProtocol::Ddp,
        }
    }

    // -----------------------------------------------------------------------
    // resolve_quality_config — WLED-vs-serial budget divergence (D-04)
    // -----------------------------------------------------------------------

    #[test]
    fn resolve_quality_config_serial_link_gets_a_baud_budget() {
        let plan = Some(UsbOutputPlan::Serial("COM1".to_string()));
        let (_, budget) = resolve_quality_config(
            &plan,
            60,
            FirmwareProfile::LumaSyncV1,
            LedChipType::Ws2812bGrb,
            0.35,
        );
        assert!(budget.is_some(), "a serial link must report a baud budget");
    }

    #[test]
    fn resolve_quality_config_wled_never_gets_a_serial_budget_even_when_led_count_is_large() {
        // 300 LEDs at GRB would be link_constrained on a real serial link;
        // WLED must stay unconstrained regardless of LED count.
        let plan = Some(UsbOutputPlan::Wled(wled_config_fixture(300)));
        let (config, budget) = resolve_quality_config(
            &plan,
            300,
            FirmwareProfile::LumaSyncV1,
            LedChipType::Ws2812bGrb,
            0.35,
        );
        assert!(
            budget.is_none(),
            "WLED must never report a serial send budget"
        );
        let defaults = RuntimeQualityConfig::default();
        assert_eq!(
            config.base_interval_ms, defaults.base_interval_ms,
            "WLED must use the capture-paced defaults, not the serial clamp"
        );
        assert_eq!(config.min_interval_ms, defaults.min_interval_ms);
        assert_eq!(config.max_interval_ms, defaults.max_interval_ms);
        assert_eq!(config.smoothing_alpha, 0.35);
    }

    #[test]
    fn resolve_quality_config_hue_only_reports_no_serial_budget() {
        let (config, budget) = resolve_quality_config(
            &None,
            0,
            FirmwareProfile::LumaSyncV1,
            LedChipType::Ws2812bGrb,
            0.35,
        );
        assert!(budget.is_none());
        assert_eq!(config.base_interval_ms, 40);
        assert_eq!(config.min_interval_ms, 30);
        assert_eq!(config.max_interval_ms, 100);
    }

    // -----------------------------------------------------------------------
    // apply_mode_change — registry-selection: WLED vs serial vs neither
    // -----------------------------------------------------------------------

    #[test]
    fn solid_mode_routes_to_wled_sink_and_never_touches_the_serial_bridge() {
        let (mut owner, recorder) = owner_with_recording_sender();
        let result = apply_mode_change(
            &mut owner,
            solid_mode(),
            true,
            Some("COM1"), // stale/irrelevant serial connection
            Some(wled_config_fixture(30)),
            None,
            None,
            None,
            None,
        );

        assert_eq!(result.status.code, "SOLID_MODE_APPLIED");
        // Proof the registered WLED sink was used, not serial, even though a
        // serial port was also nominally connected.
        let writes = recorder.writes.lock().expect("writes lock poisoned");
        assert!(
            writes.is_empty(),
            "the serial bridge must see zero writes when a WLED sink is registered"
        );
    }

    #[test]
    fn solid_mode_usb_gate_passes_when_only_a_wled_sink_is_registered() {
        // No serial device connected this session; only WLED is registered.
        // Before the registry was wired in, this combination hit the
        // DEVICE_NOT_CONNECTED gate and silently blocked WLED-only setups.
        let mut owner = owner_with_fake_sender();
        let result = apply_mode_change(
            &mut owner,
            solid_mode(),
            false,
            None,
            Some(wled_config_fixture(10)),
            None,
            None,
            None,
            None,
        );

        assert_eq!(result.status.code, "SOLID_MODE_APPLIED");
        assert!(result.active);
    }

    #[test]
    fn switching_ports_through_apply_mode_change_releases_the_old_port_only() {
        // The helper alone is not enough: every apply runs stop_previous first,
        // so this goes through the real path to prove the old port survives it.
        let (mut owner, recorder) = owner_with_recording_sender();
        let apply = |owner: &mut LightingRuntimeOwner, port: &str| {
            apply_mode_change(
                owner,
                solid_mode(),
                true,
                Some(port),
                None,
                None,
                None,
                None,
                None,
            )
        };

        assert_eq!(apply(&mut owner, "COM_A").status.code, "SOLID_MODE_APPLIED");
        assert_eq!(apply(&mut owner, "COM_A").status.code, "SOLID_MODE_APPLIED");
        assert!(
            recorder.disconnected_ports().is_empty(),
            "a restart on the same port must keep its cached session (DTR)"
        );

        assert_eq!(apply(&mut owner, "COM_B").status.code, "SOLID_MODE_APPLIED");
        assert_eq!(recorder.disconnected_ports(), vec!["COM_A".to_string()]);
        assert_eq!(owner.active_port.as_deref(), Some("COM_B"));
    }

    #[test]
    fn solid_mode_falls_back_to_serial_when_no_wled_sink_is_registered() {
        // wled_sink=None must reproduce the pre-WLED-wiring behavior exactly.
        let mut owner = owner_with_fake_sender();
        let result = apply_mode_change(
            &mut owner,
            solid_mode(),
            true,
            Some("COM9"),
            None,
            None,
            None,
            None,
            None,
        );

        assert_eq!(result.status.code, "SOLID_MODE_APPLIED");
    }

    #[test]
    fn ambilight_mode_wled_only_starts_and_sends_frames_with_no_serial_connection() {
        let _guard = acquire_worker_test_guard();
        AMBILIGHT_FRAME_ATTEMPTS.store(0, Ordering::SeqCst);
        AMBILIGHT_CAPTURE_ATTEMPTS.store(0, Ordering::SeqCst);

        let mut owner = owner_with_fake_sender();
        let result = apply_mode_change(
            &mut owner,
            ambilight_mode(),
            false,
            None,
            Some(wled_config_fixture(10)),
            None,
            Some(shared_runtime_telemetry()),
            None,
            None,
        );

        assert_eq!(result.status.code, "AMBILIGHT_MODE_STARTED");
        thread::sleep(Duration::from_millis(20));
        assert!(
            AMBILIGHT_FRAME_ATTEMPTS.load(Ordering::SeqCst) > 0,
            "wled-only ambilight must still attempt frame sends"
        );

        let mut cleanup_trace = None;
        stop_previous(&mut owner, &mut cleanup_trace);
        wait_for_worker_count(0);
    }

    /// With nothing available, `start_led_test_pattern` sends `targets: []`,
    /// which the legacy rule reads as "USB required" — and a test skips the USB
    /// gate. Only the plan keeps a recorded but unconnected port from the worker.
    #[test]
    fn a_preview_only_test_pattern_never_writes_to_an_unconnected_port() {
        let _guard = acquire_worker_test_guard();
        let (mut owner, recorder) = owner_with_recording_sender();
        owner.preview.pending_test_pattern = Some(super::TestPatternConfig {
            kind: super::TestPatternKind::Solid { r: 255, g: 0, b: 0 },
            brightness: 1.0,
            speed: Default::default(),
            display_aspect: 1.78,
        });
        let mut mode = ambilight_mode();
        mode.targets = Some(Vec::new());

        let result = apply_mode_change(
            &mut owner,
            mode,
            false,
            Some("/dev/cu.Bluetooth-Incoming-Port"),
            None,
            None,
            Some(shared_runtime_telemetry()),
            None,
            None,
        );

        assert_eq!(result.status.code, "AMBILIGHT_MODE_STARTED");
        thread::sleep(Duration::from_millis(200));
        let writes = recorder.writes.lock().expect("writes lock").len();
        let mut cleanup_trace = None;
        stop_previous(&mut owner, &mut cleanup_trace);
        wait_for_worker_count(0);

        assert_eq!(writes, 0, "a preview-only test must not open the port");
        assert_eq!(owner.active_port, None);
    }

    #[test]
    fn set_ambilight_stops_previous_then_starts_new_runtime() {
        let _guard = acquire_worker_test_guard();
        let mut owner = owner_with_fake_sender();
        owner = LightingRuntimeOwner {
            active_mode: ambilight_mode(),
            active_port: Some("COM1".to_string()),
            worker: Some(
                start_ambilight_worker(
                    owner.output_bridge.clone(),
                    Some(UsbOutputPlan::Serial("COM1".to_string())),
                    None,
                    AmbilightLiveSettings::new(0.8, false, 0.35, 1.0),
                    (owner.frame_source_factory)(super::AmbilightCaptureRequest {
                        display_id: None,
                        led_calibration: None,
                        test_pattern: None,
                        pattern_phase: None,
                        pattern_live: None,
                    })
                    .expect("frame source should be available"),
                    shared_runtime_telemetry(),
                    None,
                    None,
                    super::ColorCorrectionConfig::default(),
                    super::FirmwareProfile::default(),
                    super::LedChipType::default(),
                    None,
                    super::RoomGeometryLive::new(None),
                )
                .expect("worker start should succeed"),
            ),
            ambilight_live: None,
            room_geometry_live: None,
            output_bridge: owner.output_bridge,
            frame_source_factory: owner.frame_source_factory,
            preview: Default::default(),
        };
        let mut trace = Vec::new();

        let result = apply_mode_change(
            &mut owner,
            ambilight_mode(),
            true,
            Some("COM1"),
            None,
            None,
            Some(shared_runtime_telemetry()),
            None,
            Some(&mut trace),
        );

        assert_eq!(result.status.code, "AMBILIGHT_MODE_STARTED");
        assert_eq!(result.mode.kind, LightingModeKind::Ambilight);
        assert!(result.active);
        assert_eq!(trace, vec!["stop_previous", "start_ambilight"]);

        let mut cleanup_trace = None;
        stop_previous(&mut owner, &mut cleanup_trace);
        wait_for_worker_count(0);
    }

    #[test]
    fn set_solid_applies_payload_and_marks_mode_active() {
        SOLID_OUTPUT_ATTEMPTS.store(0, Ordering::SeqCst);
        let mut owner = owner_with_fake_sender();
        let result = apply_mode_change(
            &mut owner,
            solid_mode(),
            true,
            Some("COM4"),
            None,
            None,
            None,
            None,
            None,
        );

        assert_eq!(result.status.code, "SOLID_MODE_APPLIED");
        assert_eq!(result.mode.kind, LightingModeKind::Solid);
        assert!(result.active);
        assert_eq!(result.mode.solid.expect("solid payload").brightness, 0.6);
        assert!(
            SOLID_OUTPUT_ATTEMPTS.load(Ordering::SeqCst) > 0,
            "solid mode should attempt physical output"
        );
    }

    #[test]
    fn ambilight_mode_attempts_to_send_at_least_one_frame() {
        let _guard = acquire_worker_test_guard();
        AMBILIGHT_FRAME_ATTEMPTS.store(0, Ordering::SeqCst);
        AMBILIGHT_CAPTURE_ATTEMPTS.store(0, Ordering::SeqCst);

        let mut owner = owner_with_fake_sender();
        let result = apply_mode_change(
            &mut owner,
            ambilight_mode(),
            true,
            Some("COM7"),
            None,
            None,
            Some(shared_runtime_telemetry()),
            None,
            None,
        );

        assert_eq!(result.status.code, "AMBILIGHT_MODE_STARTED");
        thread::sleep(Duration::from_millis(20));
        assert!(
            AMBILIGHT_CAPTURE_ATTEMPTS.load(Ordering::SeqCst) > 0,
            "ambilight mode should attempt at least one frame capture"
        );
        assert!(
            AMBILIGHT_FRAME_ATTEMPTS.load(Ordering::SeqCst) > 0,
            "ambilight mode should attempt at least one frame send"
        );

        let mut cleanup_trace = None;
        stop_previous(&mut owner, &mut cleanup_trace);
        wait_for_worker_count(0);
    }

    #[test]
    fn repeated_switches_keep_single_active_runtime() {
        let _guard = acquire_worker_test_guard();
        let mut owner = owner_with_fake_sender();

        let first = apply_mode_change(
            &mut owner,
            ambilight_mode(),
            true,
            Some("COM2"),
            None,
            None,
            Some(shared_runtime_telemetry()),
            None,
            None,
        );
        assert_eq!(first.mode.kind, LightingModeKind::Ambilight);
        wait_for_worker_count(1);
        assert_eq!(ACTIVE_AMBILIGHT_WORKERS.load(Ordering::SeqCst), 1);

        let second = apply_mode_change(
            &mut owner,
            ambilight_mode(),
            true,
            Some("COM2"),
            None,
            None,
            Some(shared_runtime_telemetry()),
            None,
            None,
        );
        assert_eq!(second.mode.kind, LightingModeKind::Ambilight);
        wait_for_worker_count(1);
        assert_eq!(ACTIVE_AMBILIGHT_WORKERS.load(Ordering::SeqCst), 1);

        let final_state = apply_mode_change(
            &mut owner,
            solid_mode(),
            true,
            Some("COM2"),
            None,
            None,
            None,
            None,
            None,
        );
        assert_eq!(final_state.mode.kind, LightingModeKind::Solid);
        wait_for_worker_count(0);
        assert_eq!(ACTIVE_AMBILIGHT_WORKERS.load(Ordering::SeqCst), 0);

        assert_eq!(final_state.status.code, "SOLID_MODE_APPLIED");
    }

    #[test]
    fn solid_to_ambilight_to_solid_keeps_runtime_exclusive() {
        // Manual-test repro for v1.5 #44: user enters Solid mode, frontend
        // race fires a stale Ambilight push, then user pushes Solid again.
        // The runtime owner must end on Solid with zero active workers and
        // the LED bridge must NOT be holding a stale ambilight worker.
        let _guard = acquire_worker_test_guard();
        let mut owner = owner_with_fake_sender();

        // Solid #1
        let s1 = apply_mode_change(
            &mut owner,
            solid_mode(),
            true,
            Some("COM-EX"),
            None,
            None,
            None,
            None,
            None,
        );
        assert_eq!(s1.status.code, "SOLID_MODE_APPLIED");
        wait_for_worker_count(0);
        assert_eq!(ACTIVE_AMBILIGHT_WORKERS.load(Ordering::SeqCst), 0);

        // Stale Ambilight push (simulates the frontend race that the manual
        // tester reproduced — a brightness/preset effect re-sending Ambilight
        // immediately after the user picked Solid).
        let amb = apply_mode_change(
            &mut owner,
            ambilight_mode(),
            true,
            Some("COM-EX"),
            None,
            None,
            Some(shared_runtime_telemetry()),
            None,
            None,
        );
        assert_eq!(amb.status.code, "AMBILIGHT_MODE_STARTED");
        wait_for_worker_count(1);
        assert_eq!(ACTIVE_AMBILIGHT_WORKERS.load(Ordering::SeqCst), 1);

        // Solid #2 — final user intent. Must stop the ambilight worker
        // synchronously and leave zero active workers so the next packet
        // written to the LED bridge is the solid colour, not a stale frame.
        let s2 = apply_mode_change(
            &mut owner,
            solid_mode(),
            true,
            Some("COM-EX"),
            None,
            None,
            None,
            None,
            None,
        );
        assert_eq!(s2.status.code, "SOLID_MODE_APPLIED");
        assert_eq!(s2.mode.kind, LightingModeKind::Solid);
        wait_for_worker_count(0);
        assert_eq!(
            ACTIVE_AMBILIGHT_WORKERS.load(Ordering::SeqCst),
            0,
            "after final Solid, ambilight workers must be fully drained",
        );
        assert!(
            owner.worker.is_none(),
            "owner.worker must be None after Solid takes over",
        );
        assert!(
            owner.ambilight_live.is_none(),
            "owner.ambilight_live must be None after Solid takes over",
        );
    }

    #[test]
    fn disconnected_mode_change_keeps_existing_runtime_state() {
        let mut owner = owner_with_fake_sender();
        let _ = apply_mode_change(
            &mut owner,
            solid_mode(),
            true,
            Some("COM3"),
            None,
            None,
            None,
            None,
            None,
        );

        let denied = apply_mode_change(
            &mut owner,
            ambilight_mode(),
            false,
            None,
            None,
            None,
            Some(shared_runtime_telemetry()),
            None,
            None,
        );

        assert_eq!(denied.status.code, "DEVICE_NOT_CONNECTED");
        assert_eq!(denied.mode.kind, LightingModeKind::Solid);
    }

    #[test]
    fn ambilight_mode_reports_start_failure_when_capture_is_unavailable() {
        let mut owner = owner_with_unavailable_capture();

        let failed = apply_mode_change(
            &mut owner,
            ambilight_mode(),
            true,
            Some("COM1"),
            None,
            None,
            Some(shared_runtime_telemetry()),
            None,
            None,
        );

        assert_eq!(failed.status.code, "AMBILIGHT_MODE_START_FAILED");
        assert_eq!(
            failed.status.details,
            Some("AMBILIGHT_CAPTURE_FRAME_UNAVAILABLE".to_string())
        );
        assert_eq!(failed.mode.kind, LightingModeKind::Off);
    }

    // Originally guarded only against `target_os = "windows"`, but v1.4 added
    // macOS SCDisplay capture and v1.5 W1-D added Linux X11 capture via xcap —
    // so all three first-class targets now build a live source successfully.
    // Restrict the contract assertion to the truly-unsupported platforms (BSDs
    // / illumos) where the factory is still expected to surface the
    // `AMBILIGHT_CAPTURE_UNSUPPORTED_PLATFORM` reason instead of silently
    // falling back to a static source.
    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    #[test]
    fn default_runtime_owner_uses_live_source_factory_contract() {
        let owner = LightingRuntimeOwner::default();

        let error = match (owner.frame_source_factory)(super::AmbilightCaptureRequest {
            display_id: None,
            led_calibration: None,
            test_pattern: None,
        }) {
            Ok(_) => panic!("default frame source must not fall back to static source"),
            Err(error) => error,
        };

        assert_eq!(
            error.as_reason(),
            "AMBILIGHT_CAPTURE_UNSUPPORTED_PLATFORM".to_string()
        );
    }

    #[test]
    fn quality_runtime_smoothes_frame_before_send_when_gate_opens() {
        let mut quality = AmbilightWorkerQualityState::new(RuntimeQualityConfig {
            smoothing_alpha: 0.5,
            base_interval_ms: 1,
            min_interval_ms: 1,
            max_interval_ms: 32,
            pressure_ewma_alpha: 1.0,
        });
        let mut slot = RuntimeFrameSlot::new();
        let base = Instant::now();

        quality.queue_processed_frame(&mut slot, &[[0, 0, 0]]);
        quality.queue_processed_frame(&mut slot, &[[255, 255, 255]]);

        let mut sent = Vec::new();
        let send_due =
            quality.try_send_latest(&mut slot, base + Duration::from_millis(2), |frame| {
                sent.push(frame.to_vec());
                Ok(())
            });

        assert!(send_due.expect("send attempt should succeed"));
        assert_eq!(sent.len(), 1);
        assert_eq!(sent[0], vec![[128, 128, 128]]);
    }

    #[test]
    fn quality_runtime_coalesces_to_latest_frame_when_gate_is_closed() {
        let mut quality = AmbilightWorkerQualityState::new(RuntimeQualityConfig {
            smoothing_alpha: 1.0,
            base_interval_ms: 60,
            min_interval_ms: 8,
            max_interval_ms: 120,
            pressure_ewma_alpha: 1.0,
        });
        let mut slot = RuntimeFrameSlot::new();
        let base = Instant::now();

        quality.queue_processed_frame(&mut slot, &[[10, 10, 10]]);
        let first = quality
            .try_send_latest(&mut slot, base, |_| Ok(()))
            .expect("first send should succeed");
        assert!(first);

        quality.queue_processed_frame(&mut slot, &[[20, 20, 20]]);
        quality.queue_processed_frame(&mut slot, &[[30, 30, 30]]);

        let blocked = quality
            .try_send_latest(&mut slot, base + Duration::from_millis(1), |_| Ok(()))
            .expect("gate check should succeed");
        assert!(!blocked);
        assert_eq!(slot.take_latest(), Some(vec![[30, 30, 30]]));
    }

    #[test]
    fn quality_runtime_adapts_send_interval_under_high_cost() {
        let mut quality = AmbilightWorkerQualityState::new(RuntimeQualityConfig {
            smoothing_alpha: 1.0,
            base_interval_ms: 16,
            min_interval_ms: 8,
            max_interval_ms: 80,
            pressure_ewma_alpha: 1.0,
        });

        let baseline = quality.current_send_interval();
        quality.observe_capture_and_send_cost(28.0, 24.0);
        let adapted = quality.current_send_interval();

        assert!(adapted > baseline);
    }

    // -----------------------------------------------------------------------
    // Ambilight worker — per-LED USB encoding (v1.5 hardware repro)
    //
    // Latent symptom (HEAD): "ambilight only lights LED #0". Even though the
    // worker pipeline samples one colour per LED via `sample_frame_for_sequence`
    // and the `SerialSink` encodes the full slice, there was no test that
    // observed the actual byte count reaching the wire. This test snapshots
    // the recorded packet against the LumaSync v1 wire format so any future
    // refactor that drops back to a 1-LED slice is caught immediately.
    // -----------------------------------------------------------------------

    fn ambilight_calibration_with_total_leds(total: u16) -> super::LedCalibrationConfig {
        use crate::commands::led_calibration::LedSegmentCounts;
        let top = total / 2;
        let right = (total - top) / 2;
        let bottom = (total - top - right) / 2;
        let left = total - top - right - bottom;
        super::LedCalibrationConfig {
            template_id: None,
            counts: LedSegmentCounts {
                top,
                right,
                bottom,
                left,
            },
            bottom_missing: 0,
            corner_ownership: "horizontal".to_string(),
            visual_preset: "subtle".to_string(),
            start_anchor: "top-start".to_string(),
            direction: "cw".to_string(),
            total_leds: total,
        }
    }

    fn ambilight_mode_with_calibration(total_leds: u16) -> LightingModeConfig {
        LightingModeConfig {
            kind: LightingModeKind::Ambilight,
            solid: None,
            ambilight: Some(AmbilightPayload {
                brightness: 1.0,
                ..Default::default()
            }),
            targets: Some(vec!["usb".to_string()]),
            display_id: None,
            led_calibration: Some(ambilight_calibration_with_total_leds(total_leds)),
            color_correction: None,
            firmware_profile: None,
            chip_type: None,
            color_order: None,
            room_geometry: None,
        }
    }

    /// Build an owner whose `LedPacketSender` is exposed as an `Arc` so the
    /// test can read recorded packet bytes back. Mirrors `owner_with_fake_sender`
    /// but returns the recorder Arc alongside the owner.
    fn owner_with_recording_sender_for_ambilight() -> (LightingRuntimeOwner, Arc<FakeLedSender>) {
        let recorder: Arc<FakeLedSender> = Arc::new(FakeLedSender::default());
        let owner = LightingRuntimeOwner {
            active_mode: LightingModeConfig::default(),
            active_port: None,
            worker: None,
            ambilight_live: None,
            room_geometry_live: None,
            output_bridge: LedOutputBridge::from_sender(recorder.clone()),
            preview: Default::default(),
            frame_source_factory: Arc::new(|_req: super::AmbilightCaptureRequest| {
                Ok(Box::new(FakeFrameSource {
                    frame: CapturedFrame {
                        width: 4,
                        height: 4,
                        // 16 unique pixels so per-LED averaging in
                        // `sample_frame_for_sequence` produces non-zero output
                        // for every edge LED regardless of segment counts.
                        pixels_rgb: (0..16)
                            .map(|i| [(i * 16) as u8, ((i * 7) % 256) as u8, 200])
                            .collect(),
                    },
                    fail_with_unavailable: false,
                }))
            }),
        };
        (owner, recorder)
    }

    #[test]
    fn ambilight_mode_with_30_led_calibration_emits_per_led_usb_packet() {
        // 30 LEDs × 3 bytes/LED + 5-byte header + 1-byte XOR = 96 bytes.
        // Verifies the ambilight worker's USB sink is encoding the FULL
        // sampled sequence — not just a single-LED slice. Asserts on the
        // initial-frame send (line ~899 in lighting_mode.rs) which fires
        // synchronously inside `start_ambilight_worker` BEFORE the worker
        // thread spawns. That deterministic write avoids racing the worker
        // loop's first iteration.
        let _guard = acquire_worker_test_guard();
        AMBILIGHT_FRAME_ATTEMPTS.store(0, Ordering::SeqCst);
        AMBILIGHT_CAPTURE_ATTEMPTS.store(0, Ordering::SeqCst);

        let (mut owner, recorder) = owner_with_recording_sender_for_ambilight();
        let result = apply_mode_change(
            &mut owner,
            ambilight_mode_with_calibration(30),
            true,
            Some("COM-AMB-30"),
            None,
            None,
            Some(shared_runtime_telemetry()),
            None,
            None,
        );

        assert_eq!(result.status.code, "AMBILIGHT_MODE_STARTED");

        // The worker's initial-frame send is synchronous. Brief grace period
        // covers the worker thread's first loop iteration as a belt-and-braces
        // measure, but the assertion below requires only the synchronous send.
        thread::sleep(Duration::from_millis(50));

        let writes = recorder.writes.lock().expect("writes lock poisoned");
        assert!(
            !writes.is_empty(),
            "ambilight worker must dispatch at least one USB packet"
        );
        let (port, packet) = &writes[0];
        assert_eq!(port, "COM-AMB-30");
        assert_eq!(
            packet.len(),
            5 + 3 * 30 + 1,
            "30-LED ambilight frame must be 96 bytes (was {} bytes — likely a 1-LED slice regression)",
            packet.len()
        );
        assert_eq!(&packet[0..2], &[0xAA, 0x55]);
        let count = u16::from_le_bytes([packet[3], packet[4]]);
        assert_eq!(count, 30, "wire count must match calibration total_leds");

        // XOR checksum must validate so the firmware accepts the frame.
        let (body, checksum) = packet.split_at(packet.len() - 1);
        let computed = body.iter().fold(0_u8, |acc, b| acc ^ b);
        assert_eq!(
            computed, checksum[0],
            "ambilight frame XOR must match firmware-side parser"
        );

        drop(writes);
        let mut cleanup_trace = None;
        stop_previous(&mut owner, &mut cleanup_trace);
        wait_for_worker_count(0);
    }

    // -----------------------------------------------------------------------
    // Colour order — read live by the worker, not by a restart
    // -----------------------------------------------------------------------

    fn owner_with_red_frame() -> (LightingRuntimeOwner, Arc<FakeLedSender>) {
        let recorder: Arc<FakeLedSender> = Arc::new(FakeLedSender::default());
        let owner = LightingRuntimeOwner {
            active_mode: LightingModeConfig::default(),
            active_port: None,
            worker: None,
            ambilight_live: None,
            room_geometry_live: None,
            output_bridge: LedOutputBridge::from_sender(recorder.clone()),
            preview: Default::default(),
            frame_source_factory: Arc::new(|_req: super::AmbilightCaptureRequest| {
                Ok(Box::new(FakeFrameSource {
                    frame: CapturedFrame {
                        width: 4,
                        height: 4,
                        pixels_rgb: vec![[255, 0, 0]; 16],
                    },
                    fail_with_unavailable: false,
                }))
            }),
        };
        (owner, recorder)
    }

    /// Red dominates wire slot 0 under the identity order and slot 2 under
    /// BGR; the scene stage may blend, but it cannot swap which slot leads.
    fn first_pixel(packet: &[u8]) -> [u8; 3] {
        [packet[5], packet[6], packet[7]]
    }

    fn apply_on(
        owner: &mut LightingRuntimeOwner,
        mode: LightingModeConfig,
    ) -> super::LightingModeCommandResult {
        apply_mode_change(
            owner,
            mode,
            true,
            Some("COM-ORDER"),
            None,
            None,
            Some(shared_runtime_telemetry()),
            None,
            None,
        )
    }

    #[test]
    fn a_color_order_change_retunes_the_running_worker_in_place() {
        let _guard = acquire_worker_test_guard();
        let (mut owner, recorder) = owner_with_red_frame();
        let mode = ambilight_mode_with_calibration(8);

        assert_eq!(
            apply_on(&mut owner, mode.clone()).status.code,
            "AMBILIGHT_MODE_STARTED"
        );
        let live = Arc::clone(owner.ambilight_live.as_ref().expect("live after start"));
        let [r, _, b] = first_pixel(&recorder.writes.lock().unwrap()[0].1);
        assert!(r > b, "identity order leaves red in slot 0");

        let reordered = LightingModeConfig {
            color_order: Some(LedColorOrder::Bgr),
            ..mode.clone()
        };
        let result = apply_on(&mut owner, reordered);
        assert_eq!(
            result.status.code, "AMBILIGHT_MODE_UPDATED",
            "a colour-order change must not restart the worker"
        );
        assert!(Arc::ptr_eq(&live, owner.ambilight_live.as_ref().unwrap()));
        assert_eq!(live.read_color_order(), LedColorOrder::Bgr);
        assert_eq!(result.mode.color_order, Some(LedColorOrder::Bgr));

        let seen = recorder.writes.lock().unwrap().len();
        let deadline = Instant::now() + Duration::from_secs(3);
        let reached_the_wire = loop {
            let reordered_frame =
                recorder.writes.lock().unwrap()[seen..]
                    .iter()
                    .any(|(_, packet)| {
                        let [r, _, b] = first_pixel(packet);
                        b > r
                    });
            if reordered_frame || Instant::now() > deadline {
                break reordered_frame;
            }
            thread::sleep(Duration::from_millis(20));
        };
        assert!(reached_the_wire, "the running worker sends red in slot 2");

        assert_eq!(
            apply_on(&mut owner, mode).status.code,
            "AMBILIGHT_MODE_UPDATED"
        );
        assert_eq!(
            live.read_color_order(),
            LedColorOrder::Rgb,
            "dropping the order returns to the identity"
        );

        let mut cleanup_trace = None;
        stop_previous(&mut owner, &mut cleanup_trace);
        wait_for_worker_count(0);
    }

    /// The first frame is sent before the loop starts; without its own
    /// `set_color_order` it would go out in the identity order.
    #[test]
    fn the_first_frame_already_carries_the_color_order() {
        let _guard = acquire_worker_test_guard();
        let (mut owner, recorder) = owner_with_red_frame();
        let mode = LightingModeConfig {
            color_order: Some(LedColorOrder::Bgr),
            ..ambilight_mode_with_calibration(8)
        };

        assert_eq!(
            apply_on(&mut owner, mode).status.code,
            "AMBILIGHT_MODE_STARTED"
        );
        let [r, _, b] = first_pixel(&recorder.writes.lock().unwrap()[0].1);
        assert!(b > r, "the synchronous first send is already reordered");

        let mut cleanup_trace = None;
        stop_previous(&mut owner, &mut cleanup_trace);
        wait_for_worker_count(0);
    }

    #[test]
    fn solid_writes_in_the_requested_color_order() {
        let (mut owner, recorder) = owner_with_red_frame();
        let mode = LightingModeConfig {
            kind: LightingModeKind::Solid,
            solid: Some(SolidColorPayload {
                r: 255,
                g: 0,
                b: 0,
                brightness: 1.0,
            }),
            targets: Some(vec!["usb".to_string()]),
            led_calibration: Some(ambilight_calibration_with_total_leds(4)),
            color_order: Some(LedColorOrder::Gbr),
            ..LightingModeConfig::default()
        };
        assert_eq!(apply_on(&mut owner, mode).status.code, "SOLID_MODE_APPLIED");
        let writes = recorder.writes.lock().unwrap();
        assert_eq!(first_pixel(&writes[0].1), [0, 0, 255]);
    }

    /// WLED has its own colour-order setting on the device; reordering here
    /// too would apply the correction twice.
    #[test]
    fn a_wled_sink_ignores_the_color_order() {
        let receiver = std::net::UdpSocket::bind("127.0.0.1:0").expect("bind receiver");
        receiver
            .set_read_timeout(Some(Duration::from_secs(2)))
            .expect("read timeout");
        let config = WledSinkConfig {
            ip: "127.0.0.1".parse().expect("valid IPv4"),
            port: receiver.local_addr().expect("addr").port(),
            led_count: 2,
            protocol: WledProtocol::Ddp,
        };
        let mut sink = super::ActiveUsbSink::Wled(Box::new(super::CorrectedWledSink::new(
            config.build(),
            Default::default(),
        )));
        sink.start().expect("start");

        let pixels = |sink: &mut super::ActiveUsbSink| {
            sink.send_frame(&[[255, 0, 0], [0, 0, 255]]).expect("send");
            let mut buf = [0_u8; 64];
            let n = receiver.recv(&mut buf).expect("datagram");
            buf[10..n].to_vec()
        };
        assert_eq!(pixels(&mut sink), vec![255, 0, 0, 0, 0, 255]);
        sink.set_color_order(LedColorOrder::Bgr);
        assert_eq!(pixels(&mut sink), vec![255, 0, 0, 0, 0, 255]);
        sink.stop().expect("stop");
    }
}

#[cfg(test)]
mod lighting_mode_tests {
    use std::sync::{Arc, Mutex};

    use crate::commands::ambilight_capture::{
        AmbilightCaptureError, AmbilightFrameSource, CapturedFrame,
    };
    use crate::commands::led_output::{LedOutputBridge, LedOutputError, LedPacketSender};
    use crate::commands::runtime_telemetry::RuntimeTelemetrySnapshot;

    use super::{
        apply_mode_change, normalize_mode_config, AmbilightPayload, LedChipType, LedColorOrder,
        LightingModeConfig, LightingModeKind, LightingRuntimeOwner, SolidColorPayload,
        TestPatternConfig, TestPatternKind, TestPatternSpeed,
    };
    use crate::commands::hue::frame::{
        HueAreaChannel, HueColorSender, HueColorUpdate, HueScreenRegion,
    };
    use crate::commands::hue::state_store::HueActiveOutputContext;
    use crate::commands::led_output::{ColorCorrectionConfig, FirmwareProfile};
    use crate::models::room_map::{RoomDimensions, RoomGeometry, TvAnchorPlacement};

    #[derive(Default)]
    struct FakeLedSender {
        writes: Mutex<Vec<(String, Vec<u8>)>>,
    }

    impl LedPacketSender for FakeLedSender {
        fn send(&self, port_name: &str, packet: &[u8]) -> Result<(), LedOutputError> {
            self.writes
                .lock()
                .expect("writes lock poisoned")
                .push((port_name.to_string(), packet.to_vec()));
            Ok(())
        }

        fn disconnect_session(&self, _port_name: &str) {}
    }

    struct FakeFrameSource {
        frame: CapturedFrame,
    }

    impl AmbilightFrameSource for FakeFrameSource {
        fn capture_frame(&mut self) -> Result<Arc<CapturedFrame>, AmbilightCaptureError> {
            Ok(Arc::new(self.frame.clone()))
        }
    }

    fn owner_with_fake_sender() -> LightingRuntimeOwner {
        LightingRuntimeOwner {
            active_mode: LightingModeConfig::default(),
            active_port: None,
            worker: None,
            ambilight_live: None,
            room_geometry_live: None,
            output_bridge: LedOutputBridge::from_sender(Arc::new(FakeLedSender::default())),
            preview: Default::default(),
            frame_source_factory: Arc::new(|_req: super::AmbilightCaptureRequest| {
                Ok(Box::new(FakeFrameSource {
                    frame: CapturedFrame {
                        width: 2,
                        height: 2,
                        pixels_rgb: vec![[10, 20, 30], [40, 50, 60], [70, 80, 90], [100, 110, 120]],
                    },
                }))
            }),
        }
    }

    fn shared_telemetry() -> Arc<Mutex<RuntimeTelemetrySnapshot>> {
        Arc::new(Mutex::new(RuntimeTelemetrySnapshot::default()))
    }

    /// Warms up once, then fails forever — the display-unplugged-mid-stream
    /// shape. The first frame must succeed or `start_ambilight_worker` never
    /// gets past its warm-up retry loop and no worker exists to observe.
    struct FailsAfterFirstFrameSource {
        frame: CapturedFrame,
        served: std::sync::atomic::AtomicBool,
    }

    impl AmbilightFrameSource for FailsAfterFirstFrameSource {
        fn capture_frame(&mut self) -> Result<Arc<CapturedFrame>, AmbilightCaptureError> {
            if self.served.swap(true, std::sync::atomic::Ordering::SeqCst) {
                return Err(AmbilightCaptureError::InvalidFrame(
                    "AMBILIGHT_CAPTURE_MONITOR_NOT_FOUND",
                ));
            }
            Ok(Arc::new(self.frame.clone()))
        }
    }

    fn owner_that_fails_after_first_frame() -> LightingRuntimeOwner {
        LightingRuntimeOwner {
            active_mode: LightingModeConfig::default(),
            active_port: None,
            worker: None,
            ambilight_live: None,
            room_geometry_live: None,
            output_bridge: LedOutputBridge::from_sender(Arc::new(FakeLedSender::default())),
            preview: Default::default(),
            frame_source_factory: Arc::new(|_req: super::AmbilightCaptureRequest| {
                Ok(Box::new(FailsAfterFirstFrameSource {
                    frame: CapturedFrame {
                        width: 2,
                        height: 2,
                        pixels_rgb: vec![[10, 20, 30], [40, 50, 60], [70, 80, 90], [100, 110, 120]],
                    },
                    served: std::sync::atomic::AtomicBool::new(false),
                }))
            }),
        }
    }

    /// Serialise a worker-touching test against the process-global
    /// `ACTIVE_AMBILIGHT_WORKERS` counter, sharing the SAME lock as the sibling
    /// `tests` module. Hold the returned guard for the whole test body.
    fn acquire_worker_test_guard() -> std::sync::MutexGuard<'static, ()> {
        super::WORKER_TEST_GUARD
            .lock()
            .unwrap_or_else(|e| e.into_inner())
    }

    /// Spin until the process-global active-worker count drains to zero (or a
    /// short timeout elapses) so the guarded test releases its lock only after
    /// its spawned workers have exited. Mirrors `tests::wait_for_worker_count`
    /// but is local to this module, which does not import the counter directly.
    fn wait_for_workers_drained() {
        for _ in 0..20 {
            if super::ACTIVE_AMBILIGHT_WORKERS.load(std::sync::atomic::Ordering::SeqCst) == 0 {
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
    }

    fn ambilight_with_targets(targets: Option<Vec<String>>) -> LightingModeConfig {
        LightingModeConfig {
            kind: LightingModeKind::Ambilight,
            solid: None,
            ambilight: Some(AmbilightPayload {
                brightness: 1.0,
                ..Default::default()
            }),
            targets,
            display_id: None,
            led_calibration: None,
            color_correction: None,
            firmware_profile: None,
            chip_type: None,
            color_order: None,
            room_geometry: None,
        }
    }

    fn solid_with_targets(targets: Option<Vec<String>>) -> LightingModeConfig {
        LightingModeConfig {
            kind: LightingModeKind::Solid,
            solid: Some(SolidColorPayload {
                r: 255,
                g: 0,
                b: 0,
                brightness: 1.0,
            }),
            ambilight: None,
            targets,
            display_id: None,
            led_calibration: None,
            color_correction: None,
            firmware_profile: None,
            chip_type: None,
            color_order: None,
            room_geometry: None,
        }
    }

    #[test]
    fn hue_only_target_bypasses_usb_gate() {
        // targets=["hue"], device_connected=false, hue_output=None
        // USB gate should be bypassed; Hue gate should fire (HUE_NOT_READY)
        // Either way: result must NOT be DEVICE_NOT_CONNECTED.
        let mut owner = owner_with_fake_sender();
        let result = apply_mode_change(
            &mut owner,
            solid_with_targets(Some(vec!["hue".to_string()])),
            false,
            // device not connected
            None,
            None,
            // no serial port
            None,
            // hue_output=None triggers HUE_NOT_READY gate
            None,
            None,
            None,
        );

        assert_ne!(
            result.status.code, "DEVICE_NOT_CONNECTED",
            "Hue-only target should bypass USB gate; got: {}",
            result.status.code
        );
        // Hue gate fires because hue_output is None
        assert_eq!(result.status.code, "HUE_NOT_READY");
    }

    #[test]
    fn usb_target_requires_device_connected() {
        // targets=["usb"], device_connected=false -> DEVICE_NOT_CONNECTED
        let mut owner = owner_with_fake_sender();
        let result = apply_mode_change(
            &mut owner,
            solid_with_targets(Some(vec!["usb".to_string()])),
            false,
            // device not connected
            None,
            None,
            None,
            None,
            None,
            None,
        );

        assert_eq!(result.status.code, "DEVICE_NOT_CONNECTED");
    }

    /// A port name recorded while `connected` is false was never admitted by
    /// `connect_serial_port`, so it must not become a serial plan.
    #[test]
    fn a_recorded_port_without_a_connection_does_not_arm_serial_output() {
        let mut owner = owner_with_fake_sender();
        let result = apply_mode_change(
            &mut owner,
            solid_with_targets(Some(vec!["usb".to_string()])),
            false,
            Some("/dev/cu.Bluetooth-Incoming-Port"),
            None,
            None,
            None,
            None,
            None,
        );

        assert_eq!(result.status.code, "DEVICE_NOT_CONNECTED");
        assert_eq!(owner.active_port, None);
    }

    #[test]
    fn none_targets_preserves_legacy_usb_gate() {
        // targets=None, device_connected=false -> DEVICE_NOT_CONNECTED (backward compat per D-10)
        let mut owner = owner_with_fake_sender();
        let result = apply_mode_change(
            &mut owner,
            solid_with_targets(None),
            false,
            // device not connected
            None,
            None,
            None,
            None,
            None,
            None,
        );

        assert_eq!(result.status.code, "DEVICE_NOT_CONNECTED");
    }

    #[test]
    fn hue_only_target_returns_hue_not_ready_when_no_hue_output() {
        // targets=["hue"], hue_output=None -> HUE_NOT_READY
        let mut owner = owner_with_fake_sender();
        let result = apply_mode_change(
            &mut owner,
            ambilight_with_targets(Some(vec!["hue".to_string()])),
            false, // device not connected (irrelevant for hue-only)
            None,
            None, // wled_sink
            None, // no hue output -> HUE_NOT_READY
            Some(shared_telemetry()),
            None,
            None,
        );

        assert_eq!(result.status.code, "HUE_NOT_READY");
    }

    fn solid_hue_only() -> LightingModeConfig {
        LightingModeConfig {
            kind: LightingModeKind::Solid,
            solid: Some(SolidColorPayload {
                r: 200,
                g: 10,
                b: 40,
                brightness: 1.0,
            }),
            ambilight: None,
            targets: Some(vec!["hue".to_string()]),
            display_id: None,
            led_calibration: None,
            color_correction: None,
            firmware_profile: None,
            chip_type: None,
            color_order: None,
            room_geometry: None,
        }
    }

    fn hue_context_with_channels(channel_count: usize) -> HueActiveOutputContext {
        let (tx, rx) = std::sync::mpsc::sync_channel::<HueColorUpdate>(4);
        // Keep the receiver alive for the duration of the test process so
        // `try_send` mirrors a live sender thread rather than a closed channel.
        std::mem::forget(rx);
        HueActiveOutputContext {
            channels: (0..channel_count)
                .map(|i| HueAreaChannel {
                    channel_id: i as u8,
                    light_ids: vec![format!("light-{i}")],
                    screen_region: HueScreenRegion::Center,
                    position_x: 0.0,
                    position_y: 0.0,
                    position_z: None,
                })
                .collect(),
            color_sender: HueColorSender {
                tx: Arc::new(tx),
                channel_count: channel_count.max(1),
            },
        }
    }

    #[test]
    fn a_channel_height_does_not_reach_the_scene_stage() {
        let at_height = |position_z: Option<f32>| {
            vec![
                HueAreaChannel {
                    channel_id: 0,
                    light_ids: vec!["light-0".to_string()],
                    screen_region: HueScreenRegion::Left,
                    position_x: -0.7,
                    position_y: 0.4,
                    position_z,
                },
                HueAreaChannel {
                    channel_id: 3,
                    light_ids: vec!["light-3".to_string()],
                    screen_region: HueScreenRegion::Bottom,
                    position_x: 0.1,
                    position_y: -0.9,
                    position_z: position_z.map(|z| -z),
                },
            ]
        };
        let points = |topology: crate::commands::ambilight_scene::LightTopology| match topology {
            crate::commands::ambilight_scene::LightTopology::Points(points) => points,
            other => panic!("expected points, got {other:?}"),
        };

        let (flat_topology, flat_affinity) = super::hue_topology_and_affinity(&at_height(None));
        for z in [Some(0.0), Some(1.0), Some(-1.0)] {
            let (topology, affinity) = super::hue_topology_and_affinity(&at_height(z));
            assert_eq!(points(topology), points(flat_topology.clone()));
            assert_eq!(affinity, flat_affinity);
            // What the worker actually calls: without geometry it is the legacy
            // table, sampling at the bridge's (x, y) whatever the height.
            let table = super::hue_sample_table(&at_height(z), None);
            assert_eq!(points(table.topology), points(flat_topology.clone()));
            assert_eq!(table.affinity, flat_affinity);
            assert_eq!(table.sample_points, vec![(-0.7, 0.4), (0.1, -0.9)]);
        }
        assert_eq!(points(flat_topology), vec![(-0.7, 0.4), (0.1, -0.9)]);
    }

    /// 4 × 5 × 2.5 m room, 1.2 m TV centred on the TV wall, default mount (1.0 m).
    fn room_geometry(
        placements: Vec<crate::commands::hue::state_store::HueChannelPlacementOverride>,
    ) -> RoomGeometry {
        RoomGeometry {
            dimensions: RoomDimensions {
                width_meters: 4.0,
                depth_meters: 5.0,
                height_meters: 2.5,
            },
            tv: TvAnchorPlacement {
                x: 1.4,
                y: 0.0,
                width: 1.2,
                height: 0.1,
                locked: None,
                mount_height_meters: None,
            },
            hue_placements: placements,
        }
    }

    fn placement(
        channel_id: u8,
        x: f32,
        y: f32,
        z: Option<f32>,
    ) -> crate::commands::hue::state_store::HueChannelPlacementOverride {
        crate::commands::hue::state_store::HueChannelPlacementOverride {
            channel_id,
            position_x: x,
            position_y: y,
            position_z: z,
        }
    }

    fn channel(channel_id: u8, x: f32, y: f32, z: Option<f32>) -> HueAreaChannel {
        HueAreaChannel {
            channel_id,
            light_ids: vec![format!("light-{channel_id}")],
            screen_region: HueScreenRegion::Center,
            position_x: x,
            position_y: y,
            position_z: z,
        }
    }

    #[test]
    fn a_channel_height_reaches_the_scene_stage_with_room_geometry() {
        let geometry = room_geometry(Vec::new());
        let at_height =
            |z: Option<f32>| super::hue_sample_table(&[channel(0, 0.0, 1.0, z)], Some(&geometry));
        let floor = at_height(Some(-1.0));
        let ceiling = at_height(Some(1.0));
        let unknown = at_height(None);
        assert!((floor.sample_points[0].1 + 1.0).abs() < 1e-5);
        assert!((ceiling.sample_points[0].1 - 1.0).abs() < 1e-5);
        assert_eq!(
            unknown.sample_points[0].1, 0.0,
            "unknown height samples at mount"
        );
        assert_ne!(floor.affinity, ceiling.affinity);
        assert!(
            (unknown.affinity[0] - 1.0).abs() < 1e-5,
            "at the screen centre"
        );

        // Depth no longer drives vertical: the legacy table put a TV-wall light
        // at the top row whatever its height.
        let legacy = super::hue_sample_table(&[channel(0, 0.0, 1.0, Some(-1.0))], None);
        assert_eq!(legacy.sample_points[0], (0.0, 1.0));
    }

    #[test]
    fn room_geometry_placements_overlay_the_stream_channels_by_channel_id() {
        // Ordinal 1 is channel 3: matching by position in the list would move
        // the wrong light.
        let channels = [channel(0, -0.5, 1.0, None), channel(3, 0.0, 1.0, None)];
        let unmoved = super::hue_sample_table(&channels, Some(&room_geometry(Vec::new())));
        let moved = super::hue_sample_table(
            &channels,
            Some(&room_geometry(vec![
                placement(3, 0.3, 1.0, Some(1.0)),
                placement(9, 0.9, 0.0, None),
            ])),
        );
        assert_eq!(moved.sample_points[0], unmoved.sample_points[0]);
        assert!((moved.sample_points[1].0 - 1.0).abs() < 1e-5);
        assert!((moved.sample_points[1].1 - 1.0).abs() < 1e-5);
        assert_eq!(
            moved.sample_points.len(),
            2,
            "an unknown channel_id is skipped"
        );
    }

    #[test]
    fn invalid_room_geometry_falls_back_to_the_legacy_table() {
        let channels = [channel(0, -0.7, 0.4, Some(1.0))];
        let mut broken = room_geometry(vec![placement(0, 0.5, 0.5, None)]);
        broken.dimensions.width_meters = 0.0;
        let table = super::hue_sample_table(&channels, Some(&broken));
        let legacy = super::hue_sample_table(&channels, None);
        assert_eq!(table.sample_points, legacy.sample_points);
        assert_eq!(table.affinity, legacy.affinity);
    }

    #[test]
    fn normalize_mode_config_carries_room_geometry_only_for_ambilight() {
        let geometry = room_geometry(vec![placement(0, 0.1, 0.2, Some(0.3))]);
        let with_geometry = |kind: LightingModeKind| LightingModeConfig {
            kind,
            room_geometry: Some(geometry.clone()),
            ..LightingModeConfig::default()
        };
        assert_eq!(
            normalize_mode_config(with_geometry(LightingModeKind::Ambilight)).room_geometry,
            Some(geometry.clone())
        );
        assert_eq!(
            normalize_mode_config(with_geometry(LightingModeKind::Solid)).room_geometry,
            None
        );
        assert_eq!(
            normalize_mode_config(with_geometry(LightingModeKind::Off)).room_geometry,
            None
        );
    }

    #[test]
    fn absent_room_geometry_serializes_without_the_key() {
        let without = serde_json::to_value(ambilight_with_payload(AmbilightPayload {
            brightness: 1.0,
            ..Default::default()
        }))
        .expect("serialize");
        assert!(without.get("roomGeometry").is_none(), "{without}");

        let wire = serde_json::json!({
            "kind": "ambilight",
            "ambilight": { "brightness": 1.0 },
            "roomGeometry": {
                "dimensions": { "widthMeters": 4.0, "depthMeters": 5.0, "heightMeters": 2.5 },
                "tv": { "x": 1.4, "y": 0.0, "width": 1.2, "height": 0.1 },
                "huePlacements": [{ "channelId": 3, "positionX": 0.25, "positionY": 1.0 }]
            }
        });
        let parsed: LightingModeConfig = serde_json::from_value(wire.clone()).expect("parse");
        assert_eq!(
            parsed.room_geometry,
            Some(room_geometry(vec![placement(3, 0.25, 1.0, None)]))
        );
        let echoed = serde_json::to_value(&parsed).expect("serialize");
        assert_eq!(
            echoed["roomGeometry"], wire["roomGeometry"],
            "echo is byte-identical"
        );
    }

    #[test]
    fn a_room_geometry_change_retunes_the_running_worker_in_place() {
        let _guard = acquire_worker_test_guard();
        let mut owner = owner_with_fake_sender();
        let base = ambilight_with_payload(AmbilightPayload {
            brightness: 0.8,
            ..Default::default()
        });
        let apply = |owner: &mut LightingRuntimeOwner, mode: LightingModeConfig| {
            apply_mode_change(
                owner,
                mode,
                true,
                Some("COM-RG"),
                None,
                None,
                Some(shared_telemetry()),
                None,
                None,
            )
        };

        assert_eq!(
            apply(&mut owner, base.clone()).status.code,
            "AMBILIGHT_MODE_STARTED"
        );
        let cell = Arc::clone(owner.room_geometry_live.as_ref().expect("cell after start"));
        let live = Arc::clone(owner.ambilight_live.as_ref().expect("live after start"));
        assert_eq!(cell.generation(), 0);

        let geometry = room_geometry(vec![placement(0, 0.2, 0.9, Some(0.5))]);
        let placed = LightingModeConfig {
            room_geometry: Some(geometry.clone()),
            ..base.clone()
        };
        let result = apply(&mut owner, placed.clone());
        assert_eq!(
            result.status.code, "AMBILIGHT_MODE_UPDATED",
            "a room-map drag must not restart the worker"
        );
        assert!(Arc::ptr_eq(
            &cell,
            owner.room_geometry_live.as_ref().unwrap()
        ));
        assert!(Arc::ptr_eq(&live, owner.ambilight_live.as_ref().unwrap()));
        assert_eq!(cell.generation(), 1);
        assert_eq!(cell.snapshot(), (1, Some(geometry.clone())));
        assert_eq!(result.mode.room_geometry, Some(geometry));

        assert_eq!(
            apply(&mut owner, placed).status.code,
            "AMBILIGHT_MODE_UPDATED"
        );
        assert_eq!(cell.generation(), 1, "an unchanged geometry does not bump");

        assert_eq!(
            apply(&mut owner, base).status.code,
            "AMBILIGHT_MODE_UPDATED"
        );
        assert_eq!(
            cell.snapshot(),
            (2, None),
            "removing the TV anchor clears the cell"
        );

        let mut cleanup_trace = None;
        super::stop_previous(&mut owner, &mut cleanup_trace);
        assert!(owner.room_geometry_live.is_none());
        wait_for_workers_drained();
    }

    /// Top half red, bottom half blue — which half a Hue channel samples is
    /// visible in the colour it sends.
    fn split_frame_owner() -> LightingRuntimeOwner {
        let mut owner = owner_with_fake_sender();
        owner.frame_source_factory = Arc::new(|_req: super::AmbilightCaptureRequest| {
            let (w, h) = (64u32, 64u32);
            let pixels_rgb = (0..h)
                .flat_map(|row| {
                    let px = if row < h / 2 {
                        [220, 0, 0]
                    } else {
                        [0, 0, 220]
                    };
                    std::iter::repeat_n(px, w as usize)
                })
                .collect();
            Ok(Box::new(FakeFrameSource {
                frame: CapturedFrame {
                    width: w,
                    height: h,
                    pixels_rgb,
                },
            }))
        });
        owner
    }

    /// A new colour every capture, so every Hue frame is a light PUT the
    /// fallback sender has to make.
    struct CyclingFrameSource {
        tick: u8,
    }

    impl AmbilightFrameSource for CyclingFrameSource {
        fn capture_frame(&mut self) -> Result<Arc<CapturedFrame>, AmbilightCaptureError> {
            self.tick = self.tick.wrapping_add(47);
            Ok(Arc::new(CapturedFrame {
                width: 2,
                height: 2,
                pixels_rgb: vec![[self.tick, 255 - self.tick, 90]; 4],
            }))
        }
    }

    /// Removing Hue from a running `[usb, hue]` mode: the frontend re-applies
    /// the mode on USB, then `stop_hue_stream` drops the runtime's sender
    /// handle and waits for the sender thread to exit before it restores the
    /// lights. That exit needs the worker's handle gone too, or the sender
    /// keeps painting the lights after the restore.
    #[test]
    fn a_mode_re_applied_without_hue_lets_the_hue_sender_exit() {
        use crate::commands::hue::sender::{
            hue_http_client_arc, spawn_hue_http_sender, wait_for_shutdown,
        };
        use crate::commands::hue::test_bridge::{Reply, TestBridge};
        use std::time::Duration;

        let _guard = acquire_worker_test_guard();
        let bridge = TestBridge::start(|_, _, _| Reply::ok());
        let light_puts = || bridge.puts_to("/clip/v2/resource/light/").len();
        let channels = vec![channel(0, 0.0, 1.0, None)];
        let (color_sender, sender_exited) = spawn_hue_http_sender(
            hue_http_client_arc().expect("client"),
            bridge.authority.clone(),
            "app-key".to_string(),
            channels.clone(),
        );
        // Stands in for the Hue runtime's `active_stream`, which every
        // `set_lighting_mode` snapshots while the stream is up.
        let runtime_handle = HueActiveOutputContext {
            channels,
            color_sender,
        };

        let mut owner = owner_with_fake_sender();
        owner.frame_source_factory = Arc::new(|_req: super::AmbilightCaptureRequest| {
            Ok(Box::new(CyclingFrameSource { tick: 0 }))
        });
        let mode = |targets: &[&str]| LightingModeConfig {
            kind: LightingModeKind::Ambilight,
            ambilight: Some(AmbilightPayload {
                brightness: 1.0,
                smoothing_alpha: Some(1.0),
                ..Default::default()
            }),
            targets: Some(targets.iter().map(|t| t.to_string()).collect()),
            ..LightingModeConfig::default()
        };
        let mut apply = |targets: &[&str]| {
            apply_mode_change(
                &mut owner,
                mode(targets),
                true,
                Some("COM-HUE"),
                None,
                Some(runtime_handle.clone()),
                Some(shared_telemetry()),
                None,
                None,
            )
            .status
            .code
        };

        assert_eq!(apply(&["usb", "hue"]), "AMBILIGHT_MODE_STARTED");
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while light_puts() < 2 {
            assert!(
                std::time::Instant::now() < deadline,
                "the worker never drove the Hue sender"
            );
            std::thread::sleep(Duration::from_millis(20));
        }

        assert_eq!(apply(&["usb"]), "AMBILIGHT_MODE_STARTED");
        // What `stop_hue_stream` does to `active_stream`.
        drop(runtime_handle);

        assert!(
            wait_for_shutdown(&sender_exited, Duration::from_secs(2)),
            "the worker re-applied on USB still holds the Hue sender open"
        );
        // The restore would start here; nothing may reach a light after it.
        let at_restore = light_puts();
        std::thread::sleep(Duration::from_millis(400));
        assert_eq!(light_puts(), at_restore);
        assert!(owner.worker.is_some(), "USB keeps running");

        let mut cleanup_trace = None;
        super::stop_previous(&mut owner, &mut cleanup_trace);
        wait_for_workers_drained();
    }

    /// Off from a Hue-only mode. `stop_hue_stream` alone drops only the
    /// runtime's sender handle; the worker keeps its own and goes on painting
    /// the lights. Only stopping the worker lets the sender go, which is why
    /// the frontend's Off calls `stop_lighting` before the Hue stop whatever
    /// the targets.
    #[test]
    fn off_from_a_hue_only_mode_needs_the_worker_stopped_before_the_hue_sender_can_exit() {
        use crate::commands::hue::sender::{
            hue_http_client_arc, spawn_hue_http_sender, wait_for_shutdown,
        };
        use crate::commands::hue::test_bridge::{Reply, TestBridge};
        use std::time::Duration;

        let _guard = acquire_worker_test_guard();
        let bridge = TestBridge::start(|_, _, _| Reply::ok());
        let light_puts = || bridge.puts_to("/clip/v2/resource/light/").len();
        let wait_for_puts = |at_least: usize, why: &str| {
            let deadline = std::time::Instant::now() + Duration::from_secs(5);
            while light_puts() < at_least {
                assert!(std::time::Instant::now() < deadline, "{why}");
                std::thread::sleep(Duration::from_millis(20));
            }
        };
        let channels = vec![channel(0, 0.0, 1.0, None)];
        let (color_sender, sender_exited) = spawn_hue_http_sender(
            hue_http_client_arc().expect("client"),
            bridge.authority.clone(),
            "app-key".to_string(),
            channels.clone(),
        );
        let runtime_handle = HueActiveOutputContext {
            channels,
            color_sender,
        };

        let mut owner = owner_with_fake_sender();
        owner.frame_source_factory = Arc::new(|_req: super::AmbilightCaptureRequest| {
            Ok(Box::new(CyclingFrameSource { tick: 0 }))
        });
        let hue_only = LightingModeConfig {
            kind: LightingModeKind::Ambilight,
            ambilight: Some(AmbilightPayload {
                brightness: 1.0,
                smoothing_alpha: Some(1.0),
                ..Default::default()
            }),
            targets: Some(vec!["hue".to_string()]),
            ..LightingModeConfig::default()
        };
        let started = apply_mode_change(
            &mut owner,
            hue_only,
            false,
            None,
            None,
            Some(runtime_handle.clone()),
            Some(shared_telemetry()),
            None,
            None,
        );
        assert_eq!(started.status.code, "AMBILIGHT_MODE_STARTED");
        wait_for_puts(2, "the Hue-only worker never drove the Hue sender");

        // `stop_hue_stream` alone: the stream's handle goes, the worker's stays.
        drop(runtime_handle);
        assert!(
            !wait_for_shutdown(&sender_exited, Duration::from_millis(300)),
            "the sender exited while the worker still held it"
        );
        let after_stream_stop = light_puts();
        wait_for_puts(
            after_stream_stop + 1,
            "the worker stopped painting the lights on its own",
        );

        // What `stop_lighting` does.
        let stopped = apply_mode_change(
            &mut owner,
            LightingModeConfig::default(),
            true,
            None,
            None,
            None,
            None,
            None,
            None,
        );
        assert_eq!(stopped.status.code, "LIGHTING_MODE_STOPPED");
        assert!(owner.worker.is_none());
        assert!(
            wait_for_shutdown(&sender_exited, Duration::from_secs(2)),
            "the Hue sender outlived the lighting stop"
        );
        // The restore would start here; nothing may reach a light after it.
        let at_restore = light_puts();
        std::thread::sleep(Duration::from_millis(400));
        assert_eq!(light_puts(), at_restore);
        wait_for_workers_drained();
    }

    #[test]
    fn a_live_room_geometry_update_reaches_hue_sampling() {
        let _guard = acquire_worker_test_guard();
        let mut owner = split_frame_owner();
        let (tx, rx) = std::sync::mpsc::sync_channel::<HueColorUpdate>(64);
        let context = HueActiveOutputContext {
            channels: vec![channel(0, 0.0, 1.0, None)],
            color_sender: HueColorSender {
                tx: Arc::new(tx),
                channel_count: 1,
            },
        };
        let mode_at = |z: f32| LightingModeConfig {
            kind: LightingModeKind::Ambilight,
            ambilight: Some(AmbilightPayload {
                brightness: 1.0,
                smoothing_alpha: Some(1.0),
                ..Default::default()
            }),
            targets: Some(vec!["hue".to_string()]),
            room_geometry: Some(room_geometry(vec![placement(0, 0.0, 1.0, Some(z))])),
            ..LightingModeConfig::default()
        };
        let apply = |owner: &mut LightingRuntimeOwner, mode: LightingModeConfig| {
            apply_mode_change(
                owner,
                mode,
                false,
                None,
                None,
                Some(context.clone()),
                Some(shared_telemetry()),
                None,
                None,
            )
        };
        // Blue-dominant vs red-dominant: the scene stage mixes in some ambience,
        // so the test asserts which half wins, not an exact colour.
        let wait_for = |want_red: bool| {
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
            while std::time::Instant::now() < deadline {
                if let Ok(update) = rx.recv_timeout(std::time::Duration::from_millis(100)) {
                    let (r, _, b) = update.channel_colors[0];
                    if (r > b) == want_red && r != b {
                        return true;
                    }
                }
            }
            false
        };

        assert_eq!(
            apply(&mut owner, mode_at(-1.0)).status.code,
            "AMBILIGHT_MODE_STARTED"
        );
        assert!(
            wait_for(false),
            "a floor-level light must sample the bottom (blue) half"
        );

        assert_eq!(
            apply(&mut owner, mode_at(1.0)).status.code,
            "AMBILIGHT_MODE_UPDATED"
        );
        assert!(
            wait_for(true),
            "the live update must move it to the top (red) half"
        );

        let mut cleanup_trace = None;
        super::stop_previous(&mut owner, &mut cleanup_trace);
        wait_for_workers_drained();
    }

    #[test]
    fn solid_hue_only_reports_applied_when_the_color_reaches_the_sender() {
        let mut owner = owner_with_fake_sender();
        let result = apply_mode_change(
            &mut owner,
            solid_hue_only(),
            false,
            None,
            None,
            Some(hue_context_with_channels(2)),
            Some(shared_telemetry()),
            None,
            None,
        );

        assert_eq!(result.status.code, "SOLID_MODE_APPLIED");
    }

    /// Regression: an empty-channel Hue context made `apply_hue_color_with_context`
    /// return `HUE_COLOR_APPLY_SKIPPED_NO_LIGHTS`, which was discarded with
    /// `let _ =` while the command still reported `SOLID_MODE_APPLIED` — a
    /// success status for a mode where no packet reached any sink.
    #[test]
    fn solid_hue_only_reports_skipped_when_no_lights_resolve() {
        let mut owner = owner_with_fake_sender();
        let result = apply_mode_change(
            &mut owner,
            solid_hue_only(),
            false,
            None,
            None,
            Some(hue_context_with_channels(0)),
            Some(shared_telemetry()),
            None,
            None,
        );

        assert_eq!(result.status.code, "SOLID_MODE_HUE_OUTPUT_SKIPPED");
        assert_eq!(
            result.status.details.as_deref(),
            Some("HUE_COLOR_APPLY_SKIPPED_NO_LIGHTS")
        );
    }

    // ---------------------------------------------------------------------------
    // normalize_mode_config — color_correction and firmware_profile passthrough
    // ---------------------------------------------------------------------------

    #[test]
    fn normalize_mode_config_passthrough_color_correction_and_firmware_profile() {
        let corrections = ColorCorrectionConfig {
            gamma_r: 1.8,
            gamma_g: 2.0,
            gamma_b: 2.2,
            kelvin: 4000,
            saturation: 0.8,
        };
        let profile = FirmwareProfile::Adalight;

        let input = LightingModeConfig {
            kind: LightingModeKind::Ambilight,
            solid: None,
            ambilight: Some(AmbilightPayload {
                brightness: 0.75,
                ..Default::default()
            }),
            targets: None,
            display_id: None,
            led_calibration: None,
            color_correction: Some(corrections.clone()),
            firmware_profile: Some(profile),
            chip_type: None,
            color_order: None,
            room_geometry: None,
        };

        let normalized = normalize_mode_config(input);

        assert_eq!(
            normalized.color_correction,
            Some(corrections),
            "color_correction must be preserved through normalization"
        );
        assert_eq!(
            normalized.firmware_profile,
            Some(FirmwareProfile::Adalight),
            "firmware_profile must be preserved through normalization"
        );
    }

    #[test]
    fn normalize_mode_config_absent_fields_stay_none() {
        let input = LightingModeConfig {
            kind: LightingModeKind::Ambilight,
            solid: None,
            ambilight: Some(AmbilightPayload {
                brightness: 1.0,
                ..Default::default()
            }),
            targets: None,
            display_id: None,
            led_calibration: None,
            color_correction: None,
            firmware_profile: None,
            chip_type: None,
            color_order: None,
            room_geometry: None,
        };

        let normalized = normalize_mode_config(input);

        assert!(
            normalized.color_correction.is_none(),
            "color_correction must remain None when absent"
        );
        assert!(
            normalized.firmware_profile.is_none(),
            "firmware_profile must remain None when absent"
        );
    }

    #[test]
    fn fast_path_guard_triggers_restart_on_color_correction_change() {
        // Verify that changing color_correction bypasses the live-update fast path
        // (forces a worker restart instead of in-place atomic update).
        let base = LightingModeConfig {
            kind: LightingModeKind::Ambilight,
            solid: None,
            ambilight: Some(AmbilightPayload {
                brightness: 0.8,
                ..Default::default()
            }),
            targets: None,
            display_id: None,
            led_calibration: None,
            color_correction: Some(ColorCorrectionConfig::default()),
            firmware_profile: None,
            chip_type: None,
            color_order: None,
            room_geometry: None,
        };

        let changed = LightingModeConfig {
            color_correction: Some(ColorCorrectionConfig {
                kelvin: 3200,
                ..ColorCorrectionConfig::default()
            }),
            ..base.clone()
        };

        // Equality on the two configs must differ — fast-path guard fails
        let base_normalized = normalize_mode_config(base);
        let changed_normalized = normalize_mode_config(changed);
        assert_ne!(
            base_normalized.color_correction, changed_normalized.color_correction,
            "different color_correction must break fast-path equality"
        );
    }

    // ---------------------------------------------------------------------------
    // LightingSmoothingPreset — coefficient mapping and backward compat
    // ---------------------------------------------------------------------------

    #[test]
    fn lighting_smoothing_preset_coefficient_mapping() {
        use crate::commands::hue_intensity::LightingSmoothingPreset;
        assert_eq!(LightingSmoothingPreset::Subtle.coefficient(), 0.15);
        assert_eq!(LightingSmoothingPreset::Moderate.coefficient(), 0.35);
        assert_eq!(LightingSmoothingPreset::Intense.coefficient(), 0.60);
    }

    #[test]
    fn lighting_smoothing_preset_takes_priority_over_smoothing_alpha() {
        use crate::commands::hue_intensity::LightingSmoothingPreset;
        // When lighting_smoothing_preset is set, the live alpha must equal
        // the preset coefficient, not the raw smoothing_alpha slider value.
        let live = super::AmbilightLiveSettings::new(1.0, false, 0.99, 1.0);
        live.update(
            1.0,
            false,
            0.99, // raw slider — should be overridden
            1.0,
            Some(LightingSmoothingPreset::Subtle), // preset wins
        );
        let alpha = live.read_smoothing_alpha();
        assert!(
            (alpha - 0.15).abs() < 1e-5,
            "preset Subtle must override slider; expected 0.15, got {alpha}"
        );
    }

    #[test]
    fn smoothing_alpha_slider_used_as_fallback_when_no_preset() {
        // Without a preset, raw smoothing_alpha must be applied directly.
        let live = super::AmbilightLiveSettings::new(1.0, false, 0.70, 1.0);
        live.update(1.0, false, 0.70, 1.0, None);
        let alpha = live.read_smoothing_alpha();
        assert!(
            (alpha - 0.70).abs() < 1e-5,
            "no-preset path must use raw slider; expected 0.70, got {alpha}"
        );
    }

    #[test]
    fn hue_intensity_preset_backward_compat_coerced_to_smoothing_preset() {
        use crate::commands::hue_intensity::{HueIntensityPreset, LightingSmoothingPreset};
        // HueIntensityPreset is a type alias — the same values must resolve
        // identically when used through the lighting_smoothing_preset path.
        let via_alias: LightingSmoothingPreset = HueIntensityPreset::Intense;
        assert_eq!(via_alias, LightingSmoothingPreset::Intense);
        assert_eq!(via_alias.coefficient(), 0.60);
    }

    #[test]
    fn lighting_smoothing_preset_field_propagates_through_normalize() {
        use crate::commands::hue_intensity::LightingSmoothingPreset;
        // lighting_smoothing_preset on an incoming payload must survive
        // normalize_mode_config unchanged.
        let config = LightingModeConfig {
            kind: LightingModeKind::Ambilight,
            ambilight: Some(AmbilightPayload {
                brightness: 0.8,
                lighting_smoothing_preset: Some(LightingSmoothingPreset::Intense),
                ..Default::default()
            }),
            ..Default::default()
        };
        let normalized = normalize_mode_config(config);
        assert_eq!(
            normalized
                .ambilight
                .as_ref()
                .and_then(|a| a.lighting_smoothing_preset),
            Some(LightingSmoothingPreset::Intense),
            "lighting_smoothing_preset must survive normalize_mode_config"
        );
    }

    // ---------------------------------------------------------------------------
    // Fast-path None preservation — saturation / smoothing_alpha must NOT
    // collapse to defaults when an incoming payload omits them.
    //
    // Repro for the v1.5 manual-test regression "ambilight saturation /
    // smoothing reset on every brightness slider tweak": frontend pushed
    // brightness-only payloads with `saturation: None` and `smoothing_alpha:
    // None`, and the fast path's old `unwrap_or(1.0)` / `unwrap_or(0.35)`
    // silently clobbered the user's tuned values. The new behaviour reads
    // the live atomic on None so the running worker keeps its current state.
    // ---------------------------------------------------------------------------

    fn ambilight_with_payload(payload: AmbilightPayload) -> LightingModeConfig {
        LightingModeConfig {
            kind: LightingModeKind::Ambilight,
            solid: None,
            ambilight: Some(payload),
            targets: None,
            display_id: None,
            led_calibration: None,
            color_correction: None,
            firmware_profile: None,
            chip_type: None,
            color_order: None,
            room_geometry: None,
        }
    }

    #[test]
    fn a_worker_failing_mid_stream_reaches_telemetry() {
        // The start already returned AMBILIGHT_MODE_STARTED, so a status code
        // can never carry this — and the only other flush lives on the success
        // branch, which a failing worker never takes.
        let _guard = acquire_worker_test_guard();
        let mut owner = owner_that_fails_after_first_frame();
        let telemetry = shared_telemetry();

        let started = apply_mode_change(
            &mut owner,
            ambilight_with_payload(AmbilightPayload {
                brightness: 1.0,
                ..Default::default()
            }),
            true,
            Some("COM-MIDFAIL"),
            None,
            None,
            Some(Arc::clone(&telemetry)),
            None,
            None,
        );
        assert_eq!(started.status.code, "AMBILIGHT_MODE_STARTED");

        // One TELEMETRY_WINDOW must elapse before the failure path flushes, and
        // the first flushed window still counts the warm-up frame — the frozen
        // capture_fps only falls to zero on the window after that.
        let mut observed = None;
        for _ in 0..60 {
            std::thread::sleep(std::time::Duration::from_millis(50));
            let snapshot = telemetry.lock().expect("telemetry lock").clone();
            if snapshot.last_capture_error_code.is_some() && snapshot.capture_fps == 0.0 {
                observed = Some(snapshot);
                break;
            }
        }

        let mut cleanup_trace = None;
        super::stop_previous(&mut owner, &mut cleanup_trace);
        wait_for_workers_drained();

        let snapshot = observed.expect("a mid-stream capture failure must reach telemetry");
        assert_eq!(
            snapshot.last_capture_error_code.as_deref(),
            Some("AMBILIGHT_CAPTURE_MONITOR_NOT_FOUND")
        );
        assert_eq!(snapshot.last_capture_error_at_secs, Some(0));
    }

    fn test_config(
        kind: TestPatternKind,
        speed: TestPatternSpeed,
        aspect: f32,
    ) -> TestPatternConfig {
        TestPatternConfig {
            kind,
            brightness: 0.5,
            speed,
            display_aspect: aspect,
        }
    }

    fn red_chase() -> TestPatternKind {
        TestPatternKind::Chase { r: 255, g: 0, b: 0 }
    }

    /// The retune landed in #264 but `start_led_test_pattern` still only
    /// accepted `AMBILIGHT_MODE_STARTED`, so every change after the first
    /// reported "test pattern could not start" over a test that was running.
    #[test]
    fn a_retuned_test_is_a_success_not_a_failure() {
        assert!(
            super::is_ambilight_start_ok("AMBILIGHT_MODE_STARTED"),
            "a fresh start is a success"
        );
        assert!(
            super::is_ambilight_start_ok("AMBILIGHT_MODE_UPDATED"),
            "an in-place retune reaches the lights just as a restart does"
        );
        assert!(
            !super::is_ambilight_start_ok("AMBILIGHT_MODE_START_FAILED"),
            "a real failure must still read as one"
        );
        assert!(
            !super::is_ambilight_start_ok("DEVICE_NOT_CONNECTED"),
            "a gated start must still read as a failure"
        );
    }

    /// R15: a colour or speed change during a running test used to tear the
    /// worker down and build a new one, which is why the frontend had to throttle
    /// a continuous drag to 4 Hz.
    #[test]
    fn a_running_test_retunes_in_place_instead_of_rebuilding() {
        let _guard = acquire_worker_test_guard();
        let mut owner = owner_with_fake_sender();

        owner.preview.pending_test_pattern =
            Some(test_config(red_chase(), TestPatternSpeed::Slow, 1.78));
        let started = apply_mode_change(
            &mut owner,
            ambilight_with_payload(AmbilightPayload {
                brightness: 0.5,
                ..Default::default()
            }),
            true,
            Some("COM-R15"),
            None,
            None,
            Some(shared_telemetry()),
            None,
            None,
        );
        assert_eq!(started.status.code, "AMBILIGHT_MODE_STARTED");
        let slot = owner
            .preview
            .pattern_live
            .clone()
            .expect("a synthetic worker must publish its live cell");

        owner.preview.pending_test_pattern = Some(test_config(
            TestPatternKind::Spiral,
            TestPatternSpeed::Fast,
            1.78,
        ));
        let retuned = apply_mode_change(
            &mut owner,
            ambilight_with_payload(AmbilightPayload {
                brightness: 0.5,
                ..Default::default()
            }),
            true,
            Some("COM-R15"),
            None,
            None,
            Some(shared_telemetry()),
            None,
            None,
        );
        assert_eq!(
            retuned.status.code, "AMBILIGHT_MODE_UPDATED",
            "a pattern tweak on a running test must not rebuild the worker",
        );

        let cell = slot.lock().expect("live cell");
        assert_eq!(cell.kind, TestPatternKind::Spiral);
        assert_eq!(cell.speed, TestPatternSpeed::Fast);
        drop(cell);
        assert_eq!(
            owner.preview.active_test_pattern.as_ref().map(|c| &c.kind),
            Some(&TestPatternKind::Spiral),
            "the retune must also move the reported active pattern",
        );

        let mut cleanup_trace = None;
        super::stop_previous(&mut owner, &mut cleanup_trace);
        wait_for_workers_drained();
    }

    /// The frame size is baked into the source, so a display swap is the one
    /// test-to-test change the cell cannot carry.
    #[test]
    fn a_display_aspect_change_still_rebuilds_the_source() {
        let _guard = acquire_worker_test_guard();
        let mut owner = owner_with_fake_sender();

        owner.preview.pending_test_pattern =
            Some(test_config(red_chase(), TestPatternSpeed::Slow, 1.78));
        let payload = ambilight_with_payload(AmbilightPayload {
            brightness: 0.5,
            ..Default::default()
        });
        let started = apply_mode_change(
            &mut owner,
            payload.clone(),
            true,
            Some("COM-R15B"),
            None,
            None,
            Some(shared_telemetry()),
            None,
            None,
        );
        assert_eq!(started.status.code, "AMBILIGHT_MODE_STARTED");

        owner.preview.pending_test_pattern =
            Some(test_config(red_chase(), TestPatternSpeed::Slow, 1.6));
        let after = apply_mode_change(
            &mut owner,
            payload,
            true,
            Some("COM-R15B"),
            None,
            None,
            Some(shared_telemetry()),
            None,
            None,
        );
        assert_eq!(after.status.code, "AMBILIGHT_MODE_STARTED");

        let mut cleanup_trace = None;
        super::stop_previous(&mut owner, &mut cleanup_trace);
        wait_for_workers_drained();
    }

    /// Live→test needs a synthetic source built, so it can never be a retune
    /// however similar the rest of the config looks.
    #[test]
    fn starting_a_test_over_live_ambilight_rebuilds() {
        let _guard = acquire_worker_test_guard();
        let mut owner = owner_with_fake_sender();

        let payload = ambilight_with_payload(AmbilightPayload {
            brightness: 0.5,
            ..Default::default()
        });
        let live = apply_mode_change(
            &mut owner,
            payload.clone(),
            true,
            Some("COM-R15C"),
            None,
            None,
            Some(shared_telemetry()),
            None,
            None,
        );
        assert_eq!(live.status.code, "AMBILIGHT_MODE_STARTED");
        assert!(owner.preview.pattern_live.is_none());

        owner.preview.pending_test_pattern =
            Some(test_config(red_chase(), TestPatternSpeed::Slow, 1.78));
        let to_test = apply_mode_change(
            &mut owner,
            payload,
            true,
            Some("COM-R15C"),
            None,
            None,
            Some(shared_telemetry()),
            None,
            None,
        );
        assert_eq!(to_test.status.code, "AMBILIGHT_MODE_STARTED");
        assert!(owner.preview.pattern_live.is_some());

        let mut cleanup_trace = None;
        super::stop_previous(&mut owner, &mut cleanup_trace);
        wait_for_workers_drained();
    }

    /// The chip type decides the wire format — SK6812 RGBW emits four bytes per
    /// pixel where WS2812B emits three — and it is read only when the encoder is
    /// built. Left out of the fast-path guard, a chip change took the in-place
    /// retune and the strip kept being driven with the previous format.
    #[test]
    fn fast_path_guard_restarts_the_worker_on_a_chip_type_change() {
        let _guard = acquire_worker_test_guard();
        let mut owner = owner_with_fake_sender();

        let mut start = ambilight_with_payload(AmbilightPayload {
            brightness: 0.8,
            ..Default::default()
        });
        start.chip_type = Some(LedChipType::Ws2812bGrb);
        let brought_up = apply_mode_change(
            &mut owner,
            start.clone(),
            true,
            Some("COM-CHIP"),
            None,
            None,
            Some(shared_telemetry()),
            None,
            None,
        );
        assert_eq!(brought_up.status.code, "AMBILIGHT_MODE_STARTED");

        let mut swapped = start.clone();
        swapped.chip_type = Some(LedChipType::Sk6812Rgbw);
        let after = apply_mode_change(
            &mut owner,
            swapped,
            true,
            Some("COM-CHIP"),
            None,
            None,
            Some(shared_telemetry()),
            None,
            None,
        );
        assert_eq!(
            after.status.code, "AMBILIGHT_MODE_STARTED",
            "a chip-type change must rebuild the encoder, not retune atomics",
        );

        // …while an unchanged chip still takes the cheap path.
        let retune = apply_mode_change(
            &mut owner,
            {
                let mut same = start.clone();
                same.chip_type = Some(LedChipType::Sk6812Rgbw);
                same.ambilight = Some(AmbilightPayload {
                    brightness: 0.3,
                    ..Default::default()
                });
                same
            },
            true,
            Some("COM-CHIP"),
            None,
            None,
            Some(shared_telemetry()),
            None,
            None,
        );
        assert_eq!(retune.status.code, "AMBILIGHT_MODE_UPDATED");

        let mut cleanup_trace = None;
        super::stop_previous(&mut owner, &mut cleanup_trace);
        wait_for_workers_drained();
    }

    #[test]
    fn fast_path_preserves_saturation_when_payload_omits_it() {
        let _guard = acquire_worker_test_guard();
        let mut owner = owner_with_fake_sender();

        // First call: bring up ambilight with explicit saturation = 1.5
        let bring_up = apply_mode_change(
            &mut owner,
            ambilight_with_payload(AmbilightPayload {
                brightness: 0.8,
                saturation: Some(1.5),
                ..Default::default()
            }),
            true,
            Some("COM-FP1"),
            None,
            None,
            Some(shared_telemetry()),
            None,
            None,
        );
        assert_eq!(bring_up.status.code, "AMBILIGHT_MODE_STARTED");
        let live_after_start = owner
            .ambilight_live
            .as_ref()
            .expect("ambilight_live must be present after start")
            .clone();
        assert!((live_after_start.read_saturation() - 1.5).abs() < 1e-5);

        // Second call: brightness-only tweak with saturation = None.
        // Must hit the fast path and KEEP the running 1.5 saturation.
        let tweak = apply_mode_change(
            &mut owner,
            ambilight_with_payload(AmbilightPayload {
                brightness: 0.42,
                saturation: None,
                ..Default::default()
            }),
            true,
            Some("COM-FP1"),
            None,
            None,
            Some(shared_telemetry()),
            None,
            None,
        );
        assert_eq!(
            tweak.status.code, "AMBILIGHT_MODE_UPDATED",
            "brightness-only retune must take the in-place fast path",
        );
        let live = owner.ambilight_live.as_ref().expect("live present");
        assert!(
            (live.read_saturation() - 1.5).abs() < 1e-5,
            "fast path must preserve saturation when payload omits it; got {}",
            live.read_saturation()
        );
        assert!(
            (live.read_brightness() - 0.42).abs() < 1e-5,
            "fast path must apply the new brightness",
        );

        let mut cleanup_trace = None;
        super::stop_previous(&mut owner, &mut cleanup_trace);
        wait_for_workers_drained();
    }

    #[test]
    fn fast_path_preserves_smoothing_alpha_when_payload_omits_it() {
        let _guard = acquire_worker_test_guard();
        let mut owner = owner_with_fake_sender();

        let bring_up = apply_mode_change(
            &mut owner,
            ambilight_with_payload(AmbilightPayload {
                brightness: 1.0,
                smoothing_alpha: Some(0.20),
                ..Default::default()
            }),
            true,
            Some("COM-FP2"),
            None,
            None,
            Some(shared_telemetry()),
            None,
            None,
        );
        assert_eq!(bring_up.status.code, "AMBILIGHT_MODE_STARTED");

        let tweak = apply_mode_change(
            &mut owner,
            ambilight_with_payload(AmbilightPayload {
                brightness: 0.5,
                smoothing_alpha: None,
                ..Default::default()
            }),
            true,
            Some("COM-FP2"),
            None,
            None,
            Some(shared_telemetry()),
            None,
            None,
        );
        assert_eq!(tweak.status.code, "AMBILIGHT_MODE_UPDATED");
        let live = owner.ambilight_live.as_ref().expect("live present");
        assert!(
            (live.read_smoothing_alpha() - 0.20).abs() < 1e-5,
            "fast path must preserve smoothing_alpha when payload omits it; got {}",
            live.read_smoothing_alpha()
        );

        let mut cleanup_trace = None;
        super::stop_previous(&mut owner, &mut cleanup_trace);
        wait_for_workers_drained();
    }

    #[test]
    fn fast_path_explicit_saturation_overrides_running_atomic() {
        // Sanity check: an explicit Some(value) STILL overrides the live atomic.
        // This guards against an over-eager None-preservation that would also
        // ignore explicit values.
        let _guard = acquire_worker_test_guard();
        let mut owner = owner_with_fake_sender();

        let _ = apply_mode_change(
            &mut owner,
            ambilight_with_payload(AmbilightPayload {
                brightness: 1.0,
                saturation: Some(1.0),
                ..Default::default()
            }),
            true,
            Some("COM-FP3"),
            None,
            None,
            Some(shared_telemetry()),
            None,
            None,
        );

        let tweak = apply_mode_change(
            &mut owner,
            ambilight_with_payload(AmbilightPayload {
                brightness: 1.0,
                saturation: Some(1.8),
                ..Default::default()
            }),
            true,
            Some("COM-FP3"),
            None,
            None,
            Some(shared_telemetry()),
            None,
            None,
        );
        assert_eq!(tweak.status.code, "AMBILIGHT_MODE_UPDATED");
        let live = owner.ambilight_live.as_ref().expect("live present");
        assert!(
            (live.read_saturation() - 1.8).abs() < 1e-5,
            "explicit Some(value) must override the running atomic; got {}",
            live.read_saturation()
        );

        let mut cleanup_trace = None;
        super::stop_previous(&mut owner, &mut cleanup_trace);
        wait_for_workers_drained();
    }

    // -----------------------------------------------------------------------
    // Solid mode — full-strip USB encoding (v1.5 hardware repro)
    //
    // Latent bug (HEAD): the Solid arm encoded `&[[r, g, b]]` (a 1-element
    // slice), so the firmware received a 9-byte frame with count=1 and only
    // LED #0 was painted. These tests exercise the full-strip path against
    // an in-memory `FakeLedSender` that records every packet it receives.
    // -----------------------------------------------------------------------

    /// Variant of `owner_with_fake_sender` that returns a clone of the fake
    /// sender so the test can read the recorded writes back. Returning the
    /// `Arc<FakeLedSender>` is sufficient because the sender is always wrapped
    /// in `Arc<dyn LedPacketSender>` inside the bridge.
    fn owner_with_recording_sender() -> (LightingRuntimeOwner, Arc<FakeLedSender>) {
        let recorder: Arc<FakeLedSender> = Arc::new(FakeLedSender::default());
        let owner = LightingRuntimeOwner {
            active_mode: LightingModeConfig::default(),
            active_port: None,
            worker: None,
            ambilight_live: None,
            room_geometry_live: None,
            output_bridge: LedOutputBridge::from_sender(recorder.clone()),
            preview: Default::default(),
            frame_source_factory: Arc::new(|_req: super::AmbilightCaptureRequest| {
                Ok(Box::new(FakeFrameSource {
                    frame: CapturedFrame {
                        width: 2,
                        height: 2,
                        pixels_rgb: vec![[10, 20, 30], [40, 50, 60], [70, 80, 90], [100, 110, 120]],
                    },
                }))
            }),
        };
        (owner, recorder)
    }

    fn calibration_with_total_leds(total: u16) -> super::LedCalibrationConfig {
        use crate::commands::led_calibration::LedSegmentCounts;
        // Distribute the requested total across the four edges so
        // `build_led_sequence` produces a non-degenerate sequence. The exact
        // distribution does not matter for the byte-count assertions below;
        // what matters is that `total_leds` matches the segment sum.
        let top = total / 2;
        let right = (total - top) / 2;
        let bottom = (total - top - right) / 2;
        let left = total - top - right - bottom;
        super::LedCalibrationConfig {
            template_id: None,
            counts: LedSegmentCounts {
                top,
                right,
                bottom,
                left,
            },
            bottom_missing: 0,
            corner_ownership: "horizontal".to_string(),
            visual_preset: "subtle".to_string(),
            start_anchor: "top-start".to_string(),
            direction: "cw".to_string(),
            total_leds: total,
        }
    }

    fn solid_with_calibration(total_leds: u16) -> LightingModeConfig {
        LightingModeConfig {
            kind: LightingModeKind::Solid,
            solid: Some(SolidColorPayload {
                r: 255,
                g: 0,
                b: 0,
                brightness: 1.0,
            }),
            ambilight: None,
            targets: Some(vec!["usb".to_string()]),
            display_id: None,
            led_calibration: Some(calibration_with_total_leds(total_leds)),
            color_correction: None,
            firmware_profile: None,
            chip_type: None,
            color_order: None,
            room_geometry: None,
        }
    }

    #[test]
    fn solid_mode_with_59_led_calibration_emits_full_strip_packet() {
        // 59 LEDs × 3 bytes/LED + 5-byte header (magic + brightness + count_le)
        // + 1-byte XOR checksum = 183 bytes. This matches the byte-for-byte
        // layout produced by the firmware-test loopback script and proves the
        // "1 LED demo" regression (9-byte frame) is gone.
        let (mut owner, recorder) = owner_with_recording_sender();
        let result = apply_mode_change(
            &mut owner,
            solid_with_calibration(59),
            true,
            Some("COM-FULL"),
            None,
            None,
            None,
            None,
            None,
        );

        assert_eq!(result.status.code, "SOLID_MODE_APPLIED");

        let writes = recorder.writes.lock().expect("writes lock poisoned");
        assert!(
            !writes.is_empty(),
            "Solid mode must dispatch at least one packet"
        );
        let (port, packet) = &writes[0];
        assert_eq!(port, "COM-FULL");
        assert_eq!(
            packet.len(),
            5 + 3 * 59 + 1,
            "59-LED Solid frame must be 183 bytes (was {} bytes)",
            packet.len()
        );

        // Header sanity: AA 55 brightness count_lo count_hi
        assert_eq!(
            &packet[0..2],
            &[0xAA, 0x55],
            "magic header must precede brightness"
        );
        assert_eq!(
            packet[2], 255,
            "brightness byte must reflect input 1.0 -> 255"
        );
        let count = u16::from_le_bytes([packet[3], packet[4]]);
        assert_eq!(count, 59, "count must match total_leds=59");

        // RGB payload sanity: red input must produce non-zero R bytes (the
        // gamma LUT shrinks values but 255 in -> 255 out per the LUT's
        // inverse-square-root anchor). Avoids the "encoded all zeros" Bug B.
        let payload = &packet[5..5 + 3 * 59];
        assert_eq!(payload.len() % 3, 0);
        for chunk in payload.as_chunks::<3>().0 {
            assert!(
                chunk[0] > 0,
                "every LED's red channel must be > 0 (input red 255 must not collapse to zero)"
            );
            assert_eq!(chunk[1], 0, "green channel must be zero for pure red input");
            assert_eq!(chunk[2], 0, "blue channel must be zero for pure red input");
        }
    }

    #[test]
    fn solid_mode_without_calibration_falls_back_to_single_led_legacy_frame() {
        // When no calibration is present (legacy/uncalibrated devices) the
        // arm must still emit a valid frame instead of panicking. A 1-LED
        // packet is the correct legacy behaviour because the v1.3 firmware
        // shipped without per-LED sampling.
        let (mut owner, recorder) = owner_with_recording_sender();
        let result = apply_mode_change(
            &mut owner,
            solid_with_targets(Some(vec!["usb".to_string()])),
            true,
            Some("COM-LEGACY"),
            None,
            None,
            None,
            None,
            None,
        );

        assert_eq!(result.status.code, "SOLID_MODE_APPLIED");
        let writes = recorder.writes.lock().expect("writes lock poisoned");
        let (_, packet) = &writes[0];
        assert_eq!(
            packet.len(),
            5 + 3 + 1,
            "uncalibrated Solid frame must remain 9 bytes for v1.3 backward compat"
        );
    }

    #[test]
    fn solid_mode_with_30_led_calibration_emits_96_byte_packet() {
        // Sanity: parametric byte-count assertion. 30 LEDs × 3 + 5 + 1 = 96.
        let (mut owner, recorder) = owner_with_recording_sender();
        let result = apply_mode_change(
            &mut owner,
            solid_with_calibration(30),
            true,
            Some("COM-30"),
            None,
            None,
            None,
            None,
            None,
        );
        assert_eq!(result.status.code, "SOLID_MODE_APPLIED");

        let writes = recorder.writes.lock().expect("writes lock poisoned");
        let (_, packet) = &writes[0];
        assert_eq!(packet.len(), 5 + 3 * 30 + 1);
        let count = u16::from_le_bytes([packet[3], packet[4]]);
        assert_eq!(count, 30);
    }

    #[test]
    fn solid_mode_packet_xor_checksum_is_valid() {
        // The firmware drops frames whose terminal XOR byte does not match
        // the running checksum of all preceding bytes. A subtle off-by-one
        // in the encoder would render every Solid frame invalid and the
        // strip would freeze on its previous frame — the exact symptom
        // reported as "Bug B: LED #0 doesn't light at all in Solid mode".
        let (mut owner, recorder) = owner_with_recording_sender();
        let _ = apply_mode_change(
            &mut owner,
            solid_with_calibration(59),
            true,
            Some("COM-XOR"),
            None,
            None,
            None,
            None,
            None,
        );

        let writes = recorder.writes.lock().expect("writes lock poisoned");
        let (_, packet) = &writes[0];
        let (body, checksum) = packet.split_at(packet.len() - 1);
        let computed = body.iter().fold(0_u8, |acc, b| acc ^ b);
        assert_eq!(
            computed, checksum[0],
            "encoder XOR must match the firmware-side parser; otherwise frames are silently dropped"
        );
    }

    // -----------------------------------------------------------------------
    // Backend calibration fallback — `parse_led_calibration_from_shell_state`
    //
    // The frontend `shellStore` writes `~/Library/Application Support/
    // com.lumasync.app/shell-state.json` with the canonical shape:
    //
    //   {
    //     "shell-state": {
    //       "ledCalibration": { "totalLeds": 59, ... },
    //       ... other persisted shell state ...
    //     }
    //   }
    //
    // The backend reads this file directly inside `set_lighting_mode` to
    // recover the user's calibration when the frontend payload arrives
    // without one (v1.5 hardware repro #46). These tests pin the
    // top-level wrapper key, the camelCase serde rename, and the
    // graceful failure modes against every wrong-shape variant we can
    // think of, so the safety net cannot silently regress.
    // -----------------------------------------------------------------------

    fn fixture_shell_state_with_calibration_total(total_leds: u16) -> String {
        // Matches the production layout 1:1 (verified against the live
        // Application Support file): top-level `"shell-state"` wrapper,
        // camelCase keys, `counts` summing to `totalLeds`.
        format!(
            r#"{{
              "shell-state": {{
                "schemaVersion": 1,
                "ledCalibration": {{
                  "templateId": "monitor-34-ultrawide",
                  "counts": {{ "top": 30, "right": 14, "bottom": 0, "left": 15 }},
                  "bottomMissing": 0,
                  "cornerOwnership": "horizontal",
                  "visualPreset": "vivid",
                  "startAnchor": "left-end",
                  "direction": "cw",
                  "totalLeds": {total_leds}
                }}
              }}
            }}"#
        )
    }

    #[test]
    fn parse_led_calibration_extracts_total_leds_from_canonical_shape() {
        let raw = fixture_shell_state_with_calibration_total(59);
        let parsed = super::parse_led_calibration_from_shell_state(&raw)
            .expect("canonical shell-state must yield calibration");
        assert_eq!(parsed.total_leds, 59);
        assert_eq!(parsed.counts.top, 30);
        assert_eq!(parsed.counts.right, 14);
        assert_eq!(parsed.counts.left, 15);
        assert_eq!(parsed.start_anchor, "left-end");
        assert_eq!(parsed.direction, "cw");
    }

    #[test]
    fn parse_led_calibration_returns_none_when_top_level_wrapper_missing() {
        // Some imagined future store layout might inline the keys at the
        // top level. Today's writer always wraps under `"shell-state"`; if
        // that ever changes the parser must NOT silently succeed on the
        // wrong shape — return None and let the caller fall back.
        let raw = r#"{
          "ledCalibration": { "totalLeds": 59 }
        }"#;
        assert!(super::parse_led_calibration_from_shell_state(raw).is_none());
    }

    #[test]
    fn parse_led_calibration_returns_none_when_calibration_field_absent() {
        let raw = r#"{
          "shell-state": {
            "schemaVersion": 1,
            "lastSection": "lights"
          }
        }"#;
        assert!(super::parse_led_calibration_from_shell_state(raw).is_none());
    }

    #[test]
    fn parse_led_calibration_returns_none_on_malformed_json() {
        // A truncated write or partial flush mid-save would put garbage
        // on disk. The parser MUST return None rather than panic so the
        // command handler can fall through to the legacy 1-LED frame.
        assert!(super::parse_led_calibration_from_shell_state("{ not json").is_none());
        assert!(super::parse_led_calibration_from_shell_state("").is_none());
    }

    #[test]
    fn parse_led_calibration_returns_none_when_required_field_missing() {
        // `bottomMissing` is non-optional in the Rust struct (no
        // `#[serde(default)]`). A persisted file that pre-dates the
        // field MUST yield None, not partial deserialisation.
        let raw = r#"{
          "shell-state": {
            "ledCalibration": {
              "counts": { "top": 30, "right": 14, "bottom": 0, "left": 15 },
              "cornerOwnership": "horizontal",
              "visualPreset": "vivid",
              "startAnchor": "left-end",
              "direction": "cw",
              "totalLeds": 59
            }
          }
        }"#;
        assert!(super::parse_led_calibration_from_shell_state(raw).is_none());
    }

    #[test]
    fn parse_led_calibration_round_trips_through_canonical_writer_shape() {
        // Sanity: re-parsing what we'd write produces structurally
        // identical output. Guards against drift between the snake_case
        // Rust struct and the camelCase JSON contract.
        let raw = fixture_shell_state_with_calibration_total(30);
        let parsed = super::parse_led_calibration_from_shell_state(&raw)
            .expect("canonical fixture must parse");
        assert_eq!(parsed.total_leds, 30);
        // Re-serialise the parsed struct and confirm camelCase output.
        let serialised = serde_json::to_string(&parsed).expect("serialise");
        assert!(
            serialised.contains("\"totalLeds\":30"),
            "Rust -> JSON must preserve camelCase totalLeds; got: {serialised}"
        );
        assert!(
            serialised.contains("\"startAnchor\":\"left-end\""),
            "Rust -> JSON must preserve camelCase startAnchor; got: {serialised}"
        );
    }

    // -------------------------------------------------------------------
    // Backend ambilight settings fallback — `parse_ambilight_from_shell_state`
    // (v1.5 H1 fix — bug H1).
    //
    // Mirror of the led_calibration disk-fallback test pattern above.
    // Pins the canonical shell-state shape and graceful failure modes
    // for the ambilight payload so the safety net cannot silently
    // regress. The parser MUST extract `lightingMode.ambilight` from
    // the canonical shape, refuse wrong shapes, and survive malformed
    // / partial JSON without panicking.
    // -------------------------------------------------------------------

    fn fixture_shell_state_with_ambilight(
        saturation: f32,
        black_border: bool,
        preset: &str,
    ) -> String {
        format!(
            r#"{{
              "shell-state": {{
                "schemaVersion": 1,
                "lightingMode": {{
                  "kind": "ambilight",
                  "ambilight": {{
                    "brightness": 0.42,
                    "saturation": {saturation},
                    "blackBorderDetection": {black_border},
                    "lightingSmoothingPreset": "{preset}"
                  }}
                }}
              }}
            }}"#
        )
    }

    #[test]
    fn parse_ambilight_extracts_payload_from_canonical_shape() {
        // Regression for v1.5 H1 at the parser level: a canonical shell-state
        // file with a `lightingMode.ambilight` block must round-trip into a
        // populated `AmbilightPayload`. This is what
        // `maybe_hydrate_ambilight_settings` consumes when the frontend
        // payload arrives without an ambilight field.
        use crate::commands::hue_intensity::LightingSmoothingPreset;
        let raw = fixture_shell_state_with_ambilight(1.7, true, "intense");
        let parsed = super::parse_ambilight_from_shell_state(&raw)
            .expect("canonical shell-state must yield ambilight payload");
        assert!((parsed.brightness - 0.42).abs() < 1e-4);
        assert_eq!(parsed.saturation, Some(1.7));
        assert!(parsed.black_border_detection);
        assert_eq!(
            parsed.lighting_smoothing_preset,
            Some(LightingSmoothingPreset::Intense),
        );
    }

    #[test]
    fn parse_ambilight_returns_none_when_top_level_wrapper_missing() {
        // Same defensive contract as the led_calibration parser: if the
        // store layout ever changes, the parser must NOT silently
        // succeed on the wrong shape.
        let raw = r#"{
          "lightingMode": { "kind": "ambilight", "ambilight": { "brightness": 1 } }
        }"#;
        assert!(super::parse_ambilight_from_shell_state(raw).is_none());
    }

    #[test]
    fn parse_ambilight_returns_none_when_lighting_mode_field_absent() {
        let raw = r#"{
          "shell-state": { "schemaVersion": 1, "lastSection": "lights" }
        }"#;
        assert!(super::parse_ambilight_from_shell_state(raw).is_none());
    }

    #[test]
    fn parse_ambilight_returns_none_when_ambilight_field_absent() {
        // Persisted lightingMode without an ambilight payload (e.g.
        // `{ kind: "solid", solid: {...} }`) must yield None — there's
        // nothing to recover, so let the caller fall through.
        let raw = r#"{
          "shell-state": {
            "lightingMode": {
              "kind": "solid",
              "solid": { "r": 255, "g": 0, "b": 0, "brightness": 1 }
            }
          }
        }"#;
        assert!(super::parse_ambilight_from_shell_state(raw).is_none());
    }

    #[test]
    fn parse_ambilight_returns_none_on_malformed_json() {
        // A truncated write or partial flush mid-save must NOT panic.
        assert!(super::parse_ambilight_from_shell_state("{ not json").is_none());
        assert!(super::parse_ambilight_from_shell_state("").is_none());
    }

    #[test]
    fn parse_ambilight_round_trips_through_canonical_writer_shape() {
        // Sanity: re-serialising the parsed struct preserves camelCase
        // for the fields that drive `maybe_hydrate_ambilight_settings`.
        // This guards against drift between the snake_case Rust struct
        // and the camelCase JSON contract that the frontend writes.
        let raw = fixture_shell_state_with_ambilight(1.5, true, "moderate");
        let parsed =
            super::parse_ambilight_from_shell_state(&raw).expect("canonical fixture must parse");
        let serialised = serde_json::to_string(&parsed).expect("serialise");
        assert!(
            serialised.contains("\"saturation\":1.5"),
            "Rust -> JSON must preserve saturation; got: {serialised}"
        );
        assert!(
            serialised.contains("\"blackBorderDetection\":true"),
            "Rust -> JSON must preserve camelCase blackBorderDetection; got: {serialised}"
        );
        assert!(
            serialised.contains("\"lightingSmoothingPreset\":\"moderate\""),
            "Rust -> JSON must preserve camelCase lightingSmoothingPreset; got: {serialised}"
        );
    }

    // -----------------------------------------------------------------------
    // v1.6 LED Preview — output-stamp hydration + enrichment gating
    // -----------------------------------------------------------------------

    /// The synthetic-test commands build their mode config server-side, so the
    /// encoder settings can only come off disk. Reading the wrong key drops an
    /// SK6812 strip onto the WS2812B encoder without any visible error.
    #[test]
    fn output_stamps_read_the_keys_the_frontend_actually_writes() {
        let raw = r#"{
            "shell-state": {
                "colorCorrection": {
                    "gammaR": 2.6, "gammaG": 2.4, "gammaB": 2.2,
                    "kelvin": 4000, "saturation": 1.2
                },
                "firmwareProfile": "adalight",
                "selectedChipType": "sk6812-rgbw"
            }
        }"#;
        let stamps = super::parse_output_stamps_from_shell_state(raw);
        assert_eq!(stamps.chip_type, Some(super::LedChipType::Sk6812Rgbw));
        assert_eq!(
            stamps.firmware_profile,
            Some(super::FirmwareProfile::Adalight)
        );
        assert_eq!(stamps.color_correction.map(|c| c.kelvin), Some(4000));
    }

    /// `chipType` is NOT the persisted key — only `selectedChipType` is.
    #[test]
    fn output_stamps_ignore_the_non_persisted_chip_key() {
        let raw = r#"{"shell-state":{"chipType":"sk6812-rgbw"}}"#;
        assert_eq!(
            super::parse_output_stamps_from_shell_state(raw).chip_type,
            None
        );
    }

    #[test]
    fn output_stamps_degrade_to_empty_on_malformed_state() {
        assert!(super::parse_output_stamps_from_shell_state("not json")
            .chip_type
            .is_none());
        assert!(super::parse_output_stamps_from_shell_state("{}")
            .firmware_profile
            .is_none());
    }

    const SK6812_SHELL_STATE: &str = r#"{"shell-state":{"selectedChipType":"sk6812-rgbw"}}"#;

    /// A payload as the LED control popup sends it — kind + settings, no
    /// output stamps — run through the same hydration chain `set_lighting_mode`
    /// uses, with the persisted shell state injected in place of the disk read.
    fn hydrated_like_set_lighting_mode(
        mut payload: LightingModeConfig,
        shell_state: &'static str,
    ) -> LightingModeConfig {
        super::hydrate_mode_payload(&mut payload, &|| Some(shell_state.to_string()));
        payload
    }

    /// The popup's Ambilight click carried no chip type, so the fast-path chip
    /// comparison failed against a running SK6812 worker and the restart fell
    /// back to `LedChipType::default()` — the WS2812B encoder, three bytes per
    /// pixel on a four-byte strip.
    #[test]
    fn unstamped_ambilight_click_keeps_a_running_sk6812_worker_on_rgbw() {
        let _guard = acquire_worker_test_guard();
        let mut owner = owner_with_fake_sender();

        let mut running = ambilight_with_payload(AmbilightPayload {
            brightness: 0.8,
            ..Default::default()
        });
        running.chip_type = Some(LedChipType::Sk6812Rgbw);
        let up = apply_mode_change(
            &mut owner,
            running.clone(),
            true,
            Some("COM-RGBW"),
            None,
            None,
            Some(shared_telemetry()),
            None,
            None,
        );
        assert_eq!(up.status.code, "AMBILIGHT_MODE_STARTED");

        let mut popup_click = running.clone();
        popup_click.chip_type = None;
        popup_click.firmware_profile = None;
        popup_click.color_correction = None;
        let hydrated = hydrated_like_set_lighting_mode(popup_click, SK6812_SHELL_STATE);
        let after = apply_mode_change(
            &mut owner,
            hydrated,
            true,
            Some("COM-RGBW"),
            None,
            None,
            Some(shared_telemetry()),
            None,
            None,
        );

        assert_eq!(
            after.status.code, "AMBILIGHT_MODE_UPDATED",
            "an unstamped click must retune the running worker, not rebuild it",
        );
        assert_eq!(owner.active_mode.chip_type, Some(LedChipType::Sk6812Rgbw));

        let mut cleanup_trace = None;
        super::stop_previous(&mut owner, &mut cleanup_trace);
        wait_for_workers_drained();
    }

    /// Solid built its packet from the firmware profile alone, so an SK6812
    /// strip got three-byte pixels from every window, stamped or not.
    #[test]
    fn solid_on_sk6812_writes_four_byte_rgbw_pixels() {
        let (mut owner, recorder) = owner_with_recording_sender();
        let mut solid = solid_with_calibration(10);
        solid.solid = Some(SolidColorPayload {
            r: 255,
            g: 255,
            b: 255,
            brightness: 1.0,
        });
        let hydrated = hydrated_like_set_lighting_mode(solid, SK6812_SHELL_STATE);

        let result = apply_mode_change(
            &mut owner,
            hydrated,
            true,
            Some("COM-RGBW"),
            None,
            None,
            None,
            None,
            None,
        );
        assert_eq!(result.status.code, "SOLID_MODE_APPLIED");

        let writes = recorder.writes.lock().expect("writes lock poisoned");
        let (_, packet) = &writes[0];
        assert_eq!(packet.len(), 5 + 4 * 10 + 1, "SK6812 Solid frame is RGBW");
        assert_eq!(u16::from_le_bytes([packet[3], packet[4]]), 10);
        // White drives the dedicated W emitter, not the three colour dies.
        assert_eq!(&packet[5..9], &[0, 0, 0, 255]);
        let checksum = packet[..packet.len() - 1]
            .iter()
            .fold(0_u8, |acc, byte| acc ^ byte);
        assert_eq!(packet[packet.len() - 1], checksum);
    }

    /// The default setup (LumaSync v1 + WS2812B) used to ignore the gamma
    /// sliders on Solid too, because it shared the hardcoded-2.2 encoder.
    #[test]
    fn solid_on_the_default_setup_applies_the_user_gamma() {
        let solid_grey = |gamma: f32| {
            let (mut owner, recorder) = owner_with_recording_sender();
            let mut solid = solid_with_calibration(3);
            solid.solid = Some(SolidColorPayload {
                r: 128,
                g: 128,
                b: 128,
                brightness: 1.0,
            });
            solid.color_correction = Some(ColorCorrectionConfig {
                gamma_r: gamma,
                gamma_g: gamma,
                gamma_b: gamma,
                ..ColorCorrectionConfig::default()
            });
            let result = apply_mode_change(
                &mut owner,
                solid,
                true,
                Some("COM-GAMMA"),
                None,
                None,
                None,
                None,
                None,
            );
            assert_eq!(result.status.code, "SOLID_MODE_APPLIED");
            let writes = recorder.writes.lock().expect("writes lock poisoned");
            writes[0].1.clone()
        };

        let linear = solid_grey(1.0);
        let default = solid_grey(2.2);
        assert_eq!(&linear[0..2], &[0xAA, 0x55], "still the LumaSync v1 frame");
        assert_eq!(&linear[5..14], &[128; 9], "gamma 1.0 leaves mid-grey alone");
        assert_eq!(&default[5..14], &[56; 9], "gamma 2.2 maps 128 to 56");
    }

    /// Adalight has no four-byte pixel, so SK6812 under it must still write the
    /// three-byte Adalight frame — the same fallback the ambilight sink takes.
    #[test]
    fn solid_on_sk6812_under_adalight_keeps_the_adalight_frame() {
        let (mut owner, recorder) = owner_with_recording_sender();
        let mut solid = solid_with_calibration(10);
        solid.chip_type = Some(LedChipType::Sk6812Rgbw);
        solid.firmware_profile = Some(FirmwareProfile::Adalight);

        let result = apply_mode_change(
            &mut owner,
            solid,
            true,
            Some("COM-ADA"),
            None,
            None,
            None,
            None,
            None,
        );
        assert_eq!(result.status.code, "SOLID_MODE_APPLIED");

        let writes = recorder.writes.lock().expect("writes lock poisoned");
        let (_, packet) = &writes[0];
        assert_eq!(&packet[0..3], b"Ada");
        assert_eq!(packet.len(), 6 + 3 * 10);
    }

    /// Caller-wins: a stamp the payload already carries is never replaced.
    #[test]
    fn hydration_never_overrides_a_stamped_chip_type() {
        let mut stamped = solid_with_calibration(10);
        stamped.chip_type = Some(LedChipType::Ws2812bGrb);
        let hydrated = hydrated_like_set_lighting_mode(stamped, SK6812_SHELL_STATE);
        assert_eq!(hydrated.chip_type, Some(LedChipType::Ws2812bGrb));
    }

    /// `stop_led_test_pattern`'s restore, run through the real chain: the
    /// snapshot helper, the hydration `apply_and_broadcast` performs, then
    /// `apply_mode_change`, with the persisted shell state injected.
    fn restored_after_test(prior: LightingModeConfig, shell_state: String) -> LightingModeConfig {
        let load = || Some(shell_state.clone());
        let mut restore = super::restore_mode_after_test(Some(prior), &load);
        super::hydrate_mode_payload(&mut restore, &load);
        restore
    }

    /// The snapshot is taken at test start; a chip switch made while the test
    /// ran must survive the stop instead of reverting to the old encoder.
    #[test]
    fn stopping_a_test_restores_the_chip_type_saved_during_it() {
        let (mut owner, recorder) = owner_with_recording_sender();
        let mut prior = solid_with_calibration(10);
        prior.chip_type = Some(LedChipType::Ws2812bGrb);
        prior.firmware_profile = Some(FirmwareProfile::LumaSyncV1);

        let restored = restored_after_test(prior, SK6812_SHELL_STATE.to_string());
        assert_eq!(restored.chip_type, Some(LedChipType::Sk6812Rgbw));

        let result = apply_mode_change(
            &mut owner,
            restored,
            true,
            Some("COM-RGBW"),
            None,
            None,
            None,
            None,
            None,
        );
        assert_eq!(result.status.code, "SOLID_MODE_APPLIED");
        assert_eq!(owner.active_mode.chip_type, Some(LedChipType::Sk6812Rgbw));
        let writes = recorder.writes.lock().expect("writes lock poisoned");
        let (_, packet) = &writes[0];
        assert_eq!(packet.len(), 5 + 4 * 10 + 1, "restored Solid frame is RGBW");
    }

    /// The calibration editor saves, then stops its test. The stale layout on
    /// the snapshot has more than one LED, so caller-wins hydration would keep
    /// it over the layout just written to disk.
    #[test]
    fn stopping_a_test_restores_the_calibration_saved_during_it() {
        let (mut owner, recorder) = owner_with_recording_sender();
        let prior = solid_with_calibration(10);
        let shell_state = serde_json::json!({
            "shell-state": { "ledCalibration": calibration_with_total_leds(20) }
        })
        .to_string();

        let restored = restored_after_test(prior, shell_state);
        let result = apply_mode_change(
            &mut owner,
            restored,
            true,
            Some("COM-CAL"),
            None,
            None,
            None,
            None,
            None,
        );
        assert_eq!(result.status.code, "SOLID_MODE_APPLIED");
        let writes = recorder.writes.lock().expect("writes lock poisoned");
        let (_, packet) = &writes[0];
        assert_eq!(u16::from_le_bytes([packet[3], packet[4]]), 20);
    }

    /// With no usable layout on disk the snapshot's is still better than the
    /// legacy 1-LED frame clearing it would fall to.
    #[test]
    fn stopping_a_test_keeps_the_snapshot_calibration_when_disk_has_none() {
        let restored = restored_after_test(
            solid_with_calibration(10),
            r#"{"shell-state":{}}"#.to_string(),
        );
        assert_eq!(restored.led_calibration.map(|cal| cal.total_leds), Some(10));
    }

    /// Only twin overlays read the enriched buffer, so a running test with no
    /// twin open must not build an N-LED Vec + JSON payload every tick.
    #[test]
    fn test_source_enrichment_follows_the_twin_gate() {
        let gate = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let ctx = super::build_preview_emit_context(
            true,
            None,
            Some(Arc::clone(&gate)),
            Some("display-1".to_string()),
        )
        .expect("a test always yields an emit context");

        assert_eq!(ctx.source, "test");
        // Synthetic frames are display-agnostic — never filtered per display.
        assert_eq!(ctx.display_id, None);
        assert!(!ctx.should_enrich(), "no twin open ⇒ no enrichment");

        gate.store(true, std::sync::atomic::Ordering::Relaxed);
        assert!(ctx.should_enrich(), "twin opened mid-run ⇒ enrichment on");
    }

    /// With no gate wired (unit-test / legacy path) a test still enriches, so
    /// the twin is never left dark by a missing registration.
    #[test]
    fn test_source_enriches_unconditionally_without_a_gate() {
        let ctx = super::build_preview_emit_context(true, None, None, None)
            .expect("a test always yields an emit context");
        assert!(ctx.should_enrich());
    }

    // -----------------------------------------------------------------------
    // Colour order — contract, persistence, hydration, test patterns
    // -----------------------------------------------------------------------

    const BGR_SHELL_STATE: &str = r#"{"shell-state":{"ledColorOrder":"bgr"}}"#;

    #[test]
    fn color_order_round_trips_as_color_order_and_is_omitted_when_absent() {
        let parsed: LightingModeConfig =
            serde_json::from_str(r#"{"kind":"ambilight","colorOrder":"grb"}"#).expect("parse");
        assert_eq!(parsed.color_order, Some(LedColorOrder::Grb));
        let echoed = serde_json::to_value(&parsed).expect("serialize");
        assert_eq!(echoed["colorOrder"], serde_json::json!("grb"));

        let plain = serde_json::to_value(LightingModeConfig::default()).expect("serialize");
        assert!(
            plain.get("colorOrder").is_none(),
            "an unset order keeps the echoed mode byte-identical"
        );
    }

    /// The order is persisted under `ledColorOrder`; the IPC field name
    /// `colorOrder` is not a shell-state key and must not be read as one.
    #[test]
    fn output_stamps_read_the_persisted_color_order_key() {
        assert_eq!(
            super::parse_output_stamps_from_shell_state(BGR_SHELL_STATE).color_order,
            Some(LedColorOrder::Bgr)
        );
        assert_eq!(
            super::parse_output_stamps_from_shell_state(r#"{"shell-state":{"colorOrder":"bgr"}}"#)
                .color_order,
            None
        );
    }

    /// A payload with every other stamp still has to read the order off disk —
    /// the all-present early return must count it.
    #[test]
    fn hydration_fills_the_color_order_even_when_every_other_stamp_is_set() {
        let mut stamped = solid_with_calibration(10);
        stamped.color_correction = Some(ColorCorrectionConfig::default());
        stamped.firmware_profile = Some(FirmwareProfile::LumaSyncV1);
        stamped.chip_type = Some(LedChipType::Ws2812bGrb);
        let hydrated = hydrated_like_set_lighting_mode(stamped, BGR_SHELL_STATE);
        assert_eq!(hydrated.color_order, Some(LedColorOrder::Bgr));
    }

    #[test]
    fn hydration_never_overrides_a_stamped_color_order() {
        let mut stamped = solid_with_calibration(10);
        stamped.color_order = Some(LedColorOrder::Rgb);
        let hydrated = hydrated_like_set_lighting_mode(stamped, BGR_SHELL_STATE);
        assert_eq!(hydrated.color_order, Some(LedColorOrder::Rgb));
    }

    #[test]
    fn normalize_mode_config_carries_the_color_order_for_every_kind() {
        for kind in [
            LightingModeKind::Off,
            LightingModeKind::Solid,
            LightingModeKind::Ambilight,
        ] {
            let label = format!("{kind:?}");
            let config = LightingModeConfig {
                kind,
                color_order: Some(LedColorOrder::Brg),
                ..LightingModeConfig::default()
            };
            assert_eq!(
                normalize_mode_config(config).color_order,
                Some(LedColorOrder::Brg),
                "{label}"
            );
        }
    }

    /// The probe asks "which colour is slot N?", which a saved order would
    /// answer for the user. Every other pattern keeps the saved order.
    #[test]
    fn a_channel_probe_pins_the_identity_order_over_the_saved_one() {
        let hydrate_test = |kind: TestPatternKind| {
            let mut config = solid_with_calibration(10);
            config.color_order = super::test_pattern_color_order(&kind);
            hydrated_like_set_lighting_mode(config, BGR_SHELL_STATE).color_order
        };
        assert_eq!(
            hydrate_test(TestPatternKind::ChannelProbe { slot: 1 }),
            Some(LedColorOrder::Rgb)
        );
        assert_eq!(
            hydrate_test(TestPatternKind::Chase { r: 255, g: 0, b: 0 }),
            Some(LedColorOrder::Bgr)
        );
    }

    #[test]
    fn stopping_a_test_re_reads_the_color_order() {
        let mut prior = solid_with_calibration(10);
        prior.color_order = Some(LedColorOrder::Grb);

        let restored = restored_after_test(prior.clone(), BGR_SHELL_STATE.to_string());
        assert_eq!(restored.color_order, Some(LedColorOrder::Bgr));

        let restored = restored_after_test(prior, r#"{"shell-state":{}}"#.to_string());
        assert_eq!(
            restored.color_order, None,
            "an order cleared on disk mid-test is not revived from the snapshot"
        );
    }

    // -----------------------------------------------------------------------
    // Edge-signal — only the twin overlay listens
    // -----------------------------------------------------------------------

    /// Drives the real worker, twin gate and emitter. With no twin open the
    /// worker must not hand the emitter anything — the payload is only ever
    /// built as its argument — and no window may receive the event. Once a twin
    /// opens, that twin alone receives frames carrying the strip buffer and the
    /// Hue channel colours; the main window never does.
    #[test]
    fn the_edge_signal_is_built_and_sent_only_while_a_twin_is_open() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::time::{Duration, Instant};
        use tauri::{Listener, Manager, WebviewWindowBuilder};

        use crate::commands::led_preview::LedTwinState;

        let _guard = acquire_worker_test_guard();
        let app = tauri::test::mock_app();
        app.manage(LedTwinState::default());
        let main = WebviewWindowBuilder::new(&app, crate::MAIN_WINDOW_LABEL, Default::default())
            .build()
            .expect("main webview");
        let twin_label = "led-twin-overlay-test";
        let twin = WebviewWindowBuilder::new(&app, twin_label, Default::default())
            .build()
            .expect("twin webview");

        let main_events = Arc::new(AtomicUsize::new(0));
        let main_counter = Arc::clone(&main_events);
        main.listen(super::EDGE_SIGNAL_EVENT, move |_| {
            main_counter.fetch_add(1, Ordering::SeqCst);
        });
        let twin_frames: Arc<Mutex<Vec<serde_json::Value>>> = Arc::default();
        let twin_sink = Arc::clone(&twin_frames);
        twin.listen(super::EDGE_SIGNAL_EVENT, move |event| {
            let frame = serde_json::from_str(event.payload()).expect("payload is JSON");
            twin_sink.lock().expect("frames lock").push(frame);
        });

        let built = Arc::new(AtomicUsize::new(0));
        let built_counter = Arc::clone(&built);
        let real_emitter = super::build_edge_emitter(app.handle());
        let emitter: super::EdgeSignalEmitter = Arc::new(move |payload| {
            built_counter.fetch_add(1, Ordering::SeqCst);
            real_emitter(payload);
        });

        let twin_state = app.state::<LedTwinState>();
        let mut owner = owner_with_fake_sender();
        owner.preview.preview_gate = Some(twin_state.preview_active());
        let mode = LightingModeConfig {
            kind: LightingModeKind::Ambilight,
            ambilight: Some(AmbilightPayload {
                brightness: 1.0,
                ..Default::default()
            }),
            targets: Some(vec!["usb".to_string(), "hue".to_string()]),
            led_calibration: Some(calibration_with_total_leds(12)),
            ..LightingModeConfig::default()
        };
        let started = apply_mode_change(
            &mut owner,
            mode,
            true,
            Some("COM-TWIN"),
            None,
            Some(hue_context_with_channels(2)),
            Some(shared_telemetry()),
            Some(emitter),
            None,
        );
        assert_eq!(started.status.code, "AMBILIGHT_MODE_STARTED");

        std::thread::sleep(Duration::from_millis(300));
        assert_eq!(
            built.load(Ordering::SeqCst),
            0,
            "no twin open: the worker must not build an edge-signal payload"
        );
        assert_eq!(main_events.load(Ordering::SeqCst), 0);
        assert!(twin_frames.lock().expect("frames lock").is_empty());

        twin_state.record_twin_for_test("display-1", twin_label);
        let deadline = Instant::now() + Duration::from_secs(5);
        let frame = loop {
            let with_hue = twin_frames
                .lock()
                .expect("frames lock")
                .iter()
                .rev()
                .find(|frame| frame.get("hueChannels").is_some())
                .cloned();
            if let Some(frame) = with_hue {
                break frame;
            }
            assert!(
                Instant::now() < deadline,
                "an open twin must receive frames carrying hueChannels"
            );
            std::thread::sleep(Duration::from_millis(10));
        };
        assert_eq!(frame["leds"].as_array().map(Vec::len), Some(12));
        assert_eq!(frame["ledCount"], 12);
        assert_eq!(frame["hueChannels"].as_array().map(Vec::len), Some(2));
        assert_eq!(frame["source"], "live");
        for dropped in ["top", "bottom", "left", "right"] {
            assert!(frame.get(dropped).is_none(), "`{dropped}` has no reader");
        }
        assert_eq!(
            main_events.load(Ordering::SeqCst),
            0,
            "the main window has no edge-signal listener and must receive nothing"
        );

        twin_state.forget_twin_label(twin_label);
        // One tick may already be past the gate when the twin closes.
        std::thread::sleep(Duration::from_millis(100));
        let after_close = built.load(Ordering::SeqCst);
        std::thread::sleep(Duration::from_millis(300));
        assert_eq!(
            built.load(Ordering::SeqCst),
            after_close,
            "closing the last twin must stop the feed"
        );

        let mut cleanup_trace = None;
        super::stop_previous(&mut owner, &mut cleanup_trace);
        wait_for_workers_drained();
    }
}
