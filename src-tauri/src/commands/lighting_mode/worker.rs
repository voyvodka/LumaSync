//! The ambilight worker thread: capture, the per-frame step, and the sends to
//! every configured output. The computation itself is `frame_pipeline`; this
//! file keeps only the I/O around it — docs/architecture/capture-and-pipeline.md.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use log::{info, warn};

use super::frame_pipeline::{
    strip_topology_for, AmbilightFramePipeline, FramePipelineConfig, FrameSettings,
};
use super::{
    resolve_quality_config, ActiveUsbSink, AmbilightLiveSettings, AmbilightWorkerQualityState,
    EdgeSignalEmitter, EdgeSignalPayload, LightingWorkerRuntime, PreviewEmitContext,
    RoomGeometryLive, UsbOutputPlan, ACTIVE_AMBILIGHT_WORKERS, AMBILIGHT_CAPTURE_ATTEMPTS,
    AMBILIGHT_FRAME_ATTEMPTS, EDGE_SIGNAL_PREVIEW_INTERVAL_MS, LIVE_SAMPLE_WINDOW,
    SYNTHETIC_SAMPLE_WINDOW,
};
use crate::commands::ambilight_capture::{AmbilightFrameSource, CapturedFrame, StaticFrameSource};
use crate::commands::hue::state_store::{
    apply_hue_channels_with_context, HueActiveOutputContext, HueOutputLive,
};
use crate::commands::led_calibration::{
    build_led_sequence, sample_frame_for_sequence, LedCalibrationConfig,
};
use crate::commands::led_output::{
    ColorCorrectionConfig, FirmwareProfile, LedChipType, LedOutputBridge, SerialSink,
};
use crate::commands::runtime_quality::RuntimeFrameSlot;
use crate::commands::runtime_telemetry::{RuntimeTelemetryWindow, SharedRuntimeTelemetry};
use crate::commands::wled_sink::CorrectedWledSink;

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
    let hue_only = usb_plan.is_none()
        && hue_output
            .as_ref()
            .is_some_and(|follower| follower.context.is_some());
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
        let initial_hue = hue_output.as_ref().and_then(|f| f.context.as_ref());
        let has_hue = initial_hue.map(|c| !c.channels.is_empty()).unwrap_or(false);
        info!(
            "[ambilight-worker] started — sink={:?} chip={:?} hue={} channels={}",
            usb_plan,
            chip_type,
            has_hue,
            initial_hue.map(|c| c.channels.len()).unwrap_or(0)
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
        let scene_enabled = preview.as_ref().is_none_or(|ctx| ctx.source != "test")
            && std::env::var("LUMASYNC_AMBILIGHT_LEGACY").map_or(true, |v| v != "1");
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
            if let Some(follower) = hue_output.as_mut() {
                if follower.refresh() {
                    log_hue_output(follower.context.as_ref());
                    if follower.context.is_none() {
                        last_hue_colors = None;
                    }
                    pipeline.set_hue_channels(
                        follower.context.as_ref().map(|ctx| ctx.channels.clone()),
                    );
                }
            }
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

                let hue_context = hue_output.as_ref().and_then(|f| f.context.as_ref());
                if let (Some(context), Some(smoothed)) = (hue_context, step.hue_colors) {
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
