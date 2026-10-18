//! The ambilight worker thread: capture, the per-frame step, and the sends to
//! every configured output. The computation itself is `frame_pipeline`; this
//! file keeps the I/O and the timing around it: each captured frame is
//! analysed once, and the outputs are stepped on their own clock —
//! docs/architecture/capture-and-pipeline.md.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use log::{info, warn};

use super::effects::EffectDraw;
use super::frame_pipeline::{
    strip_topology_for, AmbilightFramePipeline, FramePipelineConfig, FrameSettings,
    StripStageConfig,
};
use super::latency::{frame_level, LatencyMeter, LatencySink};
use super::live::{AmbilightLiveSettings, RoomGeometryLive};
use super::pacing::{resolve_quality_config, AmbilightWorkerQualityState};
use super::preview::{PreviewEmitContext, TwinFrameSink, TWIN_FRAME_INTERVAL_MS};
use super::runtime::LightingWorkerRuntime;
use super::sampling::{sample_window_for, strip_for_worker};
use super::strip_set::StripSpec;
use super::usb_output::{ActiveUsbSink, UsbOutputPlan};
use super::{ACTIVE_AMBILIGHT_WORKERS, AMBILIGHT_CAPTURE_ATTEMPTS, AMBILIGHT_FRAME_ATTEMPTS};
use crate::commands::ambilight_capture::{AmbilightFrameSource, CapturedFrame};
use crate::commands::hue::frame::HueMotion;
use crate::commands::hue::state_store::{
    apply_hue_channels_with_context, HueActiveOutputContext, HueOutputLive,
};
use crate::commands::led_calibration::sample_frame_for_sequence;
use crate::commands::led_output::{
    scale_brightness, FirmwareProfile, LedChipType, LedColorOrder, LedOutputBridge, SerialSink,
};
use crate::commands::preview::feed::{twin_colour, twin_colour_linear};
use crate::commands::runtime_telemetry::{RuntimeTelemetryWindow, SharedRuntimeTelemetry};
use crate::commands::wled_sink::CorrectedWledSink;

/// Hue alone: output steps at twice the sender's 50 ms rate, so the target it
/// picks up is never more than half a tick old.
const HUE_ONLY_OUTPUT_INTERVAL: Duration = Duration::from_millis(25);

/// No single wait is longer, so a stop is seen within this long.
const MAX_WAIT: Duration = Duration::from_millis(50);

/// Where the smoothing reads time. Waits and send pacing always use the real
/// clock; a test swaps this one to make the smoothing reproducible.
pub(super) type SmoothingClock = Arc<dyn Fn() -> Instant + Send + Sync>;

pub(super) struct WorkerPacing {
    /// What capture was asked for; a pull source is polled at this rate.
    pub capture_interval: Duration,
    pub clock: SmoothingClock,
    /// The source draws its frames (an effect or a test pattern) rather than
    /// sampling a screen.
    pub synthetic: bool,
    /// An effect, drawn per light by the pipeline instead of sampled.
    pub effect: Option<EffectDraw>,
    /// A preview scene: the screen is captured as ever, but what it shows is a
    /// test, so it stays out of the runtime history.
    pub preview_scene: bool,
    /// The latency scene plays: the worker measures each flip's way to the
    /// output and reports here.
    pub latency: Option<LatencySink>,
}

impl WorkerPacing {
    pub(super) fn live(capture_interval: Duration) -> Self {
        Self {
            capture_interval,
            clock: Arc::new(Instant::now),
            synthetic: false,
            effect: None,
            preview_scene: false,
            latency: None,
        }
    }

    pub(super) fn drawn(capture_interval: Duration, effect: EffectDraw) -> Self {
        Self {
            synthetic: true,
            effect: Some(effect),
            ..Self::live(capture_interval)
        }
    }
}

/// The worker's copy of the Hue runtime's live output. Its sender clone is the
/// only one the worker holds, and it is replaced or dropped within a frame of
/// the runtime publishing, so a reconnect reaches the new sender and a stop's
/// sender can exit while the worker keeps driving USB or WLED. See
/// docs/architecture/hue.md.
pub(super) struct HueOutputFollower {
    live: Arc<HueOutputLive>,
    seen: u64,
    pub(super) context: Option<HueActiveOutputContext>,
}

impl HueOutputFollower {
    pub(super) fn new(live: Arc<HueOutputLive>) -> Self {
        let (seen, context) = live.snapshot();
        Self {
            live,
            seen,
            context,
        }
    }

    /// One relaxed load per frame when nothing moved. `true` when the context
    /// was swapped.
    pub(super) fn refresh(&mut self) -> bool {
        if self.live.generation() == self.seen {
            return false;
        }
        self.context = None;
        let (seen, context) = self.live.snapshot();
        self.seen = seen;
        self.context = context;
        true
    }
}

/// A running worker in `ACTIVE_AMBILIGHT_WORKERS`, counted out when it drops:
/// on a normal exit and on a panic alike, so a crashed loop does not leave the
/// app counting a worker that is gone.
struct ActiveWorker;

impl ActiveWorker {
    fn enter() -> Self {
        ACTIVE_AMBILIGHT_WORKERS.fetch_add(1, Ordering::SeqCst);
        Self
    }
}

impl Drop for ActiveWorker {
    fn drop(&mut self) {
        ACTIVE_AMBILIGHT_WORKERS.fetch_sub(1, Ordering::SeqCst);
    }
}

/// Which of a run of failures reaches the log: the first five, then every
/// fiftieth, so a failure that repeats every frame is seen without flooding it.
pub(super) fn is_logged_failure(count: u32) -> bool {
    count <= 5 || count.is_multiple_of(50)
}

fn log_hue_output(context: Option<&HueActiveOutputContext>) {
    let Some(ctx) = context else {
        info!("[ambilight-worker] hue output released — no live stream");
        return;
    };
    // Where the bridge (or the room map) puts each channel. Not where it samples
    // the screen: that is the pipeline's sample table, which room-aware sampling
    // moves off this position, so a screen point derived from it here misled.
    for ch in &ctx.channels {
        info!(
            "[ambilight-worker] hue ch#{} bridge_pos=({:.3},{:.3}) z={:?}",
            ch.channel_id, ch.position_x, ch.position_y, ch.position_z
        );
    }
}

/// A frame from the source, and whether it is new: a new one was sampled for every strip.
type Captured = (Arc<CapturedFrame>, bool);

/// One strip's output: the sink, the gate that paces its sends, and its counts for the log.
struct StripOutput {
    /// The pipeline stage it sends.
    stage: usize,
    sink: ActiveUsbSink,
    /// Its own colour order, or `None` to follow the live one.
    color_order: Option<LedColorOrder>,
    /// A serial link's top frame rate and whether it holds the effect back; `None` for WLED.
    link: Option<(f32, bool)>,
    gate: AmbilightWorkerQualityState,
    /// This output step's send time, for its gate's cost on a new frame.
    send_ms: f32,
    send_count: u32,
    fail_count: u32,
}

/// Sync live-tunable settings from shared atomic state (zero-cost on hot path).
fn read_frame_settings(live_settings: &AmbilightLiveSettings) -> FrameSettings {
    FrameSettings {
        black_border_detection: live_settings.read_black_border_detection(),
        alpha_ceiling: live_settings.read_smoothing_alpha(),
        saturation: live_settings.read_saturation(),
    }
}

/// `strips` are sampled and sent in order; one with no plan is sampled for the preview and sent
/// nowhere. The first is the strip the mode is for: an output of it that cannot start fails the
/// worker, as the one strip always did. Any other that cannot is left out with a warning, and
/// `started` says which ran. `hue_output` is the Hue runtime's slot, handed over only when the
/// mode's targets name Hue.
#[allow(clippy::too_many_arguments)]
pub(super) fn start_ambilight_worker(
    output_bridge: LedOutputBridge,
    strips: Vec<StripSpec>,
    live_settings: Arc<AmbilightLiveSettings>,
    frame_source: Box<dyn AmbilightFrameSource>,
    telemetry_snapshot: SharedRuntimeTelemetry,
    hue_output: Option<Arc<HueOutputLive>>,
    twin_sink: Option<TwinFrameSink>,
    preview: Option<PreviewEmitContext>,
    room_geometry: Arc<RoomGeometryLive>,
    pacing: WorkerPacing,
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
    let mut hue_output = hue_output.map(HueOutputFollower::new);
    let mut telemetry_window = RuntimeTelemetryWindow::new(Instant::now());
    telemetry_window.attach(telemetry_snapshot.clone());
    let telemetry_snapshot_for_stop = telemetry_snapshot.clone();

    AMBILIGHT_CAPTURE_ATTEMPTS.fetch_add(1, Ordering::SeqCst);
    // A synthetic test paints exact per-LED blocks; the live 0.05 box is wider
    // than the whole comet, so it averaged in unlit screen and dimmed the head.
    let synthetic = pacing.synthetic;
    telemetry_window.set_capture_interval(pacing.capture_interval);
    if synthetic || pacing.preview_scene {
        telemetry_window.skip_history();
    }

    let mut stages = Vec::with_capacity(strips.len());
    let mut initial_sampled = Vec::with_capacity(strips.len());
    let mut outputs: Vec<StripOutput> = Vec::new();
    for (stage, spec) in strips.iter().enumerate() {
        // Per-LED calibration: build the strip sequence once at worker start. Each iteration calls
        // sample_frame_for_sequence to produce per-LED colours from edge regions of the captured frame.
        let (led_sequence, strip_shape, total_leds) =
            strip_for_worker(spec.layout.as_ref(), spec.plan.is_some());
        info!(
            "[start_ambilight_worker] led sequence resolved — strip={stage} total_leds={total_leds} sequence_len={} calibration_present={}",
            led_sequence.len(),
            spec.layout.is_some()
        );
        let sample_window =
            sample_window_for(synthetic, spec.layout.is_some(), spec.plan.is_some());
        info!(
            "[start_ambilight_worker] sample_window={sample_window} synthetic={synthetic} calibration_present={} strip_output={}",
            spec.layout.is_some(),
            spec.plan.is_some()
        );
        // No border detection for the initial warmup frame — detection runs in the worker loop.
        initial_sampled.push(sample_frame_for_sequence(
            &initial_frame,
            &led_sequence,
            &strip_shape,
            sample_window,
        ));
        stages.push(StripStageConfig {
            led_sequence,
            strip_shape,
            sample_window,
            topology: strip_topology_for(spec.layout.as_ref()),
        });
        let Some(plan) = spec.plan.as_ref() else {
            continue;
        };
        let (quality_config, serial_budget) =
            resolve_quality_config(&spec.plan, total_leds, spec.profile, spec.chip);
        // Deliberately gated on `serial_budget`, not on the plan -- a WLED-only
        // session must report `link_max_fps: 0.0` / unconstrained, the same as
        // a Hue-only session (see contract note on `RuntimeTelemetrySnapshot`).

        // Built once at worker start; brightness and colour order are synced each
        // output step via `set_brightness` / `set_color_order` before `send_frame`.
        let mut sink = match plan {
            UsbOutputPlan::Serial(port) => ActiveUsbSink::Serial(SerialSink::with_chip_type(
                output_bridge.clone(),
                Some(port.clone()),
                live_settings.read_brightness(),
                spec.profile,
                spec.correction.clone(),
                spec.chip,
            )),
            UsbOutputPlan::Wled(cfg) => {
                ActiveUsbSink::Wled(CorrectedWledSink::new(cfg.build(), spec.correction.clone()))
            }
        };
        if let Err(reason) = sink.start() {
            if stage == 0 {
                return Err(reason);
            }
            warn!("[start_ambilight_worker] strip {stage} left out — its output did not start: {reason}");
            continue;
        }
        outputs.push(StripOutput {
            stage,
            sink,
            color_order: spec.color_order,
            link: serial_budget.map(|budget| (budget.link_max_fps, budget.is_link_constrained())),
            gate: AmbilightWorkerQualityState::new(quality_config),
            send_ms: 0.0,
            send_count: 0,
            fail_count: 0,
        });
    }
    telemetry_window.record_capture();
    // With no strip output, a Hue-only gate keeps the capture cost for the latency report.
    let mut hue_only_gate = outputs.is_empty().then(|| {
        AmbilightWorkerQualityState::new(
            resolve_quality_config(&None, 0, FirmwareProfile::default(), LedChipType::default()).0,
        )
    });

    let send_started = Instant::now();
    let mut warmed = false;
    let mut first_frame_failed = Vec::new();
    for (index, output) in outputs.iter_mut().enumerate() {
        output.sink.set_brightness(live_settings.read_brightness());
        output.sink.set_color_order(
            output
                .color_order
                .unwrap_or_else(|| live_settings.read_color_order()),
        );
        if output.gate.should_send_now(Instant::now()) {
            AMBILIGHT_FRAME_ATTEMPTS.fetch_add(1, Ordering::SeqCst);
            match output.sink.send_frame(&initial_sampled[output.stage]) {
                Ok(()) => warmed = true,
                Err(reason) if output.stage == 0 => return Err(reason),
                Err(reason) => {
                    warn!(
                        "[start_ambilight_worker] strip {} left out — its first frame failed: {reason}",
                        output.stage
                    );
                    first_frame_failed.push(index);
                }
            }
        }
    }
    for index in first_frame_failed.into_iter().rev() {
        let mut dropped = outputs.remove(index);
        let _ = dropped.sink.stop();
    }
    // The strips whose outputs run, by their place in `strips`.
    let started: Vec<usize> = outputs.iter().map(|output| output.stage).collect();
    // The link the slowest strip that runs leaves: what the telemetry reports for the run.
    let worst_link = outputs
        .iter()
        .filter_map(|output| output.link)
        .reduce(|(fps, constrained), (other, tight)| (fps.min(other), constrained || tight));
    if let Some((fps, constrained)) = worst_link {
        telemetry_window.set_link_budget(fps, constrained);
    }
    if warmed {
        telemetry_window.record_send();
    }
    // Hue-only: no initial USB send needed, just apply Hue from capture
    let warmup_ms = send_started.elapsed().as_secs_f32() * 1000.0;
    for output in &mut outputs {
        output.gate.observe_capture_and_send_cost(0.0, warmup_ms);
    }
    if let Some(gate) = hue_only_gate.as_mut() {
        gate.observe_capture_and_send_cost(0.0, warmup_ms);
    }
    telemetry_window.record_latency(observed_cost_ms(&outputs, hue_only_gate.as_ref()));
    telemetry_window.flush_if_due(Instant::now(), &telemetry_snapshot)?;

    let cancel = Arc::new(AtomicBool::new(false));
    let cancel_flag = Arc::clone(&cancel);

    let frame_signal = frame_source.frame_signal();
    // Wrap the frame source in Arc<Mutex<...>> so ownership stays on the command
    // thread. The worker receives only a clone (refcount=2). When the worker loop
    // exits it drops its clone (refcount→1). Then LightingWorkerRuntime::stop()
    // drops `self` from the command thread, dropping the last Arc (refcount→0) and
    // calling SCStream::stop_capture safely — never from the worker thread.
    let frame_source_arc: Arc<Mutex<Box<dyn AmbilightFrameSource>>> =
        Arc::new(Mutex::new(frame_source));
    let worker_source = Arc::clone(&frame_source_arc);
    let seeded_at = (pacing.clock)();
    let effect_draw = pacing.effect.clone();

    let handle = thread::spawn(move || {
        let _active = ActiveWorker::enter();
        let initial_hue = hue_output.as_ref().and_then(|f| f.context.as_ref());
        let has_hue = initial_hue.map(|c| !c.channels.is_empty()).unwrap_or(false);
        info!(
            "[ambilight-worker] started — sinks={:?} chips={:?} hue={} channels={} capture_interval={:?} push_source={}",
            strips.iter().map(|spec| &spec.plan).collect::<Vec<_>>(),
            strips.iter().map(|spec| spec.chip).collect::<Vec<_>>(),
            has_hue,
            initial_hue.map(|c| c.channels.len()).unwrap_or(0),
            pacing.capture_interval,
            frame_signal.is_some()
        );
        if initial_hue.is_some() {
            log_hue_output(initial_hue);
        }
        let mut hue_send_count = 0u32;
        // Scene-adaptive stage (docs/architecture/capture-and-pipeline.md). Off
        // for synthetic test frames, which must reach the strip exactly as
        // painted, and under LUMASYNC_AMBILIGHT_LEGACY=1 for A/B bisecting.
        // Off for the latency scene too: its adaptive smoothing would hold a
        // flip back, and the flip reaching the output is what it measures.
        let measuring = pacing.latency.is_some();
        let scene_enabled = !synthetic
            && !measuring
            && std::env::var("LUMASYNC_AMBILIGHT_LEGACY").map_or(true, |v| v != "1");
        let mut pipeline = AmbilightFramePipeline::new(FramePipelineConfig {
            strips: stages,
            scene_enabled,
            hue_channels: hue_output
                .as_ref()
                .and_then(|f| f.context.as_ref())
                .map(|ctx| ctx.channels.clone()),
            room_geometry,
            black_border_detection: live_settings.read_black_border_detection(),
            // Hue and the twin take the first strip's correction, as they took the one strip's.
            color_correction: strips
                .first()
                .map(|spec| spec.correction.clone())
                .unwrap_or_default(),
            effect: effect_draw,
        });
        pipeline.seed_strips(&initial_sampled, seeded_at);
        info!(
            "[ambilight-worker] scene-adaptive stage {}",
            if scene_enabled { "on" } else { "off" }
        );
        // A test pattern is painted exactly and must reach the lamps that way.
        let mut latency_meter = measuring.then(LatencyMeter::default);
        let hue_motion = if synthetic || measuring {
            HueMotion::Snap
        } else {
            HueMotion::Ease
        };
        let has_strip = !outputs.is_empty();

        let mut capture_fail_count = 0u32;
        let mut last_twin_frame_at: Option<Instant> = None;
        // The twin's copy of the Hue lamps' linear colours, kept only while it
        // is fed — in f32, since a u8 here bands dark scenes once screen-encoded.
        let mut last_hue_colors: Vec<[f32; 3]> = Vec::new();
        // Reused every twin frame rather than allocated per tick.
        let mut twin_leds: Vec<[u8; 3]> = Vec::new();
        let mut twin_lamps: Vec<[u8; 3]> = Vec::new();
        // 0 is never a frame's seq, so the first frame on hand — the warm-up
        // one, if nothing newer came — is analysed.
        let mut seen_seq = 0u64;
        let mut last_frame: Option<Arc<CapturedFrame>> = None;
        let mut analyzed_with: Option<FrameSettings> = None;
        // A still screen sends no new frame, so a change to what the analysis
        // reads is applied by re-analysing the one on hand.
        let mut reanalyze = false;
        let mut last_poll: Option<Instant> = None;
        let mut next_tick = Instant::now();
        let mut last_hue_push: Option<Instant> = None;
        // A frame analysed but not yet sent anywhere; a second one replacing
        // it is the old slot overwrite, for queue health.
        let mut unsent_frame = false;
        while !cancel_flag.load(Ordering::Relaxed) {
            if let Some(follower) = hue_output.as_mut() {
                if follower.refresh() {
                    log_hue_output(follower.context.as_ref());
                    if follower.context.is_none() {
                        last_hue_colors.clear();
                    }
                    pipeline.set_hue_channels(
                        follower.context.as_ref().map(|ctx| ctx.channels.clone()),
                    );
                    reanalyze = true;
                }
            }

            // The step runs at the fastest output's pace; each gate holds its own back.
            let output_interval = outputs
                .iter()
                .map(|output| output.gate.current_send_interval())
                .min()
                .unwrap_or(HUE_ONLY_OUTPUT_INTERVAL);
            // A synthetic pattern animates per call, so it is drawn at the
            // output rate rather than the screen's.
            let poll_interval = if synthetic {
                output_interval
            } else {
                pacing.capture_interval
            };
            let now = Instant::now();
            let poll_due = last_poll.map_or(now, |at| at + poll_interval);
            let frame_ready = match &frame_signal {
                Some(signal) => {
                    let wait = next_tick.saturating_duration_since(now).min(MAX_WAIT);
                    signal.wait_newer(seen_seq, wait)
                }
                None => {
                    let wait = next_tick
                        .min(poll_due)
                        .saturating_duration_since(now)
                        .min(MAX_WAIT);
                    if !wait.is_zero() {
                        thread::sleep(wait);
                    }
                    Instant::now() >= poll_due
                }
            };
            if cancel_flag.load(Ordering::Relaxed) {
                break;
            }

            let mut new_frame = false;
            let mut capture_ms = 0.0;
            if frame_ready {
                let capture_started = Instant::now();
                last_poll = Some(capture_started);
                let captured: Result<Captured, String> = match worker_source.lock() {
                    Ok(mut src) => {
                        AMBILIGHT_CAPTURE_ATTEMPTS.fetch_add(1, Ordering::SeqCst);
                        src.capture_frame().map_err(|e| e.as_reason()).map(|frame| {
                            // A frame already analysed is not sampled again.
                            let fresh = frame.seq != seen_seq;
                            if fresh {
                                pipeline.sample(&frame);
                            }
                            (frame, fresh)
                        })
                    }
                    Err(_) => Err("AMBILIGHT_CAPTURE_FRAME_LOCK_FAILED".to_string()),
                };
                match captured {
                    Err(e) => {
                        capture_fail_count += 1;
                        if is_logged_failure(capture_fail_count) {
                            warn!("[ambilight-worker] capture failed #{capture_fail_count}: {e}");
                        }
                        // The frame branch owns the only other flush, so without
                        // this one a sustained outage freezes telemetry at the
                        // last good frame.
                        telemetry_window.record_capture_error(&e, Instant::now());
                        let _ = telemetry_window.flush_if_due(Instant::now(), &telemetry_snapshot);
                    }
                    Ok((frame, true)) => {
                        seen_seq = frame.seq;
                        if let Some(meter) = latency_meter.as_mut() {
                            meter.observe_frame(frame_level(&frame), frame.captured_at);
                        }
                        let settings = read_frame_settings(&live_settings);
                        let analyzed_at = pipeline.analyze(&frame, settings, (pacing.clock)());
                        analyzed_with = Some(settings);
                        reanalyze = false;
                        last_frame = Some(frame);
                        capture_ms = analyzed_at
                            .saturating_duration_since(capture_started)
                            .as_secs_f32()
                            * 1000.0;
                        // Unique frames only: this is what capture fps reports.
                        telemetry_window.record_capture();
                        if unsent_frame {
                            telemetry_window.record_slot_overwrite();
                        }
                        unsent_frame = true;
                        new_frame = true;
                    }
                    Ok((_, false)) => {}
                }
            }

            let mut retuned = false;
            if let (false, Some(frame)) = (new_frame, last_frame.as_ref()) {
                let settings = read_frame_settings(&live_settings);
                if reanalyze || analyzed_with != Some(settings) || pipeline.hue_resample_due() {
                    pipeline.sample(frame);
                    pipeline.analyze(frame, settings, (pacing.clock)());
                    analyzed_with = Some(settings);
                    reanalyze = false;
                    retuned = true;
                }
            }

            let now = Instant::now();
            if !new_frame && !retuned && now < next_tick {
                continue;
            }
            if now >= next_tick {
                next_tick += output_interval;
                if next_tick <= now {
                    next_tick = now + output_interval;
                }
            }

            // One output step: every smoother moves by the time that passed,
            // then each sink takes its share.
            pipeline.advance((pacing.clock)());
            let brightness = live_settings.read_brightness();
            let color_order = live_settings.read_color_order();
            let frame_age_ms = last_frame.as_ref().map_or(0, |frame| {
                now.saturating_duration_since(frame.captured_at).as_millis()
            });

            let send_started = Instant::now();
            let mut sent = false;
            for output in &mut outputs {
                output.send_ms = 0.0;
                if !output.gate.should_send_now(send_started) {
                    continue;
                }
                let output_started = Instant::now();
                output.sink.set_brightness(brightness);
                output
                    .sink
                    .set_color_order(output.color_order.unwrap_or(color_order));
                AMBILIGHT_FRAME_ATTEMPTS.fetch_add(1, Ordering::SeqCst);
                let strip = pipeline.strip_frame(output.stage);
                match output.sink.send_frame(strip) {
                    Ok(()) => {
                        sent = true;
                        // LumaSync v1 wire format: 5-byte header
                        // (magic + brightness + count_le) + RGB payload
                        // (3 bytes per LED) + 1-byte XOR. Adalight's
                        // 6-byte header without the brightness byte
                        // produces a slightly different total — the log
                        // assumes LumaSyncV1 (the production default)
                        // and is observability-only, not load-bearing.
                        let usb_bytes_estimate = 5usize + strip.len().saturating_mul(3) + 1;
                        output.send_count += 1;
                        let count = output.send_count;
                        if count <= 3 || count.is_multiple_of(200) {
                            info!(
                                "[ambilight-worker] usb update #{count} — strip={} bytes={usb_bytes_estimate} led_count={} frame_age_ms={frame_age_ms}",
                                output.stage,
                                strip.len()
                            );
                        }
                        output.send_ms = output_started.elapsed().as_secs_f32() * 1000.0;
                    }
                    Err(e) => {
                        // Every one kept for telemetry; the log keeps the first few and a
                        // sample after, as for capture, so a dead strip does not flood it.
                        output.fail_count += 1;
                        telemetry_window.record_output_error(&e, Instant::now());
                        if is_logged_failure(output.fail_count) {
                            warn!(
                                "[ambilight-worker] strip {} send failed #{}: {e}",
                                output.stage, output.fail_count
                            );
                        }
                    }
                }
            }
            // One send per step, however many strips took it.
            if sent {
                telemetry_window.record_send();
                unsent_frame = false;
                report_latency(&mut latency_meter, pacing.latency.as_ref());
            }

            // Hue: the sender streams at its own 50 ms floor and eases between
            // the targets it finds, so the worker only keeps the newest one
            // on hand — on every new frame and at least every half tick.
            let enrich_preview = preview.as_ref().is_some_and(|ctx| ctx.should_enrich());
            let hue_due = new_frame
                || retuned
                || last_hue_push
                    .is_none_or(|at| now.saturating_duration_since(at) >= HUE_ONLY_OUTPUT_INTERVAL);
            let hue_context = hue_output.as_ref().and_then(|f| f.context.as_ref());
            if let (true, Some(context), Some(colors)) =
                (hue_due, hue_context, pipeline.hue_colors())
            {
                if new_frame {
                    hue_send_count += 1;
                    if hue_send_count <= 3 || hue_send_count.is_multiple_of(200) {
                        info!(
                            "[ambilight-worker] hue update #{hue_send_count} — frame_age_ms={frame_age_ms} colors: {:?}",
                            &colors[..colors.len().min(3)]
                        );
                    }
                    if !has_strip {
                        telemetry_window.record_send();
                        unsent_frame = false;
                    }
                }
                // Only the twin reads this; allocating it unconditionally
                // burned a Vec per frame at up to 60 Hz.
                if enrich_preview {
                    last_hue_colors.clear();
                    last_hue_colors.extend_from_slice(colors);
                }
                let _ = apply_hue_channels_with_context(
                    context,
                    colors.to_vec(),
                    brightness,
                    hue_motion,
                );
                // Ends at the hand-off to the stream, which sends on its own
                // 50 ms beat; the popup says so.
                if new_frame && !has_strip {
                    report_latency(&mut latency_meter, pacing.latency.as_ref());
                }
                last_hue_push = Some(now);
            }

            if new_frame {
                for output in &mut outputs {
                    output
                        .gate
                        .observe_capture_and_send_cost(capture_ms, output.send_ms);
                }
                if let Some(gate) = hue_only_gate.as_mut() {
                    gate.observe_capture_and_send_cost(capture_ms, 0.0);
                }
                telemetry_window.record_latency(observed_cost_ms(&outputs, hue_only_gate.as_ref()));
            }
            let _ = telemetry_window.flush_if_due(Instant::now(), &telemetry_snapshot);

            // The twin's feed. With no twin subscribed this is skipped whole.
            let twin_feed = twin_sink.as_ref().filter(|_| enrich_preview);
            if let Some(sink) = twin_feed {
                let now = Instant::now();
                let due = last_twin_frame_at.is_none_or(|prev| {
                    now.duration_since(prev) >= Duration::from_millis(TWIN_FRAME_INTERVAL_MS)
                });
                if due {
                    // The light the strip makes: the sink's correction, then
                    // brightness, then encoded for a screen. Hue arrives
                    // corrected already, so it takes brightness only.
                    twin_leds.clear();
                    // The first strip, until the twin draws every strip.
                    twin_leds.extend(pipeline.strip_frame(0).iter().map(|&rgb| {
                        twin_colour(scale_brightness(pipeline.correct_rgb(rgb), brightness))
                    }));
                    twin_lamps.clear();
                    twin_lamps.extend(
                        last_hue_colors
                            .iter()
                            .map(|&linear| twin_colour_linear(linear.map(|v| v * brightness))),
                    );
                    sink(&twin_leds, &twin_lamps);
                    last_twin_frame_at = Some(now);
                }
            }
        }

        // Stop every strip's sink cleanly before the worker thread exits.
        for mut output in outputs {
            let _ = output.sink.stop();
        }
    });

    Ok(LightingWorkerRuntime {
        cancel,
        handle,
        started,
        telemetry: telemetry_snapshot_for_stop,
        _frame_source: frame_source_arc,
    })
}

/// What the latency telemetry reports: the slowest strip's capture and send cost, or the Hue-only
/// gate's with no strip.
fn observed_cost_ms(
    outputs: &[StripOutput],
    hue_only_gate: Option<&AmbilightWorkerQualityState>,
) -> f32 {
    outputs
        .iter()
        .map(|output| output.gate.observed_cost_ms())
        .chain(hue_only_gate.map(AmbilightWorkerQualityState::observed_cost_ms))
        .fold(0.0, f32::max)
}

/// An output just went out: the latency scene's sample ends here, if one began.
fn report_latency(meter: &mut Option<LatencyMeter>, sink: Option<&LatencySink>) {
    if let (Some(meter), Some(sink)) = (meter.as_mut(), sink) {
        if let Some(result) = meter.observe_sent(Instant::now()) {
            sink(&result);
        }
    }
}

#[cfg(test)]
mod failure_log_tests {
    use super::is_logged_failure;

    #[test]
    fn a_repeating_failure_logs_the_first_five_then_every_fiftieth() {
        let logged: Vec<u32> = (1..=200).filter(|&n| is_logged_failure(n)).collect();
        assert_eq!(logged, vec![1, 2, 3, 4, 5, 50, 100, 150, 200]);
    }
}
