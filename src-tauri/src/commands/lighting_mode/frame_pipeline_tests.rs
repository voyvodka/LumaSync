//! Equivalence, allocation and cost checks for the ambilight worker's per-frame
//! step. See docs/architecture/capture-and-pipeline.md, "Measuring the frame
//! budget".

use std::sync::atomic::AtomicU32;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use super::frame_pipeline::{
    strip_topology_for, AmbilightFramePipeline, FramePipelineConfig, FrameSettings,
};
use super::smoothing::{alpha_for_interval, TimeSmoother, SMOOTHING_REFERENCE_INTERVAL};
use super::worker::WorkerPacing;
use super::*;
use crate::commands::ambilight_capture::AmbilightCaptureError;
use crate::commands::ambilight_scene::{LightSetState, SceneAnalyzer};
use crate::commands::hue::frame::{HueAreaChannel, HueColorSender, HueRgb, HueScreenRegion};
use crate::commands::hue::state_store::{
    HueActiveOutputContext, HueChannelPlacementOverride, HueOutputLive,
};
use crate::commands::led_calibration::{
    build_led_sequence, sample_frame_for_sequence, sample_frame_within_insets, LedSegment,
    LedSegmentCounts, LedSequenceItem,
};
use crate::commands::led_output::{apply_saturation_to_pixel, LedOutputError, LedPacketSender};
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
    CapturedFrame::new(width, height, pixels_rgb)
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
// Reference: the worker's per-frame glue written out inline, with I/O replaced
// by recording and time fixed at one frame per `FRAME_GAP`. It is the
// yardstick both the threaded worker and the extracted step are held to —
// change it only together with the worker, and say why. Changed since the
// extraction: the strip samples inside the black-border insets; smoothing is
// time-based and runs on the smoothed-then-corrected order for every sink,
// live saturation reaches Hue, and Hue keeps 16-bit precision (review items
// 17 and 27, docs/architecture/capture-and-pipeline.md).
// ---------------------------------------------------------------------------

/// Time between analysed frames in the lock-step runs: the reference
/// cadence, so the scene stage's per-frame rates are exactly the tuned ones.
const FRAME_GAP: Duration = SMOOTHING_REFERENCE_INTERVAL;

/// Per-channel colours and the brightness they were sent with.
type HueSend = (Vec<HueRgb>, f32);

struct ReferenceFrame {
    packet: Vec<u8>,
    /// Smoothed strip, before encoding.
    strip: Vec<[u8; 3]>,
    hue: Option<HueSend>,
}

/// `state += k · (target − state)` per channel.
fn reference_step(state: &mut [[f32; 3]], target: &[[f32; 3]], k: f32) {
    for (s, t) in state.iter_mut().zip(target) {
        for c in 0..3 {
            s[c] += k * (t[c] - s[c]);
        }
    }
}

fn reference_saturate(colors: &mut [[u8; 3]], saturation: f32) {
    for pixel in colors.iter_mut() {
        let saturated = apply_saturation_to_pixel(*pixel, saturation);
        pixel.copy_from_slice(&saturated);
    }
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
    border_cache: BlackBorderCache,
    plan: EncoderPlan,
    frame_alpha: f32,
    strip_state: Vec<[f32; 3]>,
    strip_target: Vec<[f32; 3]>,
    hue_state: Vec<[f32; 3]>,
    hue_target: Vec<[f32; 3]>,
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
            border_cache: BlackBorderCache::new(live_settings.read_black_border_detection()),
            plan: EncoderPlan::new(&color_correction),
            frame_alpha: 1.0,
            strip_state: Vec::new(),
            strip_target: Vec::new(),
            hue_state: Vec::new(),
            hue_target: Vec::new(),
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

    /// `start_ambilight_worker` before it spawns: sample, send once, and the
    /// strip smoother starts from it.
    fn warmup(&mut self, frame: &CapturedFrame, live_settings: &AmbilightLiveSettings) -> Vec<u8> {
        let initial_sampled = sample_frame_for_sequence(
            frame,
            &self.led_sequence,
            &self.led_counts,
            self.sample_window,
        );
        self.strip_state = initial_sampled.iter().map(|c| c.map(f32::from)).collect();
        self.strip_target = self.strip_state.clone();
        self.sink.set_brightness(live_settings.read_brightness());
        self.sink.set_color_order(live_settings.read_color_order());
        self.sink
            .send_frame(&initial_sampled)
            .expect("reference send");
        self.take_packet()
    }

    /// One frame, `FRAME_GAP` after the previous one.
    fn frame(
        &mut self,
        raw_frame: &CapturedFrame,
        live_settings: &AmbilightLiveSettings,
    ) -> ReferenceFrame {
        self.border_cache.update_if_due(raw_frame);
        let mut sampled = sample_frame_within_insets(
            raw_frame,
            &self.led_sequence,
            &self.led_counts,
            self.sample_window,
            self.border_cache.insets(),
        );
        self.border_cache
            .set_enabled(live_settings.read_black_border_detection());
        let brightness = live_settings.read_brightness();
        let color_order = live_settings.read_color_order();
        let saturation = live_settings.read_saturation();
        let alpha_ceiling = live_settings.read_smoothing_alpha();

        // The gap since the previous frame, under the previous frame's targets.
        let k = alpha_for_interval(self.frame_alpha, FRAME_GAP);
        reference_step(&mut self.strip_state, &self.strip_target, k);
        reference_step(&mut self.hue_state, &self.hue_target, k);

        self.frame_alpha = if self.scene_enabled {
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
        reference_saturate(&mut sampled, saturation);
        self.strip_target = sampled.iter().map(|c| c.map(f32::from)).collect();

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
            reference_saturate(&mut self.hue_scene_scratch, saturation);
            self.hue_target = self
                .hue_scene_scratch
                .iter()
                .map(|c| c.map(f32::from))
                .collect();
            if self.hue_state.len() != self.hue_target.len() {
                self.hue_state = self.hue_target.clone();
            }
            let colors = self
                .hue_state
                .iter()
                .map(|&rgb| self.plan.correct_precise(rgb))
                .collect();
            Some((colors, brightness))
        };

        let strip: Vec<[u8; 3]> = self
            .strip_state
            .iter()
            .map(|c| c.map(|v| v.round().clamp(0.0, 255.0) as u8))
            .collect();
        self.sink.set_brightness(brightness);
        self.sink.set_color_order(color_order);
        self.sink.send_frame(&strip).expect("reference send");
        let packet = self.take_packet();

        ReferenceFrame { packet, strip, hue }
    }
}

// ---------------------------------------------------------------------------
// The threaded worker against the reference
// ---------------------------------------------------------------------------

/// Serves `frames` in order, applying the script before each, then reports the
/// display as gone so the worker idles without producing more output. Each
/// frame served moves the worker's smoothing clock on by `FRAME_GAP`, so the
/// threaded run smooths exactly as the lock-step reference does however its
/// output steps fall.
struct ScriptedFrameSource {
    frames: Vec<Arc<CapturedFrame>>,
    next: usize,
    live: Arc<AmbilightLiveSettings>,
    room: Arc<RoomGeometryLive>,
    served: Arc<AtomicU32>,
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
        self.served.fetch_add(1, Ordering::SeqCst);
        Ok(Arc::clone(frame))
    }
}

/// A smoothing clock that reads one `FRAME_GAP` per frame served. Frames are
/// polled slower than the slowest strip's send gate (SK6812, 164 LEDs: 58 ms),
/// so most of them reach the wire and the packet check below has teeth.
fn scripted_clock(served: &Arc<AtomicU32>) -> WorkerPacing {
    let base = Instant::now();
    let served = Arc::clone(served);
    WorkerPacing {
        capture_interval: Duration::from_millis(70),
        clock: Arc::new(move || base + FRAME_GAP * served.load(Ordering::SeqCst)),
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

/// The worker also steps its outputs between frames; with the smoothing
/// clock standing still there, those repeat the last value.
fn without_repeats<T: PartialEq>(mut items: Vec<T>) -> Vec<T> {
    items.dedup();
    items
}

fn assert_worker_matches_reference(profile: FirmwareProfile, chip_type: LedChipType) {
    let _watchdog = Watchdog::arm("worker_output_matches_reference", Duration::from_secs(90));
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
    let (color_sender, rx) = HueColorSender::recording(2);
    let hue_output = HueOutputLive::holding(HueActiveOutputContext {
        channels: hue_channels(),
        color_sender,
    });
    let served = Arc::new(AtomicU32::new(0));
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
            served: Arc::clone(&served),
        }),
        Arc::new(Mutex::new(RuntimeTelemetrySnapshot::default())),
        Some(hue_output),
        None,
        color_correction(),
        profile,
        chip_type,
        None,
        Arc::clone(&room),
        scripted_clock(&served),
    )
    .expect("worker starts");

    let expected_hue: Vec<HueSend> = without_repeats(
        reference
            .iter()
            .map(|frame| frame.hue.clone().expect("hue output every frame"))
            .collect(),
    );
    let mut hue_updates = Vec::new();
    let deadline = Instant::now() + Duration::from_secs(20);
    while Instant::now() < deadline {
        if let Ok(update) = rx.recv_timeout(Duration::from_millis(100)) {
            hue_updates.push((update.channel_colors, update.brightness));
            if without_repeats(hue_updates.clone()).len() >= expected_hue.len() {
                break;
            }
        }
    }
    runtime.stop();

    assert_eq!(
        without_repeats(hue_updates),
        expected_hue,
        "every Hue update must match the reference frame for frame"
    );

    // Pacing decides which frames reach the wire, never what they contain: each
    // packet must be the reference packet of a later frame than the last one.
    let packets = without_repeats(sent.packets.lock().expect("packets lock").clone());
    assert!(packets.len() >= 10, "only {} packets sent", packets.len());
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
/// the same constructors, then per frame `sample_strip` → `analyze` →
/// `advance` → the serial sink, in the worker's order, one `FRAME_GAP` apart.
struct PipelineRun {
    pipeline: AmbilightFramePipeline,
    led_sequence: Vec<LedSequenceItem>,
    led_counts: LedSegmentCounts,
    sink: SerialSink,
    now: Instant,
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
        let sink = SerialSink::with_chip_type(
            bridge,
            Some(PORT.to_string()),
            live_settings.read_brightness(),
            profile,
            color_correction(),
            chip_type,
        );
        let led_sequence = build_led_sequence(led_calibration);
        let pipeline = AmbilightFramePipeline::new(FramePipelineConfig {
            led_sequence: led_sequence.clone(),
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
            led_sequence,
            led_counts: led_calibration.counts.clone(),
            sink,
            now: Instant::now(),
        }
    }

    fn send(&mut self, live_settings: &AmbilightLiveSettings) {
        self.sink.set_brightness(live_settings.read_brightness());
        self.sink.set_color_order(live_settings.read_color_order());
        self.sink
            .send_frame(self.pipeline.strip_frame())
            .expect("send");
    }

    /// The worker samples its warm-up frame before the pipeline exists, so
    /// uncropped and without touching the border cache.
    fn warmup(&mut self, frame: &CapturedFrame, live_settings: &AmbilightLiveSettings) {
        let sampled = sample_frame_for_sequence(
            frame,
            &self.led_sequence,
            &self.led_counts,
            LIVE_SAMPLE_WINDOW,
        );
        self.pipeline.seed_strip(&sampled, self.now);
        self.send(live_settings);
    }

    fn frame(
        &mut self,
        raw_frame: &CapturedFrame,
        live_settings: &AmbilightLiveSettings,
    ) -> Option<&[HueRgb]> {
        self.now += FRAME_GAP;
        let sampled = self.pipeline.sample_strip(raw_frame);
        let settings = FrameSettings {
            black_border_detection: live_settings.read_black_border_detection(),
            alpha_ceiling: live_settings.read_smoothing_alpha(),
            saturation: live_settings.read_saturation(),
        };
        self.pipeline
            .analyze(raw_frame, sampled, settings, self.now);
        self.pipeline.advance(self.now);
        self.send(live_settings);
        self.pipeline.hue_colors()
    }

    /// An output step with no new frame, `dt` after the last one.
    fn tick(&mut self, dt: Duration, live_settings: &AmbilightLiveSettings) {
        self.now += dt;
        self.pipeline.advance(self.now);
        self.send(live_settings);
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
            run.pipeline.strip_frame(),
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
// Review item 17: one frame, analysed once; outputs that do not depend on how
// often they are stepped
// ---------------------------------------------------------------------------

/// A strip and Hue fed frames at 20 Hz must show the same colours at the same
/// moments whether the outputs are stepped at 20, 25 or 60 Hz — the strip-on
/// and Hue-only cadences used to give one preset two different speeds.
#[test]
fn outputs_are_the_same_whatever_the_output_rate() {
    let frames = scene_frames(FRAME_W, FRAME_H, 13);
    let calibration = strip_164();
    let frame_gap = Duration::from_millis(50);
    let checkpoint_gap = Duration::from_millis(200);
    let end = Duration::from_millis(600);
    let settings = FrameSettings {
        black_border_detection: true,
        alpha_ceiling: 0.35,
        saturation: 1.0,
    };
    // Frames, output steps and checkpoints merged in time order, as the
    // worker meets them.
    let run_at = |tick: Duration| -> Vec<(Vec<[f32; 3]>, Vec<HueRgb>)> {
        let live = live_settings();
        let mut run = PipelineRun::new(
            &calibration,
            &live,
            RoomGeometryLive::new(None),
            FirmwareProfile::LumaSyncV1,
            LedChipType::Ws2812bGrb,
            LedOutputBridge::from_sender(Arc::new(NullSender)),
        );
        let start = run.now;
        run.warmup(&frames[0], &live);
        let mut checkpoints = Vec::new();
        let (mut next_frame, mut next_tick, mut next_checkpoint) = (1usize, tick, checkpoint_gap);
        loop {
            let frame_at = (next_frame < frames.len()).then(|| frame_gap * next_frame as u32);
            let at = [frame_at, Some(next_tick), Some(next_checkpoint)]
                .into_iter()
                .flatten()
                .min()
                .expect("an event");
            if at > end {
                break;
            }
            let now = start + at;
            if frame_at == Some(at) {
                let frame = &frames[next_frame];
                let sampled = run.pipeline.sample_strip(frame);
                run.pipeline.analyze(frame, sampled, settings, now);
                next_frame += 1;
            }
            run.pipeline.advance(now);
            if next_tick == at {
                next_tick += tick;
            }
            if next_checkpoint == at {
                checkpoints.push((
                    run.pipeline.strip_state().to_vec(),
                    run.pipeline.hue_colors().expect("hue colours").to_vec(),
                ));
                next_checkpoint += checkpoint_gap;
            }
        }
        checkpoints
    };
    let at_20 = run_at(Duration::from_millis(50));
    assert_eq!(at_20.len(), 3);
    for (label, tick) in [
        ("25 Hz", Duration::from_millis(40)),
        ("60 Hz", Duration::from_nanos(16_666_667)),
    ] {
        let other = run_at(tick);
        assert_eq!(other.len(), at_20.len(), "{label}: checkpoints");
        for ((strip_a, hue_a), (strip_b, hue_b)) in at_20.iter().zip(&other) {
            for (a, b) in strip_a.iter().flatten().zip(strip_b.iter().flatten()) {
                assert!((a - b).abs() < 0.05, "{label}: strip {a} vs {b}");
            }
            for (a, b) in hue_a.iter().flatten().zip(hue_b.iter().flatten()) {
                assert!((a - b).abs() < 1e-4, "{label}: hue {a} vs {b}");
            }
        }
    }
}

/// Serves one and the same frame on every call, and counts the calls.
struct StillScreen {
    frame: Arc<CapturedFrame>,
    calls: Arc<AtomicUsize>,
}

impl AmbilightFrameSource for StillScreen {
    fn capture_frame(&mut self) -> Result<Arc<CapturedFrame>, AmbilightCaptureError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        Ok(Arc::clone(&self.frame))
    }
}

/// Review item 17: the worker used to re-run the whole step on whatever frame
/// the source still held, several times per captured frame, and telemetry
/// counted each pass as a captured frame. A frame is analysed once: a still
/// screen polled a hundred times is two captures in the first window — the
/// warm-up and the one analysis — not a hundred.
#[test]
fn a_frame_is_analysed_once_however_often_the_worker_looks() {
    let _watchdog = Watchdog::arm(
        "a_frame_is_analysed_once_however_often_the_worker_looks",
        Duration::from_secs(60),
    );
    let _guard = WORKER_TEST_GUARD
        .lock()
        .unwrap_or_else(|err| err.into_inner());
    let calls = Arc::new(AtomicUsize::new(0));
    let telemetry = Arc::new(Mutex::new(RuntimeTelemetrySnapshot::default()));
    let (color_sender, hue_updates) = HueColorSender::recording(2);
    let runtime = start_ambilight_worker(
        LedOutputBridge::from_sender(Arc::new(NullSender)),
        Some(UsbOutputPlan::Serial(PORT.to_string())),
        Some(strip_164()),
        live_settings(),
        Box::new(StillScreen {
            frame: Arc::new(scene_frame(FRAME_W, FRAME_H, 0)),
            calls: Arc::clone(&calls),
        }),
        Arc::clone(&telemetry),
        Some(HueOutputLive::holding(HueActiveOutputContext {
            channels: hue_channels(),
            color_sender,
        })),
        None,
        color_correction(),
        FirmwareProfile::LumaSyncV1,
        LedChipType::Ws2812bGrb,
        None,
        RoomGeometryLive::new(None),
        WorkerPacing::live(Duration::from_millis(2)),
    )
    .expect("worker starts");

    let deadline = Instant::now() + Duration::from_secs(10);
    let flushed = loop {
        let snapshot = telemetry.lock().expect("telemetry").clone();
        if snapshot.send_fps > 0.0 {
            break snapshot;
        }
        assert!(Instant::now() < deadline, "telemetry never flushed");
        thread::sleep(Duration::from_millis(20));
    };
    runtime.stop();

    let polled = calls.load(Ordering::SeqCst);
    assert!(polled >= 50, "the source was only polled {polled} times");
    assert!(
        flushed.capture_fps <= 2.0,
        "a still screen reported {} captured frames per second over {polled} polls",
        flushed.capture_fps
    );
    // The outputs kept stepping on the one frame: the strip is resent and Hue
    // keeps its newest target on hand.
    assert!(flushed.send_fps >= 10.0, "send fps {}", flushed.send_fps);
    assert!(hue_updates.try_iter().count() >= 10);
}

/// A push source wakes the worker when its callback publishes, instead of the
/// worker sleeping a fixed interval and re-reading the slot.
#[test]
fn a_published_frame_wakes_a_waiting_reader_at_once() {
    let latest = crate::commands::ambilight_capture::LatestFrame::new();
    latest.publish(CapturedFrame::new(1, 1, vec![[0, 0, 0]]));
    let seen = latest.latest().expect("frame").seq;
    assert!(
        !latest.wait_newer(seen, Duration::from_millis(5)),
        "nothing newer yet"
    );

    let publisher = Arc::clone(&latest);
    let started = Instant::now();
    let handle = thread::spawn(move || {
        thread::sleep(Duration::from_millis(20));
        publisher.publish(CapturedFrame::new(1, 1, vec![[9, 9, 9]]));
    });
    assert!(latest.wait_newer(seen, Duration::from_secs(10)));
    assert!(
        started.elapsed() < Duration::from_secs(5),
        "woke on the timeout, not on the publish"
    );
    handle.join().expect("publisher");
    assert_eq!(latest.latest().expect("frame").pixels_rgb, vec![[9, 9, 9]]);
}

// ---------------------------------------------------------------------------
// Black-border crop on the strip
// ---------------------------------------------------------------------------

const PICTURE_TOP: [u8; 3] = [200, 40, 40];
const PICTURE_MIDDLE: [u8; 3] = [60, 160, 60];
const PICTURE_BOTTOM: [u8; 3] = [40, 40, 200];

/// A 2.39:1 picture letterboxed into a 640×360 frame — 46-row bars — whose
/// top quarter is red and bottom quarter blue. A top LED that samples the
/// picture reads red; one that samples the bar reads black.
fn letterboxed_frame() -> CapturedFrame {
    let (w, h) = (FRAME_W as usize, FRAME_H as usize);
    let picture_h = (w as f32 / 2.39).round() as usize;
    let bar = (h - picture_h) / 2;
    let band = picture_h / 4;
    let mut pixels_rgb = Vec::with_capacity(w * h);
    for y in 0..h {
        let pixel = if y < bar || y >= h - bar {
            [0, 0, 0]
        } else if y < bar + band {
            PICTURE_TOP
        } else if y >= h - bar - band {
            PICTURE_BOTTOM
        } else {
            PICTURE_MIDDLE
        };
        pixels_rgb.extend(std::iter::repeat_n(pixel, w));
    }
    CapturedFrame::new(FRAME_W, FRAME_H, pixels_rgb)
}

/// The strip colours the pipeline hands the sink on its first frame. Scene
/// stage off and alpha 1.0, so they are the samples themselves.
fn first_strip_frame(
    led_calibration: &LedCalibrationConfig,
    black_border_detection: bool,
    frame: &CapturedFrame,
) -> Vec<[u8; 3]> {
    let mut pipeline = AmbilightFramePipeline::new(FramePipelineConfig {
        led_sequence: build_led_sequence(led_calibration),
        led_counts: led_calibration.counts.clone(),
        sample_window: LIVE_SAMPLE_WINDOW,
        scene_enabled: false,
        strip_topology: strip_topology_for(Some(led_calibration)),
        hue_channels: None,
        room_geometry: RoomGeometryLive::new(None),
        black_border_detection,
        color_correction: ColorCorrectionConfig::default(),
    });
    let now = Instant::now();
    let sampled = pipeline.sample_strip(frame);
    pipeline.analyze(
        frame,
        sampled,
        FrameSettings {
            black_border_detection,
            alpha_ceiling: 1.0,
            saturation: 1.0,
        },
        now,
    );
    pipeline.advance(now);
    pipeline.strip_frame().to_vec()
}

fn colors_on(
    led_calibration: &LedCalibrationConfig,
    strip: &[[u8; 3]],
    segment: LedSegment,
) -> Vec<[u8; 3]> {
    build_led_sequence(led_calibration)
        .iter()
        .zip(strip)
        .filter(|(item, _)| item.segment == segment)
        .map(|(_, color)| *color)
        .collect()
}

#[test]
fn letterboxed_strip_takes_the_picture_edge_not_the_bars() {
    let frame = letterboxed_frame();
    for led_calibration in [calibration(24, 10, 24, 10), strip_164()] {
        let strip = first_strip_frame(&led_calibration, true, &frame);
        let top = colors_on(&led_calibration, &strip, LedSegment::Top);
        let bottom = colors_on(&led_calibration, &strip, LedSegment::Bottom);
        assert!(
            top.iter().all(|&color| color == PICTURE_TOP),
            "top LEDs must take the picture's top edge: {top:?}"
        );
        assert!(
            bottom.iter().all(|&color| color == PICTURE_BOTTOM),
            "bottom LEDs must take the picture's bottom edge: {bottom:?}"
        );

        // The same frame without detection: the bars are what the top and
        // bottom LEDs see, which is what makes the assertion above mean anything.
        let uncropped = first_strip_frame(&led_calibration, false, &frame);
        for segment in [LedSegment::Top, LedSegment::Bottom] {
            assert!(
                colors_on(&led_calibration, &uncropped, segment)
                    .iter()
                    .all(|&color| color == [0, 0, 0]),
                "{segment:?} LEDs sample the bar with detection off"
            );
        }
    }
}

/// Review item 27, the intended change for Hue: the live saturation slider
/// reached the strip only, and Hue was corrected before it was smoothed. Hue
/// now gets the strip's order — sample, live saturation, smoothing, then the
/// colour plan — at the wire's precision.
#[test]
fn live_saturation_reaches_hue() {
    let frame = scene_frame(FRAME_W, FRAME_H, 3);
    let hue_at = |saturation: f32| -> Vec<HueRgb> {
        let calibration = strip_164();
        let mut pipeline = AmbilightFramePipeline::new(FramePipelineConfig {
            led_sequence: build_led_sequence(&calibration),
            led_counts: calibration.counts.clone(),
            sample_window: LIVE_SAMPLE_WINDOW,
            scene_enabled: false,
            strip_topology: strip_topology_for(Some(&calibration)),
            hue_channels: Some(hue_channels()),
            room_geometry: RoomGeometryLive::new(None),
            black_border_detection: false,
            color_correction: color_correction(),
        });
        let now = Instant::now();
        let sampled = pipeline.sample_strip(&frame);
        let settings = FrameSettings {
            black_border_detection: false,
            alpha_ceiling: 1.0,
            saturation,
        };
        pipeline.analyze(&frame, sampled, settings, now);
        pipeline.advance(now);
        pipeline.hue_colors().expect("hue colours").to_vec()
    };

    let plan = EncoderPlan::new(&color_correction());
    let table = hue_sample_table(&hue_channels(), None);
    let expected = |saturation: f32| -> Vec<HueRgb> {
        table
            .sample_points
            .iter()
            .map(|&(x, y)| {
                let (r, g, b) =
                    sample_screen_position_avg(&frame, x, y, &BlackBorderInsets::default());
                let saturated = apply_saturation_to_pixel([r, g, b], saturation);
                plan.correct_precise(saturated.map(f32::from))
            })
            .collect()
    };
    let plain = hue_at(1.0);
    let vivid = hue_at(1.6);
    assert_eq!(plain, expected(1.0));
    assert_eq!(vivid, expected(1.6));
    assert_ne!(plain, vivid, "the slider must change what Hue shows");
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
        restart();
        f();
        ACTIVE.with(|active| active.set(false));
        (COUNT.with(Cell::get), BYTES.with(Cell::get))
    }

    /// Start counting on this thread from zero, for a thread the test does not
    /// drive directly — the serial writer counts from inside its port.
    pub fn restart() {
        COUNT.with(|count| count.set(0));
        BYTES.with(|total| total.set(0));
        ACTIVE.with(|active| active.set(true));
    }

    /// Allocations on this thread since the last `restart`.
    pub fn count_so_far() -> usize {
        COUNT.with(Cell::get)
    }
}

#[global_allocator]
static COUNTING_ALLOCATOR: alloc_count::CountingAllocator = alloc_count::CountingAllocator;

/// What one steady-state frame may allocate: the sampled strip and the
/// encoded packet. The smoothers, the Hue path, the scene stage and the border
/// cache reuse their buffers and add nothing; the smoothed strip used to be a
/// third, queued for the sink, and is now read in place.
const ALLOCS_PER_FRAME: usize = 2;

/// An output step with no new frame re-encodes the strip and nothing else.
const ALLOCS_PER_TICK: usize = 1;

/// Accepts the packet without keeping it, so the timing report's sink costs
/// only its encode.
struct NullSender;

impl LedPacketSender for NullSender {
    fn send(&self, _port_name: &str, packet: &[u8]) -> Result<(), LedOutputError> {
        std::hint::black_box(packet);
        Ok(())
    }

    fn disconnect_session(&self, _port_name: &str) {}
}

/// The port behind the production serial writer. It runs on the writer
/// thread, so it is where that thread's allocations are counted: each write
/// reads what the writer allocated since the previous one, past warm-up.
struct CountingPort {
    writes: Arc<AtomicUsize>,
    writer_allocs: Arc<AtomicUsize>,
}

/// Writes before the writer's two ping-pong buffers have both grown.
const WRITER_WARM_WRITES: usize = 4;

impl std::io::Write for CountingPort {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        if self.writes.fetch_add(1, Ordering::SeqCst) >= WRITER_WARM_WRITES {
            self.writer_allocs
                .fetch_add(alloc_count::count_so_far(), Ordering::SeqCst);
        }
        std::hint::black_box(buf);
        alloc_count::restart();
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
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

    let writes = Arc::new(AtomicUsize::new(0));
    let writer_allocs = Arc::new(AtomicUsize::new(0));
    let (port_writes, port_allocs) = (Arc::clone(&writes), Arc::clone(&writer_allocs));
    let bridge = LedOutputBridge::with_serial_writer_for_tests(move |_| {
        Ok(Box::new(CountingPort {
            writes: Arc::clone(&port_writes),
            writer_allocs: Arc::clone(&port_allocs),
        }))
    });

    let before_construction = lut_builds();
    let mut run = PipelineRun::new(
        led_calibration,
        &live,
        room,
        profile,
        chip_type,
        bridge.clone(),
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
    let max_bytes = leds * 3 + packet_bytes;
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
        let (allocs, bytes) = alloc_count::measure(|| {
            run.tick(Duration::from_millis(16), &live);
        });
        assert!(
            allocs <= ALLOCS_PER_TICK && bytes <= packet_bytes,
            "output step after frame {n} ({leds} LEDs, {profile:?}/{chip_type:?}) made \
             {allocs} allocations / {bytes} bytes; the budget is {ALLOCS_PER_TICK} / \
             {packet_bytes}"
        );
    }
    assert_eq!(
        lut_builds(),
        before_steady,
        "a steady frame tabulated a gamma or sRGB LUT; build it once per worker"
    );

    bridge.wait_idle_for_tests(PORT);
    assert!(
        writes.load(Ordering::SeqCst) > WRITER_WARM_WRITES,
        "the writer never got past warm-up, so it was never measured"
    );
    assert_eq!(
        writer_allocs.load(Ordering::SeqCst),
        0,
        "the serial writer allocated per frame ({leds} LEDs, {profile:?}/{chip_type:?}); \
         it must reuse its two buffers"
    );
}

/// The worker checks the Hue output slot every frame. Until a Hue start,
/// reconnect, restart or stop moves it, that check must cost no allocation —
/// it is one atomic load, not a lock and a clone of the context.
#[test]
fn an_unchanged_hue_output_slot_costs_a_frame_no_allocation() {
    use super::worker::HueOutputFollower;

    let (color_sender, _frames) = HueColorSender::recording(2);
    let live = HueOutputLive::holding(HueActiveOutputContext {
        channels: hue_channels(),
        color_sender,
    });
    let mut follower = HueOutputFollower::new(Arc::clone(&live));
    let mut swapped = 0;
    let (allocs, _) = alloc_count::measure(|| {
        for _ in 0..100 {
            swapped += usize::from(follower.refresh());
        }
    });
    assert_eq!(swapped, 0);
    assert_eq!(allocs, 0, "the per-frame Hue slot check allocated");

    live.publish(None);
    assert!(
        follower.refresh(),
        "a published change must reach the worker"
    );
    assert!(follower.context.is_none());
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

/// A WLED frame's allocations: the corrected strip, then the datagram list,
/// the chunk list and one datagram per chunk. 164 LEDs is one datagram in
/// both protocols.
const WLED_ALLOCS_PER_FRAME: usize = 4;

#[test]
fn corrected_wled_sink_frame_allocations_stay_within_budget() {
    use crate::commands::led_sink::LedSink;
    use crate::commands::wled_sink::{CorrectedWledSink, WledProtocol, WledUdpSink};

    // Loopback only; nothing reads it, so UDP simply drops what overflows.
    let receiver = std::net::UdpSocket::bind("127.0.0.1:0").expect("bind receiver");
    let port = receiver.local_addr().expect("receiver addr").port();
    let strip: Vec<[u8; 3]> = (0..164_u16)
        .map(|i| [(i % 256) as u8, (i * 3 % 256) as u8, (i * 7 % 256) as u8])
        .collect();

    for protocol in [WledProtocol::Ddp, WledProtocol::Drgb] {
        let mut sink = CorrectedWledSink::new(
            WledUdpSink::new(std::net::Ipv4Addr::LOCALHOST, port, 164, protocol),
            color_correction(),
        );
        sink.start().expect("bind");
        sink.set_brightness(0.8);
        for _ in 0..4 {
            sink.send_frame(&strip).expect("warm-up send");
        }
        for n in 0..16 {
            let (allocs, _) = alloc_count::measure(|| {
                sink.send_frame(&strip).expect("send");
            });
            assert!(
                allocs <= WLED_ALLOCS_PER_FRAME,
                "{protocol:?} frame {n} made {allocs} allocations; the budget is \
                 {WLED_ALLOCS_PER_FRAME}"
            );
        }
    }
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
    print_timing("frame step (sample, analyse, advance, encode)", &full);
    let tick = time_calls(ITERATIONS, |_| {
        run.tick(Duration::from_millis(16), &live);
    });
    print_timing("output step (advance, Hue colour, encode)", &tick);

    let sequence = build_led_sequence(led_calibration);
    let insets = detect_black_borders(frame_at(0), BLACK_BORDER_THRESHOLD);
    print_timing(
        "  strip sampling (inside the border insets)",
        &time_calls(ITERATIONS, |i| {
            std::hint::black_box(sample_frame_within_insets(
                frame_at(i),
                &sequence,
                &led_calibration.counts,
                LIVE_SAMPLE_WINDOW,
                &insets,
            ));
        }),
    );
    print_timing(
        "  black-border detection (every 2.5 s)",
        &time_calls(ITERATIONS, |i| {
            std::hint::black_box(detect_black_borders(frame_at(i), BLACK_BORDER_THRESHOLD));
        }),
    );
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
    let mut smoother = TimeSmoother::default();
    smoother.seed(&sampled);
    print_timing(
        "  strip smoothing (target + time step)",
        &time_calls(ITERATIONS, |_| {
            smoother.set_target(&sampled);
            smoother.advance(Duration::from_millis(16), 0.35);
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
        "  frame step, median: {:.3}% of a 16.7 ms (60 Hz) frame, {:.3}% of 50 ms (20 Hz capture)",
        full.median_us / 16_667.0 * 100.0,
        full.median_us / 50_000.0 * 100.0
    );
    println!(
        "  per second at 30 Hz capture + 60 Hz output: {:.0} µs (frame steps) + {:.0} µs (output steps)",
        full.median_us * 30.0,
        tick.median_us * 30.0
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
