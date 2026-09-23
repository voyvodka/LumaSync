//! The ambilight worker's per-frame computation with every I/O edge cut off:
//! no capture, no sink, no telemetry, no clock except the one timestamp the
//! worker's cost figure needs. The worker and the frame-budget checks in
//! `frame_pipeline_tests` drive this same code, which is what makes those
//! checks mean anything — docs/architecture/capture-and-pipeline.md.

use std::sync::Arc;
use std::time::Instant;

use log::info;

use super::{
    apply_saturation_inplace, hue_sample_table, sample_screen_position_avg,
    AmbilightWorkerQualityState, BlackBorderCache, HueChannelSmoother, HueSampleTable,
    RoomGeometryLive,
};
use crate::commands::ambilight_capture::CapturedFrame;
use crate::commands::ambilight_scene::{LightSetState, LightTopology, SceneAnalyzer};
use crate::commands::hue::frame::HueAreaChannel;
use crate::commands::led_calibration::{
    sample_frame_for_sequence, LedCalibrationConfig, LedSegmentCounts, LedSequenceItem,
};
use crate::commands::led_output::{
    apply_color_correction_rgb_with_luts, gamma_luts_for, ColorCorrectionConfig, GammaLuts,
};
use crate::commands::runtime_quality::RuntimeFrameSlot;

const SCENE_LOG_EVERY: u32 = 600;

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

/// The `AmbilightLiveSettings` values the step reads, sampled once per frame
/// by the worker.
#[derive(Clone, Copy, Debug)]
pub(super) struct FrameSettings {
    pub black_border_detection: bool,
    pub alpha_ceiling: f32,
    pub saturation: f32,
}

pub(super) struct FrameStep<'a> {
    /// End of the strip analysis — where the worker's capture cost stops.
    pub analyzed_at: Instant,
    /// The queued strip frame replaced one that was never sent.
    pub slot_overwritten: bool,
    /// Corrected, smoothed colour per Hue channel; `None` without channels.
    pub hue_colors: Option<&'a [(u8, u8, u8)]>,
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
    hue_corrected: Vec<(u8, u8, u8)>,
    hue_channel_smoother: HueChannelSmoother,
    color_correction: ColorCorrectionConfig,
    frame_luts: std::borrow::Cow<'static, GammaLuts>,
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
        // Hoisted out of the frame loop: a non-2.2 gamma makes `gamma_luts_for`
        // run 768 `powf`s, and color_correction is fixed for the worker's
        // lifetime — any change forces a full restart (guard at apply_mode_change).
        let frame_luts = gamma_luts_for(&config.color_correction);
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
            hue_corrected: Vec::new(),
            hue_channel_smoother: HueChannelSmoother::new(),
            color_correction: config.color_correction,
            frame_luts,
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

    /// Per-LED colours of the strip, in physical order. The worker calls this
    /// while it still holds the frame source.
    pub(super) fn sample_strip(&self, frame: &CapturedFrame) -> Vec<[u8; 3]> {
        sample_frame_for_sequence(
            frame,
            &self.led_sequence,
            &self.led_counts,
            self.sample_window,
        )
    }

    /// The same correction the Hue colours get, for the twin overlay's feed.
    pub(super) fn correct_rgb(&self, rgb: (u8, u8, u8)) -> (u8, u8, u8) {
        apply_color_correction_rgb_with_luts(rgb, &self.color_correction, &self.frame_luts)
    }

    /// One frame: border cache, scene stage, strip smoothing into `frame_slot`,
    /// then the Hue channels. Sending is the caller's.
    pub(super) fn process(
        &mut self,
        raw_frame: &CapturedFrame,
        mut sampled: Vec<[u8; 3]>,
        settings: FrameSettings,
        quality_state: &mut AmbilightWorkerQualityState,
        frame_slot: &mut RuntimeFrameSlot,
    ) -> FrameStep<'_> {
        // Border cache is refreshed each iteration from live_settings.
        self.border_cache
            .set_enabled(settings.black_border_detection);
        // Update black border detection cache from the raw (uncropped) frame.
        self.border_cache.update_if_due(raw_frame);
        // The preset is a ceiling; the scene stage decides how much of it this
        // frame gets to use, and every sink reads the same answer.
        let alpha_ceiling = settings.alpha_ceiling;
        let frame_alpha = if self.scene_enabled {
            self.scene
                .observe_frame(raw_frame, self.border_cache.insets(), alpha_ceiling);
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
        quality_state.set_smoothing_alpha(frame_alpha);
        let analyzed_at = Instant::now();
        // Apply saturation before smoothing/sending so the quality gate sees
        // the corrected colors and temporal smoothing operates on final values.
        apply_saturation_inplace(&mut sampled, settings.saturation);
        let slot_overwritten = quality_state.queue_processed_frame(frame_slot, sampled.as_slice());

        FrameStep {
            analyzed_at,
            slot_overwritten,
            hue_colors: self.hue_colors(raw_frame, frame_alpha),
        }
    }

    /// Runs after the strip, so the scene stage has already observed this
    /// frame and resolved its alpha.
    fn hue_colors(
        &mut self,
        raw_frame: &CapturedFrame,
        frame_alpha: f32,
    ) -> Option<&[(u8, u8, u8)]> {
        let channels = self
            .hue_channels
            .as_deref()
            .filter(|channels| !channels.is_empty())?;
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
        self.hue_corrected.clear();
        self.hue_corrected
            .extend(self.hue_scene_scratch.iter().map(|&[r, g, b]| {
                apply_color_correction_rgb_with_luts(
                    (r, g, b),
                    &self.color_correction,
                    &self.frame_luts,
                )
            }));
        Some(
            self.hue_channel_smoother
                .smooth(&self.hue_corrected, frame_alpha),
        )
    }
}
