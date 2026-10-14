//! Where the worker samples the screen: the black-border cache, the Hue
//! position windows and the per-channel sample table.

use std::ops::Range;
use std::time::{Duration, Instant};

use log::{info, warn};

use crate::commands::ambilight_capture::{
    detect_black_borders, BlackBorderInsets, CapturedFrame, BLACK_BORDER_THRESHOLD,
};
use crate::commands::ambilight_scene::{hue_default_screen_affinity, LightTopology};
use crate::commands::led_calibration::{
    build_led_sequence, LedCalibrationConfig, LedSegmentCounts, LedSequenceItem, StripShape,
};
use crate::commands::room_affinity::{room_aware_hue_samples, room_geometry_rejection};
use crate::models::room_map::RoomGeometry;

/// The black-border insets the worker samples inside, kept steady.
///
/// Detection runs at most every `UPDATE_INTERVAL`. A frame with nothing to
/// measure (black, a fade) changes nothing, and a new answer moves an axis —
/// the letterbox rows or the pillarbox columns, each on its own — only once
/// `STABLE_READS` reads in a row agree on it to within a scan step, so a
/// subtitle, a logo or one dark shot does not move the crop. The first answer
/// after detection is switched on is taken at once. When disabled all insets
/// stay zero (full-frame sampling).
pub(super) struct BlackBorderCache {
    insets: BlackBorderInsets,
    rows: AxisCandidate,
    cols: AxisCandidate,
    settled: bool,
    changed: bool,
    last_updated: Instant,
    enabled: bool,
}

/// A depth one axis has read but not yet taken, and how many reads agreed.
#[derive(Default)]
struct AxisCandidate(Option<(f32, u8)>);

impl AxisCandidate {
    /// Whether `read` has now held long enough to replace `current`.
    fn holds(&mut self, current: f32, read: f32, tolerance: f32) -> bool {
        if (read - current).abs() <= tolerance {
            self.0 = None;
            return false;
        }
        let reads = match self.0 {
            Some((candidate, reads)) if (read - candidate).abs() <= tolerance => reads + 1,
            _ => 1,
        };
        if reads >= BlackBorderCache::STABLE_READS {
            self.0 = None;
            true
        } else {
            self.0 = Some((read, reads));
            false
        }
    }
}

impl BlackBorderCache {
    const UPDATE_INTERVAL: Duration = Duration::from_millis(500);
    const STABLE_READS: u8 = 3;

    pub(super) fn new(enabled: bool) -> Self {
        Self {
            insets: BlackBorderInsets::default(),
            rows: AxisCandidate::default(),
            cols: AxisCandidate::default(),
            settled: false,
            changed: false,
            last_updated: Self::due_now(),
            enabled,
        }
    }

    /// An `Instant` one interval ago, so the next frame triggers a detection pass.
    fn due_now() -> Instant {
        Instant::now()
            .checked_sub(Self::UPDATE_INTERVAL)
            .unwrap_or_else(Instant::now)
    }

    pub(super) fn set_enabled(&mut self, enabled: bool) {
        if self.enabled == enabled {
            return;
        }
        self.enabled = enabled;
        self.rows = AxisCandidate::default();
        self.cols = AxisCandidate::default();
        self.settled = false;
        if enabled {
            self.last_updated = Self::due_now();
        } else if self.insets != BlackBorderInsets::default() {
            self.insets = BlackBorderInsets::default();
            self.changed = true;
        }
    }

    pub(super) fn update_if_due(&mut self, frame: &CapturedFrame) {
        if !self.enabled || self.last_updated.elapsed() < Self::UPDATE_INTERVAL {
            return;
        }
        self.last_updated = Instant::now();
        // One scan step of the detector, as a fraction of each axis.
        let step = |len: u32| 8.0 / len.max(1) as f32;
        self.absorb(
            detect_black_borders(frame, BLACK_BORDER_THRESHOLD),
            (step(frame.height), step(frame.width)),
        );
    }

    fn absorb(&mut self, read: Option<BlackBorderInsets>, (row_step, col_step): (f32, f32)) {
        let Some(read) = read else {
            return;
        };
        let mut next = self.insets.clone();
        if !self.settled {
            self.settled = true;
            next = read;
        } else {
            if self.rows.holds(self.insets.top, read.top, row_step) {
                (next.top, next.bottom) = (read.top, read.bottom);
            }
            if self.cols.holds(self.insets.left, read.left, col_step) {
                (next.left, next.right) = (read.left, read.right);
            }
        }
        if next != self.insets {
            self.insets = next;
            self.changed = true;
        }
    }

    pub(super) fn insets(&self) -> &BlackBorderInsets {
        &self.insets
    }

    /// Whether the insets moved since the last call: the scene stage then
    /// measures this frame's change against a different rectangle and must
    /// not read the move as a cut.
    pub(super) fn take_changed(&mut self) -> bool {
        std::mem::take(&mut self.changed)
    }
}

/// The picture inside the black-border bars as half-open `(rows, cols)` pixel
/// ranges — what [`BlackBorderInsets::content_bounds`] returns.
pub(super) type ContentBounds = (Range<usize>, Range<usize>);

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
///
/// `content` is [`BlackBorderInsets::content_bounds`] for this frame. The
/// caller computes it once per frame and hands it to every channel, rather
/// than each channel re-deriving the same rectangle from the insets.
pub(super) fn sample_screen_position_avg(
    frame: &CapturedFrame,
    pos_x: f32,
    pos_y: f32,
    content: &ContentBounds,
) -> (u8, u8, u8) {
    let w = frame.width as usize;
    let h = frame.height as usize;
    if w == 0 || h == 0 || frame.pixels_rgb.is_empty() {
        return (0, 0, 0);
    }

    const WINDOW_FRAC: f32 = 0.30; // 30% of content dimension
    const STEP: usize = 8;

    let (rows, cols) = content;
    let (ct, cb, cl, cr) = (rows.start, rows.end, cols.start, cols.end);
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

/// Sampling box for live capture — deliberately wide so screen noise averages out.
pub const LIVE_SAMPLE_WINDOW: f32 = 0.05;
/// Sampling box for synthetic test frames. Must stay NARROWER than one LED's
/// pitch or neighbouring LEDs blend into each other and no LED can reach the
/// intensity the pattern asked for.
pub const SYNTHETIC_SAMPLE_WINDOW: f32 = 0.0125;
/// Sampling box for a strip with no layout on record — the legacy single-zone device, which shows
/// one colour for the whole strip. The half-window is `content * window / 2`, so at 2.0 it is at
/// least the whole content rectangle from any position: the lone LED takes the picture's mean
/// (inside any black bars) instead of the corner a one-LED segment maps to.
pub const WHOLE_FRAME_SAMPLE_WINDOW: f32 = 2.0;

/// The strip the worker samples: the layout on record; without one, a single LED (backward-compat
/// with v1.3 firmware) — but only when a strip output reads it. With neither a layout nor a strip
/// output (Hue alone) there is no strip: a fallback LED there was sampled every frame for nothing,
/// and stood in an effect's bounds as a light that does not exist.
pub(super) fn strip_for_worker(
    led_calibration: Option<&LedCalibrationConfig>,
    strip_output: bool,
) -> (Vec<LedSequenceItem>, StripShape, u16) {
    if let Some(cal) = led_calibration {
        return (build_led_sequence(cal), StripShape::of(cal), cal.total_leds);
    }
    let leds = u16::from(strip_output);
    let fallback = LedCalibrationConfig {
        template_id: None,
        counts: LedSegmentCounts {
            top: leds,
            right: 0,
            bottom: 0,
            left: 0,
        },
        bottom_missing: 0,
        corner_ownership: "horizontal".to_string(),
        visual_preset: "subtle".to_string(),
        start_anchor: "top-start".to_string(),
        start_local_index: None,
        direction: "cw".to_string(),
        total_leds: leds,
    };
    (
        build_led_sequence(&fallback),
        StripShape::of(&fallback),
        leds,
    )
}

/// Which box the strip samples with. A synthetic test paints exact per-LED blocks; a strip with no
/// layout takes the whole picture; anything else the live box. Without a strip output (Hue only)
/// the strip sample is thrown away, so it keeps the cheap live box rather than averaging the frame
/// for nothing.
pub(super) fn sample_window_for(synthetic: bool, has_layout: bool, has_strip: bool) -> f32 {
    if synthetic {
        SYNTHETIC_SAMPLE_WINDOW
    } else if !has_layout && has_strip {
        WHOLE_FRAME_SAMPLE_WINDOW
    } else {
        LIVE_SAMPLE_WINDOW
    }
}

/// Per-channel Hue inputs the worker holds between frames: where each channel
/// samples the screen, and what the scene stage relates it by. Rebuilt only when
/// the room geometry generation moves, never per frame.
pub(super) struct HueSampleTable {
    pub(super) topology: LightTopology,
    pub(super) affinity: Vec<f32>,
    pub(super) sample_points: Vec<(f32, f32)>,
}

impl HueSampleTable {
    pub(super) fn empty() -> Self {
        Self {
            topology: LightTopology::Points(Vec::new()),
            affinity: Vec::new(),
            sample_points: Vec::new(),
        }
    }
}

/// `None` geometry, or geometry that fails validation, is exactly the legacy
/// table. With geometry, the room map's placements are overlaid onto the
/// stream's channels by `channel_id` first, because the stream's copy is fixed
/// at stream start and the room map's is the one a drag moves.
pub(super) fn hue_sample_table(
    channels: &[crate::commands::hue::frame::HueAreaChannel],
    geometry: Option<&RoomGeometry>,
) -> HueSampleTable {
    if let Some(geometry) = geometry {
        let mut placed = channels.to_vec();
        crate::commands::hue::sender::apply_channel_placements(
            &mut placed,
            &geometry.hue_placements,
        );
        if let Some(samples) = room_aware_hue_samples(geometry, &placed) {
            info!(
                "[room-geometry] applied — channels={} placements={}",
                placed.len(),
                geometry.hue_placements.len()
            );
            let (topology, _) = hue_topology_and_affinity(&placed);
            return HueSampleTable {
                topology,
                affinity: samples.iter().map(|s| s.affinity).collect(),
                sample_points: samples.iter().map(|s| (s.sample_x, s.sample_y)).collect(),
            };
        }
        warn!(
            "[room-geometry] rejected — {}; sampling by the bridge positions instead",
            room_geometry_rejection(geometry).unwrap_or("invalid geometry")
        );
    }
    let (topology, affinity) = hue_topology_and_affinity(channels);
    HueSampleTable {
        topology,
        affinity,
        sample_points: channels
            .iter()
            .map(|ch| (ch.position_x, ch.position_y))
            .collect(),
    }
}

/// Legacy scene-stage inputs for the Hue set, from `x`/`y` alone: depth stands
/// in for screen vertical and a channel's height is not read. The room-aware
/// path (`hue_sample_table` with geometry) is the only reader of height.
pub(super) fn hue_topology_and_affinity(
    channels: &[crate::commands::hue::frame::HueAreaChannel],
) -> (LightTopology, Vec<f32>) {
    (
        LightTopology::Points(
            channels
                .iter()
                .map(|ch| (ch.position_x, ch.position_y))
                .collect(),
        ),
        channels
            .iter()
            .map(|ch| hue_default_screen_affinity(ch.position_y))
            .collect(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// One scan step of a 640x360 frame.
    const STEP: (f32, f32) = (8.0 / 360.0, 8.0 / 640.0);

    impl BlackBorderCache {
        fn absorb_read(&mut self, read: Option<BlackBorderInsets>) {
            self.absorb(read, STEP);
        }
    }

    fn bars(rows: f32) -> BlackBorderInsets {
        BlackBorderInsets {
            top: rows,
            bottom: rows,
            ..Default::default()
        }
    }

    #[test]
    fn the_first_answer_is_taken_at_once() {
        let mut cache = BlackBorderCache::new(true);
        cache.absorb_read(Some(bars(0.13)));
        assert_eq!(cache.insets(), &bars(0.13));
        assert!(cache.take_changed());
        assert!(!cache.take_changed());
    }

    // A fade or a cut through black must not drop the crop until the picture is back.
    #[test]
    fn a_frame_with_nothing_to_measure_keeps_the_crop() {
        let mut cache = BlackBorderCache::new(true);
        cache.absorb_read(Some(bars(0.13)));
        cache.take_changed();
        cache.absorb_read(None);
        assert_eq!(cache.insets(), &bars(0.13));
        assert!(!cache.take_changed());
    }

    // A subtitle or one dark shot lasts a read or two; the crop waits for an answer that holds.
    #[test]
    fn a_new_crop_waits_until_reads_agree_on_it() {
        let mut cache = BlackBorderCache::new(true);
        cache.absorb_read(Some(bars(0.13)));
        cache.absorb_read(Some(bars(0.05)));
        cache.absorb_read(Some(bars(0.05)));
        assert_eq!(cache.insets(), &bars(0.13));
        cache.absorb_read(Some(bars(0.13)));
        cache.absorb_read(Some(bars(0.05)));
        cache.absorb_read(Some(bars(0.05)));
        assert_eq!(
            cache.insets(),
            &bars(0.13),
            "an agreeing read starts the count again"
        );
        cache.absorb_read(Some(bars(0.05)));
        assert_eq!(cache.insets(), &bars(0.05));
    }

    #[test]
    fn switching_detection_off_drops_the_crop_and_on_again_reads_at_once() {
        let mut cache = BlackBorderCache::new(true);
        cache.absorb_read(Some(bars(0.13)));
        cache.take_changed();
        cache.set_enabled(false);
        assert_eq!(cache.insets(), &BlackBorderInsets::default());
        assert!(cache.take_changed());
        cache.set_enabled(true);
        assert!(cache.last_updated.elapsed() >= BlackBorderCache::UPDATE_INTERVAL);
        cache.absorb_read(Some(bars(0.13)));
        assert_eq!(cache.insets(), &bars(0.13));
    }

    // Detection quantises to a scan step; a read one step off is the same crop.
    #[test]
    fn reads_within_a_scan_step_agree() {
        let mut cache = BlackBorderCache::new(true);
        cache.absorb_read(Some(bars(0.0)));
        cache.absorb_read(Some(bars(0.13)));
        cache.absorb_read(Some(bars(0.135)));
        cache.absorb_read(Some(bars(0.13)));
        assert_eq!(cache.insets(), &bars(0.13));
        cache.take_changed();
        cache.absorb_read(Some(bars(0.135)));
        assert_eq!(
            cache.insets(),
            &bars(0.13),
            "a step's wobble does not move the crop"
        );
        assert!(!cache.take_changed());
    }

    // A letterbox settling must not wait on, or be reset by, the pillarbox columns.
    #[test]
    fn each_axis_settles_on_its_own() {
        let mut cache = BlackBorderCache::new(true);
        cache.absorb_read(Some(BlackBorderInsets::default()));
        for left in [0.1, 0.0, 0.1] {
            cache.absorb_read(Some(BlackBorderInsets {
                left,
                right: left,
                ..bars(0.13)
            }));
        }
        assert_eq!(cache.insets().top, 0.13);
        assert_eq!(cache.insets().left, 0.0);
    }
}
