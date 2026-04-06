use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::State;

use super::ambilight_capture::{
    create_live_frame_source, sample_led_frame, AmbilightCaptureError, AmbilightFrameSource,
    CapturedFrame, SamplingCalibration, StaticFrameSource,
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

#[derive(Clone, Deserialize, Serialize, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AmbilightPayload {
    pub brightness: f32,
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
}

impl Default for LightingModeConfig {
    fn default() -> Self {
        Self {
            kind: LightingModeKind::Off,
            solid: None,
            ambilight: None,
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
}

impl LightingWorkerRuntime {
    fn stop(self) {
        self.cancel.store(true, Ordering::Relaxed);
        let _ = self.handle.join();
    }
}

struct LightingRuntimeOwner {
    active_mode: LightingModeConfig,
    /// Port name for the currently active LED session.
    /// Cleared in stop_previous so the cached serial handle is released
    /// via disconnect_session, preventing stale handle reuse on reconnect.
    active_port: Option<String>,
    worker: Option<LightingWorkerRuntime>,
    output_bridge: LedOutputBridge,
    frame_source_factory: Arc<AmbilightFrameSourceFactory>,
}

impl Default for LightingRuntimeOwner {
    fn default() -> Self {
        Self {
            active_mode: LightingModeConfig::default(),
            active_port: None,
            worker: None,
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
    match config.kind {
        LightingModeKind::Off => LightingModeConfig::default(),
        LightingModeKind::Ambilight => LightingModeConfig {
            kind: LightingModeKind::Ambilight,
            solid: None,
            ambilight: Some(AmbilightPayload {
                brightness: clamp_brightness(config.ambilight.map(|value| value.brightness), 1.0),
            }),
        },
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
    if let Some(worker) = owner.worker.take() {
        worker.stop();
    }
    // Release the cached serial handle for the port that was active.
    // This prevents the next connect from inheriting a stale file descriptor.
    if let Some(port_name) = owner.active_port.take() {
        owner.output_bridge.disconnect_session(&port_name);
    }
}

fn capture_sample_send_frame(
    source: &mut dyn AmbilightFrameSource,
    calibration: &SamplingCalibration,
) -> Result<(CapturedFrame, Vec<[u8; 3]>), String> {
    AMBILIGHT_CAPTURE_ATTEMPTS.fetch_add(1, Ordering::SeqCst);
    let frame = source.capture_frame().map_err(|error| error.as_reason())?;
    let sampled = sample_led_frame(&frame, calibration).map_err(|error| error.as_reason())?;
    Ok((frame, sampled.colors))
}

/// Average the colour of the pixels in the screen strip corresponding to
/// `region`. Uses a step of 8 pixels in both axes for fast sub-sampling.
fn sample_screen_region_avg(frame: &CapturedFrame, region: &HueScreenRegion) -> (u8, u8, u8) {
    let w = frame.width as usize;
    let h = frame.height as usize;
    if w == 0 || h == 0 || frame.pixels_rgb.is_empty() {
        return (0, 0, 0);
    }

    const STRIP: f32 = 0.20; // 20% strip depth
    const STEP: usize = 8;   // sub-sample every 8th pixel for speed

    let strip_h = ((h as f32 * STRIP) as usize).max(1);
    let strip_w = ((w as f32 * STRIP) as usize).max(1);

    let (row_start, row_end, col_start, col_end) = match region {
        HueScreenRegion::Top    => (0,           strip_h,     0,           w          ),
        HueScreenRegion::Bottom => (h - strip_h, h,           0,           w          ),
        HueScreenRegion::Left   => (0,           h,           0,           strip_w    ),
        HueScreenRegion::Right  => (0,           h,           w - strip_w, w          ),
        HueScreenRegion::Center => (h / 4,       3 * h / 4,   w / 4,       3 * w / 4 ),
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

struct AmbilightWorkerQualityState {
    controller: RuntimeQualityController,
}

impl AmbilightWorkerQualityState {
    fn new(config: RuntimeQualityConfig) -> Self {
        Self {
            controller: RuntimeQualityController::new(config),
        }
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

fn start_ambilight_worker(
    output_bridge: LedOutputBridge,
    port_name: String,
    brightness: f32,
    mut frame_source: Box<dyn AmbilightFrameSource>,
    telemetry_snapshot: SharedRuntimeTelemetry,
    hue_output: Option<HueActiveOutputContext>,
) -> Result<LightingWorkerRuntime, String> {
    let initial_frame = frame_source
        .capture_frame()
        .map_err(|error| error.as_reason())?;
    let calibration = SamplingCalibration {
        led_count: initial_frame.pixels_rgb.len(),
    };

    let mut quality_state = AmbilightWorkerQualityState::new(RuntimeQualityConfig::default());
    let mut frame_slot = RuntimeFrameSlot::new();
    let mut telemetry_window = RuntimeTelemetryWindow::new(Instant::now());

    let mut initial_frame_source = StaticFrameSource::new(initial_frame);
    let (_, initial_sampled) = capture_sample_send_frame(&mut initial_frame_source, &calibration)?;
    telemetry_window.record_capture();
    if quality_state.queue_processed_frame(&mut frame_slot, initial_sampled.as_slice()) {
        telemetry_window.record_slot_overwrite();
    }
    let send_started = Instant::now();
    let initial_sent = quality_state.try_send_latest(&mut frame_slot, Instant::now(), |frame| {
        AMBILIGHT_FRAME_ATTEMPTS.fetch_add(1, Ordering::SeqCst);
        send_ambilight_frame_hot_path_to_port(&output_bridge, &port_name, frame, brightness)
            .map_err(|error| error.as_reason())
    })?;
    if initial_sent {
        telemetry_window.record_send();
    }
    quality_state.observe_capture_and_send_cost(0.0, send_started.elapsed().as_secs_f32() * 1000.0);
    telemetry_window.flush_if_due(Instant::now(), &telemetry_snapshot)?;

    let cancel = Arc::new(AtomicBool::new(false));
    let cancel_flag = Arc::clone(&cancel);

    let handle = thread::spawn(move || {
        ACTIVE_AMBILIGHT_WORKERS.fetch_add(1, Ordering::SeqCst);

        while !cancel_flag.load(Ordering::Relaxed) {
            let capture_started = Instant::now();
            if let Ok((raw_frame, sampled)) =
                capture_sample_send_frame(frame_source.as_mut(), &calibration)
            {
                let capture_ms = capture_started.elapsed().as_secs_f32() * 1000.0;
                telemetry_window.record_capture();
                if quality_state.queue_processed_frame(&mut frame_slot, sampled.as_slice()) {
                    telemetry_window.record_slot_overwrite();
                }

                let send_started = Instant::now();
                let send_ms =
                    match quality_state.try_send_latest(&mut frame_slot, Instant::now(), |frame| {
                        AMBILIGHT_FRAME_ATTEMPTS.fetch_add(1, Ordering::SeqCst);
                        send_ambilight_frame_hot_path_to_port(
                            &output_bridge,
                            &port_name,
                            frame,
                            brightness,
                        )
                        .map_err(|error| error.as_reason())
                    }) {
                        Ok(true) => {
                            telemetry_window.record_send();
                            // Fire-and-forget per-channel Hue update.
                            // Rate limiting (50ms) is handled inside the sender.
                            if let Some(context) = hue_output.as_ref() {
                                if !context.channels.is_empty() {
                                    let channel_colors: Vec<(u8, u8, u8)> = context
                                        .channels
                                        .iter()
                                        .map(|ch| {
                                            sample_screen_region_avg(&raw_frame, &ch.screen_region)
                                        })
                                        .collect();
                                    let _ = apply_hue_channels_with_context(
                                        context,
                                        channel_colors,
                                        brightness,
                                    );
                                }
                            }
                            send_started.elapsed().as_secs_f32() * 1000.0
                        }
                        _ => 0.0,
                    };

                quality_state.observe_capture_and_send_cost(capture_ms, send_ms);
                let _ = telemetry_window.flush_if_due(Instant::now(), &telemetry_snapshot);
            }

            let interval_ms = quality_state.current_send_interval().as_millis() as u64;
            let sleep_ms = (interval_ms / 4).clamp(1, 8);
            thread::sleep(Duration::from_millis(sleep_ms));
        }

        ACTIVE_AMBILIGHT_WORKERS.fetch_sub(1, Ordering::SeqCst);
    });

    Ok(LightingWorkerRuntime { cancel, handle })
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

    if normalized_next.kind != LightingModeKind::Off && !device_connected {
        return make_result(
            owner.active_mode.clone(),
            command_status(
                "DEVICE_NOT_CONNECTED",
                "Cannot apply lighting mode while device is disconnected.",
                Some("Connect a supported serial controller before changing mode.".to_string()),
            ),
        );
    }

    let mut trace = trace;
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

            owner.active_mode = normalized_next;
            owner.active_port = Some(port_name.to_string());
            if let Some(context) = hue_output.as_ref() {
                let _ = apply_hue_color_with_context(
                    context,
                    payload.r,
                    payload.g,
                    payload.b,
                    payload.brightness,
                );
            }

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

            let Some(port_name) = connected_port else {
                owner.active_mode = LightingModeConfig::default();
                return make_result(
                    owner.active_mode.clone(),
                    command_status(
                        "AMBILIGHT_MODE_START_FAILED",
                        "Ambilight runtime could not start.",
                        Some("LED_OUTPUT_PORT_UNAVAILABLE".to_string()),
                    ),
                );
            };

            let brightness = normalized_next
                .ambilight
                .as_ref()
                .map(|payload| payload.brightness)
                .unwrap_or(1.0);

            let frame_source = match (owner.frame_source_factory)() {
                Ok(source) => source,
                Err(reason) => {
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

            match start_ambilight_worker(
                owner.output_bridge.clone(),
                port_name.to_string(),
                brightness,
                frame_source,
                telemetry_snapshot
                    .unwrap_or_else(|| Arc::new(Mutex::new(RuntimeTelemetrySnapshot::default()))),
                hue_output,
            ) {
                Ok(worker) => {
                    owner.worker = Some(worker);
                    owner.active_mode = normalized_next;
                    owner.active_port = Some(port_name.to_string());
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
    let connection_snapshot = connection_state
        .last_status
        .lock()
        .map(|status| status.clone())
        .map_err(|error| format!("LIGHTING_CONNECTION_STATE_LOCK_FAILED: {error}"))?;

    let mut owner = runtime_state
        .runtime
        .lock()
        .map_err(|error| format!("LIGHTING_RUNTIME_STATE_LOCK_FAILED: {error}"))?;

    let hue_output = snapshot_hue_output_context(&hue_runtime_state)?;

    Ok(apply_mode_change(
        &mut owner,
        payload,
        connection_snapshot.connected,
        connection_snapshot.port_name.as_deref(),
        hue_output,
        Some(telemetry_state.shared_snapshot()),
        None,
    ))
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
        apply_mode_change, start_ambilight_worker, stop_previous, AmbilightPayload,
        AmbilightWorkerQualityState, LightingModeConfig, LightingModeKind, LightingRuntimeOwner,
        SolidColorPayload, ACTIVE_AMBILIGHT_WORKERS, AMBILIGHT_CAPTURE_ATTEMPTS,
        AMBILIGHT_FRAME_ATTEMPTS, SOLID_OUTPUT_ATTEMPTS,
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
            ambilight: Some(AmbilightPayload { brightness: 0.8 }),
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
                    "COM1".to_string(),
                    0.8,
                    (owner.frame_source_factory)().expect("frame source should be available"),
                    shared_runtime_telemetry(),
                    None,
                )
                .expect("worker start should succeed"),
            ),
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
    use super::*;

    #[test]
    fn hue_only_target_bypasses_usb_gate() {
        // Setup: device_connected=false, targets=Some(vec!["hue".to_string()])
        // Expect: apply_mode_change does NOT return DEVICE_NOT_CONNECTED
        todo!("Implement after Task 1 adds targets field")
    }

    #[test]
    fn usb_target_requires_device_connected() {
        // Setup: device_connected=false, targets=Some(vec!["usb".to_string()])
        // Expect: apply_mode_change returns DEVICE_NOT_CONNECTED
        todo!("Implement after Task 1 adds targets field")
    }

    #[test]
    fn none_targets_preserves_legacy_usb_gate() {
        // Setup: device_connected=false, targets=None
        // Expect: apply_mode_change returns DEVICE_NOT_CONNECTED (backward compat)
        todo!("Implement after Task 1 adds targets field")
    }

    #[test]
    fn hue_only_target_returns_hue_not_ready_when_no_hue_output() {
        // Setup: targets=Some(vec!["hue".to_string()]), hue_output=None
        // Expect: apply_mode_change returns HUE_NOT_READY
        todo!("Implement after Task 1 adds targets field")
    }
}
