//! The ambilight worker's computation with every I/O edge cut off: no capture,
//! no sink, no telemetry. Two halves, run at different rates: `analyze` once
//! per new frame (sampling, the scene stage, live saturation, the smoothing
//! targets), and `advance` on every output step (time-based smoothing, then
//! the colour pipeline for Hue). Time comes in as an argument, so the checks in
//! `frame_pipeline_tests` drive the same code the worker does —
//! docs/architecture/capture-and-pipeline.md.

use std::sync::Arc;
use std::time::{Duration, Instant};

use log::info;

use super::smoothing::{TimeSmoother, SMOOTHING_REFERENCE_INTERVAL};
use super::{
    hue_sample_table, sample_screen_position_avg, BlackBorderCache, HueSampleTable,
    RoomGeometryLive,
};
use crate::commands::ambilight_capture::CapturedFrame;
use crate::commands::ambilight_scene::{LightSetState, LightTopology, SceneAnalyzer};
use crate::commands::hue::frame::{HueAreaChannel, HueRgb};
use crate::commands::led_calibration::{
    sample_frame_within_insets, LedCalibrationConfig, LedSegmentCounts, LedSequenceItem,
};
use crate::commands::led_output::{apply_saturation_to_pixel, ColorCorrectionConfig, EncoderPlan};

const SCENE_LOG_EVERY: u32 = 600;

fn saturate(colors: &mut [[u8; 3]], factor: f32) {
    for pixel in colors {
        let saturated = apply_saturation_to_pixel(*pixel, factor);
        pixel.copy_from_slice(&saturated);
    }
}

/// Chain topology of the calibrated strip: closed only for a full perimeter.
pub(super) fn strip_topology_for(led_calibration: Option<&LedCalibrationConfig>) -> LightTopology {
    LightTopology::Chain {
        closed: led_calibration.is_some_and(|cal| {
            cal.counts.top > 0
                && cal.counts.right > 0
                && cal.counts.bottom > 0
                && cal.counts.left > 0
                && cal.bottom_missing == 0
        }),
    }
}

/// Everything fixed for a worker's lifetime. A change to any of it restarts
/// the worker (see the fast-path guard in `apply_mode_change`), except the
/// room geometry, which arrives live through its cell.
pub(super) struct FramePipelineConfig {
    pub led_sequence: Vec<LedSequenceItem>,
    pub led_counts: LedSegmentCounts,
    pub sample_window: f32,
    pub scene_enabled: bool,
    pub strip_topology: LightTopology,
    /// `None` with no Hue output at all; `Some(empty)` is an area that
    /// resolved no channels, and still builds its (empty) table.
    pub hue_channels: Option<Vec<HueAreaChannel>>,
    pub room_geometry: Arc<RoomGeometryLive>,
    pub black_border_detection: bool,
    pub color_correction: ColorCorrectionConfig,
}

/// The `AmbilightLiveSettings` values the analysis reads, sampled once per
/// frame by the worker.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) struct FrameSettings {
    pub black_border_detection: bool,
    pub alpha_ceiling: f32,
    pub saturation: f32,
}

pub(super) struct AmbilightFramePipeline {
    led_sequence: Vec<LedSequenceItem>,
    led_counts: LedSegmentCounts,
    sample_window: f32,
    scene_enabled: bool,
    scene: SceneAnalyzer,
    strip_topology: LightTopology,
    strip_scene_state: LightSetState,
    scene_frame_count: u32,
    border_cache: BlackBorderCache,
    hue_channels: Option<Vec<HueAreaChannel>>,
    room_geometry: Arc<RoomGeometryLive>,
    room_generation: u64,
    hue_table: HueSampleTable,
    hue_scene_state: LightSetState,
    hue_scene_scratch: Vec<[u8; 3]>,
    plan: EncoderPlan,
    /// The scene stage's α for the newest frame, per reference interval.
    frame_alpha: f32,
    last_analysis: Option<Instant>,
    last_advance: Option<Instant>,
    strip: TimeSmoother,
    strip_out: Vec<[u8; 3]>,
    hue: TimeSmoother,
    hue_out: Vec<HueRgb>,
}

impl AmbilightFramePipeline {
    pub(super) fn new(config: FramePipelineConfig) -> Self {
        let (room_generation, initial_geometry) = config.room_geometry.snapshot();
        let hue_table = config
            .hue_channels
            .as_ref()
            .map_or_else(HueSampleTable::empty, |channels| {
                hue_sample_table(channels, initial_geometry.as_ref())
            });
        Self {
            led_sequence: config.led_sequence,
            led_counts: config.led_counts,
            sample_window: config.sample_window,
            scene_enabled: config.scene_enabled,
            scene: SceneAnalyzer::new(),
            strip_topology: config.strip_topology,
            strip_scene_state: LightSetState::default(),
            scene_frame_count: 0,
            border_cache: BlackBorderCache::new(config.black_border_detection),
            hue_channels: config.hue_channels,
            room_geometry: config.room_geometry,
            room_generation,
            hue_table,
            hue_scene_state: LightSetState::default(),
            hue_scene_scratch: Vec::new(),
            // Built once: color_correction is fixed for the worker's lifetime
            // (any change forces a restart, guard at apply_mode_change).
            plan: EncoderPlan::new(&config.color_correction),
            frame_alpha: 1.0,
            last_analysis: None,
            last_advance: None,
            strip: TimeSmoother::default(),
            strip_out: Vec::new(),
            hue: TimeSmoother::default(),
            hue_out: Vec::new(),
        }
    }

    /// The Hue stream the worker follows was replaced or went away. A
    /// reconnect or restart may bring other channels, so the table is rebuilt;
    /// `None` stops Hue sampling until a stream is back.
    pub(super) fn set_hue_channels(&mut self, channels: Option<Vec<HueAreaChannel>>) {
        if let Some(channels) = channels.as_deref() {
            let (seen, geometry) = self.room_geometry.snapshot();
            self.room_generation = seen;
            self.hue_table = hue_sample_table(channels, geometry.as_ref());
        }
        self.hue_channels = channels;
    }

    /// A room-map change moved where the Hue channels sample since the last
    /// analysis. The worker re-analyses the frame it has for it: a still
    /// screen brings no new frame to carry the change.
    pub(super) fn hue_resample_due(&self) -> bool {
        self.hue_channels
            .as_deref()
            .is_some_and(|channels| !channels.is_empty())
            && self.room_geometry.generation() != self.room_generation
    }

    /// Per-LED colours of the strip, in physical order, sampled inside the
    /// black-border insets. The worker calls this while it still holds the
    /// frame source, before `analyze`, so the border cache is refreshed here:
    /// the strip, the scene stage and Hue then crop the frame identically.
    pub(super) fn sample_strip(&mut self, frame: &CapturedFrame) -> Vec<[u8; 3]> {
        self.border_cache.update_if_due(frame);
        sample_frame_within_insets(
            frame,
            &self.led_sequence,
            &self.led_counts,
            self.sample_window,
            self.border_cache.insets(),
        )
    }

    /// The warm-up frame the worker sent before the pipeline existed: the
    /// strip's smoother starts from it, at `now`.
    pub(super) fn seed_strip(&mut self, sampled: &[[u8; 3]], now: Instant) {
        self.strip.seed(sampled);
        self.last_advance = Some(now);
        self.refresh_strip_out();
    }

    /// The correction the strip's sink applies, for the twin overlay's feed.
    pub(super) fn correct_rgb(&self, rgb: [u8; 3]) -> [u8; 3] {
        self.plan.correct(rgb)
    }

    /// One new frame, after `sample_strip`: the scene stage, live saturation,
    /// and the new smoothing targets for the strip and Hue. Returns when the
    /// analysis ended, where the worker's capture cost stops. Call once per
    /// frame `seq`; `now` is the smoothing clock.
    pub(super) fn analyze(
        &mut self,
        raw_frame: &CapturedFrame,
        mut sampled: Vec<[u8; 3]>,
        settings: FrameSettings,
        now: Instant,
    ) -> Instant {
        // The setting is read after capture, so a toggle reaches the strip at
        // the next `sample_strip`. Switching off clears the insets here, which
        // lets Hue and the scene stage drop the crop one frame before the strip.
        self.border_cache
            .set_enabled(settings.black_border_detection);
        let since_previous = self
            .last_analysis
            .map_or(SMOOTHING_REFERENCE_INTERVAL, |at| {
                now.saturating_duration_since(at)
            });
        self.last_analysis = Some(now);
        // The old targets held until this moment: the smoothers get there
        // under them before the switch, so when an output step happens to run
        // never changes what the lights show.
        self.step_smoothers(now);
        // The preset is a ceiling; the scene stage decides how much of it this
        // frame gets to use, and every sink reads the same answer.
        let alpha_ceiling = settings.alpha_ceiling;
        self.frame_alpha = if self.scene_enabled {
            self.scene.observe_frame_after(
                raw_frame,
                self.border_cache.insets(),
                alpha_ceiling,
                since_previous,
            );
            self.scene.process(
                &mut sampled,
                &self.strip_topology,
                &[],
                &mut self.strip_scene_state,
            );
            self.scene_frame_count += 1;
            if self.scene_frame_count <= 2 || self.scene_frame_count.is_multiple_of(SCENE_LOG_EVERY)
            {
                let scene_frame_count = self.scene_frame_count;
                let (ss, sm, sp, sl) = self.strip_scene_state.debug_tuple();
                let (hs, hm, hp, hl) = self.hue_scene_state.debug_tuple();
                info!(
                    "[ambilight-worker] scene #{scene_frame_count} — alpha={:.3}/{alpha_ceiling:.3} change={:.3} env={:.3} ambience={:?} strip[sigma={ss:.2} med={sm:.2} spread={sp:.2} lean={sl:.2}] hue[sigma={hs:.2} med={hm:.2} spread={hp:.2} lean={hl:.2}]",
                    self.scene.alpha(),
                    self.scene.last_change(),
                    self.scene.change_envelope(),
                    self.scene.ambience_srgb()
                );
            }
            self.scene.alpha()
        } else {
            alpha_ceiling
        };
        let analyzed_at = Instant::now();
        // Live saturation lands on the smoothing target, before the smoother,
        // for every sink alike; the device calibration's own saturation is a
        // stage of `plan` and comes after it.
        saturate(&mut sampled, settings.saturation);
        self.strip.set_target(&sampled);
        self.retarget_hue(raw_frame, settings.saturation);
        analyzed_at
    }

    /// Runs after the strip, so the scene stage has already observed this
    /// frame and resolved its alpha.
    fn retarget_hue(&mut self, raw_frame: &CapturedFrame, saturation: f32) {
        let Some(channels) = self
            .hue_channels
            .as_deref()
            .filter(|channels| !channels.is_empty())
        else {
            return;
        };
        if self.room_geometry.generation() != self.room_generation {
            let (seen, geometry) = self.room_geometry.snapshot();
            self.room_generation = seen;
            self.hue_table = hue_sample_table(channels, geometry.as_ref());
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
        saturate(&mut self.hue_scene_scratch, saturation);
        self.hue.set_target(&self.hue_scene_scratch);
    }

    fn step_smoothers(&mut self, now: Instant) {
        let dt = self
            .last_advance
            .map_or(Duration::ZERO, |at| now.saturating_duration_since(at));
        self.last_advance = Some(now);
        self.strip.advance(dt, self.frame_alpha);
        self.hue.advance(dt, self.frame_alpha);
    }

    /// Move both smoothers to `now` — by the time that passed, not by the
    /// number of calls — and refresh what `strip_frame` and `hue_colors` read.
    pub(super) fn advance(&mut self, now: Instant) {
        self.step_smoothers(now);
        self.refresh_strip_out();
        self.hue_out.clear();
        let plan = &self.plan;
        self.hue_out.extend(
            self.hue
                .state()
                .iter()
                .map(|&rgb| plan.correct_precise(rgb)),
        );
    }

    fn refresh_strip_out(&mut self) {
        self.strip_out.clear();
        self.strip_out.extend(
            self.strip
                .state()
                .iter()
                .map(|rgb| rgb.map(|v| v.round().clamp(0.0, 255.0) as u8)),
        );
    }

    #[cfg(test)]
    pub(super) fn strip_state(&self) -> &[[f32; 3]] {
        self.strip.state()
    }

    /// The smoothed strip, for the sink (which corrects and encodes it) and
    /// the twin overlay.
    pub(super) fn strip_frame(&self) -> &[[u8; 3]] {
        &self.strip_out
    }

    /// Smoothed, corrected colour per Hue channel on the wire's 0–1 scale;
    /// `None` without channels or before the first frame reached them.
    pub(super) fn hue_colors(&self) -> Option<&[HueRgb]> {
        let channels = self.hue_channels.as_deref()?;
        (!channels.is_empty() && self.hue_out.len() == channels.len())
            .then_some(self.hue_out.as_slice())
    }
}
