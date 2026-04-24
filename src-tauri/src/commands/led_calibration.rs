/// Rust mirror of the `LedCalibrationConfig` TypeScript contract defined in
/// `src/shared/contracts/calibration.ts`.
///
/// Field names and types must stay in sync with the TS interface. The
/// `verify:shell-contracts` script will flag drift. All string-enum fields use
/// `String` (not Rust enums) so that unknown future values round-trip without
/// breaking deserialization — the encoder validates them at use-time.
use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// LED segment counts
// ---------------------------------------------------------------------------

/// Per-edge LED count. Mirror of `LedSegmentCounts` in calibration.ts.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LedSegmentCounts {
    pub top: u16,
    pub right: u16,
    pub bottom: u16,
    pub left: u16,
}

// ---------------------------------------------------------------------------
// LED calibration config
// ---------------------------------------------------------------------------

/// Persisted LED calibration model. Mirror of `LedCalibrationConfig` in
/// `src/shared/contracts/calibration.ts`.
///
/// String-union fields:
///   - `corner_ownership`: `"horizontal"` | `"vertical"`
///   - `visual_preset`:    `"subtle"` | `"vivid"`
///   - `start_anchor`: `"top-start"` | `"top-end"` | `"right-start"` |
///     `"right-end"` | `"bottom-start"` | `"bottom-end"` |
///     `"bottom-gap-right"` | `"bottom-gap-left"` |
///     `"left-start"` | `"left-end"`
///   - `direction`: `"cw"` | `"ccw"`
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LedCalibrationConfig {
    #[serde(default)]
    pub template_id: Option<String>,
    pub counts: LedSegmentCounts,
    pub bottom_missing: u16,
    /// `"horizontal"` | `"vertical"`
    pub corner_ownership: String,
    /// `"subtle"` | `"vivid"`
    pub visual_preset: String,
    /// `"top-start"` | `"top-end"` | ... (10 variants)
    pub start_anchor: String,
    /// `"cw"` | `"ccw"`
    pub direction: String,
    pub total_leds: u16,
}

/// Canonical LED segment traversal order, matching the TypeScript constant
/// `SEGMENT_ORDER = ["top", "right", "bottom", "left"]` in indexMapping.ts.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LedSegment {
    Top,
    Right,
    Bottom,
    Left,
}

impl LedSegment {
    pub const ORDER: [LedSegment; 4] = [
        LedSegment::Top,
        LedSegment::Right,
        LedSegment::Bottom,
        LedSegment::Left,
    ];

    pub fn count(&self, counts: &LedSegmentCounts) -> u16 {
        match self {
            LedSegment::Top => counts.top,
            LedSegment::Right => counts.right,
            LedSegment::Bottom => counts.bottom,
            LedSegment::Left => counts.left,
        }
    }
}

// ---------------------------------------------------------------------------
// Sequence item — mirrors `LedSequenceItem` in indexMapping.ts
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LedSequenceItem {
    pub index: usize,
    pub segment: LedSegment,
    pub local_index: u16,
}

// ---------------------------------------------------------------------------
// buildLedSequence — Rust port of indexMapping.ts::buildLedSequence
// ---------------------------------------------------------------------------
// Algorithm is intentionally a line-for-line mirror so that the same
// calibration config produces identical LED ordering on both sides.

/// Resolve the canonical (top→right→bottom→left) flat sequence, then rotate
/// it to `start_anchor`, then reverse the tail when `direction == "ccw"`.
///
/// Returns a `Vec<LedSequenceItem>` in strip order (index 0 = first physical LED).
/// The caller maps each item's (segment, local_index) to a screen region and
/// averages the pixels there to get the LED colour.
pub fn build_led_sequence(config: &LedCalibrationConfig) -> Vec<LedSequenceItem> {
    let canonical = build_canonical_sequence(config);
    let anchor_index = resolve_anchor_index(&canonical, config);
    let rotated = rotate_sequence(canonical, anchor_index);

    if config.direction == "cw" {
        return rotated;
    }

    // ccw: keep item[0], reverse items[1..]
    if rotated.len() <= 1 {
        return rotated;
    }

    let mut result = Vec::with_capacity(rotated.len());
    result.push(rotated[0].clone());
    for item in rotated[1..].iter().rev() {
        result.push(item.clone());
    }
    // Re-index after rotation+reversal
    for (i, item) in result.iter_mut().enumerate() {
        item.index = i;
    }
    result
}

/// Build the flat sequence top → right → bottom → left, local_index ascending.
fn build_canonical_sequence(config: &LedCalibrationConfig) -> Vec<LedSequenceItem> {
    let mut items = Vec::new();
    for segment in LedSegment::ORDER {
        let count = segment.count(&config.counts);
        for local in 0..count {
            items.push(LedSequenceItem {
                index: items.len(),
                segment,
                local_index: local,
            });
        }
    }
    items
}

/// Resolve the flat index of the anchor LED inside the canonical sequence.
///
/// Mirrors `resolveAnchorIndex` in indexMapping.ts.
fn resolve_anchor_index(sequence: &[LedSequenceItem], config: &LedCalibrationConfig) -> usize {
    let start_anchor = config.start_anchor.as_str();

    let (anchor_segment, mode) = match start_anchor {
        "top-start" => (LedSegment::Top, AnchorMode::Start),
        "top-end" => (LedSegment::Top, AnchorMode::End),
        "right-start" => (LedSegment::Right, AnchorMode::Start),
        "right-end" => (LedSegment::Right, AnchorMode::End),
        "bottom-start" => (LedSegment::Bottom, AnchorMode::Start),
        "bottom-end" => (LedSegment::Bottom, AnchorMode::End),
        "bottom-gap-right" => (LedSegment::Bottom, AnchorMode::GapRight),
        "bottom-gap-left" => (LedSegment::Bottom, AnchorMode::GapLeft),
        "left-start" => (LedSegment::Left, AnchorMode::Start),
        "left-end" => (LedSegment::Left, AnchorMode::End),
        _ => return 0, // unknown anchor → default to 0
    };

    let target_local: u16 = match mode {
        AnchorMode::Start => 0,
        AnchorMode::End => {
            // last item in the segment
            return sequence
                .iter()
                .rposition(|item| item.segment == anchor_segment)
                .unwrap_or(0);
        }
        AnchorMode::GapRight => {
            resolve_bottom_gap_local(config.counts.bottom, config.bottom_missing, GapSide::Right)
        }
        AnchorMode::GapLeft => {
            resolve_bottom_gap_local(config.counts.bottom, config.bottom_missing, GapSide::Left)
        }
    };

    sequence
        .iter()
        .position(|item| item.segment == anchor_segment && item.local_index == target_local)
        .unwrap_or(0)
}

enum AnchorMode {
    Start,
    End,
    GapRight,
    GapLeft,
}

enum GapSide {
    Right,
    Left,
}

/// Mirror of `resolveBottomGapAnchorLocalIndex` in indexMapping.ts.
fn resolve_bottom_gap_local(bottom_count: u16, bottom_missing: u16, side: GapSide) -> u16 {
    if bottom_count <= 1 {
        return 0;
    }

    if bottom_missing > 0 {
        let right_side_count = bottom_count / 2;
        return match side {
            GapSide::Right => right_side_count.saturating_sub(1),
            GapSide::Left => bottom_count.min(right_side_count),
        };
    }

    let center_right = (bottom_count.saturating_sub(1)) / 2;
    let center_left = bottom_count.saturating_sub(1).div_ceil(2);
    match side {
        GapSide::Right => center_right,
        GapSide::Left => center_left,
    }
}

/// Rotate the canonical sequence so that `start_index` becomes item[0].
///
/// Mirror of `rotateSequence` in indexMapping.ts.
fn rotate_sequence(mut sequence: Vec<LedSequenceItem>, start_index: usize) -> Vec<LedSequenceItem> {
    if sequence.is_empty() || start_index == 0 {
        return sequence;
    }
    sequence.rotate_left(start_index);
    // Re-index after rotation
    for (i, item) in sequence.iter_mut().enumerate() {
        item.index = i;
    }
    sequence
}

// ---------------------------------------------------------------------------
// Edge-position mapping — (segment, local_index) → normalised screen coords
// ---------------------------------------------------------------------------

/// Map a `LedSequenceItem` to a normalised screen position `(norm_x, norm_y)`
/// where `(0.0, 0.0)` is top-left and `(1.0, 1.0)` is bottom-right.
///
/// Used by `build_led_sequence_colors` to derive the pixel-averaging window
/// centre for each LED.
pub fn led_to_screen_pos(item: &LedSequenceItem, counts: &LedSegmentCounts) -> (f32, f32) {
    // Fractional position along the segment [0, 1].
    let frac = if item.local_index == 0 || segment_count(item.segment, counts) <= 1 {
        0.0_f32
    } else {
        item.local_index as f32 / (segment_count(item.segment, counts) - 1) as f32
    };

    match item.segment {
        // Top edge: left → right  (y fixed near top)
        LedSegment::Top => (frac, 0.0),
        // Right edge: top → bottom (x fixed near right)
        LedSegment::Right => (1.0, frac),
        // Bottom edge: right → left (y fixed near bottom)
        LedSegment::Bottom => (1.0 - frac, 1.0),
        // Left edge: bottom → top  (x fixed near left)
        LedSegment::Left => (0.0, 1.0 - frac),
    }
}

fn segment_count(segment: LedSegment, counts: &LedSegmentCounts) -> u16 {
    segment.count(counts)
}

// ---------------------------------------------------------------------------
// baud-budget helper
// ---------------------------------------------------------------------------

/// Derive a frame interval (ms) that fits within the 115 200-baud serial budget.
///
/// 115 200 baud, 8N1 = 11 520 bytes/s.
/// Each frame: `total_leds × 3 + 5` bytes (2-byte magic, 1 brightness,
/// 2-byte count LE, RGB payload, 1-byte XOR checksum).
/// Target FPS is clamped to [10, 60]; minimum interval is 16 ms.
pub fn derive_base_interval_ms(total_leds: u16) -> u32 {
    const BAUD_BYTES_PER_SEC: usize = 11_520;
    let bytes_per_frame = (total_leds as usize) * 3 + 5;
    let max_fps = BAUD_BYTES_PER_SEC / bytes_per_frame.max(1);
    let target_fps = max_fps.clamp(10, 60);
    let interval = 1000 / target_fps as u32;
    interval.max(16)
}

// ---------------------------------------------------------------------------
// Full pixel-averaging sequencer
// ---------------------------------------------------------------------------

/// Compute the RGB colour for every LED in the sequence by averaging a small
/// pixel window from `frame` at the LED's normalised screen position.
///
/// `window_frac` — fraction of frame dimension used as the half-window; 0.05
/// (5%) is a reasonable default that covers ~32 px on a 640-wide frame.
///
/// The function applies the gamma LUT from `led_output.rs` **externally** —
/// callers should pass the already-gamma-corrected values, or pass raw values
/// and let `encode_led_packet` handle gamma. Here we return raw averaged RGB;
/// gamma is applied at the packet-encode stage.
pub fn sample_frame_for_sequence(
    frame: &crate::commands::ambilight_capture::CapturedFrame,
    sequence: &[LedSequenceItem],
    counts: &LedSegmentCounts,
    window_frac: f32,
) -> Vec<[u8; 3]> {
    let w = frame.width as usize;
    let h = frame.height as usize;
    if w == 0 || h == 0 || frame.pixels_rgb.is_empty() {
        return vec![[0, 0, 0]; sequence.len()];
    }

    let half_w = ((w as f32 * window_frac) / 2.0).max(1.0) as usize;
    let half_h = ((h as f32 * window_frac) / 2.0).max(1.0) as usize;
    const STEP: usize = 4;

    sequence
        .iter()
        .map(|item| {
            let (nx, ny) = led_to_screen_pos(item, counts);
            let cx = (nx * (w as f32 - 1.0)).round() as usize;
            let cy = (ny * (h as f32 - 1.0)).round() as usize;

            let row_start = cy.saturating_sub(half_h);
            let row_end = (cy + half_h + 1).min(h);
            let col_start = cx.saturating_sub(half_w);
            let col_end = (cx + half_w + 1).min(w);

            let mut sum_r = 0u32;
            let mut sum_g = 0u32;
            let mut sum_b = 0u32;
            let mut count = 0u32;

            let mut row = row_start;
            while row < row_end {
                let mut col = col_start;
                while col < col_end {
                    if let Some(px) = frame.pixels_rgb.get(row * w + col) {
                        sum_r += px[0] as u32;
                        sum_g += px[1] as u32;
                        sum_b += px[2] as u32;
                        count += 1;
                    }
                    col += STEP;
                }
                row += STEP;
            }

            std::num::NonZeroU32::new(count).map_or([0, 0, 0], |nz| {
                let n = nz.get();
                [(sum_r / n) as u8, (sum_g / n) as u8, (sum_b / n) as u8]
            })
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::ambilight_capture::CapturedFrame;

    fn simple_config(top: u16, right: u16, bottom: u16, left: u16) -> LedCalibrationConfig {
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

    // Test 1: deterministic output — fixed config → fixed ordering
    #[test]
    fn build_led_sequence_is_deterministic() {
        let config = simple_config(4, 3, 4, 3);
        let seq1 = build_led_sequence(&config);
        let seq2 = build_led_sequence(&config);
        assert_eq!(seq1, seq2);
        assert_eq!(seq1.len(), 14);
    }

    // Test 2: top-start cw vs top-end ccw → first LED and segment ordering correct
    #[test]
    fn cw_top_start_first_led_is_top_segment() {
        let config = simple_config(4, 3, 4, 3);
        let seq = build_led_sequence(&config);
        assert_eq!(seq[0].segment, LedSegment::Top);
        assert_eq!(seq[0].local_index, 0);
    }

    #[test]
    fn ccw_top_start_reverses_tail() {
        let mut config = simple_config(4, 3, 4, 3);
        config.direction = "ccw".to_string();
        let seq = build_led_sequence(&config);
        // item[0] same anchor; item[1] should be last of left (since ccw reverses after anchor)
        assert_eq!(seq[0].segment, LedSegment::Top);
        assert_eq!(seq[0].local_index, 0);
        // After reversal item[1] comes from left edge (the element before anchor in canonical)
        assert_eq!(seq[1].segment, LedSegment::Left);
    }

    // Test 3: bottomMissing with gap anchors
    #[test]
    fn bottom_missing_gap_anchor_skips_center() {
        // 80 bottom LEDs, 20 bottomMissing
        // right_side_count = 80 / 2 = 40
        // gap-right local_index = 40 - 1 = 39
        let config = LedCalibrationConfig {
            template_id: None,
            counts: LedSegmentCounts {
                top: 0,
                right: 0,
                bottom: 80,
                left: 0,
            },
            bottom_missing: 20,
            corner_ownership: "horizontal".to_string(),
            visual_preset: "subtle".to_string(),
            start_anchor: "bottom-gap-right".to_string(),
            direction: "cw".to_string(),
            total_leds: 80,
        };
        let seq = build_led_sequence(&config);
        assert_eq!(seq[0].segment, LedSegment::Bottom);
        assert_eq!(seq[0].local_index, 39);
    }

    #[test]
    fn bottom_gap_left_anchor_starts_after_center() {
        // 80 bottom LEDs, 20 bottomMissing
        // right_side_count = 40; gap-left = 80.min(40) = 40
        let config = LedCalibrationConfig {
            template_id: None,
            counts: LedSegmentCounts {
                top: 0,
                right: 0,
                bottom: 80,
                left: 0,
            },
            bottom_missing: 20,
            corner_ownership: "horizontal".to_string(),
            visual_preset: "subtle".to_string(),
            start_anchor: "bottom-gap-left".to_string(),
            direction: "cw".to_string(),
            total_leds: 80,
        };
        let seq = build_led_sequence(&config);
        assert_eq!(seq[0].segment, LedSegment::Bottom);
        assert_eq!(seq[0].local_index, 40);
    }

    // Test 4: derive_base_interval_ms
    #[test]
    fn derive_base_interval_ms_60_leds() {
        // 60 × 3 + 5 = 185 bytes; max_fps = 11520 / 185 = 62 → clamp 60 → 16ms
        assert_eq!(derive_base_interval_ms(60), 16);
    }

    #[test]
    fn derive_base_interval_ms_100_leds() {
        // 100 × 3 + 5 = 305; max_fps = 11520 / 305 = 37; 1000/37 = 27ms
        assert_eq!(derive_base_interval_ms(100), 27);
    }

    #[test]
    fn derive_base_interval_ms_200_leds() {
        // 200 × 3 + 5 = 605; max_fps = 11520 / 605 = 19; 1000/19 = 52ms
        assert_eq!(derive_base_interval_ms(200), 52);
    }

    #[test]
    fn derive_base_interval_ms_clamps_slow_strips() {
        // very many LEDs → would be < 10 fps → min 10 fps → 100ms
        let interval = derive_base_interval_ms(4000);
        assert_eq!(interval, 100); // 1000 / 10 = 100
    }

    // Test 5: sample_frame_for_sequence — deterministic pixel averaging
    #[test]
    fn sample_frame_for_sequence_deterministic() {
        // 4×4 frame: top-left quadrant red, top-right green, bottom-left blue, bottom-right white
        let mut pixels = Vec::with_capacity(16);
        for row in 0..4usize {
            for col in 0..4usize {
                let px = match (row < 2, col < 2) {
                    (true, true) => [200_u8, 0, 0],    // red
                    (true, false) => [0, 200, 0],      // green
                    (false, true) => [0, 0, 200],      // blue
                    (false, false) => [200, 200, 200], // white
                };
                pixels.push(px);
            }
        }
        let frame = CapturedFrame {
            width: 4,
            height: 4,
            pixels_rgb: pixels,
        };

        // 1 top LED + 1 right LED
        let config = LedCalibrationConfig {
            template_id: None,
            counts: LedSegmentCounts {
                top: 1,
                right: 1,
                bottom: 0,
                left: 0,
            },
            bottom_missing: 0,
            corner_ownership: "horizontal".to_string(),
            visual_preset: "subtle".to_string(),
            start_anchor: "top-start".to_string(),
            direction: "cw".to_string(),
            total_leds: 2,
        };
        let seq = build_led_sequence(&config);
        let colors1 = sample_frame_for_sequence(&frame, &seq, &config.counts, 0.3);
        let colors2 = sample_frame_for_sequence(&frame, &seq, &config.counts, 0.3);
        assert_eq!(colors1, colors2, "sampling must be deterministic");
        assert_eq!(colors1.len(), 2);
    }

    // Test 6: LED index ordering is contiguous 0..N
    #[test]
    fn sequence_indices_are_contiguous() {
        let config = simple_config(10, 6, 10, 6);
        let seq = build_led_sequence(&config);
        for (i, item) in seq.iter().enumerate() {
            assert_eq!(item.index, i, "index must be contiguous");
        }
    }
}
