use std::sync::atomic::{AtomicBool, AtomicU32, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use log::{info, warn};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, Runtime, State};

use super::ambilight_capture::{
    create_live_frame_source, detect_black_borders, AmbilightCaptureError, AmbilightFrameSource,
    BlackBorderInsets, CapturedFrame, StaticFrameSource,
};
use super::device_connection::{CommandStatus, SerialConnectionState};
use super::hue_intensity::{HueIntensityPreset, LightingSmoothingPreset};
use super::hue_stream_lifecycle::{
    apply_hue_channels_with_context, apply_hue_color_with_context, snapshot_hue_output_context,
    HueActiveOutputContext, HueRuntimeStateStore,
};
use super::led_calibration::{
    build_led_sequence, derive_base_interval_ms, sample_frame_for_sequence, LedCalibrationConfig,
};
use super::led_output::{
    apply_color_correction_rgb, encode_packet_for_profile, ColorCorrectionConfig, FirmwareProfile,
    LedOutputBridge, SerialSink,
};
use super::led_sink::LedSink;
use super::runtime_quality::{RuntimeFrameSlot, RuntimeQualityConfig, RuntimeQualityController};
use super::runtime_telemetry::{
    RuntimeTelemetrySnapshot, RuntimeTelemetryState, RuntimeTelemetryWindow, SharedRuntimeTelemetry,
};

static ACTIVE_AMBILIGHT_WORKERS: AtomicUsize = AtomicUsize::new(0);
static SOLID_OUTPUT_ATTEMPTS: AtomicUsize = AtomicUsize::new(0);
static AMBILIGHT_FRAME_ATTEMPTS: AtomicUsize = AtomicUsize::new(0);
static AMBILIGHT_CAPTURE_ATTEMPTS: AtomicUsize = AtomicUsize::new(0);

/// Request passed to the frame-source factory on worker start.
/// Carries both the display selection hint and the LED calibration config
/// so the factory signature stays stable as v1.5/v2.0 sinks add fields.
#[derive(Clone, Debug)]
pub struct AmbilightCaptureRequest {
    pub display_id: Option<String>,
    /// Per-LED strip calibration. When `None` the worker falls back to
    /// single-zone sampling (v1.3 compat). Populated by `set_lighting_mode`
    /// from `LightingModeConfig.led_calibration`.
    #[allow(dead_code)]
    pub led_calibration: Option<LedCalibrationConfig>,
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
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LightingModeCommandResult {
    pub active: bool,
    pub mode: LightingModeConfig,
    pub status: CommandStatus,
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
        })
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

struct LightingRuntimeOwner {
    active_mode: LightingModeConfig,
    /// Port name for the currently active LED session.
    /// Cleared in stop_previous so the cached serial handle is released
    /// via disconnect_session, preventing stale handle reuse on reconnect.
    active_port: Option<String>,
    worker: Option<LightingWorkerRuntime>,
    /// Shared settings for the currently running ambilight worker.
    /// Updated in-place when only ambilight settings change, avoiding worker restart.
    ambilight_live: Option<Arc<AmbilightLiveSettings>>,
    output_bridge: LedOutputBridge,
    frame_source_factory: Arc<AmbilightFrameSourceFactory>,
}

impl Default for LightingRuntimeOwner {
    fn default() -> Self {
        Self {
            active_mode: LightingModeConfig::default(),
            active_port: None,
            worker: None,
            ambilight_live: None,
            output_bridge: LedOutputBridge::default(),
            frame_source_factory: Arc::new(|req: AmbilightCaptureRequest| {
                create_live_frame_source(req.display_id.as_deref())
            }),
        }
    }
}

#[derive(Default)]
pub struct LightingRuntimeState {
    runtime: Mutex<LightingRuntimeOwner>,
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
    }
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

/// Read the persisted shell-state JSON file and extract `ledCalibration` if
/// present. The frontend `shellStore` writes this via the
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
fn hydrate_led_calibration_from_disk<R: Runtime>(
    app: &AppHandle<R>,
) -> Option<LedCalibrationConfig> {
    let app_data_dir = app.path().app_data_dir().ok()?;
    let store_path = app_data_dir.join("shell-state.json");
    let raw = std::fs::read_to_string(&store_path).ok()?;
    parse_led_calibration_from_shell_state(&raw)
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
fn maybe_hydrate_led_calibration<R: Runtime>(app: &AppHandle<R>, payload: &mut LightingModeConfig) {
    let payload_total_leds = payload
        .led_calibration
        .as_ref()
        .map(|cal| cal.total_leds)
        .unwrap_or(0);

    if payload_total_leds > 1 {
        return;
    }

    if let Some(persisted) = hydrate_led_calibration_from_disk(app) {
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

/// Read the persisted shell-state JSON file and extract
/// `lightingMode.ambilight` if present. Mirrors
/// `hydrate_led_calibration_from_disk` in resolution semantics —
/// frontend remains the source of truth, this is a pure recovery path.
fn hydrate_ambilight_settings_from_disk<R: Runtime>(
    app: &AppHandle<R>,
) -> Option<AmbilightPayload> {
    let app_data_dir = app.path().app_data_dir().ok()?;
    let store_path = app_data_dir.join("shell-state.json");
    let raw = std::fs::read_to_string(&store_path).ok()?;
    parse_ambilight_from_shell_state(&raw)
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
fn maybe_hydrate_ambilight_settings<R: Runtime>(
    app: &AppHandle<R>,
    payload: &mut LightingModeConfig,
) {
    if payload.kind != LightingModeKind::Ambilight {
        return;
    }
    if payload.ambilight.is_some() {
        // Caller-wins: frontend is source of truth for any
        // present-but-default value. Do NOT compare to defaults here.
        return;
    }
    if let Some(persisted) = hydrate_ambilight_settings_from_disk(app) {
        info!(
            "[set_lighting_mode] ambilight settings fallback engaged — payload.ambilight=None disk.ambilight=Some (frontend payload missing; using persisted shell-state)"
        );
        payload.ambilight = Some(persisted);
    }
}

fn normalize_mode_config(config: LightingModeConfig) -> LightingModeConfig {
    let targets = config.targets.clone();
    let display_id = config.display_id.clone();
    let led_calibration = config.led_calibration.clone();
    let color_correction = config.color_correction.clone();
    let firmware_profile = config.firmware_profile;
    match config.kind {
        LightingModeKind::Off => LightingModeConfig {
            targets,
            display_id,
            color_correction,
            firmware_profile,
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
            }
        }
    }
}

fn push_trace(trace: &mut Option<&mut Vec<&'static str>>, step: &'static str) {
    if let Some(events) = trace.as_mut() {
        events.push(step);
    }
}

fn stop_previous(owner: &mut LightingRuntimeOwner, trace: &mut Option<&mut Vec<&'static str>>) {
    push_trace(trace, "stop_previous");
    let t0 = std::time::Instant::now();
    owner.ambilight_live = None;
    let had_worker = owner.worker.is_some();
    if let Some(worker) = owner.worker.take() {
        worker.stop();
    }
    // v1.5 — DO NOT close the cached serial port handle here.
    //
    // Calling `disconnect_session` drops the open `Box<dyn Write>` for
    // this port; the very next packet write reopens it via
    // `serialport::new(...).open()`, which on CH340 / Arduino Nano /
    // most USB-CDC adapters toggles DTR — and that toggles the
    // Arduino's RESET line. The bootloader then runs for ~1-2 s and
    // swallows whatever LumaSync packet was supposed to land on the
    // strip, so the WS2812 buffer ends up at the post-reset zeroed
    // state and the strip looks "off".
    //
    // This is exactly the asymmetry the user reported on real hardware
    // (v1.5 hardware repro #47): Ambilight runs through a single open
    // (the worker holds the handle for its lifetime) so it's immune,
    // but Solid mode disconnects on every transition and re-opens on
    // the very next frame, resetting the MCU before its packet ever
    // reaches FastLED.
    //
    // Keeping the cached handle alive is safe across mode transitions:
    //  - The same port will be reused by the next Solid / Ambilight
    //    invocation; cache-hit avoids the DTR pulse.
    //  - If the device is unplugged, the next `write_all` errors and
    //    `SerialLedPacketSender::send` already drops the handle on
    //    failure (`sessions.remove(port_name)` on `result.is_err()`).
    //  - If the user picks a different port, the old handle stays in
    //    the cache as an inert FD until the process exits — acceptable
    //    leak (one fd per ever-used port), priced against the
    //    user-facing "Solid is dark" bug.
    //
    // Net behaviour: stop_previous is now a pure runtime-state
    // teardown (workers + live atomics + active_port slot). The serial
    // session lives on the LedOutputBridge across mode changes.
    let cleared_port = owner.active_port.take();
    let total_ms = t0.elapsed().as_millis();
    info!(
        "[stop_previous] completed in {total_ms}ms had_worker={had_worker} cleared_port={:?} (cached serial session preserved to avoid DTR-reset cycle)",
        cleared_port
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
    const THRESHOLD: u8 = 15;

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
            self.insets = detect_black_borders(frame, Self::THRESHOLD);
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
// Edge signal preview — live capture feed for LightsSection
// ---------------------------------------------------------------------------
//
// Emitted at ~10 Hz while the ambilight worker is running so the frontend
// can render the four edges of the screen the way they're being sampled.
// Decoupled from the LED-driving pipeline: uses its own lightweight edge
// sampling so a rework of the LED mapping logic doesn't break the preview.

pub const EDGE_SIGNAL_EVENT: &str = "ambilight://edge-signal";
pub const EDGE_SIGNAL_MIN_INTERVAL_MS: u64 = 100;
pub const EDGE_SIGNAL_SAMPLES_PER_EDGE: usize = 16;
/// How far inside the screen edges the preview samples. 0.92 picks up the
/// dominant fringe color without dipping too deep into the center.
const EDGE_SIGNAL_AXIS_OFFSET: f32 = 0.92;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EdgeSignalPayload {
    pub top: Vec<[u8; 3]>,
    pub bottom: Vec<[u8; 3]>,
    pub left: Vec<[u8; 3]>,
    pub right: Vec<[u8; 3]>,
}

/// Thread-safe emitter the worker calls to surface edge previews. Thin
/// wrapper over `AppHandle::emit` so the worker doesn't depend on the
/// Tauri runtime type parameter.
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

pub fn compute_edge_signal(frame: &CapturedFrame, insets: &BlackBorderInsets) -> EdgeSignalPayload {
    let samples = EDGE_SIGNAL_SAMPLES_PER_EDGE;
    let mut top = Vec::with_capacity(samples);
    let mut bottom = Vec::with_capacity(samples);
    let mut left = Vec::with_capacity(samples);
    let mut right = Vec::with_capacity(samples);

    let denom = if samples > 1 {
        (samples - 1) as f32
    } else {
        1.0
    };
    let span = 2.0 * EDGE_SIGNAL_AXIS_OFFSET;

    for i in 0..samples {
        let t = i as f32 / denom;
        // Horizontal traversal for top/bottom, vertical for left/right.
        let x = -EDGE_SIGNAL_AXIS_OFFSET + t * span;
        // y: +1 at top → -1 at bottom (sample_screen_position_avg convention).
        let y = EDGE_SIGNAL_AXIS_OFFSET - t * span;

        let t_color = sample_screen_position_avg(frame, x, EDGE_SIGNAL_AXIS_OFFSET, insets);
        let b_color = sample_screen_position_avg(frame, x, -EDGE_SIGNAL_AXIS_OFFSET, insets);
        let l_color = sample_screen_position_avg(frame, -EDGE_SIGNAL_AXIS_OFFSET, y, insets);
        let r_color = sample_screen_position_avg(frame, EDGE_SIGNAL_AXIS_OFFSET, y, insets);

        top.push([t_color.0, t_color.1, t_color.2]);
        bottom.push([b_color.0, b_color.1, b_color.2]);
        left.push([l_color.0, l_color.1, l_color.2]);
        right.push([r_color.0, r_color.1, r_color.2]);
    }

    EdgeSignalPayload {
        top,
        bottom,
        left,
        right,
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

#[allow(clippy::too_many_arguments)]
fn start_ambilight_worker(
    output_bridge: LedOutputBridge,
    port_name: Option<String>,
    led_calibration: Option<LedCalibrationConfig>,
    live_settings: Arc<AmbilightLiveSettings>,
    frame_source: Box<dyn AmbilightFrameSource>,
    telemetry_snapshot: SharedRuntimeTelemetry,
    hue_output: Option<HueActiveOutputContext>,
    edge_signal_emitter: Option<EdgeSignalEmitter>,
    color_correction: ColorCorrectionConfig,
    firmware_profile: FirmwareProfile,
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

    let hue_only = port_name.is_none() && hue_output.is_some();
    let initial_smoothing_alpha = live_settings.read_smoothing_alpha();
    let quality_config = if hue_only {
        // Hue bridge enforces 50 ms minimum (20 Hz). Target ~25 FPS capture
        // to stay just above the send rate without flooding the queue.
        RuntimeQualityConfig {
            base_interval_ms: 40,
            min_interval_ms: 30,
            max_interval_ms: 100,
            smoothing_alpha: initial_smoothing_alpha,
            ..RuntimeQualityConfig::default()
        }
    } else {
        // Derive send interval from LED count to stay within 115 200-baud budget.
        let base_ms = derive_base_interval_ms(total_leds) as u64;
        RuntimeQualityConfig {
            base_interval_ms: base_ms,
            min_interval_ms: base_ms / 2,
            smoothing_alpha: initial_smoothing_alpha,
            ..RuntimeQualityConfig::default()
        }
    };
    let mut quality_state = AmbilightWorkerQualityState::new(quality_config);
    let mut frame_slot = RuntimeFrameSlot::new();
    let mut telemetry_window = RuntimeTelemetryWindow::new(Instant::now());

    let mut initial_frame_source =
        StaticFrameSource::new(Arc::try_unwrap(initial_frame).unwrap_or_else(|arc| (*arc).clone()));
    // No border detection for the initial warmup frame — detection runs in the worker loop.
    let initial_raw = initial_frame_source
        .capture_frame()
        .map_err(|e| e.as_reason())?;
    AMBILIGHT_CAPTURE_ATTEMPTS.fetch_add(1, Ordering::SeqCst);
    let initial_sampled = sample_frame_for_sequence(&initial_raw, &led_sequence, &led_counts, 0.05);
    telemetry_window.record_capture();
    if quality_state.queue_processed_frame(&mut frame_slot, initial_sampled.as_slice()) {
        telemetry_window.record_slot_overwrite();
    }

    // Build the USB sink once at worker start. The sink holds the LedOutputBridge
    // and encodes frames via the active FirmwareProfile + ColorCorrectionConfig.
    // Brightness is synced each iteration via SerialSink::set_brightness before
    // calling send_frame — this avoids circular module dependencies while keeping
    // the hot path allocation-free.
    let mut usb_sink: Option<SerialSink> = port_name.as_ref().map(|p| {
        SerialSink::with_profile_and_corrections(
            output_bridge.clone(),
            Some(p.clone()),
            live_settings.read_brightness(),
            firmware_profile,
            color_correction.clone(),
        )
    });
    if let Some(ref mut sink) = usb_sink {
        sink.start()?;
    }

    let send_started = Instant::now();
    if usb_sink.is_some() {
        let initial_brightness = live_settings.read_brightness();
        if let Some(ref mut sink) = usb_sink {
            sink.set_brightness(initial_brightness);
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
            "[ambilight-worker] started — port={:?} hue={} channels={}",
            port_name,
            has_hue,
            hue_output.as_ref().map(|c| c.channels.len()).unwrap_or(0)
        );
        if let Some(ctx) = hue_output.as_ref() {
            for ch in &ctx.channels {
                let norm_x = (ch.position_x.clamp(-1.0, 1.0) + 1.0) / 2.0;
                let norm_y = (1.0 - ch.position_y.clamp(-1.0, 1.0)) / 2.0;
                info!("[ambilight-worker] hue ch#{} bridge_pos=({:.3},{:.3}) screen_norm=({:.1}%,{:.1}%) region={:?}",
                    ch.channel_id, ch.position_x, ch.position_y,
                    norm_x * 100.0, norm_y * 100.0, ch.screen_region);
            }
        }
        let mut hue_send_count = 0u32;
        // Mirror of `hue_send_count` for the USB sink so live-debug sessions
        // can confirm full-strip frames are reaching the wire (e.g. byte
        // count, led_count) without flooding stdout at 60 Hz.
        let mut usb_send_count = 0u32;
        let mut hue_channel_smoother = HueChannelSmoother::new();
        // Border cache is refreshed each iteration from live_settings.
        let mut border_cache = BlackBorderCache::new(live_settings.read_black_border_detection());

        let mut capture_fail_count = 0u32;
        let mut last_edge_emit_at: Option<Instant> = None;
        while !cancel_flag.load(Ordering::Relaxed) {
            let capture_started = Instant::now();
            let capture_result: Result<(Arc<CapturedFrame>, Vec<[u8; 3]>), String> =
                match worker_source.lock() {
                    Ok(mut src) => {
                        AMBILIGHT_CAPTURE_ATTEMPTS.fetch_add(1, Ordering::SeqCst);
                        src.capture_frame().map_err(|e| e.as_reason()).map(|frame| {
                            let colors =
                                sample_frame_for_sequence(&frame, &led_sequence, &led_counts, 0.05);
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
            }
            if let Ok((raw_frame, mut sampled)) = capture_result {
                // Sync live-tunable settings from shared atomic state (zero-cost on hot path).
                border_cache.set_enabled(live_settings.read_black_border_detection());
                let brightness = live_settings.read_brightness();
                let saturation = live_settings.read_saturation();
                quality_state.set_smoothing_alpha(live_settings.read_smoothing_alpha());
                // Update black border detection cache from the raw (uncropped) frame.
                border_cache.update_if_due(&raw_frame);
                let capture_ms = capture_started.elapsed().as_secs_f32() * 1000.0;
                telemetry_window.record_capture();
                // Apply saturation before smoothing/sending so the quality gate sees
                // the corrected colors and temporal smoothing operates on final values.
                apply_saturation_inplace(&mut sampled, saturation);
                if quality_state.queue_processed_frame(&mut frame_slot, sampled.as_slice()) {
                    telemetry_window.record_slot_overwrite();
                }

                let send_started = Instant::now();
                let send_ms = if usb_sink.is_some() {
                    // USB send path: sync brightness then dispatch via LedSink trait.
                    if let Some(ref mut sink) = usb_sink {
                        sink.set_brightness(brightness);
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
                // smoothing, then send every frame to the bridge. Sending every
                // frame (instead of delta-skipping) lets the bridge's internal
                // ~100ms hardware interpolation produce smooth gradients.
                if let Some(context) = hue_output.as_ref() {
                    if !context.channels.is_empty() {
                        let raw_colors: Vec<(u8, u8, u8)> = context
                            .channels
                            .iter()
                            .map(|ch| {
                                let rgb = sample_screen_position_avg(
                                    &raw_frame,
                                    ch.position_x,
                                    ch.position_y,
                                    border_cache.insets(),
                                );
                                apply_color_correction_rgb(rgb, &color_correction)
                            })
                            .collect();

                        let hue_smoothing_alpha = live_settings.read_smoothing_alpha();
                        let smoothed =
                            hue_channel_smoother.smooth(&raw_colors, hue_smoothing_alpha);

                        hue_send_count += 1;
                        if hue_send_count <= 3 || hue_send_count.is_multiple_of(200) {
                            info!(
                                "[ambilight-worker] hue update #{hue_send_count} — colors: {:?}",
                                &smoothed[..smoothed.len().min(3)]
                            );
                        }
                        let _ =
                            apply_hue_channels_with_context(context, smoothed.to_vec(), brightness);
                        telemetry_window.record_send();
                    }
                }

                quality_state.observe_capture_and_send_cost(capture_ms, send_ms);
                telemetry_window.record_latency(quality_state.observed_cost_ms());
                let _ = telemetry_window.flush_if_due(Instant::now(), &telemetry_snapshot);

                // Edge signal preview — throttled to ~10 Hz.
                if let Some(emitter) = edge_signal_emitter.as_ref() {
                    let now = Instant::now();
                    let due = last_edge_emit_at
                        .map(|prev| {
                            now.duration_since(prev)
                                >= Duration::from_millis(EDGE_SIGNAL_MIN_INTERVAL_MS)
                        })
                        .unwrap_or(true);
                    if due {
                        let mut payload = compute_edge_signal(&raw_frame, border_cache.insets());
                        apply_saturation_inplace(&mut payload.top, saturation);
                        apply_saturation_inplace(&mut payload.bottom, saturation);
                        apply_saturation_inplace(&mut payload.left, saturation);
                        apply_saturation_inplace(&mut payload.right, saturation);
                        emitter(payload);
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

// Central state machine transition. 8-arg signature is retained to avoid
// disturbing the 16 existing call sites (several of which live in lib-tests
// that carry other outstanding compilation issues). Bundling these into a
// struct is tracked as a follow-up refactor rather than part of the clippy
// cleanup pass.
#[allow(clippy::too_many_arguments)]
fn apply_mode_change(
    owner: &mut LightingRuntimeOwner,
    next_mode: LightingModeConfig,
    device_connected: bool,
    connected_port: Option<&str>,
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

    // USB gate: only applies when USB is a required target (per D-01).
    if normalized_next.kind != LightingModeKind::Off && needs_usb && !device_connected {
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
    if normalized_next.kind != LightingModeKind::Off && needs_hue && hue_output.is_none() {
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

    // Fast path: ambilight already running and only settings changed (brightness,
    // black border detection, smoothing alpha) — update live atomics in-place
    // without stopping the worker or recreating SCStream.
    // NOTE: led_calibration, color_correction, or firmware_profile changes force a worker
    // restart because they affect the LED encoder pipeline, not just runtime atomics.
    if normalized_next.kind == LightingModeKind::Ambilight
        && owner.active_mode.kind == LightingModeKind::Ambilight
        && owner.worker.is_some()
        && normalized_next.targets == owner.active_mode.targets
        && normalized_next.display_id == owner.active_mode.display_id
        && normalized_next.led_calibration == owner.active_mode.led_calibration
        && normalized_next.color_correction == owner.active_mode.color_correction
        && normalized_next.firmware_profile == owner.active_mode.firmware_profile
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
            owner.active_mode = normalized_next;
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

            // USB solid output (only if USB target requested and port available)
            if needs_usb {
                let Some(port_name) = connected_port else {
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

                // Solid USB output must paint EVERY LED on the strip, not just
                // LED #0. Prior to this fix the encoder received a 1-element
                // slice (`&[[r, g, b]]`) and emitted a 9-byte frame with
                // count=1 — leaving 58/59 LEDs dark on a typical strip.
                //
                // Source the LED count from the calibration payload. When the
                // frontend has not yet stamped `ledCalibration` (e.g. user has
                // not run the calibration flow) the legacy 1-LED single-zone
                // behaviour is preserved so older firmware images keep working.
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
                let solid_packet = encode_packet_for_profile(
                    solid_profile,
                    payload.brightness,
                    &solid_triplets,
                    &solid_corrections,
                );

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

                if let Err(reason) = owner
                    .output_bridge
                    .send_packet_to_port(port_name, &solid_packet)
                    .map_err(|error| error.as_reason())
                {
                    warn!(
                        "[apply_mode_change] solid USB send FAILED — port={port_name} bytes={} led_count={solid_led_count} reason={reason}",
                        solid_packet.len()
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
                    "[apply_mode_change] solid USB packet sent — port={port_name} bytes={} led_count={solid_led_count} brightness_byte={brightness_byte} input=({}, {}, {}) corrected=({corrected_r}, {corrected_g}, {corrected_b})",
                    solid_packet.len(),
                    payload.r,
                    payload.g,
                    payload.b,
                );

                owner.active_port = Some(port_name.to_string());
            }

            // Hue solid output (if hue target requested and context available)
            if needs_hue {
                if let Some(context) = hue_output.as_ref() {
                    let hue_corrections =
                        normalized_next.color_correction.clone().unwrap_or_default();
                    let (hr, hg, hb) = apply_color_correction_rgb(
                        (payload.r, payload.g, payload.b),
                        &hue_corrections,
                    );
                    let _ = apply_hue_color_with_context(context, hr, hg, hb, payload.brightness);
                }
            }

            owner.active_mode = normalized_next;
            make_result(
                owner.active_mode.clone(),
                command_status(
                    "SOLID_MODE_APPLIED",
                    "Solid mode applied successfully.",
                    None,
                ),
            )
        }
        LightingModeKind::Ambilight => {
            push_trace(&mut trace, "start_ambilight");

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

            info!("[apply_mode_change] starting ambilight — needs_usb={needs_usb} needs_hue={needs_hue} hue_output={}", hue_output.is_some());

            let frame_source = {
                let req = AmbilightCaptureRequest {
                    display_id: normalized_next.display_id.clone(),
                    led_calibration: normalized_next.led_calibration.clone(),
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

            // Resolve port for worker: only pass port if USB is a required target
            let port_for_worker: Option<String> = if needs_usb {
                match connected_port {
                    Some(p) => Some(p.to_string()),
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

            match start_ambilight_worker(
                owner.output_bridge.clone(),
                port_for_worker,
                normalized_next.led_calibration.clone(),
                Arc::clone(&live_settings),
                frame_source,
                telemetry_snapshot
                    .unwrap_or_else(|| Arc::new(Mutex::new(RuntimeTelemetrySnapshot::default()))),
                hue_output,
                edge_signal_emitter,
                corrections,
                profile,
            ) {
                Ok(worker) => {
                    owner.worker = Some(worker);
                    owner.ambilight_live = Some(live_settings);
                    owner.active_mode = normalized_next;
                    if let Some(p) = connected_port {
                        owner.active_port = Some(p.to_string());
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

#[tauri::command]
pub fn set_lighting_mode<R: Runtime>(
    app: AppHandle<R>,
    mut payload: LightingModeConfig,
    runtime_state: State<'_, LightingRuntimeState>,
    connection_state: State<'_, SerialConnectionState>,
    hue_runtime_state: State<'_, HueRuntimeStateStore>,
    telemetry_state: State<'_, RuntimeTelemetryState>,
) -> Result<LightingModeCommandResult, String> {
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
    maybe_hydrate_led_calibration(&app, &mut payload);

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
    maybe_hydrate_ambilight_settings(&app, &mut payload);

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

    let edge_emitter: Option<EdgeSignalEmitter> = {
        let app_handle = app.clone();
        Some(Arc::new(move |payload: EdgeSignalPayload| {
            let _ = app_handle.emit(EDGE_SIGNAL_EVENT, payload);
        }))
    };

    let result = apply_mode_change(
        &mut owner,
        payload,
        connection_snapshot.connected,
        connection_snapshot.port_name.as_deref(),
        hue_output,
        Some(telemetry_state.shared_snapshot()),
        edge_emitter,
        None,
    );
    info!(
        "[set_lighting_mode] completed in {}ms",
        t_cmd.elapsed().as_millis()
    );
    Ok(result)
}

#[tauri::command]
pub fn stop_lighting(
    runtime_state: State<'_, LightingRuntimeState>,
) -> Result<LightingModeCommandResult, String> {
    let mut owner = runtime_state
        .runtime
        .lock()
        .map_err(|error| format!("LIGHTING_RUNTIME_STATE_LOCK_FAILED: {error}"))?;

    Ok(apply_mode_change(
        &mut owner,
        LightingModeConfig::default(),
        true,
        None,
        None,
        None,
        None,
        None,
    ))
}

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

    use super::{
        apply_mode_change, start_ambilight_worker, stop_previous, AmbilightLiveSettings,
        AmbilightPayload, AmbilightWorkerQualityState, LightingModeConfig, LightingModeKind,
        LightingRuntimeOwner, SolidColorPayload, ACTIVE_AMBILIGHT_WORKERS,
        AMBILIGHT_CAPTURE_ATTEMPTS, AMBILIGHT_FRAME_ATTEMPTS, SOLID_OUTPUT_ATTEMPTS,
    };

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

        fn disconnect_session(&self, _port_name: &str) {
            // no-op in tests — session tracking is not exercised here
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
            output_bridge: LedOutputBridge::from_sender(Arc::new(FakeLedSender::default())),
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
            output_bridge: LedOutputBridge::from_sender(Arc::new(FakeLedSender::default())),
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

    fn shared_runtime_telemetry() -> Arc<Mutex<RuntimeTelemetrySnapshot>> {
        Arc::new(Mutex::new(RuntimeTelemetrySnapshot::default()))
    }

    #[test]
    fn set_ambilight_stops_previous_then_starts_new_runtime() {
        let mut owner = owner_with_fake_sender();
        owner = LightingRuntimeOwner {
            active_mode: ambilight_mode(),
            active_port: Some("COM1".to_string()),
            worker: Some(
                start_ambilight_worker(
                    owner.output_bridge.clone(),
                    Some("COM1".to_string()),
                    None,
                    AmbilightLiveSettings::new(0.8, false, 0.35, 1.0),
                    (owner.frame_source_factory)(super::AmbilightCaptureRequest {
                        display_id: None,
                        led_calibration: None,
                    })
                    .expect("frame source should be available"),
                    shared_runtime_telemetry(),
                    None,
                    None,
                    super::ColorCorrectionConfig::default(),
                    super::FirmwareProfile::default(),
                )
                .expect("worker start should succeed"),
            ),
            ambilight_live: None,
            output_bridge: owner.output_bridge,
            frame_source_factory: owner.frame_source_factory,
        };
        let mut trace = Vec::new();

        let result = apply_mode_change(
            &mut owner,
            ambilight_mode(),
            true,
            Some("COM1"),
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
        AMBILIGHT_FRAME_ATTEMPTS.store(0, Ordering::SeqCst);
        AMBILIGHT_CAPTURE_ATTEMPTS.store(0, Ordering::SeqCst);

        let mut owner = owner_with_fake_sender();
        let result = apply_mode_change(
            &mut owner,
            ambilight_mode(),
            true,
            Some("COM7"),
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
    }

    #[test]
    fn repeated_switches_keep_single_active_runtime() {
        let mut owner = owner_with_fake_sender();

        let first = apply_mode_change(
            &mut owner,
            ambilight_mode(),
            true,
            Some("COM2"),
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
        );

        let denied = apply_mode_change(
            &mut owner,
            ambilight_mode(),
            false,
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
            output_bridge: LedOutputBridge::from_sender(recorder.clone()),
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
        AMBILIGHT_FRAME_ATTEMPTS.store(0, Ordering::SeqCst);
        AMBILIGHT_CAPTURE_ATTEMPTS.store(0, Ordering::SeqCst);

        let (mut owner, recorder) = owner_with_recording_sender_for_ambilight();
        let result = apply_mode_change(
            &mut owner,
            ambilight_mode_with_calibration(30),
            true,
            Some("COM-AMB-30"),
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
        apply_mode_change, normalize_mode_config, AmbilightPayload, LightingModeConfig,
        LightingModeKind, LightingRuntimeOwner, SolidColorPayload,
    };
    use crate::commands::led_output::{ColorCorrectionConfig, FirmwareProfile};

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
            output_bridge: LedOutputBridge::from_sender(Arc::new(FakeLedSender::default())),
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
            false, // device not connected
            None,  // no serial port
            None,  // hue_output=None triggers HUE_NOT_READY gate
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
            false, // device not connected
            None,
            None,
            None,
            None,
            None,
        );

        assert_eq!(result.status.code, "DEVICE_NOT_CONNECTED");
    }

    #[test]
    fn none_targets_preserves_legacy_usb_gate() {
        // targets=None, device_connected=false -> DEVICE_NOT_CONNECTED (backward compat per D-10)
        let mut owner = owner_with_fake_sender();
        let result = apply_mode_change(
            &mut owner,
            solid_with_targets(None),
            false, // device not connected
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
            None, // no hue output -> HUE_NOT_READY
            Some(shared_telemetry()),
            None,
            None,
        );

        assert_eq!(result.status.code, "HUE_NOT_READY");
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
        }
    }

    #[test]
    fn fast_path_preserves_saturation_when_payload_omits_it() {
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
    }

    #[test]
    fn fast_path_preserves_smoothing_alpha_when_payload_omits_it() {
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
    }

    #[test]
    fn fast_path_explicit_saturation_overrides_running_atomic() {
        // Sanity check: an explicit Some(value) STILL overrides the live atomic.
        // This guards against an over-eager None-preservation that would also
        // ignore explicit values.
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
            output_bridge: LedOutputBridge::from_sender(recorder.clone()),
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
        for chunk in payload.chunks_exact(3) {
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
        // Regression for v1.5 H1 — `apply_mode_change_with_disk_ambilight_fallback`
        // at the parser level: a canonical shell-state file with a
        // `lightingMode.ambilight` block must round-trip into a
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
}
