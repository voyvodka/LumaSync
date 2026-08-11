//! Synthetic test-pattern frame source (v1.6 LED Preview — Phase 1).
//!
//! Phase 1 is **TEST MODE with screen capture OFF**. Instead of grabbing real
//! screen pixels, [`SyntheticFrameSource`] renders a procedural SCREEN-SPACE
//! [`CapturedFrame`] (640 px long axis, display aspect) for each
//! `capture_frame()` call and hands it to
//! the *existing* ambilight worker. The worker then samples that synthetic
//! frame through the normal `sample_frame_for_sequence` edge-mapping path, so a
//! test pattern lights real LEDs (and Hue channels) exactly like live capture
//! would — no capture-pipeline fork.
//!
//! Patterns advance on an ACCUMULATED phase (`phase += dt × rate`) rather than
//! elapsed wall-clock, so changing speed never teleports them. Brightness is
//! intentionally NOT baked into the rendered frame — it flows through the
//! worker's existing brightness path (LumaSync v1 header byte + the twin's
//! post-EWMA scalar) so a synthetic run dims identically to live ambilight.
//!
//! Phase 2 (capture-exclusion via `SCContentFilter` exclude /
//! `SetWindowDisplayAffinity`) is explicitly OUT OF SCOPE here.

use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use std::time::Instant;

use serde::{Deserialize, Serialize};

use super::ambilight_capture::{AmbilightCaptureError, AmbilightFrameSource, CapturedFrame};
use super::led_calibration::{
    build_led_sequence, led_to_screen_pos, LedCalibrationConfig, LedSegment, LedSegmentCounts,
    LedSequenceItem,
};

/// Long axis of the rendered synthetic frame. Mirrors the macOS/Windows
/// live-capture downscale target so the edge sampler sees a comparable grid;
/// the short axis follows the display's aspect (see `frame_size_for_aspect`).
const SYNTH_LONG_AXIS: u32 = 640;

/// Fallback LED count when no calibration is available — only affects the
/// comet's physical length estimate, never the ability to render.
const FALLBACK_TOTAL_LEDS: u16 = 60;

/// Aspect used when the display could not be resolved. 16:9 is the overwhelming
/// desktop default and only shifts the perimeter weighting slightly if wrong.
pub const DEFAULT_DISPLAY_ASPECT: f32 = 16.0 / 9.0;

/// Physical length of the comet's tail. The strip density assumption mirrors
/// `CalibrationPage`'s `totalLeds / 60` metre readout, so the tail keeps the
/// same real-world size whatever LED counts the user assigned to each edge.
const COMET_LENGTH_M: f32 = 0.04;
const ASSUMED_LEDS_PER_M: f32 = 60.0;

/// Slowest realistic consumer of a synthetic frame — the Hue bridge's 20 Hz
/// floor and roughly the serial budget for a mid-length strip. The worker
/// renders faster than this, but coverage is decided by whoever CONSUMES the
/// frames: a tail shorter than one consumer interval skips LEDs outright.
const MIN_CONSUMER_INTERVAL_S: f32 = 0.04;

/// How far in from the border the perimeter patterns paint, as a fraction of
/// the frame. Must stay wider than the sampler's window so an edge LED never
/// averages the unlit interior.
const EDGE_THICKNESS: f32 = 0.10;

/// Resolve the synthetic frame size for a display aspect (width / height),
/// keeping the long axis at `SYNTH_LONG_AXIS`.
fn frame_size_for_aspect(aspect: f32) -> (u32, u32) {
    let aspect = if aspect.is_finite() && aspect > 0.05 && aspect < 20.0 {
        aspect
    } else {
        DEFAULT_DISPLAY_ASPECT
    };
    if aspect >= 1.0 {
        let h = (SYNTH_LONG_AXIS as f32 / aspect).round().max(64.0) as u32;
        (SYNTH_LONG_AXIS, h)
    } else {
        let w = (SYNTH_LONG_AXIS as f32 * aspect).round().max(64.0) as u32;
        (w, SYNTH_LONG_AXIS)
    }
}

// ---------------------------------------------------------------------------
// Wire types — mirror `src/shared/contracts/preview.ts`
// ---------------------------------------------------------------------------

/// Animation cadence for time-varying patterns. Mirrors the TS
/// `TestPatternSpeed` union (`"slow" | "med" | "fast"`).
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum TestPatternSpeed {
    Slow,
    #[default]
    Med,
    Fast,
}

impl TestPatternSpeed {
    /// Full perimeter / hue loops per second for the animated patterns.
    fn loops_per_sec(self) -> f32 {
        match self {
            TestPatternSpeed::Slow => 0.12,
            TestPatternSpeed::Med => 0.30,
            TestPatternSpeed::Fast => 0.60,
        }
    }
}

/// Discriminated union of synthetic test patterns (discriminator `kind`).
///
/// Mirrors the TS `LedTestPattern` union exactly: `solid`/`chase` carry an
/// explicit RGB triple; `rainbow`/`spiral`/`gamut` are fully procedural.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum TestPatternKind {
    Solid { r: u8, g: u8, b: u8 },
    Chase { r: u8, g: u8, b: u8 },
    Rainbow,
    Spiral,
    Gamut,
}

impl TestPatternKind {
    /// Stable discriminator string, matching the TS `LedTestPatternKind`
    /// union. Used to stamp `EdgeSignalPayload.pattern`.
    pub fn tag(&self) -> &'static str {
        match self {
            TestPatternKind::Solid { .. } => "solid",
            TestPatternKind::Chase { .. } => "chase",
            TestPatternKind::Rainbow => "rainbow",
            TestPatternKind::Spiral => "spiral",
            TestPatternKind::Gamut => "gamut",
        }
    }
}

/// Resolved synthetic-pattern request carried from `start_led_test_pattern`
/// into the frame-source factory and stored on the lighting runtime for
/// `get_led_preview_status`.
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TestPatternConfig {
    pub kind: TestPatternKind,
    /// Master brightness scalar (0..1). Applied downstream by the worker /
    /// twin, not baked into the rendered frame.
    pub brightness: f32,
    pub speed: TestPatternSpeed,
    /// Target display aspect (width / height). The synthetic frame adopts it so
    /// perimeter arc length is proportional to REAL edge length — without it a
    /// comet crosses the short edges far faster than the long ones.
    pub display_aspect: f32,
}

// ---------------------------------------------------------------------------
// Synthetic frame source
// ---------------------------------------------------------------------------

/// Build a boxed [`AmbilightFrameSource`] that renders synthetic test frames.
///
/// `calibration` only estimates strip density for the comet's tail length; all
/// patterns render regardless of whether a calibration is present.
pub fn create_synthetic_frame_source(
    config: TestPatternConfig,
    calibration: Option<LedCalibrationConfig>,
    phase_slot: Option<Arc<AtomicU32>>,
) -> Box<dyn AmbilightFrameSource> {
    Box::new(SyntheticFrameSource::new(config, calibration, phase_slot))
}

/// Procedural frame source.
///
/// Phase is ACCUMULATED (`phase += dt × rate`), never derived from elapsed
/// wall-clock: a speed change must alter how fast the animation moves without
/// teleporting it. `phase_slot` carries that phase across the worker rebuild
/// that every parameter change forces, so a colour tweak does not restart the
/// animation from zero either.
pub struct SyntheticFrameSource {
    kind: TestPatternKind,
    speed: TestPatternSpeed,
    total_leds: u16,
    /// Strip layout, so the comet can paint one exact block per LED.
    sequence: Vec<LedSequenceItem>,
    counts: LedSegmentCounts,
    width: u32,
    height: u32,
    phase: f32,
    /// Seconds since the previous frame, floored into the comet's tail so a
    /// stalled worker widens the trail rather than tearing it.
    last_dt: f32,
    last_tick: Instant,
    phase_slot: Option<Arc<AtomicU32>>,
}

impl SyntheticFrameSource {
    fn new(
        config: TestPatternConfig,
        calibration: Option<LedCalibrationConfig>,
        phase_slot: Option<Arc<AtomicU32>>,
    ) -> Self {
        let total_leds = calibration
            .as_ref()
            .map(|c| c.total_leds)
            .filter(|n| *n > 0)
            .unwrap_or(FALLBACK_TOTAL_LEDS);
        let (sequence, counts) = match calibration.as_ref() {
            Some(cal) => (build_led_sequence(cal), cal.counts.clone()),
            None => (
                Vec::new(),
                LedSegmentCounts {
                    top: 0,
                    right: 0,
                    bottom: 0,
                    left: 0,
                },
            ),
        };
        let (width, height) = frame_size_for_aspect(config.display_aspect);
        let phase = phase_slot
            .as_ref()
            .map(|slot| f32::from_bits(slot.load(Ordering::Relaxed)))
            .filter(|p| p.is_finite())
            .unwrap_or(0.0)
            .rem_euclid(1.0);
        Self {
            kind: config.kind,
            speed: config.speed,
            total_leds,
            sequence,
            counts,
            width,
            height,
            phase,
            last_dt: 0.0,
            last_tick: Instant::now(),
            phase_slot,
        }
    }

    /// Tail length as a fraction of the perimeter.
    ///
    /// The visual term is a fixed PHYSICAL length, so the number of LEDs it
    /// lights follows each edge's own density — 4 cm covers more LEDs on a
    /// densely populated edge than a sparse one, which is what keeps the comet
    /// the same size all the way round. The motion-blur floor is a hard
    /// requirement, not a preference: a tail shorter than one frame's travel
    /// leaves unlit gaps no matter how the colour is computed.
    fn tail_fraction(&self) -> f32 {
        let perimeter_m = (self.total_leds as f32 / ASSUMED_LEDS_PER_M).max(0.05);
        let visual = (COMET_LENGTH_M / perimeter_m).clamp(0.006, 0.15);
        let interval = self.last_dt.max(MIN_CONSUMER_INTERVAL_S);
        let coverage = self.speed.loops_per_sec() * interval * 1.15;
        visual.max(coverage)
    }

    fn render(&self) -> CapturedFrame {
        let w = self.width as usize;
        let h = self.height as usize;
        let mut pixels_rgb: Vec<[u8; 3]> = Vec::with_capacity(w * h);

        match self.kind {
            TestPatternKind::Solid { r, g, b } => {
                pixels_rgb.resize(w * h, [r, g, b]);
            }
            TestPatternKind::Chase { r, g, b } => {
                render_comet(
                    &mut pixels_rgb,
                    w,
                    h,
                    &self.sequence,
                    &self.counts,
                    self.phase,
                    self.tail_fraction(),
                    [r, g, b],
                );
            }
            TestPatternKind::Rainbow => {
                render_rainbow(&mut pixels_rgb, w, h, self.phase);
            }
            TestPatternKind::Spiral => {
                render_spiral(&mut pixels_rgb, w, h, self.phase);
            }
            TestPatternKind::Gamut => {
                render_gamut(&mut pixels_rgb, w, h);
            }
        }

        CapturedFrame {
            width: self.width,
            height: self.height,
            pixels_rgb,
        }
    }
}

impl AmbilightFrameSource for SyntheticFrameSource {
    fn capture_frame(&mut self) -> Result<Arc<CapturedFrame>, AmbilightCaptureError> {
        let now = Instant::now();
        // Clamped so a stalled worker (or a debugger pause) cannot teleport the
        // comet a full lap on the next tick.
        let dt = now.duration_since(self.last_tick).as_secs_f32().min(0.5);
        self.last_tick = now;
        self.last_dt = dt;
        self.phase = (self.phase + dt * self.speed.loops_per_sec()).rem_euclid(1.0);
        if let Some(slot) = self.phase_slot.as_ref() {
            slot.store(self.phase.to_bits(), Ordering::Relaxed);
        }
        Ok(Arc::new(self.render()))
    }
}

// ---------------------------------------------------------------------------
// Perimeter arc — weighted by TRUE edge length
// ---------------------------------------------------------------------------

/// Fraction along its own segment for a strip item, matching `led_to_screen_pos`.
fn segment_fraction(item: &LedSequenceItem, counts: &LedSegmentCounts) -> f32 {
    let count = item.segment.count(counts);
    if item.local_index == 0 || count <= 1 {
        0.0
    } else {
        item.local_index as f32 / (count - 1) as f32
    }
}

/// Arc position of an LED, derived from its segment rather than its pixel so a
/// corner LED cannot be attributed to the neighbouring edge by a distance tie.
fn led_arc(item: &LedSequenceItem, counts: &LedSegmentCounts, w: f32, h: f32) -> f32 {
    let frac = segment_fraction(item, counts);
    let total = 2.0 * (w + h);
    match item.segment {
        LedSegment::Top => frac * w / total,
        LedSegment::Right => (w + frac * h) / total,
        LedSegment::Bottom => (w + h + frac * w) / total,
        LedSegment::Left => (2.0 * w + h + frac * h) / total,
    }
}

/// A comet travelling the border in strip order: a full-intensity head at
/// `phase` with a trail fading to black over `tail` of the perimeter.
///
/// Painted PER LED rather than per pixel. A pixel-space comet is area-averaged
/// by `sample_frame_for_sequence`, and since the sampling box spans a comparable
/// distance to the comet itself, the head arrived at a fraction of its intended
/// value — the trail's own falloff diluted it, then gamma squared the loss. Here
/// each LED's cell is filled with exactly the intensity that LED should show, so
/// whatever the sampler averages inside that cell is that value.
#[allow(clippy::too_many_arguments)]
fn render_comet(
    pixels: &mut Vec<[u8; 3]>,
    w: usize,
    h: usize,
    sequence: &[LedSequenceItem],
    counts: &LedSegmentCounts,
    phase: f32,
    tail: f32,
    rgb: [u8; 3],
) {
    pixels.clear();
    pixels.resize(w * h, [0, 0, 0]);
    if sequence.is_empty() || w < 2 || h < 2 {
        return;
    }
    let tail = tail.clamp(0.001, 0.5);
    let (wf, hf) = ((w - 1) as f32, (h - 1) as f32);
    let depth = ((EDGE_THICKNESS * h.min(w) as f32) as usize).max(2);

    for item in sequence {
        let behind = (phase - led_arc(item, counts, w as f32, h as f32)).rem_euclid(1.0);
        if behind >= tail {
            continue;
        }
        // Linear falloff: the sink's gamma already steepens it into a comet
        // profile, and squaring here on top left only the head visible.
        let intensity = 1.0 - behind / tail;
        let color = [
            (rgb[0] as f32 * intensity).round() as u8,
            (rgb[1] as f32 * intensity).round() as u8,
            (rgb[2] as f32 * intensity).round() as u8,
        ];

        let (nx, ny) = led_to_screen_pos(item, counts);
        let cx = (nx * wf).round() as usize;
        let cy = (ny * hf).round() as usize;
        let count = item.segment.count(counts).max(2) as f32;
        let horizontal = matches!(item.segment, LedSegment::Top | LedSegment::Bottom);
        // Half a pitch either side — the LED owns its own cell and no more.
        let half = if horizontal {
            (wf / (count - 1.0) / 2.0).max(1.0) as usize
        } else {
            (hf / (count - 1.0) / 2.0).max(1.0) as usize
        };

        let (x0, x1, y0, y1) = if horizontal {
            let y0 = if ny < 0.5 { 0 } else { h.saturating_sub(depth) };
            (
                cx.saturating_sub(half),
                (cx + half + 1).min(w),
                y0,
                (y0 + depth).min(h),
            )
        } else {
            let x0 = if nx < 0.5 { 0 } else { w.saturating_sub(depth) };
            (
                x0,
                (x0 + depth).min(w),
                cy.saturating_sub(half),
                (cy + half + 1).min(h),
            )
        };

        for row in y0..y1 {
            let base = row * w;
            for col in x0..x1 {
                pixels[base + col] = color;
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Pattern renderers
// ---------------------------------------------------------------------------

/// Angular hue wheel that rotates around the screen centre with time. Sampling
/// the perimeter therefore cycles through the spectrum *around the ring* and
/// the whole rainbow appears to rotate — not a linear left→right sweep (which
/// left the side edges a constant colour and read as a flat horizontal slide).
fn render_rainbow(pixels: &mut Vec<[u8; 3]>, w: usize, h: usize, phase: f32) {
    let cx = w as f32 / 2.0;
    let cy = h as f32 / 2.0;
    for y in 0..h {
        let dy = y as f32 - cy;
        for x in 0..w {
            let dx = x as f32 - cx;
            let angle = dy.atan2(dx) / (2.0 * std::f32::consts::PI) + 0.5; // [0,1)
            let hue = (angle + phase).rem_euclid(1.0);
            pixels.push(hsv_to_rgb(hue, 1.0, 1.0));
        }
    }
}

/// Rotating spiral: hue from polar angle + radius, advanced by time.
fn render_spiral(pixels: &mut Vec<[u8; 3]>, w: usize, h: usize, phase: f32) {
    let cx = (w as f32 - 1.0) / 2.0;
    let cy = (h as f32 - 1.0) / 2.0;
    let max_r = (cx * cx + cy * cy).sqrt().max(1.0);
    for y in 0..h {
        let dy = y as f32 - cy;
        for x in 0..w {
            let dx = x as f32 - cx;
            let angle = dy.atan2(dx) / (2.0 * std::f32::consts::PI) + 0.5; // [0,1)
            let radius = (dx * dx + dy * dy).sqrt() / max_r; // [0,1]
            let hue = (angle + radius * 2.0 - phase).rem_euclid(1.0);
            pixels.push(hsv_to_rgb(hue, 1.0, 1.0));
        }
    }
}

/// Static colour-gamut wheel: hue from polar angle, saturation from radius.
fn render_gamut(pixels: &mut Vec<[u8; 3]>, w: usize, h: usize) {
    let cx = (w as f32 - 1.0) / 2.0;
    let cy = (h as f32 - 1.0) / 2.0;
    let max_r = (cx * cx + cy * cy).sqrt().max(1.0);
    for y in 0..h {
        let dy = y as f32 - cy;
        for x in 0..w {
            let dx = x as f32 - cx;
            let angle = dy.atan2(dx) / (2.0 * std::f32::consts::PI) + 0.5;
            let sat = ((dx * dx + dy * dy).sqrt() / max_r).clamp(0.0, 1.0);
            pixels.push(hsv_to_rgb(angle, sat, 1.0));
        }
    }
}

/// HSV → RGB (all components in `[0, 1]`), returning 8-bit channels.
fn hsv_to_rgb(h: f32, s: f32, v: f32) -> [u8; 3] {
    let h = h.rem_euclid(1.0) * 6.0;
    let i = h.floor();
    let f = h - i;
    let p = v * (1.0 - s);
    let q = v * (1.0 - s * f);
    let t = v * (1.0 - s * (1.0 - f));
    let (r, g, b) = match i as i32 % 6 {
        0 => (v, t, p),
        1 => (q, v, p),
        2 => (p, v, t),
        3 => (p, q, v),
        4 => (t, p, v),
        _ => (v, p, q),
    };
    [
        (r * 255.0).round().clamp(0.0, 255.0) as u8,
        (g * 255.0).round().clamp(0.0, 255.0) as u8,
        (b * 255.0).round().clamp(0.0, 255.0) as u8,
    ]
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::led_calibration::{LedCalibrationConfig, LedSegmentCounts};

    const WIDE: f32 = 16.0 / 9.0;

    fn cfg(kind: TestPatternKind, speed: TestPatternSpeed) -> TestPatternConfig {
        TestPatternConfig {
            kind,
            brightness: 1.0,
            speed,
            display_aspect: WIDE,
        }
    }

    /// Calibration with deliberately lopsided edge counts: the long edges carry
    /// nearly 3x the LEDs of the short ones, which is what exposed the flat
    /// quarter-per-edge arc.
    fn lopsided_calibration() -> LedCalibrationConfig {
        LedCalibrationConfig {
            counts: LedSegmentCounts {
                top: 60,
                right: 22,
                bottom: 60,
                left: 22,
            },
            bottom_missing: 0,
            total_leds: 164,
            template_id: None,
            corner_ownership: "horizontal".to_string(),
            visual_preset: "vivid".to_string(),
            start_anchor: "top-start".to_string(),
            direction: "cw".to_string(),
        }
    }

    fn source(kind: TestPatternKind, speed: TestPatternSpeed) -> Box<dyn AmbilightFrameSource> {
        create_synthetic_frame_source(cfg(kind, speed), Some(lopsided_calibration()), None)
    }

    fn seq_item(segment: LedSegment, local_index: u16) -> LedSequenceItem {
        LedSequenceItem {
            index: 0,
            segment,
            local_index,
        }
    }

    #[test]
    fn solid_fills_every_pixel_with_requested_color() {
        let mut src = source(
            TestPatternKind::Solid {
                r: 10,
                g: 20,
                b: 30,
            },
            TestPatternSpeed::Med,
        );
        let frame = src.capture_frame().expect("synthetic frame");
        let (w, h) = frame_size_for_aspect(WIDE);
        assert_eq!(frame.width, w);
        assert_eq!(frame.height, h);
        assert_eq!(frame.pixels_rgb.len(), (w * h) as usize);
        assert!(frame.pixels_rgb.iter().all(|p| *p == [10, 20, 30]));
    }

    #[test]
    fn pixel_count_matches_dimensions_for_every_pattern() {
        for kind in [
            TestPatternKind::Chase { r: 255, g: 0, b: 0 },
            TestPatternKind::Rainbow,
            TestPatternKind::Spiral,
            TestPatternKind::Gamut,
        ] {
            let mut src = source(kind, TestPatternSpeed::Fast);
            let frame = src.capture_frame().expect("frame");
            assert_eq!(
                frame.pixels_rgb.len(),
                (frame.width * frame.height) as usize,
                "pixel buffer must equal width*height"
            );
        }
    }

    #[test]
    fn kind_tag_matches_contract_strings() {
        assert_eq!(TestPatternKind::Solid { r: 0, g: 0, b: 0 }.tag(), "solid");
        assert_eq!(TestPatternKind::Chase { r: 0, g: 0, b: 0 }.tag(), "chase");
        assert_eq!(TestPatternKind::Rainbow.tag(), "rainbow");
        assert_eq!(TestPatternKind::Spiral.tag(), "spiral");
        assert_eq!(TestPatternKind::Gamut.tag(), "gamut");
    }

    #[test]
    fn pattern_kind_deserializes_tagged_union() {
        let solid: TestPatternKind =
            serde_json::from_str(r#"{"kind":"solid","r":1,"g":2,"b":3}"#).expect("solid");
        assert_eq!(solid, TestPatternKind::Solid { r: 1, g: 2, b: 3 });
        let rainbow: TestPatternKind =
            serde_json::from_str(r#"{"kind":"rainbow"}"#).expect("rainbow");
        assert_eq!(rainbow, TestPatternKind::Rainbow);
    }

    #[test]
    fn speed_deserializes_lowercase() {
        let s: TestPatternSpeed = serde_json::from_str(r#""med""#).expect("med");
        assert_eq!(s, TestPatternSpeed::Med);
    }

    // -------------------------------------------------------------------------
    // Frame geometry
    // -------------------------------------------------------------------------

    #[test]
    fn frame_adopts_the_display_aspect() {
        assert_eq!(frame_size_for_aspect(16.0 / 9.0), (640, 360));
        assert_eq!(frame_size_for_aspect(1.0), (640, 640));
        // Portrait keeps the long axis on height.
        assert_eq!(frame_size_for_aspect(0.5), (320, 640));
    }

    #[test]
    fn frame_falls_back_on_a_nonsense_aspect() {
        let sane = frame_size_for_aspect(DEFAULT_DISPLAY_ASPECT);
        assert_eq!(frame_size_for_aspect(f32::NAN), sane);
        assert_eq!(frame_size_for_aspect(0.0), sane);
        assert_eq!(frame_size_for_aspect(-3.0), sane);
    }

    // -------------------------------------------------------------------------
    // Perimeter arc — each edge gets its REAL length, not a flat quarter
    // -------------------------------------------------------------------------

    /// On a 16:9 frame the long edges are 16/50 of the perimeter and the short
    /// ones 9/50. A flat quarter each made the comet cross the short edges at
    /// ~1.8x the speed of the long ones.
    #[test]
    fn perimeter_arc_is_weighted_by_edge_length() {
        let counts = lopsided_calibration().counts;
        let (w, h) = (16.0_f32, 9.0_f32);
        let perimeter = 2.0 * (w + h);
        let at = |seg, idx| led_arc(&seq_item(seg, idx), &counts, w, h);

        let top_start = at(LedSegment::Top, 0);
        let top_end = at(LedSegment::Right, 0);
        let right_end = at(LedSegment::Bottom, 0);

        assert!(top_start.abs() < 1e-5, "top edge must open the arc");
        let top_share = top_end - top_start;
        let right_share = right_end - top_end;
        assert!(
            (top_share - w / perimeter).abs() < 1e-4,
            "long edge share {top_share} must equal its length fraction"
        );
        assert!(
            (right_share - h / perimeter).abs() < 1e-4,
            "short edge share {right_share} must equal its length fraction"
        );
        assert!(
            top_share > right_share * 1.7,
            "a 16:9 long edge must claim far more arc than a short one"
        );
    }

    #[test]
    fn perimeter_arc_walks_the_canonical_strip_order() {
        let counts = lopsided_calibration().counts;
        let (w, h) = (16.0_f32, 9.0_f32);
        // top L→R, right T→B, bottom R→L, left B→T — strictly increasing.
        let stops = [
            led_arc(&seq_item(LedSegment::Top, 5), &counts, w, h),
            led_arc(&seq_item(LedSegment::Right, 5), &counts, w, h),
            led_arc(&seq_item(LedSegment::Bottom, 5), &counts, w, h),
            led_arc(&seq_item(LedSegment::Left, 5), &counts, w, h),
        ];
        for pair in stops.windows(2) {
            assert!(
                pair[1] > pair[0],
                "arc must increase along the canonical traversal: {stops:?}"
            );
        }
    }

    // -------------------------------------------------------------------------
    // Comet
    // -------------------------------------------------------------------------

    fn lit_pixels(pixels: &[[u8; 3]]) -> usize {
        pixels.iter().filter(|p| p.iter().any(|&c| c > 0)).count()
    }

    /// Push a rendered comet frame through the REAL sampler, exactly as the
    /// worker does, and return the per-LED colours the strip would receive.
    fn sampled_comet(phase: f32, tail: f32) -> Vec<[u8; 3]> {
        let cal = lopsided_calibration();
        let sequence = build_led_sequence(&cal);
        let (w, h) = frame_size_for_aspect(WIDE);
        let mut pixels: Vec<[u8; 3]> = Vec::new();
        render_comet(
            &mut pixels,
            w as usize,
            h as usize,
            &sequence,
            &cal.counts,
            phase,
            tail,
            [255, 255, 255],
        );
        let frame = CapturedFrame {
            width: w,
            height: h,
            pixels_rgb: pixels,
        };
        crate::commands::led_calibration::sample_frame_for_sequence(
            &frame,
            &sequence,
            &cal.counts,
            crate::commands::lighting_mode::SYNTHETIC_SAMPLE_WINDOW,
        )
    }

    #[test]
    fn comet_lights_a_subset_of_the_perimeter() {
        let mut src = source(
            TestPatternKind::Chase {
                r: 200,
                g: 200,
                b: 200,
            },
            TestPatternSpeed::Slow,
        );
        let frame = src.capture_frame().expect("frame");
        let lit = lit_pixels(&frame.pixels_rgb);
        assert!(lit > 0, "comet must light some pixels");
        assert!(
            lit < frame.pixels_rgb.len() / 2,
            "comet must not fill the frame"
        );
    }

    #[test]
    fn comet_advances_with_phase() {
        let cal = lopsided_calibration();
        let sequence = build_led_sequence(&cal);
        let (w, h) = frame_size_for_aspect(WIDE);
        let mut early: Vec<[u8; 3]> = Vec::new();
        let mut later: Vec<[u8; 3]> = Vec::new();
        let go = |phase: f32, out: &mut Vec<[u8; 3]>| {
            render_comet(
                out,
                w as usize,
                h as usize,
                &sequence,
                &cal.counts,
                phase,
                0.02,
                [200, 0, 0],
            );
        };
        go(0.0, &mut early);
        go(0.25, &mut later);
        assert_eq!(early.len(), later.len());
        assert_ne!(early, later, "comet must move between phases");
    }

    /// THE regression guard for the washed-out comet: the head LED must survive
    /// the sampler at (near) full intensity. It used to arrive at ~27% because
    /// the averaging box was wider than the comet, and gamma then took that to
    /// ~5% — a white LED that barely registered on the strip.
    #[test]
    fn head_led_survives_the_sampler_at_full_intensity() {
        let cal = lopsided_calibration();
        let sequence = build_led_sequence(&cal);
        // Aim the head at a mid-top LED, clear of both corners.
        let head = sequence
            .iter()
            .find(|i| i.segment == LedSegment::Top && i.local_index == 30)
            .expect("a mid-top LED");
        let (w, h) = frame_size_for_aspect(WIDE);
        let phase = led_arc(head, &cal.counts, w as f32, h as f32);

        let sampled = sampled_comet(phase, 0.015);
        let head_color = sampled[head.index];
        assert!(
            head_color[0] > 240,
            "head LED must reach full white, got {head_color:?}"
        );
    }

    #[test]
    fn comet_trails_behind_its_head_only() {
        let cal = lopsided_calibration();
        let sequence = build_led_sequence(&cal);
        let head = sequence
            .iter()
            .find(|i| i.segment == LedSegment::Top && i.local_index == 30)
            .expect("a mid-top LED");
        let (w, h) = frame_size_for_aspect(WIDE);
        let phase = led_arc(head, &cal.counts, w as f32, h as f32);
        let sampled = sampled_comet(phase, 0.015);

        let at = |offset: i32| {
            let idx = (head.index as i32 + offset).rem_euclid(sampled.len() as i32) as usize;
            sampled[idx][0]
        };

        // The strip runs top L→R here, so the trail sits at LOWER indices.
        assert!(at(-1) > 0, "the LED behind the head must be lit");
        assert!(at(-1) < at(0), "brightness must decay along the trail");
        assert_eq!(at(1), 0, "nothing may light ahead of the head");
    }

    /// A denser edge must light MORE LEDs over the same physical distance —
    /// the tail is a real-world length, not a fixed LED count.
    #[test]
    fn tail_lights_more_leds_on_the_denser_edge() {
        let cal = lopsided_calibration();
        let sequence = build_led_sequence(&cal);
        let (w, h) = frame_size_for_aspect(WIDE);
        let lit_on = |segment: LedSegment, local: u16| {
            let head = sequence
                .iter()
                .find(|i| i.segment == segment && i.local_index == local)
                .expect("led");
            let phase = led_arc(head, &cal.counts, w as f32, h as f32);
            sampled_comet(phase, 0.03)
                .iter()
                .filter(|c| c[0] > 0)
                .count()
        };

        // top carries 60 LEDs, right only 22 over a comparable span.
        assert!(
            lit_on(LedSegment::Top, 30) > lit_on(LedSegment::Right, 11),
            "the same tail must cover more LEDs where the strip is denser"
        );
    }

    /// The reported defect: at higher speeds the band jumped further between
    /// frames than its own width, so whole runs of LEDs were never lit. The
    /// tail is floored at one consumer interval's travel.
    #[test]
    fn tail_always_covers_one_consumer_interval() {
        for speed in [
            TestPatternSpeed::Slow,
            TestPatternSpeed::Med,
            TestPatternSpeed::Fast,
        ] {
            let src = SyntheticFrameSource::new(
                cfg(TestPatternKind::Chase { r: 255, g: 0, b: 0 }, speed),
                Some(lopsided_calibration()),
                None,
            );
            let travel = speed.loops_per_sec() * MIN_CONSUMER_INTERVAL_S;
            assert!(
                src.tail_fraction() >= travel,
                "{speed:?}: tail {} must cover the {travel} travelled between frames",
                src.tail_fraction(),
            );
        }
    }

    /// A worker running slower than the assumed consumer rate must widen the
    /// tail further rather than tear it.
    #[test]
    fn a_stalled_worker_widens_the_tail() {
        let mut src = SyntheticFrameSource::new(
            cfg(
                TestPatternKind::Chase { r: 255, g: 0, b: 0 },
                TestPatternSpeed::Fast,
            ),
            Some(lopsided_calibration()),
            None,
        );
        let nominal = src.tail_fraction();
        src.last_dt = MIN_CONSUMER_INTERVAL_S * 4.0;
        assert!(
            src.tail_fraction() > nominal,
            "a long frame gap must stretch the trail to stay continuous"
        );
    }

    /// A fixed PHYSICAL tail: a denser strip lights more LEDs over the same
    /// distance, so the comet keeps its real-world size whatever counts the
    /// user assigned.
    #[test]
    fn tail_length_tracks_strip_density_not_led_count_alone() {
        let tail_for = |total_leds: u16| {
            let mut cal = lopsided_calibration();
            cal.total_leds = total_leds;
            let src = SyntheticFrameSource::new(
                cfg(
                    TestPatternKind::Chase { r: 1, g: 1, b: 1 },
                    TestPatternSpeed::Slow,
                ),
                Some(cal),
                None,
            );
            src.tail_fraction()
        };

        let sparse = tail_for(80);
        let dense = tail_for(320);
        assert!(
            dense < sparse,
            "a denser strip must claim a SMALLER perimeter fraction ({dense} vs {sparse})"
        );
        // …but the same physical span, so the LED count it lights is stable.
        let leds_sparse = sparse * 80.0;
        let leds_dense = dense * 320.0;
        assert!(
            (leds_sparse - leds_dense).abs() < 0.5,
            "the same physical tail must light a comparable LED span: {leds_sparse} vs {leds_dense}"
        );
    }

    // -------------------------------------------------------------------------
    // Phase continuity
    // -------------------------------------------------------------------------

    /// Phase is accumulated, never derived from elapsed time, so changing speed
    /// alters how fast the animation moves without teleporting it.
    #[test]
    fn phase_is_carried_in_from_the_shared_slot() {
        let slot = Arc::new(AtomicU32::new(0.75f32.to_bits()));
        let src = SyntheticFrameSource::new(
            cfg(TestPatternKind::Rainbow, TestPatternSpeed::Fast),
            Some(lopsided_calibration()),
            Some(Arc::clone(&slot)),
        );
        assert!(
            (src.phase - 0.75).abs() < 1e-6,
            "a rebuilt source must resume where the previous one stopped"
        );
    }

    #[test]
    fn phase_advances_forward_and_is_published_to_the_slot() {
        let slot = Arc::new(AtomicU32::new(0.5f32.to_bits()));
        let mut src = SyntheticFrameSource::new(
            cfg(TestPatternKind::Rainbow, TestPatternSpeed::Fast),
            Some(lopsided_calibration()),
            Some(Arc::clone(&slot)),
        );
        src.capture_frame().expect("frame");
        let published = f32::from_bits(slot.load(Ordering::Relaxed));
        assert!(
            (0.5..1.0).contains(&published),
            "phase must advance from 0.5, got {published}"
        );
        assert!(
            (published - src.phase).abs() < 1e-6,
            "the slot must mirror the source's phase"
        );
    }

    #[test]
    fn a_garbage_slot_value_degrades_to_zero() {
        let slot = Arc::new(AtomicU32::new(f32::NAN.to_bits()));
        let src = SyntheticFrameSource::new(
            cfg(TestPatternKind::Spiral, TestPatternSpeed::Med),
            Some(lopsided_calibration()),
            Some(slot),
        );
        assert_eq!(src.phase, 0.0);
    }

    // -------------------------------------------------------------------------
    // Remaining pattern math
    // -------------------------------------------------------------------------

    #[test]
    fn rainbow_produces_non_uniform_pixels_and_animates() {
        let (w, h) = frame_size_for_aspect(WIDE);
        let (w, h) = (w as usize, h as usize);
        let mut frame0: Vec<[u8; 3]> = Vec::new();
        let mut frame1: Vec<[u8; 3]> = Vec::new();
        render_rainbow(&mut frame0, w, h, 0.0);
        render_rainbow(&mut frame1, w, h, 0.3);

        assert_eq!(frame0.len(), w * h);
        assert_ne!(frame0[0], frame0[w / 2], "hue must vary across the frame");
        assert_ne!(frame0, frame1, "rainbow must animate with phase");
    }

    #[test]
    fn spiral_produces_non_uniform_pixels_radially_and_angularly() {
        let (w, h) = frame_size_for_aspect(WIDE);
        let (w, h) = (w as usize, h as usize);
        let mut pixels: Vec<[u8; 3]> = Vec::new();
        render_spiral(&mut pixels, w, h, 0.0);
        assert_eq!(pixels.len(), w * h);
        let corner = pixels[0];
        let center = pixels[(h / 2) * w + (w / 2)];
        assert_ne!(corner, center, "spiral must vary from corner to centre");
    }

    #[test]
    fn gamut_is_time_invariant_and_spatially_non_uniform() {
        let (w, h) = frame_size_for_aspect(WIDE);
        let (w, h) = (w as usize, h as usize);
        let mut a: Vec<[u8; 3]> = Vec::new();
        let mut b: Vec<[u8; 3]> = Vec::new();
        render_gamut(&mut a, w, h);
        render_gamut(&mut b, w, h);

        assert_eq!(a, b, "gamut must be time-invariant");
        let first = a[0];
        assert!(
            a.iter().any(|p| p != &first),
            "gamut colour wheel must have spatial variation"
        );
    }
}
