use std::sync::atomic::{AtomicBool, AtomicU32, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use log::{info, warn};
use serde::{Deserialize, Serialize};
use tauri::State;

use super::ambilight_capture::{
    create_live_frame_source, crop_frame_to_content, detect_black_borders, sample_led_frame,
    AmbilightCaptureError, AmbilightFrameSource, BlackBorderInsets, CapturedFrame,
    SamplingCalibration, StaticFrameSource,
};
use super::device_connection::{CommandStatus, SerialConnectionState};
use super::hue_stream_lifecycle::{
    apply_hue_channels_with_context, apply_hue_color_with_context, snapshot_hue_output_context,
    HueActiveOutputContext, HueScreenRegion, HueRuntimeStateStore,
};
use super::led_output::{
    apply_solid_payload_to_port, send_ambilight_frame_hot_path_to_port, LedOutputBridge,
};
use super::runtime_quality::{RuntimeFrameSlot, RuntimeQualityConfig, RuntimeQualityController};
use super::runtime_telemetry::{
    RuntimeTelemetrySnapshot, RuntimeTelemetryState, RuntimeTelemetryWindow, SharedRuntimeTelemetry,
};

static ACTIVE_AMBILIGHT_WORKERS: AtomicUsize = AtomicUsize::new(0);
static SOLID_OUTPUT_ATTEMPTS: AtomicUsize = AtomicUsize::new(0);
static AMBILIGHT_FRAME_ATTEMPTS: AtomicUsize = AtomicUsize::new(0);
static AMBILIGHT_CAPTURE_ATTEMPTS: AtomicUsize = AtomicUsize::new(0);

type AmbilightFrameSourceFactory =
    dyn Fn() -> Result<Box<dyn AmbilightFrameSource>, AmbilightCaptureError> + Send + Sync;

#[derive(Clone, Deserialize, Serialize, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum LightingModeKind {
    Off,
    Ambilight,
    Solid,
}

impl Default for LightingModeKind {
    fn default() -> Self {
        Self::Off
    }
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
}

impl Default for LightingModeConfig {
    fn default() -> Self {
        Self {
            kind: LightingModeKind::Off,
            solid: None,
            ambilight: None,
            targets: None,
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
    /// EWMA smoothing alpha as f32 bit pattern. Range [0.05, 1.0].
    smoothing_alpha: AtomicU32,
}

impl AmbilightLiveSettings {
    fn new(brightness: f32, black_border_detection: bool, smoothing_alpha: f32) -> Arc<Self> {
        Arc::new(Self {
            brightness: AtomicU32::new(brightness.to_bits()),
            black_border_detection: AtomicBool::new(black_border_detection),
            smoothing_alpha: AtomicU32::new(smoothing_alpha.clamp(0.05, 1.0).to_bits()),
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

    fn update(&self, brightness: f32, black_border_detection: bool, smoothing_alpha: f32) {
        self.brightness.store(brightness.to_bits(), Ordering::Relaxed);
        self.black_border_detection.store(black_border_detection, Ordering::Relaxed);
        self.smoothing_alpha.store(smoothing_alpha.clamp(0.05, 1.0).to_bits(), Ordering::Relaxed);
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
            frame_source_factory: Arc::new(create_live_frame_source),
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

fn normalize_mode_config(config: LightingModeConfig) -> LightingModeConfig {
    let targets = config.targets.clone();
    match config.kind {
        LightingModeKind::Off => LightingModeConfig {
            targets,
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
                }),
                targets,
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
    if let Some(worker) = owner.worker.take() {
        worker.stop();
    }
    if let Some(port_name) = owner.active_port.take() {
        owner.output_bridge.disconnect_session(&port_name);
    }
    let total_ms = t0.elapsed().as_millis();
    info!("[stop_previous] completed in {total_ms}ms");
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
        Self { insets: BlackBorderInsets::default(), last_updated: past, enabled }
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

fn capture_sample_send_frame(
    source: &mut dyn AmbilightFrameSource,
    calibration: &SamplingCalibration,
    border_insets: &BlackBorderInsets,
) -> Result<(CapturedFrame, Vec<[u8; 3]>), String> {
    AMBILIGHT_CAPTURE_ATTEMPTS.fetch_add(1, Ordering::SeqCst);
    let frame = source.capture_frame().map_err(|error| error.as_reason())?;
    let sampled = if border_insets.is_zero() {
        sample_led_frame(&frame, calibration)
    } else {
        let cropped = crop_frame_to_content(&frame, border_insets);
        sample_led_frame(&cropped, calibration)
    }
    .map_err(|error| error.as_reason())?;
    Ok((frame, sampled.colors))
}

/// Average the colour of the pixels in the screen strip corresponding to
/// `region`, respecting black-border `insets` so letterbox / pillarbox areas
/// are excluded. Uses a step of 8 pixels in both axes for fast sub-sampling.
#[allow(dead_code)]
fn sample_screen_region_avg(
    frame: &CapturedFrame,
    region: &HueScreenRegion,
    insets: &BlackBorderInsets,
) -> (u8, u8, u8) {
    let w = frame.width as usize;
    let h = frame.height as usize;
    if w == 0 || h == 0 || frame.pixels_rgb.is_empty() {
        return (0, 0, 0);
    }

    const STRIP: f32 = 0.20; // 20% strip depth within content area
    const STEP: usize = 8;   // sub-sample every 8th pixel for speed

    // Derive content-area bounds from detected insets.
    let top_border    = (h as f32 * insets.top)    as usize;
    let bottom_border = (h as f32 * insets.bottom) as usize;
    let left_border   = (w as f32 * insets.left)   as usize;
    let right_border  = (w as f32 * insets.right)  as usize;

    let ct = top_border;                              // content top row
    let cb = h.saturating_sub(bottom_border).max(ct + 1); // content bottom row
    let cl = left_border;                             // content left col
    let cr = w.saturating_sub(right_border).max(cl + 1);  // content right col
    let ch = cb - ct;                                 // content height
    let cw = cr - cl;                                 // content width

    let strip_h = ((ch as f32 * STRIP) as usize).max(1);
    let strip_w = ((cw as f32 * STRIP) as usize).max(1);

    let (row_start, row_end, col_start, col_end) = match region {
        HueScreenRegion::Top    => (ct,                    (ct + strip_h).min(cb), cl, cr),
        HueScreenRegion::Bottom => (cb.saturating_sub(strip_h), cb,                cl, cr),
        HueScreenRegion::Left   => (ct, cb,  cl,                    (cl + strip_w).min(cr)),
        HueScreenRegion::Right  => (ct, cb,  cr.saturating_sub(strip_w), cr              ),
        HueScreenRegion::Center => (h / 4, 3 * h / 4, w / 4, 3 * w / 4),
    };

    let mut sum_r = 0u32;
    let mut sum_g = 0u32;
    let mut sum_b = 0u32;
    let mut count = 0u32;

    let mut row = row_start;
    while row < row_end {
        let mut col = col_start;
        while col < col_end {
            let idx = row * w + col;
            if let Some(pixel) = frame.pixels_rgb.get(idx) {
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
    ((sum_r / count) as u8, (sum_g / count) as u8, (sum_b / count) as u8)
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
    let cb = h.saturating_sub((h as f32 * insets.bottom) as usize).max(ct + 1);
    let cl = (w as f32 * insets.left) as usize;
    let cr = w.saturating_sub((w as f32 * insets.right) as usize).max(cl + 1);
    let cw = (cr - cl) as f32;
    let ch = (cb - ct) as f32;

    // Map Hue position [-1, +1] to content area.
    // x: -1 → left edge, +1 → right edge
    // y: +1 → top edge (screen row 0), -1 → bottom edge
    let norm_x = (pos_x.clamp(-1.0, 1.0) + 1.0) / 2.0; // [0, 1]
    let norm_y = (1.0 - pos_y.clamp(-1.0, 1.0)) / 2.0;  // [0, 1], flipped for screen coords

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

    if count == 0 { return (0, 0, 0); }
    ((sum_r / count) as u8, (sum_g / count) as u8, (sum_b / count) as u8)
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
}

impl HueChannelSmoother {
    fn new() -> Self {
        Self { previous: Vec::new() }
    }

    /// Apply EWMA smoothing to incoming channel colors.
    ///
    /// `alpha` in `[0.05, 1.0]`:
    ///   - 1.0 = no smoothing (output equals input)
    ///   - 0.05 = very slow, gradual transitions
    fn smooth(&mut self, incoming: &[(u8, u8, u8)], alpha: f32) -> Vec<(u8, u8, u8)> {
        let a = alpha.clamp(0.05, 1.0);

        // Channel count changed → reset state (e.g. entertainment area switched).
        if self.previous.len() != incoming.len() {
            self.previous = incoming.iter()
                .map(|&(r, g, b)| (r as f32, g as f32, b as f32))
                .collect();
            return incoming.to_vec();
        }

        let mut result = Vec::with_capacity(incoming.len());
        for (prev, &(tr, tg, tb)) in self.previous.iter_mut().zip(incoming.iter()) {
            prev.0 += a * (tr as f32 - prev.0);
            prev.1 += a * (tg as f32 - prev.1);
            prev.2 += a * (tb as f32 - prev.2);
            result.push((
                prev.0.round().clamp(0.0, 255.0) as u8,
                prev.1.round().clamp(0.0, 255.0) as u8,
                prev.2.round().clamp(0.0, 255.0) as u8,
            ));
        }
        result
    }
}

fn start_ambilight_worker(
    output_bridge: LedOutputBridge,
    port_name: Option<String>,
    live_settings: Arc<AmbilightLiveSettings>,
    frame_source: Box<dyn AmbilightFrameSource>,
    telemetry_snapshot: SharedRuntimeTelemetry,
    hue_output: Option<HueActiveOutputContext>,
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
                Ok(frame) => { found = Some(frame); break; }
                Err(crate::commands::ambilight_capture::AmbilightCaptureError::FrameUnavailable) => {
                    last_err = "AMBILIGHT_CAPTURE_FRAME_UNAVAILABLE".to_string();
                    thread::sleep(Duration::from_millis(RETRY_MS));
                }
                Err(other) => return Err(other.as_reason()),
            }
        }
        found.ok_or(last_err)?
    };
    // led_count=1 is a safe placeholder for the quality-gate smoothing pipeline.
    // USB LED count is a separate concern (room-map config); using pixel count here
    // produced ~11 MB serial packets and blocked the Hue update path entirely.
    let calibration = SamplingCalibration { led_count: 1 };

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
        RuntimeQualityConfig {
            smoothing_alpha: initial_smoothing_alpha,
            ..RuntimeQualityConfig::default()
        }
    };
    let mut quality_state = AmbilightWorkerQualityState::new(quality_config);
    let mut frame_slot = RuntimeFrameSlot::new();
    let mut telemetry_window = RuntimeTelemetryWindow::new(Instant::now());

    let mut initial_frame_source = StaticFrameSource::new(initial_frame);
    // No border detection for the initial warmup frame — detection runs in the worker loop.
    let (_, initial_sampled) = capture_sample_send_frame(
        &mut initial_frame_source,
        &calibration,
        &BlackBorderInsets::default(),
    )?;
    telemetry_window.record_capture();
    if quality_state.queue_processed_frame(&mut frame_slot, initial_sampled.as_slice()) {
        telemetry_window.record_slot_overwrite();
    }
    let send_started = Instant::now();
    if let Some(ref port) = port_name {
        let initial_brightness = live_settings.read_brightness();
        let initial_sent = quality_state.try_send_latest(&mut frame_slot, Instant::now(), |frame| {
            AMBILIGHT_FRAME_ATTEMPTS.fetch_add(1, Ordering::SeqCst);
            send_ambilight_frame_hot_path_to_port(&output_bridge, port, frame, initial_brightness)
                .map_err(|error| error.as_reason())
        })?;
        if initial_sent {
            telemetry_window.record_send();
        }
    }
    // Hue-only: no initial USB send needed, just apply Hue from capture
    quality_state.observe_capture_and_send_cost(0.0, send_started.elapsed().as_secs_f32() * 1000.0);
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
        let has_hue = hue_output.as_ref().map(|c| !c.channels.is_empty()).unwrap_or(false);
        info!("[ambilight-worker] started — port={:?} hue={} channels={}", port_name, has_hue, hue_output.as_ref().map(|c| c.channels.len()).unwrap_or(0));
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
        let mut hue_channel_smoother = HueChannelSmoother::new();
        // Border cache is refreshed each iteration from live_settings.
        let mut border_cache = BlackBorderCache::new(live_settings.read_black_border_detection());

        let mut capture_fail_count = 0u32;
        while !cancel_flag.load(Ordering::Relaxed) {
            let capture_started = Instant::now();
            let capture_result = match worker_source.lock() {
                Ok(mut src) => capture_sample_send_frame(
                    src.as_mut(),
                    &calibration,
                    border_cache.insets(),
                ),
                Err(_) => Err("AMBILIGHT_CAPTURE_FRAME_LOCK_FAILED".to_string()),
            };
            if let Err(ref e) = capture_result {
                capture_fail_count += 1;
                if capture_fail_count <= 5 || capture_fail_count % 50 == 0 {
                    warn!("[ambilight-worker] capture failed #{capture_fail_count}: {e}");
                }
            }
            if let Ok((raw_frame, sampled)) = capture_result {
                // Sync live-tunable settings from shared atomic state (zero-cost on hot path).
                border_cache.set_enabled(live_settings.read_black_border_detection());
                let brightness = live_settings.read_brightness();
                quality_state.set_smoothing_alpha(live_settings.read_smoothing_alpha());
                // Update black border detection cache from the raw (uncropped) frame.
                border_cache.update_if_due(&raw_frame);
                let capture_ms = capture_started.elapsed().as_secs_f32() * 1000.0;
                telemetry_window.record_capture();
                if quality_state.queue_processed_frame(&mut frame_slot, sampled.as_slice()) {
                    telemetry_window.record_slot_overwrite();
                }

                let send_started = Instant::now();
                let send_ms = if let Some(ref port) = port_name {
                    // USB send path: send frame to serial port.
                    match quality_state.try_send_latest(&mut frame_slot, Instant::now(), |frame| {
                        AMBILIGHT_FRAME_ATTEMPTS.fetch_add(1, Ordering::SeqCst);
                        send_ambilight_frame_hot_path_to_port(
                            &output_bridge,
                            port,
                            frame,
                            brightness,
                        )
                        .map_err(|error| error.as_reason())
                    }) {
                        Ok(true) => {
                            telemetry_window.record_send();
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
                            .map(|ch| sample_screen_position_avg(&raw_frame, ch.position_x, ch.position_y, border_cache.insets()))
                            .collect();

                        let smoothing_alpha = live_settings.read_smoothing_alpha();
                        let smoothed = hue_channel_smoother.smooth(&raw_colors, smoothing_alpha);

                        hue_send_count += 1;
                        if hue_send_count <= 3 || hue_send_count % 200 == 0 {
                            info!("[ambilight-worker] hue update #{hue_send_count} — colors: {:?}", &smoothed[..smoothed.len().min(3)]);
                        }
                        let _ = apply_hue_channels_with_context(context, smoothed, brightness);
                        telemetry_window.record_send();
                    }
                }

                quality_state.observe_capture_and_send_cost(capture_ms, send_ms);
                let _ = telemetry_window.flush_if_due(Instant::now(), &telemetry_snapshot);
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

        ACTIVE_AMBILIGHT_WORKERS.fetch_sub(1, Ordering::SeqCst);
    });

    Ok(LightingWorkerRuntime { cancel, handle, _frame_source: frame_source_arc })
}

fn apply_mode_change(
    owner: &mut LightingRuntimeOwner,
    next_mode: LightingModeConfig,
    device_connected: bool,
    connected_port: Option<&str>,
    hue_output: Option<HueActiveOutputContext>,
    telemetry_snapshot: Option<SharedRuntimeTelemetry>,
    trace: Option<&mut Vec<&'static str>>,
) -> LightingModeCommandResult {
    let normalized_next = normalize_mode_config(next_mode);

    // Derive target flags from the requested targets list.
    // Empty/None targets = legacy behavior: USB is required (backward compat per D-10).
    let requested_targets = normalized_next.targets.clone().unwrap_or_default();
    let needs_usb = requested_targets.is_empty() || requested_targets.iter().any(|t| t == "usb");
    let needs_hue = requested_targets.iter().any(|t| t == "hue");

    // USB gate: only applies when USB is a required target (per D-01).
    if normalized_next.kind != LightingModeKind::Off && needs_usb && !device_connected {
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
    if normalized_next.kind == LightingModeKind::Ambilight
        && owner.active_mode.kind == LightingModeKind::Ambilight
        && owner.worker.is_some()
        && normalized_next.targets == owner.active_mode.targets
    {
        if let Some(live) = &owner.ambilight_live {
            let cfg = normalized_next.ambilight.as_ref().cloned().unwrap_or_default();
            live.update(cfg.brightness, cfg.black_border_detection, cfg.smoothing_alpha.unwrap_or(0.35));
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

                if let Err(reason) = apply_solid_payload_to_port(
                    &owner.output_bridge,
                    port_name,
                    payload.r,
                    payload.g,
                    payload.b,
                    payload.brightness,
                )
                .map_err(|error| error.as_reason())
                {
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

                owner.active_port = Some(port_name.to_string());
            }

            // Hue solid output (if hue target requested and context available)
            if needs_hue {
                if let Some(context) = hue_output.as_ref() {
                    let _ = apply_hue_color_with_context(
                        context,
                        payload.r,
                        payload.g,
                        payload.b,
                        payload.brightness,
                    );
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

            let ambilight_cfg = normalized_next.ambilight.as_ref().cloned().unwrap_or_default();
            let live_settings = AmbilightLiveSettings::new(
                ambilight_cfg.brightness,
                ambilight_cfg.black_border_detection,
                ambilight_cfg.smoothing_alpha.unwrap_or(0.35),
            );

            info!("[apply_mode_change] starting ambilight — needs_usb={needs_usb} needs_hue={needs_hue} hue_output={}", hue_output.is_some());

            let frame_source = match (owner.frame_source_factory)() {
                Ok(source) => { info!("[apply_mode_change] frame_source created OK"); source }
                Err(reason) => {
                    warn!("[apply_mode_change] frame_source FAILED: {}", reason.as_reason());
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

            match start_ambilight_worker(
                owner.output_bridge.clone(),
                port_for_worker,
                Arc::clone(&live_settings),
                frame_source,
                telemetry_snapshot
                    .unwrap_or_else(|| Arc::new(Mutex::new(RuntimeTelemetrySnapshot::default()))),
                hue_output,
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
pub fn set_lighting_mode(
    payload: LightingModeConfig,
    runtime_state: State<'_, LightingRuntimeState>,
    connection_state: State<'_, SerialConnectionState>,
    hue_runtime_state: State<'_, HueRuntimeStateStore>,
    telemetry_state: State<'_, RuntimeTelemetryState>,
) -> Result<LightingModeCommandResult, String> {
    let t_cmd = std::time::Instant::now();
    info!("[set_lighting_mode] invoked kind={:?}", payload.kind);

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
    if lock_ms > 10 { info!("[set_lighting_mode] runtime lock waited {lock_ms}ms"); }

    let hue_output = snapshot_hue_output_context(&hue_runtime_state)?;

    let result = apply_mode_change(
        &mut owner,
        payload,
        connection_snapshot.connected,
        connection_snapshot.port_name.as_deref(),
        hue_output,
        Some(telemetry_state.shared_snapshot()),
        None,
    );
    info!("[set_lighting_mode] completed in {}ms", t_cmd.elapsed().as_millis());
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
        fn capture_frame(&mut self) -> Result<CapturedFrame, AmbilightCaptureError> {
            if self.fail_with_unavailable {
                return Err(AmbilightCaptureError::FrameUnavailable);
            }
            Ok(self.frame.clone())
        }
    }

    fn owner_with_fake_sender() -> LightingRuntimeOwner {
        LightingRuntimeOwner {
            active_mode: LightingModeConfig::default(),
            active_port: None,
            worker: None,
            output_bridge: LedOutputBridge::from_sender(Arc::new(FakeLedSender::default())),
            frame_source_factory: Arc::new(|| {
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
            output_bridge: LedOutputBridge::from_sender(Arc::new(FakeLedSender::default())),
            frame_source_factory: Arc::new(|| {
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
            ambilight: Some(AmbilightPayload { brightness: 0.8, ..Default::default() }),
            targets: None,
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
                    AmbilightLiveSettings::new(0.8, false, 0.35),
                    (owner.frame_source_factory)().expect("frame source should be available"),
                    shared_runtime_telemetry(),
                    None,
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
        );
        assert_eq!(final_state.mode.kind, LightingModeKind::Solid);
        wait_for_worker_count(0);
        assert_eq!(ACTIVE_AMBILIGHT_WORKERS.load(Ordering::SeqCst), 0);

        assert_eq!(final_state.status.code, "SOLID_MODE_APPLIED");
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
        );

        let denied = apply_mode_change(
            &mut owner,
            ambilight_mode(),
            false,
            None,
            None,
            Some(shared_runtime_telemetry()),
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
        );

        assert_eq!(failed.status.code, "AMBILIGHT_MODE_START_FAILED");
        assert_eq!(
            failed.status.details,
            Some("AMBILIGHT_CAPTURE_FRAME_UNAVAILABLE".to_string())
        );
        assert_eq!(failed.mode.kind, LightingModeKind::Off);
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn default_runtime_owner_uses_live_source_factory_contract() {
        let owner = LightingRuntimeOwner::default();

        let error = match (owner.frame_source_factory)() {
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
        apply_mode_change, AmbilightPayload, LightingModeConfig, LightingModeKind,
        LightingRuntimeOwner, SolidColorPayload,
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

        fn disconnect_session(&self, _port_name: &str) {}
    }

    struct FakeFrameSource {
        frame: CapturedFrame,
    }

    impl AmbilightFrameSource for FakeFrameSource {
        fn capture_frame(&mut self) -> Result<CapturedFrame, AmbilightCaptureError> {
            Ok(self.frame.clone())
        }
    }

    fn owner_with_fake_sender() -> LightingRuntimeOwner {
        LightingRuntimeOwner {
            active_mode: LightingModeConfig::default(),
            active_port: None,
            worker: None,
            output_bridge: LedOutputBridge::from_sender(Arc::new(FakeLedSender::default())),
            frame_source_factory: Arc::new(|| {
                Ok(Box::new(FakeFrameSource {
                    frame: CapturedFrame {
                        width: 2,
                        height: 2,
                        pixels_rgb: vec![
                            [10, 20, 30],
                            [40, 50, 60],
                            [70, 80, 90],
                            [100, 110, 120],
                        ],
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
            ambilight: Some(AmbilightPayload { brightness: 1.0, ..Default::default() }),
            targets,
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
        );

        assert_eq!(result.status.code, "HUE_NOT_READY");
    }
}
