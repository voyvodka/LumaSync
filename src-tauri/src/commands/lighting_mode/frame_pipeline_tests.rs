//! Equivalence, allocation and cost checks for the ambilight worker's per-frame
//! step. See docs/architecture/capture-and-pipeline.md, "Measuring the frame
//! budget".

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use super::frame_pipeline::{
    strip_topology_for, AmbilightFramePipeline, FramePipelineConfig, FrameSettings,
};
use super::*;
use crate::commands::ambilight_capture::AmbilightCaptureError;
use crate::commands::ambilight_scene::{LightSetState, SceneAnalyzer};
use crate::commands::hue::frame::{
    HueAreaChannel, HueColorSender, HueColorUpdate, HueScreenRegion,
};
use crate::commands::hue::state_store::HueChannelPlacementOverride;
use crate::commands::led_calibration::{
    build_led_sequence, sample_frame_for_sequence, LedSegmentCounts, LedSequenceItem,
};
use crate::commands::led_output::{
    apply_color_correction_rgb_with_luts, gamma_luts_for, GammaLuts, LedOutputError,
    LedPacketSender,
};
use crate::commands::runtime_telemetry::RuntimeTelemetrySnapshot;
use crate::models::room_map::{RoomDimensions, TvAnchorPlacement};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/// What ScreenCaptureKit hands the worker for a 1920×1080 or 3840×2160 display
/// (`MAX_CAPTURE_DIM` 640, integer scale). A 2560×1600 panel gives 640×400.
const FRAME_W: u32 = 640;
const FRAME_H: u32 = 360;

fn calibration(top: u16, right: u16, bottom: u16, left: u16) -> LedCalibrationConfig {
    LedCalibrationConfig {
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
        total_leds: top + right + bottom + left,
    }
}

fn strip_164() -> LedCalibrationConfig {
    calibration(50, 32, 50, 32)
}

fn strip_300() -> LedCalibrationConfig {
    calibration(90, 60, 90, 60)
}

const WIRE_COMBOS: [(FirmwareProfile, LedChipType); 4] = [
    (FirmwareProfile::LumaSyncV1, LedChipType::Ws2812bGrb),
    (FirmwareProfile::LumaSyncV1, LedChipType::Sk6812Rgbw),
    (FirmwareProfile::Adalight, LedChipType::Ws2812bGrb),
    (FirmwareProfile::Adalight, LedChipType::Sk6812Rgbw),
];

/// Non-default on every axis, so a per-frame LUT or Kelvin rebuild would do
/// real work instead of hitting the shared 2.2 table.
fn color_correction() -> ColorCorrectionConfig {
    ColorCorrectionConfig {
        gamma_r: 2.4,
        gamma_g: 2.2,
        gamma_b: 2.0,
        kelvin: 5000,
        saturation: 1.2,
    }
}

/// Deterministic content with a fixed letterbox, so black-border detection
/// answers the same whenever its 2.5 s timer happens to fire. The palette
/// changes every 12 frames (a hard cut) and a bright block moves every frame.
fn scene_frame(width: u32, height: u32, t: u32) -> CapturedFrame {
    let (w, h) = (width as usize, height as usize);
    let bar = h / 10;
    let palette = (t / 12) % 3;
    let block_x = (t as usize * 23) % w;
    let block_y = h / 2 + (t as usize * 7) % (h / 4);
    let mut pixels_rgb = Vec::with_capacity(w * h);
    for y in 0..h {
        for x in 0..w {
            if y < bar || y >= h - bar {
                pixels_rgb.push([0, 0, 0]);
                continue;
            }
            if x.abs_diff(block_x) < w / 10 && y.abs_diff(block_y) < h / 8 {
                pixels_rgb.push([255, 220, 40]);
                continue;
            }
            pixels_rgb.push(match palette {
                0 => [(x * 255 / w) as u8, (y * 255 / h) as u8, 90],
                1 => [40, (x * 200 / w) as u8 + 30, (255 - y * 255 / h) as u8],
                _ => [(255 - x * 255 / w) as u8, 60, (y * 180 / h) as u8 + 40],
            });
        }
    }
    CapturedFrame {
        width,
        height,
        pixels_rgb,
    }
}

fn scene_frames(width: u32, height: u32, count: u32) -> Vec<Arc<CapturedFrame>> {
    (0..count)
        .map(|t| Arc::new(scene_frame(width, height, t)))
        .collect()
}

fn hue_channel(channel_id: u8, x: f32, y: f32, z: Option<f32>) -> HueAreaChannel {
    HueAreaChannel {
        channel_id,
        light_ids: vec![format!("light-{channel_id}")],
        screen_region: HueScreenRegion::Center,
        position_x: x,
        position_y: y,
        position_z: z,
    }
}

fn hue_channels() -> Vec<HueAreaChannel> {
    vec![
        hue_channel(0, -0.8, 0.9, Some(0.3)),
        hue_channel(3, 0.7, -0.6, None),
    ]
}

fn placement(channel_id: u8, x: f32, y: f32, z: Option<f32>) -> HueChannelPlacementOverride {
    HueChannelPlacementOverride {
        channel_id,
        position_x: x,
        position_y: y,
        position_z: z,
    }
}

fn room_geometry(placements: Vec<HueChannelPlacementOverride>) -> RoomGeometry {
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

fn live_settings() -> Arc<AmbilightLiveSettings> {
    AmbilightLiveSettings::new(0.9, true, 0.35, 1.0)
}

/// Settings and room-map changes a running worker receives, keyed by the
/// capture call they precede. The threaded run applies them from inside
/// `capture_frame`, so they land on the same frame in both runs.
/// `border_off_at` exists for the lock-step tests only: re-enabling detection
/// waits on a wall-clock timer, which a threaded run cannot pin to a frame.
fn apply_script(
    call: usize,
    live: &AmbilightLiveSettings,
    room: &RoomGeometryLive,
    border_off_at: Option<usize>,
) {
    match call {
        6 => live.update(0.6, true, 0.8, 1.3, None),
        10 => room.publish(Some(room_geometry(vec![placement(
            0,
            -0.2,
            0.5,
            Some(0.8),
        )]))),
        14 => live.store_color_order(LedColorOrder::Grb),
        18 => room.publish(Some(room_geometry(vec![
            placement(3, 0.9, 0.9, Some(-0.4)),
            placement(0, -1.0, -1.0, None),
        ]))),
        22 => live.update(1.0, true, 0.2, 0.7, Some(LightingSmoothingPreset::Intense)),
        26 => room.publish(None),
        _ => {}
    }
    if border_off_at == Some(call) {
        live.update(
            live.read_brightness(),
            false,
            live.read_smoothing_alpha(),
            live.read_saturation(),
            None,
        );
    }
}

#[derive(Default)]
struct RecordingSender {
    packets: Mutex<Vec<Vec<u8>>>,
}

impl LedPacketSender for RecordingSender {
    fn send(&self, _port_name: &str, packet: &[u8]) -> Result<(), LedOutputError> {
        self.packets
            .lock()
            .expect("packets lock")
            .push(packet.to_vec());
        Ok(())
    }

    fn disconnect_session(&self, _port_name: &str) {}
}

const PORT: &str = "perf-port";

// ---------------------------------------------------------------------------
// Reference: the worker loop body as it stood before the per-frame step was
// extracted, with I/O replaced by recording. It is the yardstick both the
// threaded worker and the extracted step are held to — change it only
// together with the worker, and say why.
// ---------------------------------------------------------------------------

/// Per-channel colours and the brightness they were sent with.
type HueSend = (Vec<(u8, u8, u8)>, f32);

struct ReferenceFrame {
    packet: Vec<u8>,
    /// Smoothed strip, before encoding.
    strip: Vec<[u8; 3]>,
    hue: Option<HueSend>,
}

struct ReferenceLoop {
    led_sequence: Vec<LedSequenceItem>,
    led_counts: LedSegmentCounts,
    sample_window: f32,
    scene_enabled: bool,
    scene: SceneAnalyzer,
    strip_topology: LightTopology,
    strip_scene_state: LightSetState,
    room_generation: u64,
    hue_table: HueSampleTable,
    hue_scene_state: LightSetState,
    hue_scene_scratch: Vec<[u8; 3]>,
    hue_channel_smoother: HueChannelSmoother,
    border_cache: BlackBorderCache,
    color_correction: ColorCorrectionConfig,
    frame_luts: std::borrow::Cow<'static, GammaLuts>,
    quality_state: AmbilightWorkerQualityState,
    frame_slot: RuntimeFrameSlot,
    sink: SerialSink,
    sent: Arc<RecordingSender>,
    hue_channels: Vec<HueAreaChannel>,
    room_geometry: Arc<RoomGeometryLive>,
}

impl ReferenceLoop {
    fn new(
        led_calibration: &LedCalibrationConfig,
        hue_channels: Vec<HueAreaChannel>,
        live_settings: &AmbilightLiveSettings,
        room_geometry: Arc<RoomGeometryLive>,
        profile: FirmwareProfile,
        chip_type: LedChipType,
    ) -> Self {
        let color_correction = color_correction();
        let usb_plan = Some(UsbOutputPlan::Serial(PORT.to_string()));
        let (quality_config, _) = resolve_quality_config(
            &usb_plan,
            led_calibration.total_leds,
            profile,
            chip_type,
            live_settings.read_smoothing_alpha(),
        );
        let sent = Arc::new(RecordingSender::default());
        let sink = SerialSink::with_chip_type(
            LedOutputBridge::from_sender(sent.clone()),
            Some(PORT.to_string()),
            live_settings.read_brightness(),
            profile,
            color_correction.clone(),
            chip_type,
        );
        let strip_topology = LightTopology::Chain {
            closed: {
                let cal = led_calibration;
                cal.counts.top > 0
                    && cal.counts.right > 0
                    && cal.counts.bottom > 0
                    && cal.counts.left > 0
                    && cal.bottom_missing == 0
            },
        };
        let (room_generation, initial_geometry) = room_geometry.snapshot();
        let hue_table = hue_sample_table(&hue_channels, initial_geometry.as_ref());
        Self {
            led_sequence: build_led_sequence(led_calibration),
            led_counts: led_calibration.counts.clone(),
            sample_window: LIVE_SAMPLE_WINDOW,
            scene_enabled: true,
            scene: SceneAnalyzer::new(),
            strip_topology,
            strip_scene_state: LightSetState::default(),
            room_generation,
            hue_table,
            hue_scene_state: LightSetState::default(),
            hue_scene_scratch: Vec::new(),
            hue_channel_smoother: HueChannelSmoother::new(),
            border_cache: BlackBorderCache::new(live_settings.read_black_border_detection()),
            frame_luts: gamma_luts_for(&color_correction),
            color_correction,
            quality_state: AmbilightWorkerQualityState::new(quality_config),
            frame_slot: RuntimeFrameSlot::new(),
            sink,
            sent,
            hue_channels,
            room_geometry,
        }
    }

    fn take_packet(&self) -> Vec<u8> {
        self.sent
            .packets
            .lock()
            .expect("packets lock")
            .pop()
            .expect("reference sink sent a packet")
    }

    /// `start_ambilight_worker` before it spawns: sample, queue, send once.
    fn warmup(&mut self, frame: &CapturedFrame, live_settings: &AmbilightLiveSettings) -> Vec<u8> {
        let initial_sampled = sample_frame_for_sequence(
            frame,
            &self.led_sequence,
            &self.led_counts,
            self.sample_window,
        );
        self.quality_state
            .queue_processed_frame(&mut self.frame_slot, initial_sampled.as_slice());
        self.sink.set_brightness(live_settings.read_brightness());
        self.sink.set_color_order(live_settings.read_color_order());
        let latest = self.frame_slot.take_latest().expect("queued warm-up frame");
        self.sink.send_frame(&latest).expect("reference send");
        self.take_packet()
    }

    fn frame(
        &mut self,
        raw_frame: &CapturedFrame,
        live_settings: &AmbilightLiveSettings,
    ) -> ReferenceFrame {
        let mut sampled = sample_frame_for_sequence(
            raw_frame,
            &self.led_sequence,
            &self.led_counts,
            self.sample_window,
        );
        self.border_cache
            .set_enabled(live_settings.read_black_border_detection());
        let brightness = live_settings.read_brightness();
        let color_order = live_settings.read_color_order();
        let saturation = live_settings.read_saturation();
        self.border_cache.update_if_due(raw_frame);
        let alpha_ceiling = live_settings.read_smoothing_alpha();
        let frame_alpha = if self.scene_enabled {
            self.scene
                .observe_frame(raw_frame, self.border_cache.insets(), alpha_ceiling);
            self.scene.process(
                &mut sampled,
                &self.strip_topology,
                &[],
                &mut self.strip_scene_state,
            );
            self.scene.alpha()
        } else {
            alpha_ceiling
        };
        self.quality_state.set_smoothing_alpha(frame_alpha);
        apply_saturation_inplace(&mut sampled, saturation);
        self.quality_state
            .queue_processed_frame(&mut self.frame_slot, sampled.as_slice());

        self.sink.set_brightness(brightness);
        self.sink.set_color_order(color_order);
        let latest = self.frame_slot.take_latest().expect("queued frame");
        self.sink.send_frame(&latest).expect("reference send");
        let packet = self.take_packet();

        let hue = if self.hue_channels.is_empty() {
            None
        } else {
            if self.room_geometry.generation() != self.room_generation {
                let (seen, geometry) = self.room_geometry.snapshot();
                self.room_generation = seen;
                self.hue_table = hue_sample_table(&self.hue_channels, geometry.as_ref());
            }
            self.hue_scene_scratch.clear();
            self.hue_scene_scratch
                .extend(
                    self.hue_table
                        .sample_points
                        .iter()
                        .map(|&(sample_x, sample_y)| {
                            let (r, g, b) = sample_screen_position_avg(
                                raw_frame,
                                sample_x,
                                sample_y,
                                self.border_cache.insets(),
                            );
                            [r, g, b]
                        }),
                );
            if self.scene_enabled {
                self.scene.process(
                    &mut self.hue_scene_scratch,
                    &self.hue_table.topology,
                    &self.hue_table.affinity,
                    &mut self.hue_scene_state,
                );
            }
            let raw_colors: Vec<(u8, u8, u8)> = self
                .hue_scene_scratch
                .iter()
                .map(|&[r, g, b]| {
                    apply_color_correction_rgb_with_luts(
                        (r, g, b),
                        &self.color_correction,
                        &self.frame_luts,
                    )
                })
                .collect();
            let smoothed = self.hue_channel_smoother.smooth(&raw_colors, frame_alpha);
            Some((smoothed.to_vec(), brightness))
        };

        ReferenceFrame {
            packet,
            strip: self.quality_state.last_smoothed().to_vec(),
            hue,
        }
    }
}

// ---------------------------------------------------------------------------
// The threaded worker against the reference
// ---------------------------------------------------------------------------

/// Serves `frames` in order, applying the script before each, then reports the
/// display as gone so the worker idles without producing more output.
struct ScriptedFrameSource {
    frames: Vec<Arc<CapturedFrame>>,
    next: usize,
    live: Arc<AmbilightLiveSettings>,
    room: Arc<RoomGeometryLive>,
}

impl AmbilightFrameSource for ScriptedFrameSource {
    fn capture_frame(&mut self) -> Result<Arc<CapturedFrame>, AmbilightCaptureError> {
        let Some(frame) = self.frames.get(self.next) else {
            return Err(AmbilightCaptureError::InvalidFrame(
                "AMBILIGHT_CAPTURE_MONITOR_NOT_FOUND",
            ));
        };
        apply_script(self.next, &self.live, &self.room, None);
        self.next += 1;
        Ok(Arc::clone(frame))
    }
}

fn reference_run(
    frames: &[Arc<CapturedFrame>],
    led_calibration: &LedCalibrationConfig,
    profile: FirmwareProfile,
    chip_type: LedChipType,
    border_off_at: Option<usize>,
) -> (Vec<u8>, Vec<ReferenceFrame>) {
    let live = live_settings();
    let room = RoomGeometryLive::new(None);
    apply_script(0, &live, &room, border_off_at);
    let mut reference = ReferenceLoop::new(
        led_calibration,
        hue_channels(),
        &live,
        Arc::clone(&room),
        profile,
        chip_type,
    );
    let warmup = reference.warmup(&frames[0], &live);
    let outputs = frames[1..]
        .iter()
        .enumerate()
        .map(|(i, frame)| {
            apply_script(i + 1, &live, &room, border_off_at);
            reference.frame(frame, &live)
        })
        .collect();
    (warmup, outputs)
}

/// Frames after the warm-up capture. Enough to cross every scripted event.
const LOOP_FRAMES: u32 = 30;

fn assert_worker_matches_reference(profile: FirmwareProfile, chip_type: LedChipType) {
    let _guard = WORKER_TEST_GUARD
        .lock()
        .unwrap_or_else(|err| err.into_inner());
    let calibration = strip_164();
    let frames = scene_frames(FRAME_W, FRAME_H, LOOP_FRAMES + 1);
    let (reference_warmup, reference) =
        reference_run(&frames, &calibration, profile, chip_type, None);

    let live = live_settings();
    let room = RoomGeometryLive::new(None);
    let sent = Arc::new(RecordingSender::default());
    let (tx, rx) = std::sync::mpsc::sync_channel::<HueColorUpdate>(256);
    let hue_output = HueActiveOutputContext {
        channels: hue_channels(),
        color_sender: HueColorSender {
            tx: Arc::new(tx),
            channel_count: 2,
        },
    };
    let runtime = start_ambilight_worker(
        LedOutputBridge::from_sender(sent.clone()),
        Some(UsbOutputPlan::Serial(PORT.to_string())),
        Some(calibration),
        Arc::clone(&live),
        Box::new(ScriptedFrameSource {
            frames: frames.clone(),
            next: 0,
            live: Arc::clone(&live),
            room: Arc::clone(&room),
        }),
        Arc::new(Mutex::new(RuntimeTelemetrySnapshot::default())),
        Some(hue_output),
        None,
        color_correction(),
        profile,
        chip_type,
        None,
        Arc::clone(&room),
    )
    .expect("worker starts");

    let mut hue_updates = Vec::new();
    let deadline = Instant::now() + Duration::from_secs(20);
    while hue_updates.len() < LOOP_FRAMES as usize && Instant::now() < deadline {
        if let Ok(update) = rx.recv_timeout(Duration::from_millis(100)) {
            hue_updates.push((update.channel_colors, update.brightness));
        }
    }
    runtime.stop();

    let expected_hue: Vec<_> = reference
        .iter()
        .map(|frame| frame.hue.clone().expect("hue output every frame"))
        .collect();
    assert_eq!(
        hue_updates, expected_hue,
        "every Hue update must match the reference frame for frame"
    );

    // Pacing decides which frames reach the wire, never what they contain: each
    // packet must be the reference packet of a later frame than the last one.
    let packets = sent.packets.lock().expect("packets lock").clone();
    assert!(packets.len() >= 3, "only {} packets sent", packets.len());
    assert_eq!(packets[0], reference_warmup, "warm-up packet");
    let mut expected = reference.iter().map(|frame| &frame.packet);
    for (n, packet) in packets[1..].iter().enumerate() {
        assert!(
            expected.any(|candidate| candidate == packet),
            "packet {} is not the reference packet of any later frame",
            n + 1
        );
    }
}

#[test]
fn worker_output_matches_reference_v1_sk6812() {
    assert_worker_matches_reference(FirmwareProfile::LumaSyncV1, LedChipType::Sk6812Rgbw);
}

#[test]
fn worker_output_matches_reference_adalight_ws2812b() {
    assert_worker_matches_reference(FirmwareProfile::Adalight, LedChipType::Ws2812bGrb);
}

// ---------------------------------------------------------------------------
// The extracted step, driven the way the worker drives it
// ---------------------------------------------------------------------------

/// `start_ambilight_worker` without the thread, the capture or the telemetry:
/// the same constructors, then per frame `sample_strip` → `process` → the
/// serial sink, in the worker's order.
struct PipelineRun {
    pipeline: AmbilightFramePipeline,
    quality_state: AmbilightWorkerQualityState,
    frame_slot: RuntimeFrameSlot,
    sink: SerialSink,
}

impl PipelineRun {
    fn new(
        led_calibration: &LedCalibrationConfig,
        live_settings: &AmbilightLiveSettings,
        room_geometry: Arc<RoomGeometryLive>,
        profile: FirmwareProfile,
        chip_type: LedChipType,
        bridge: LedOutputBridge,
    ) -> Self {
        let usb_plan = Some(UsbOutputPlan::Serial(PORT.to_string()));
        let (quality_config, _) = resolve_quality_config(
            &usb_plan,
            led_calibration.total_leds,
            profile,
            chip_type,
            live_settings.read_smoothing_alpha(),
        );
        let sink = SerialSink::with_chip_type(
            bridge,
            Some(PORT.to_string()),
            live_settings.read_brightness(),
            profile,
            color_correction(),
            chip_type,
        );
        let pipeline = AmbilightFramePipeline::new(FramePipelineConfig {
            led_sequence: build_led_sequence(led_calibration),
            led_counts: led_calibration.counts.clone(),
            sample_window: LIVE_SAMPLE_WINDOW,
            scene_enabled: true,
            strip_topology: strip_topology_for(Some(led_calibration)),
            hue_channels: Some(hue_channels()),
            room_geometry,
            black_border_detection: live_settings.read_black_border_detection(),
            color_correction: color_correction(),
        });
        Self {
            pipeline,
            quality_state: AmbilightWorkerQualityState::new(quality_config),
            frame_slot: RuntimeFrameSlot::new(),
            sink,
        }
    }

    fn send_latest(&mut self, brightness: f32, color_order: LedColorOrder) {
        self.sink.set_brightness(brightness);
        self.sink.set_color_order(color_order);
        if let Some(latest) = self.frame_slot.take_latest() {
            self.sink.send_frame(&latest).expect("send");
        }
    }

    fn warmup(&mut self, frame: &CapturedFrame, live_settings: &AmbilightLiveSettings) {
        let sampled = self.pipeline.sample_strip(frame);
        self.quality_state
            .queue_processed_frame(&mut self.frame_slot, sampled.as_slice());
        self.send_latest(
            live_settings.read_brightness(),
            live_settings.read_color_order(),
        );
    }

    fn frame(
        &mut self,
        raw_frame: &CapturedFrame,
        live_settings: &AmbilightLiveSettings,
    ) -> Option<&[(u8, u8, u8)]> {
        let sampled = self.pipeline.sample_strip(raw_frame);
        let brightness = live_settings.read_brightness();
        let color_order = live_settings.read_color_order();
        let settings = FrameSettings {
            black_border_detection: live_settings.read_black_border_detection(),
            alpha_ceiling: live_settings.read_smoothing_alpha(),
            saturation: live_settings.read_saturation(),
        };
        let step = self.pipeline.process(
            raw_frame,
            sampled,
            settings,
            &mut self.quality_state,
            &mut self.frame_slot,
        );
        self.sink.set_brightness(brightness);
        self.sink.set_color_order(color_order);
        if let Some(latest) = self.frame_slot.take_latest() {
            self.sink.send_frame(&latest).expect("send");
        }
        step.hue_colors
    }
}

fn assert_step_matches_reference(
    led_calibration: &LedCalibrationConfig,
    frames: &[Arc<CapturedFrame>],
    profile: FirmwareProfile,
    chip_type: LedChipType,
) {
    const BORDER_OFF_AT: usize = 28;
    let (reference_warmup, reference) = reference_run(
        frames,
        led_calibration,
        profile,
        chip_type,
        Some(BORDER_OFF_AT),
    );

    let live = live_settings();
    let room = RoomGeometryLive::new(None);
    apply_script(0, &live, &room, Some(BORDER_OFF_AT));
    let sent = Arc::new(RecordingSender::default());
    let mut run = PipelineRun::new(
        led_calibration,
        &live,
        Arc::clone(&room),
        profile,
        chip_type,
        LedOutputBridge::from_sender(sent.clone()),
    );
    let pop = || sent.packets.lock().expect("packets lock").pop();
    run.warmup(&frames[0], &live);
    assert_eq!(pop(), Some(reference_warmup), "warm-up packet");
    for (i, (frame, expected)) in frames[1..].iter().zip(&reference).enumerate() {
        let n = i + 1;
        apply_script(n, &live, &room, Some(BORDER_OFF_AT));
        let hue = run
            .frame(frame, &live)
            .map(|colors| (colors.to_vec(), live.read_brightness()));
        assert_eq!(
            hue, expected.hue,
            "Hue colours, frame {n} ({profile:?}/{chip_type:?})"
        );
        assert_eq!(
            run.quality_state.last_smoothed(),
            expected.strip.as_slice(),
            "smoothed strip, frame {n} ({profile:?}/{chip_type:?})"
        );
        assert_eq!(
            pop().as_ref(),
            Some(&expected.packet),
            "serial packet, frame {n} ({profile:?}/{chip_type:?})"
        );
    }
}

#[test]
fn extracted_step_matches_reference_164_leds_640x360() {
    let frames = scene_frames(FRAME_W, FRAME_H, LOOP_FRAMES + 1);
    for (profile, chip_type) in WIRE_COMBOS {
        assert_step_matches_reference(&strip_164(), &frames, profile, chip_type);
    }
}

#[test]
fn extracted_step_matches_reference_300_leds_640x400() {
    let frames = scene_frames(640, 400, LOOP_FRAMES + 1);
    for (profile, chip_type) in WIRE_COMBOS {
        assert_step_matches_reference(&strip_300(), &frames, profile, chip_type);
    }
}

// ---------------------------------------------------------------------------
// Frame-budget guard. Wall-clock time on a shared CI runner is noise, so this
// counts what a regression adds instead: heap allocations, the bytes they ask
// for, and LUT tabulations. All three are deterministic.
// ---------------------------------------------------------------------------

mod alloc_count {
    use std::alloc::{GlobalAlloc, Layout, System};
    use std::cell::Cell;

    /// Counts only on a thread inside `measure`; every other test in the
    /// binary pays one thread-local read per allocation and nothing else.
    pub struct CountingAllocator;

    thread_local! {
        static ACTIVE: Cell<bool> = const { Cell::new(false) };
        static COUNT: Cell<usize> = const { Cell::new(0) };
        static BYTES: Cell<usize> = const { Cell::new(0) };
    }

    fn record(bytes: usize) {
        let _ = ACTIVE.try_with(|active| {
            if active.get() {
                COUNT.with(|count| count.set(count.get() + 1));
                BYTES.with(|total| total.set(total.get() + bytes));
            }
        });
    }

    unsafe impl GlobalAlloc for CountingAllocator {
        unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
            record(layout.size());
            unsafe { System.alloc(layout) }
        }

        unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
            record(layout.size());
            unsafe { System.alloc_zeroed(layout) }
        }

        unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
            record(new_size);
            unsafe { System.realloc(ptr, layout, new_size) }
        }

        unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
            unsafe { System.dealloc(ptr, layout) }
        }
    }

    /// (allocations, bytes requested) made by `f` on this thread.
    pub fn measure(f: impl FnOnce()) -> (usize, usize) {
        COUNT.with(|count| count.set(0));
        BYTES.with(|total| total.set(0));
        ACTIVE.with(|active| active.set(true));
        f();
        ACTIVE.with(|active| active.set(false));
        (COUNT.with(Cell::get), BYTES.with(Cell::get))
    }
}

#[global_allocator]
static COUNTING_ALLOCATOR: alloc_count::CountingAllocator = alloc_count::CountingAllocator;

/// What one steady-state frame may allocate: the sampled strip, the smoothed
/// strip queued for the sink, and the encoded packet. The Hue path, the scene
/// stage and the border cache reuse their buffers and add nothing.
const ALLOCS_PER_FRAME: usize = 3;

/// Accepts the packet without keeping it, so the sink costs only its encode.
struct NullSender;

impl LedPacketSender for NullSender {
    fn send(&self, _port_name: &str, packet: &[u8]) -> Result<(), LedOutputError> {
        std::hint::black_box(packet);
        Ok(())
    }

    fn disconnect_session(&self, _port_name: &str) {}
}

fn lut_builds() -> (usize, usize) {
    (
        crate::commands::led_output::gamma_lut_builds_on_this_thread(),
        crate::commands::ambilight_scene::srgb_lut_builds_on_this_thread(),
    )
}

fn assert_steady_frames_within_budget(
    led_calibration: &LedCalibrationConfig,
    (width, height): (u32, u32),
    profile: FirmwareProfile,
    chip_type: LedChipType,
) {
    const WARM_FRAMES: usize = 8;
    let frames = scene_frames(width, height, 40);
    let live = live_settings();
    let room = RoomGeometryLive::new(Some(room_geometry(vec![placement(
        0,
        -0.2,
        0.5,
        Some(0.8),
    )])));

    let before_construction = lut_builds();
    let mut run = PipelineRun::new(
        led_calibration,
        &live,
        room,
        profile,
        chip_type,
        LedOutputBridge::from_sender(Arc::new(NullSender)),
    );
    let after_construction = lut_builds();
    assert!(
        after_construction.0 > before_construction.0
            && after_construction.1 > before_construction.1,
        "construction must register its own LUT builds, or the zero below proves nothing"
    );

    // Past the first border detection, the first two (logged) scene frames and
    // the growth of every scratch buffer.
    run.warmup(&frames[0], &live);
    for frame in &frames[1..WARM_FRAMES] {
        run.frame(frame, &live);
    }

    let leds = usize::from(led_calibration.total_leds);
    let packet_bytes = leds * WirePixelLayout::for_output(profile, chip_type).bytes_per_pixel() + 6;
    let max_bytes = 2 * leds * 3 + packet_bytes;
    let before_steady = lut_builds();
    for (n, frame) in frames[WARM_FRAMES..].iter().enumerate() {
        let (allocs, bytes) = alloc_count::measure(|| {
            std::hint::black_box(run.frame(frame, &live));
        });
        assert!(
            allocs <= ALLOCS_PER_FRAME && bytes <= max_bytes,
            "steady frame {n} ({leds} LEDs, {profile:?}/{chip_type:?}) made {allocs} \
             allocations / {bytes} bytes; the budget is {ALLOCS_PER_FRAME} / {max_bytes}"
        );
    }
    assert_eq!(
        lut_builds(),
        before_steady,
        "a steady frame tabulated a gamma or sRGB LUT; build it once per worker"
    );
}

#[test]
fn steady_frame_allocations_and_lut_builds_stay_within_budget() {
    assert_steady_frames_within_budget(
        &strip_164(),
        (FRAME_W, FRAME_H),
        FirmwareProfile::LumaSyncV1,
        LedChipType::Ws2812bGrb,
    );
    assert_steady_frames_within_budget(
        &strip_300(),
        (640, 400),
        FirmwareProfile::LumaSyncV1,
        LedChipType::Sk6812Rgbw,
    );
    assert_steady_frames_within_budget(
        &strip_300(),
        (640, 400),
        FirmwareProfile::Adalight,
        LedChipType::Ws2812bGrb,
    );
}

// ---------------------------------------------------------------------------
// Timing report — local only. Run it in release for numbers worth quoting:
//   cargo test --release --lib frame_budget_report -- --ignored --nocapture
// ---------------------------------------------------------------------------

struct Timing {
    median_us: f64,
    p95_us: f64,
    mean_us: f64,
}

fn time_calls(iterations: usize, mut call: impl FnMut(usize)) -> Timing {
    for i in 0..iterations / 10 {
        call(i);
    }
    let mut samples: Vec<f64> = (0..iterations)
        .map(|i| {
            let started = Instant::now();
            call(i);
            started.elapsed().as_secs_f64() * 1e6
        })
        .collect();
    samples.sort_by(f64::total_cmp);
    Timing {
        median_us: samples[samples.len() / 2],
        p95_us: samples[samples.len() * 95 / 100],
        mean_us: samples.iter().sum::<f64>() / samples.len() as f64,
    }
}

fn print_timing(label: &str, timing: &Timing) {
    println!(
        "  {label:<44} {:>9.1} {:>9.1} {:>9.1}",
        timing.median_us, timing.p95_us, timing.mean_us
    );
}

fn report_scenario(
    led_calibration: &LedCalibrationConfig,
    (width, height): (u32, u32),
    profile: FirmwareProfile,
    chip_type: LedChipType,
) {
    const ITERATIONS: usize = 2000;
    let frames = scene_frames(width, height, 48);
    let frame_at = |i: usize| frames[i % frames.len()].as_ref();
    let live = live_settings();
    let geometry = room_geometry(vec![placement(0, -0.2, 0.5, Some(0.8))]);
    let room = RoomGeometryLive::new(Some(geometry.clone()));
    let leds = led_calibration.total_leds;
    println!(
        "\n{leds} LEDs + 2 Hue channels (room-aware), {width}x{height}, {profile:?}/{chip_type:?} [{}]",
        if cfg!(debug_assertions) { "debug" } else { "release" }
    );
    println!(
        "  {:<44} {:>9} {:>9} {:>9}",
        "stage (µs per frame)", "median", "p95", "mean"
    );

    let mut run = PipelineRun::new(
        led_calibration,
        &live,
        room,
        profile,
        chip_type,
        LedOutputBridge::from_sender(Arc::new(NullSender)),
    );
    run.warmup(frame_at(0), &live);
    let full = time_calls(ITERATIONS, |i| {
        std::hint::black_box(run.frame(frame_at(i + 1), &live));
    });
    print_timing("whole step (sample, process, encode)", &full);

    let sequence = build_led_sequence(led_calibration);
    print_timing(
        "  strip sampling",
        &time_calls(ITERATIONS, |i| {
            std::hint::black_box(sample_frame_for_sequence(
                frame_at(i),
                &sequence,
                &led_calibration.counts,
                LIVE_SAMPLE_WINDOW,
            ));
        }),
    );
    print_timing(
        "  black-border detection (every 2.5 s)",
        &time_calls(ITERATIONS, |i| {
            std::hint::black_box(detect_black_borders(frame_at(i), BLACK_BORDER_THRESHOLD));
        }),
    );
    let insets = detect_black_borders(frame_at(0), BLACK_BORDER_THRESHOLD);
    let mut scene = SceneAnalyzer::new();
    print_timing(
        "  scene: frame histogram + mean",
        &time_calls(ITERATIONS, |i| {
            scene.observe_frame(frame_at(i), &insets, 0.35);
        }),
    );
    let sampled = sample_frame_for_sequence(
        frame_at(0),
        &sequence,
        &led_calibration.counts,
        LIVE_SAMPLE_WINDOW,
    );
    let topology = strip_topology_for(Some(led_calibration));
    let mut strip_state = LightSetState::default();
    let mut colors = sampled.clone();
    print_timing(
        "  scene: strip coherence + ambience",
        &time_calls(ITERATIONS, |_| {
            colors.copy_from_slice(&sampled);
            scene.process(&mut colors, &topology, &[], &mut strip_state);
        }),
    );
    let table = hue_sample_table(&hue_channels(), Some(&geometry));
    print_timing(
        "  Hue sampling (room-aware sample points)",
        &time_calls(ITERATIONS, |i| {
            for &(x, y) in &table.sample_points {
                std::hint::black_box(sample_screen_position_avg(frame_at(i), x, y, &insets));
            }
        }),
    );
    let mut quality = AmbilightWorkerQualityState::new(RuntimeQualityConfig::default());
    let mut slot = RuntimeFrameSlot::new();
    print_timing(
        "  strip smoothing",
        &time_calls(ITERATIONS, |_| {
            quality.queue_processed_frame(&mut slot, &sampled);
        }),
    );
    let plan = EncoderPlan::new(&color_correction());
    for (combo_profile, combo_chip) in WIRE_COMBOS {
        print_timing(
            &format!("  encode {combo_profile:?}/{combo_chip:?}"),
            &time_calls(ITERATIONS, |_| {
                std::hint::black_box(encode_packet_for_output(
                    combo_profile,
                    combo_chip,
                    0.8,
                    &sampled,
                    &plan,
                ));
            }),
        );
    }
    println!(
        "  whole step, median: {:.3}% of a 16.7 ms (60 Hz) frame, {:.3}% of 50 ms (20 Hz capture)",
        full.median_us / 16_667.0 * 100.0,
        full.median_us / 50_000.0 * 100.0
    );
}

#[test]
#[ignore = "timing report, not a check; see docs/architecture/capture-and-pipeline.md"]
fn frame_budget_report() {
    report_scenario(
        &strip_164(),
        (FRAME_W, FRAME_H),
        FirmwareProfile::LumaSyncV1,
        LedChipType::Ws2812bGrb,
    );
    report_scenario(
        &strip_300(),
        (640, 400),
        FirmwareProfile::LumaSyncV1,
        LedChipType::Sk6812Rgbw,
    );
}
