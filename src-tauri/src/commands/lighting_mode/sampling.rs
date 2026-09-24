//! Where the worker samples the screen: the black-border cache, the Hue
//! position windows and the per-channel sample table.

use std::ops::Range;
use std::time::{Duration, Instant};

use log::{info, warn};

use crate::commands::ambilight_capture::{
    detect_black_borders, BlackBorderInsets, CapturedFrame, BLACK_BORDER_THRESHOLD,
};
use crate::commands::ambilight_scene::{hue_default_screen_affinity, LightTopology};
use crate::commands::room_affinity::{room_aware_hue_samples, room_geometry_rejection};
use crate::models::room_map::RoomGeometry;

/// Periodically caches detected black border insets for the ambilight worker.
///
/// Detection runs at most once every `UPDATE_INTERVAL` to avoid per-frame overhead.
/// When disabled all insets remain zero (full-frame sampling).
pub(super) struct BlackBorderCache {
    insets: BlackBorderInsets,
    last_updated: Instant,
    enabled: bool,
}

impl BlackBorderCache {
    const UPDATE_INTERVAL: Duration = Duration::from_millis(2500);

    pub(super) fn new(enabled: bool) -> Self {
        // Subtract the interval so the very first frame triggers a detection pass.
        let past = Instant::now()
            .checked_sub(Self::UPDATE_INTERVAL)
            .unwrap_or_else(Instant::now);
        Self {
            insets: BlackBorderInsets::default(),
            last_updated: past,
            enabled,
        }
    }

    pub(super) fn set_enabled(&mut self, enabled: bool) {
        if self.enabled != enabled {
            self.enabled = enabled;
            if !enabled {
                self.insets = BlackBorderInsets::default();
            }
        }
    }

    pub(super) fn update_if_due(&mut self, frame: &CapturedFrame) {
        if !self.enabled {
            self.insets = BlackBorderInsets::default();
            return;
        }
        if self.last_updated.elapsed() >= Self::UPDATE_INTERVAL {
            self.insets = detect_black_borders(frame, BLACK_BORDER_THRESHOLD);
            self.last_updated = Instant::now();
        }
    }

    pub(super) fn insets(&self) -> &BlackBorderInsets {
        &self.insets
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
