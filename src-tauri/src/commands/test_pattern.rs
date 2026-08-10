//! Synthetic test-pattern frame source (v1.6 LED Preview — Phase 1).
//!
//! Phase 1 is **TEST MODE with screen capture OFF**. Instead of grabbing real
//! screen pixels, [`SyntheticFrameSource`] renders a procedural SCREEN-SPACE
//! [`CapturedFrame`] (~640×400) for each `capture_frame()` call and hands it to
//! the *existing* ambilight worker. The worker then samples that synthetic
//! frame through the normal `sample_frame_for_sequence` edge-mapping path, so a
//! test pattern lights real LEDs (and Hue channels) exactly like live capture
//! would — no capture-pipeline fork.
//!
//! Patterns are driven purely by an elapsed [`Instant`] + a [`TestPatternSpeed`]
//! so they animate deterministically without any external clock. Brightness is
//! intentionally NOT baked into the rendered frame — it flows through the
//! worker's existing brightness path (LumaSync v1 header byte + the twin's
//! post-EWMA scalar) so a synthetic run dims identically to live ambilight.
//!
//! Phase 2 (capture-exclusion via `SCContentFilter` exclude /
//! `SetWindowDisplayAffinity`) is explicitly OUT OF SCOPE here.

use std::sync::Arc;
use std::time::Instant;

use serde::{Deserialize, Serialize};

use super::ambilight_capture::{AmbilightCaptureError, AmbilightFrameSource, CapturedFrame};
use super::led_calibration::LedCalibrationConfig;

/// Rendered synthetic frame dimensions. Mirrors the macOS/Windows live-capture
/// downscale target (~640 px long axis) so the downstream edge sampler sees a
/// comparably sized grid.
const SYNTH_WIDTH: u32 = 640;
const SYNTH_HEIGHT: u32 = 400;

/// Fallback LED count when no calibration is available — only affects the
/// chase band width (one LED pitch), never the ability to render.
const FALLBACK_TOTAL_LEDS: u16 = 60;

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
}

// ---------------------------------------------------------------------------
// Synthetic frame source
// ---------------------------------------------------------------------------

/// Build a boxed [`AmbilightFrameSource`] that renders synthetic test frames.
///
/// `calibration` is used only to size the chase band to ~one LED pitch; all
/// patterns render regardless of whether a calibration is present.
pub fn create_synthetic_frame_source(
    config: TestPatternConfig,
    calibration: Option<LedCalibrationConfig>,
) -> Box<dyn AmbilightFrameSource> {
    Box::new(SyntheticFrameSource::new(config, calibration))
}

/// Procedural frame source. Each `capture_frame()` renders a fresh
/// screen-space frame from `started.elapsed()` so animation is wall-clock
/// driven and frame-rate independent.
pub struct SyntheticFrameSource {
    kind: TestPatternKind,
    speed: TestPatternSpeed,
    total_leds: u16,
    started: Instant,
}

impl SyntheticFrameSource {
    fn new(config: TestPatternConfig, calibration: Option<LedCalibrationConfig>) -> Self {
        let total_leds = calibration
            .as_ref()
            .map(|c| c.total_leds)
            .filter(|n| *n > 0)
            .unwrap_or(FALLBACK_TOTAL_LEDS);
        Self {
            kind: config.kind,
            speed: config.speed,
            total_leds,
            started: Instant::now(),
        }
    }

    fn render(&self, elapsed: f32) -> CapturedFrame {
        let w = SYNTH_WIDTH as usize;
        let h = SYNTH_HEIGHT as usize;
        let mut pixels_rgb: Vec<[u8; 3]> = Vec::with_capacity(w * h);
        let rate = self.speed.loops_per_sec();

        match self.kind {
            TestPatternKind::Solid { r, g, b } => {
                pixels_rgb.resize(w * h, [r, g, b]);
            }
            TestPatternKind::Chase { r, g, b } => {
                render_chase(
                    &mut pixels_rgb,
                    w,
                    h,
                    self.total_leds,
                    elapsed * rate,
                    [r, g, b],
                );
            }
            TestPatternKind::Rainbow => {
                render_rainbow(&mut pixels_rgb, w, h, elapsed * rate);
            }
            TestPatternKind::Spiral => {
                render_spiral(&mut pixels_rgb, w, h, elapsed * rate);
            }
            TestPatternKind::Gamut => {
                render_gamut(&mut pixels_rgb, w, h);
            }
        }

        CapturedFrame {
            width: SYNTH_WIDTH,
            height: SYNTH_HEIGHT,
            pixels_rgb,
        }
    }
}

impl AmbilightFrameSource for SyntheticFrameSource {
    fn capture_frame(&mut self) -> Result<Arc<CapturedFrame>, AmbilightCaptureError> {
        let elapsed = self.started.elapsed().as_secs_f32();
        Ok(Arc::new(self.render(elapsed)))
    }
}

// ---------------------------------------------------------------------------
// Pattern renderers
// ---------------------------------------------------------------------------

/// A bright band ~one LED pitch wide travelling the screen perimeter.
///
/// The perimeter is parameterised by normalised arc length matching
/// `led_to_screen_pos`'s canonical traversal (top L→R, right T→B, bottom R→L,
/// left B→T), so as the band sweeps each border the corresponding edge LED
/// lights up in physical strip order.
fn render_chase(
    pixels: &mut Vec<[u8; 3]>,
    w: usize,
    h: usize,
    total_leds: u16,
    band_pos_unwrapped: f32,
    rgb: [u8; 3],
) {
    let band_pos = band_pos_unwrapped.rem_euclid(1.0);
    // ~1.5 LED pitches so the soft-edged band reliably lands inside the
    // sampler's averaging window without smearing across neighbours.
    let half_band = (1.5 / total_leds.max(1) as f32).clamp(0.01, 0.20);
    const EDGE_THICKNESS: f32 = 0.10;

    let wf = (w.max(2) - 1) as f32;
    let hf = (h.max(2) - 1) as f32;

    for y in 0..h {
        let ny = y as f32 / hf;
        for x in 0..w {
            let nx = x as f32 / wf;

            let dist_top = ny;
            let dist_bottom = 1.0 - ny;
            let dist_left = nx;
            let dist_right = 1.0 - nx;
            let min_dist = dist_top.min(dist_bottom).min(dist_left).min(dist_right);

            if min_dist > EDGE_THICKNESS {
                pixels.push([0, 0, 0]);
                continue;
            }

            // Arc fraction [0,1) along the perimeter for the nearest edge.
            let arc = if min_dist == dist_top {
                nx * 0.25
            } else if min_dist == dist_right {
                (1.0 + ny) * 0.25
            } else if min_dist == dist_bottom {
                (2.0 + (1.0 - nx)) * 0.25
            } else {
                (3.0 + (1.0 - ny)) * 0.25
            };

            let raw = (arc - band_pos).abs();
            let circ = raw.min(1.0 - raw);
            if circ < half_band {
                let intensity = 1.0 - (circ / half_band);
                pixels.push([
                    (rgb[0] as f32 * intensity).round() as u8,
                    (rgb[1] as f32 * intensity).round() as u8,
                    (rgb[2] as f32 * intensity).round() as u8,
                ]);
            } else {
                pixels.push([0, 0, 0]);
            }
        }
    }
}

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

    fn cfg(kind: TestPatternKind, speed: TestPatternSpeed) -> TestPatternConfig {
        TestPatternConfig {
            kind,
            brightness: 1.0,
            speed,
        }
    }

    #[test]
    fn solid_fills_every_pixel_with_requested_color() {
        let mut src = create_synthetic_frame_source(
            cfg(
                TestPatternKind::Solid {
                    r: 10,
                    g: 20,
                    b: 30,
                },
                TestPatternSpeed::Med,
            ),
            None,
        );
        let frame = src.capture_frame().expect("synthetic frame");
        assert_eq!(frame.width, SYNTH_WIDTH);
        assert_eq!(frame.height, SYNTH_HEIGHT);
        assert_eq!(
            frame.pixels_rgb.len(),
            (SYNTH_WIDTH * SYNTH_HEIGHT) as usize
        );
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
            let mut src = create_synthetic_frame_source(cfg(kind, TestPatternSpeed::Fast), None);
            let frame = src.capture_frame().expect("frame");
            assert_eq!(
                frame.pixels_rgb.len(),
                (SYNTH_WIDTH * SYNTH_HEIGHT) as usize,
                "pixel buffer must equal width*height"
            );
        }
    }

    #[test]
    fn chase_lights_a_subset_of_the_perimeter() {
        let mut src = create_synthetic_frame_source(
            cfg(
                TestPatternKind::Chase {
                    r: 200,
                    g: 200,
                    b: 200,
                },
                TestPatternSpeed::Slow,
            ),
            None,
        );
        let frame = src.capture_frame().expect("frame");
        let lit = frame
            .pixels_rgb
            .iter()
            .filter(|p| p.iter().any(|&c| c > 0))
            .count();
        // Some pixels lit (the band), but far from the whole frame.
        assert!(lit > 0, "chase band must light some pixels");
        assert!(
            lit < frame.pixels_rgb.len() / 2,
            "chase band must not fill the frame"
        );
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
    // New pattern-math tests (v1.6 Phase 1)
    // -------------------------------------------------------------------------

    /// Chase band position advances with elapsed time.
    ///
    /// `render_chase` is called with two different `band_pos_unwrapped` values
    /// (0.0 and 0.25 — a quarter-perimeter advance). The resulting pixel
    /// buffers must differ because the lit band has moved to a different arc
    /// position.
    #[test]
    fn chase_band_advances_with_elapsed_time() {
        let mut early: Vec<[u8; 3]> = Vec::new();
        let mut later: Vec<[u8; 3]> = Vec::new();
        let total_leds: u16 = 60;
        // band_pos_unwrapped = 0.0 → band centred at arc 0 (top-left corner).
        render_chase(
            &mut early,
            SYNTH_WIDTH as usize,
            SYNTH_HEIGHT as usize,
            total_leds,
            0.0,
            [200, 0, 0],
        );
        // band_pos_unwrapped = 0.25 → band centred at arc 0.25 (top-right corner).
        render_chase(
            &mut later,
            SYNTH_WIDTH as usize,
            SYNTH_HEIGHT as usize,
            total_leds,
            0.25,
            [200, 0, 0],
        );
        assert_eq!(
            early.len(),
            later.len(),
            "both renders must produce identical buffer sizes"
        );
        assert_ne!(early, later, "chase band must have moved between renders");
    }

    /// Rainbow produces spatially non-uniform pixels (horizontal hue sweep).
    ///
    /// A rainbow frame at phase=0.0 must have different colours across the
    /// X axis (leftmost column ≠ middle column) because it sweeps the full
    /// hue range from left to right.
    #[test]
    fn rainbow_produces_non_uniform_pixels_across_columns() {
        let mut pixels: Vec<[u8; 3]> = Vec::new();
        render_rainbow(
            &mut pixels,
            SYNTH_WIDTH as usize,
            SYNTH_HEIGHT as usize,
            0.0, // phase = 0 → no scroll
        );
        assert_eq!(
            pixels.len(),
            (SYNTH_WIDTH * SYNTH_HEIGHT) as usize,
            "buffer must be full-frame"
        );
        // Column 0 and the middle column must carry different hues.
        let col0 = pixels[0];
        let col_mid = pixels[SYNTH_WIDTH as usize / 2];
        assert_ne!(
            col0, col_mid,
            "rainbow column 0 and middle column must have different hue values"
        );
        // Also confirm the frame is not a single uniform color.
        let first = pixels[0];
        assert!(
            pixels.iter().any(|p| p != &first),
            "rainbow must have at least two distinct pixel colors"
        );
    }

    /// Rainbow animation: the frame changes as phase advances.
    ///
    /// Calling `render_rainbow` with phase=0.0 vs phase=0.3 (roughly 1/3 of a
    /// full hue cycle) must produce different buffers — confirming the phase
    /// parameter drives real animation.
    #[test]
    fn rainbow_frame_differs_as_phase_advances() {
        let mut frame0: Vec<[u8; 3]> = Vec::new();
        let mut frame1: Vec<[u8; 3]> = Vec::new();
        render_rainbow(
            &mut frame0,
            SYNTH_WIDTH as usize,
            SYNTH_HEIGHT as usize,
            0.0,
        );
        render_rainbow(
            &mut frame1,
            SYNTH_WIDTH as usize,
            SYNTH_HEIGHT as usize,
            0.3,
        );
        assert_ne!(
            frame0, frame1,
            "rainbow frames must differ when phase advances"
        );
    }

    /// Spiral produces radially and angularly non-uniform pixels.
    ///
    /// The center pixel and a corner pixel must differ because the spiral
    /// mixes polar angle + radius, producing both angular and radial variation.
    #[test]
    fn spiral_produces_non_uniform_pixels_radially_and_angularly() {
        let mut pixels: Vec<[u8; 3]> = Vec::new();
        render_spiral(
            &mut pixels,
            SYNTH_WIDTH as usize,
            SYNTH_HEIGHT as usize,
            0.0, // phase = 0
        );
        assert_eq!(
            pixels.len(),
            (SYNTH_WIDTH * SYNTH_HEIGHT) as usize,
            "buffer must be full-frame"
        );
        let corner = pixels[0]; // top-left corner
        let center_idx =
            (SYNTH_HEIGHT as usize / 2) * SYNTH_WIDTH as usize + (SYNTH_WIDTH as usize / 2);
        let center = pixels[center_idx];
        assert_ne!(
            corner, center,
            "spiral corner and center pixels must have different colors"
        );
    }

    /// Gamut is time-invariant but spatially non-uniform.
    ///
    /// `render_gamut` ignores elapsed time (it's a static color wheel), so two
    /// calls must produce identical buffers. The wheel must also have spatial
    /// color variation — it is NOT a flat fill.
    #[test]
    fn gamut_is_time_invariant_and_spatially_non_uniform() {
        let mut pixels_a: Vec<[u8; 3]> = Vec::new();
        let mut pixels_b: Vec<[u8; 3]> = Vec::new();
        render_gamut(&mut pixels_a, SYNTH_WIDTH as usize, SYNTH_HEIGHT as usize);
        render_gamut(&mut pixels_b, SYNTH_WIDTH as usize, SYNTH_HEIGHT as usize);

        // Static — identical regardless of when called.
        assert_eq!(pixels_a, pixels_b, "gamut must be time-invariant");

        // Color wheel — at least two distinct colors across the frame.
        let first = pixels_a[0];
        assert!(
            pixels_a.iter().any(|p| p != &first),
            "gamut color wheel must have spatial color variation"
        );
    }
}
