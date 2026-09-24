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

use super::frame_pipeline::{
    strip_topology_for, AmbilightFramePipeline, FramePipelineConfig, FrameSettings,
};
use super::live::{AmbilightLiveSettings, RoomGeometryLive};
use super::pacing::{resolve_quality_config, AmbilightWorkerQualityState};
use super::preview::{
    EdgeSignalEmitter, EdgeSignalPayload, PreviewEmitContext, EDGE_SIGNAL_PREVIEW_INTERVAL_MS,
};
use super::runtime::LightingWorkerRuntime;
use super::sampling::{LIVE_SAMPLE_WINDOW, SYNTHETIC_SAMPLE_WINDOW};
use super::usb_output::{ActiveUsbSink, UsbOutputPlan};
use super::{ACTIVE_AMBILIGHT_WORKERS, AMBILIGHT_CAPTURE_ATTEMPTS, AMBILIGHT_FRAME_ATTEMPTS};
use crate::commands::ambilight_capture::{AmbilightFrameSource, CapturedFrame};
use crate::commands::hue::frame::HueMotion;
use crate::commands::hue::state_store::{
    apply_hue_channels_with_context, HueActiveOutputContext, HueOutputLive,
};
use crate::commands::led_calibration::{
    build_led_sequence, sample_frame_for_sequence, LedCalibrationConfig,
};
use crate::commands::led_output::{
    scale_brightness, ColorCorrectionConfig, FirmwareProfile, LedChipType, LedOutputBridge,
    SerialSink,
};
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
}

impl WorkerPacing {
    pub(super) fn live(capture_interval: Duration) -> Self {
        Self {
            capture_interval,
            clock: Arc::new(Instant::now),
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

fn log_hue_output(context: Option<&HueActiveOutputContext>) {
    let Some(ctx) = context else {
        info!("[ambilight-worker] hue output released — no live stream");
        return;
    };
    for ch in &ctx.channels {
        let norm_x = (ch.position_x.clamp(-1.0, 1.0) + 1.0) / 2.0;
        let norm_y = (1.0 - ch.position_y.clamp(-1.0, 1.0)) / 2.0;
        info!("[ambilight-worker] hue ch#{} bridge_pos=({:.3},{:.3}) z={:?} screen_norm=({:.1}%,{:.1}%) region={:?}",
            ch.channel_id, ch.position_x, ch.position_y, ch.position_z,
            norm_x * 100.0, norm_y * 100.0, ch.screen_region);
    }
}

/// A frame from the source, and its strip samples when it had not been seen.
type Captured = (Arc<CapturedFrame>, Option<Vec<[u8; 3]>>);

/// Sync live-tunable settings from shared atomic state (zero-cost on hot path).
fn read_frame_settings(live_settings: &AmbilightLiveSettings) -> FrameSettings {
    FrameSettings {
        black_border_detection: live_settings.read_black_border_detection(),
        alpha_ceiling: live_settings.read_smoothing_alpha(),
        saturation: live_settings.read_saturation(),
    }
}

/// `hue_output` is the Hue runtime's slot, handed over only when the mode's
/// targets name Hue.
#[allow(clippy::too_many_arguments)]
pub(super) fn start_ambilight_worker(
    output_bridge: LedOutputBridge,
    usb_plan: Option<UsbOutputPlan>,
    led_calibration: Option<LedCalibrationConfig>,
    live_settings: Arc<AmbilightLiveSettings>,
    frame_source: Box<dyn AmbilightFrameSource>,
    telemetry_snapshot: SharedRuntimeTelemetry,
    hue_output: Option<Arc<HueOutputLive>>,
    edge_signal_emitter: Option<EdgeSignalEmitter>,
    color_correction: ColorCorrectionConfig,
    firmware_profile: FirmwareProfile,
    chip_type: LedChipType,
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
        use crate::commands::led_calibration::LedSegmentCounts as Counts;
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

    let mut hue_output = hue_output.map(HueOutputFollower::new);
    let (quality_config, serial_budget) =
        resolve_quality_config(&usb_plan, total_leds, firmware_profile, chip_type);
    let mut quality_state = AmbilightWorkerQualityState::new(quality_config);
    let mut telemetry_window = RuntimeTelemetryWindow::new(Instant::now());
    // Deliberately gated on `serial_budget`, not `usb_plan` -- a WLED-only
    // session must report `link_max_fps: 0.0` / unconstrained, the same as
    // a Hue-only session (see contract note on `RuntimeTelemetrySnapshot`).
    if let Some(budget) = serial_budget {
        telemetry_window.set_link_budget(budget.link_max_fps, budget.is_link_constrained());
    }

    AMBILIGHT_CAPTURE_ATTEMPTS.fetch_add(1, Ordering::SeqCst);
    // A synthetic test paints exact per-LED blocks; the live 0.05 box is wider
    // than the whole comet, so it averaged in unlit screen and dimmed the head.
    let synthetic = preview.as_ref().is_some_and(|ctx| ctx.source == "test");
    let sample_window = if synthetic {
        SYNTHETIC_SAMPLE_WINDOW
    } else {
        LIVE_SAMPLE_WINDOW
    };
    // No border detection for the initial warmup frame — detection runs in the worker loop.
    let initial_sampled =
        sample_frame_for_sequence(&initial_frame, &led_sequence, &led_counts, sample_window);
    telemetry_window.record_capture();

    // Built once at worker start; brightness and colour order are synced each
    // output step via `set_brightness` / `set_color_order` before `send_frame`.
    let mut usb_sink: Option<ActiveUsbSink> = usb_plan.as_ref().map(|plan| match plan {
        UsbOutputPlan::Serial(port) => ActiveUsbSink::Serial(SerialSink::with_chip_type(
            output_bridge.clone(),
            Some(port.clone()),
            live_settings.read_brightness(),
            firmware_profile,
            color_correction.clone(),
            chip_type,
        )),
        UsbOutputPlan::Wled(cfg) => ActiveUsbSink::Wled(CorrectedWledSink::new(
            cfg.build(),
            color_correction.clone(),
        )),
    });
    if let Some(ref mut sink) = usb_sink {
        sink.start()?;
    }

    let send_started = Instant::now();
    if let Some(ref mut sink) = usb_sink {
        sink.set_brightness(live_settings.read_brightness());
        sink.set_color_order(live_settings.read_color_order());
        if quality_state.should_send_now(Instant::now()) {
            AMBILIGHT_FRAME_ATTEMPTS.fetch_add(1, Ordering::SeqCst);
            sink.send_frame(&initial_sampled)?;
            telemetry_window.record_send();
        }
    }
    // Hue-only: no initial USB send needed, just apply Hue from capture
    quality_state.observe_capture_and_send_cost(0.0, send_started.elapsed().as_secs_f32() * 1000.0);
    telemetry_window.record_latency(quality_state.observed_cost_ms());
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

    let handle = thread::spawn(move || {
        ACTIVE_AMBILIGHT_WORKERS.fetch_add(1, Ordering::SeqCst);
        let initial_hue = hue_output.as_ref().and_then(|f| f.context.as_ref());
        let has_hue = initial_hue.map(|c| !c.channels.is_empty()).unwrap_or(false);
        info!(
            "[ambilight-worker] started — sink={:?} chip={:?} hue={} channels={} capture_interval={:?} push_source={}",
            usb_plan,
            chip_type,
            has_hue,
            initial_hue.map(|c| c.channels.len()).unwrap_or(0),
            pacing.capture_interval,
            frame_signal.is_some()
        );
        if initial_hue.is_some() {
            log_hue_output(initial_hue);
        }
        let mut hue_send_count = 0u32;
        // Mirror of `hue_send_count` for the USB sink so live-debug sessions
        // can confirm full-strip frames are reaching the wire (e.g. byte
        // count, led_count) without flooding stdout at 60 Hz.
        let mut usb_send_count = 0u32;
        // Scene-adaptive stage (docs/architecture/capture-and-pipeline.md). Off
        // for synthetic test frames, which must reach the strip exactly as
        // painted, and under LUMASYNC_AMBILIGHT_LEGACY=1 for A/B bisecting.
        let scene_enabled =
            !synthetic && std::env::var("LUMASYNC_AMBILIGHT_LEGACY").map_or(true, |v| v != "1");
        let mut pipeline = AmbilightFramePipeline::new(FramePipelineConfig {
            led_sequence,
            led_counts,
            sample_window,
            scene_enabled,
            strip_topology: strip_topology_for(led_calibration.as_ref()),
            hue_channels: hue_output
                .as_ref()
                .and_then(|f| f.context.as_ref())
                .map(|ctx| ctx.channels.clone()),
            room_geometry,
            black_border_detection: live_settings.read_black_border_detection(),
            color_correction,
        });
        pipeline.seed_strip(&initial_sampled, seeded_at);
        info!(
            "[ambilight-worker] scene-adaptive stage {}",
            if scene_enabled { "on" } else { "off" }
        );
        // A test pattern is painted exactly and must reach the lamps that way.
        let hue_motion = if synthetic {
            HueMotion::Snap
        } else {
            HueMotion::Ease
        };
        let has_strip = usb_sink.is_some();

        let mut capture_fail_count = 0u32;
        let mut last_edge_emit_at: Option<Instant> = None;
        // v1.6 LED Preview — monotonic frame seq + last per-Hue-channel colours
        // for the enriched edge-signal (only stamped while a preview is active).
        let mut edge_seq: u64 = 0;
        let mut last_hue_colors: Option<Vec<[u8; 3]>> = None;
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
                        last_hue_colors = None;
                    }
                    pipeline.set_hue_channels(
                        follower.context.as_ref().map(|ctx| ctx.channels.clone()),
                    );
                    reanalyze = true;
                }
            }

            let output_interval = if has_strip {
                quality_state.current_send_interval()
            } else {
                HUE_ONLY_OUTPUT_INTERVAL
            };
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
                            let sampled =
                                (frame.seq != seen_seq).then(|| pipeline.sample_strip(&frame));
                            (frame, sampled)
                        })
                    }
                    Err(_) => Err("AMBILIGHT_CAPTURE_FRAME_LOCK_FAILED".to_string()),
                };
                match captured {
                    Err(e) => {
                        capture_fail_count += 1;
                        if capture_fail_count <= 5 || capture_fail_count.is_multiple_of(50) {
                            warn!("[ambilight-worker] capture failed #{capture_fail_count}: {e}");
                        }
                        // The frame branch owns the only other flush, so without
                        // this one a sustained outage freezes telemetry at the
                        // last good frame.
                        telemetry_window.record_capture_error(&e, Instant::now());
                        let _ = telemetry_window.flush_if_due(Instant::now(), &telemetry_snapshot);
                    }
                    Ok((frame, Some(sampled))) => {
                        seen_seq = frame.seq;
                        let settings = read_frame_settings(&live_settings);
                        let analyzed_at =
                            pipeline.analyze(&frame, sampled, settings, (pacing.clock)());
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
                    Ok((_, None)) => {}
                }
            }

            let mut retuned = false;
            if let (false, Some(frame)) = (new_frame, last_frame.as_ref()) {
                let settings = read_frame_settings(&live_settings);
                if reanalyze || analyzed_with != Some(settings) || pipeline.hue_resample_due() {
                    let sampled = pipeline.sample_strip(frame);
                    pipeline.analyze(frame, sampled, settings, (pacing.clock)());
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
            let send_ms = match usb_sink.as_mut() {
                Some(sink) if quality_state.should_send_now(send_started) => {
                    sink.set_brightness(brightness);
                    sink.set_color_order(color_order);
                    AMBILIGHT_FRAME_ATTEMPTS.fetch_add(1, Ordering::SeqCst);
                    let strip = pipeline.strip_frame();
                    match sink.send_frame(strip) {
                        Ok(()) => {
                            telemetry_window.record_send();
                            unsent_frame = false;
                            // LumaSync v1 wire format: 5-byte header
                            // (magic + brightness + count_le) + RGB payload
                            // (3 bytes per LED) + 1-byte XOR. Adalight's
                            // 6-byte header without the brightness byte
                            // produces a slightly different total — the log
                            // assumes LumaSyncV1 (the production default)
                            // and is observability-only, not load-bearing.
                            let usb_bytes_estimate = 5usize + strip.len().saturating_mul(3) + 1;
                            usb_send_count += 1;
                            if usb_send_count <= 3 || usb_send_count.is_multiple_of(200) {
                                info!(
                                    "[ambilight-worker] usb update #{usb_send_count} — bytes={usb_bytes_estimate} led_count={} frame_age_ms={frame_age_ms}",
                                    strip.len()
                                );
                            }
                            send_started.elapsed().as_secs_f32() * 1000.0
                        }
                        Err(_) => 0.0,
                    }
                }
                _ => 0.0,
            };

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
                // Only the enriched edge-signal reads this; allocating it
                // unconditionally burned a Vec per frame at up to 60 Hz.
                if enrich_preview {
                    last_hue_colors = Some(
                        colors
                            .iter()
                            .map(|c| c.map(|v| (v * 255.0).round().clamp(0.0, 255.0) as u8))
                            .collect(),
                    );
                }
                let _ = apply_hue_channels_with_context(
                    context,
                    colors.to_vec(),
                    brightness,
                    hue_motion,
                );
                last_hue_push = Some(now);
            }

            if new_frame {
                quality_state.observe_capture_and_send_cost(capture_ms, send_ms);
                telemetry_window.record_latency(quality_state.observed_cost_ms());
            }
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
                    let leds: Vec<[u8; 3]> = pipeline
                        .strip_frame()
                        .iter()
                        .map(|&rgb| scale_brightness(pipeline.correct_rgb(rgb), brightness))
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
