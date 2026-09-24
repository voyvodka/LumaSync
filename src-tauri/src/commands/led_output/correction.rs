//! The colour pipeline every output shares: the correction settings, the
//! per-channel gamma, Kelvin and saturation stages, and `EncoderPlan`, which
//! derives them once and applies them per pixel.

use std::sync::Arc;

use serde::{Deserialize, Serialize};

use super::wire::LedColorOrder;

// ---------------------------------------------------------------------------
// ColorCorrectionConfig — per-channel colour correction parameters
// ---------------------------------------------------------------------------

/// Per-channel colour correction parameters applied in the LED encoder hot path.
///
/// Defaults (gamma 2.2, 6500 K, saturation 1.0) reproduce the original
/// `encode_led_packet` output byte-for-byte.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ColorCorrectionConfig {
    /// Gamma exponent for the red channel (typical range 1.0–3.0).
    pub gamma_r: f32,
    /// Gamma exponent for the green channel (typical range 1.0–3.0).
    pub gamma_g: f32,
    /// Gamma exponent for the blue channel (typical range 1.0–3.0).
    pub gamma_b: f32,
    /// White-point colour temperature in Kelvin (typical range 2700–9000).
    /// 6500 K is the sRGB/D65 standard and produces an identity multiplier.
    pub kelvin: u16,
    /// Saturation multiplier (0.0 = greyscale, 1.0 = original, >1.0 = boost).
    pub saturation: f32,
}

impl Default for ColorCorrectionConfig {
    fn default() -> Self {
        Self {
            gamma_r: 2.2,
            gamma_g: 2.2,
            gamma_b: 2.2,
            kelvin: 6500,
            saturation: 1.0,
        }
    }
}

// ---------------------------------------------------------------------------
// Per-channel gamma lookup tables
// ---------------------------------------------------------------------------

/// Per-channel gamma lookup tables for WS2812B LEDs.
///
/// Splits the previously unified `GAMMA_LUT` into three independent tables so
/// that each channel can be corrected with a different exponent. The default
/// tables use gamma 2.2 for all three channels, preserving the existing wire
/// behaviour until the user selects different values.
#[derive(Clone)]
pub struct GammaLuts {
    pub r: [u8; 256],
    pub g: [u8; 256],
    pub b: [u8; 256],
}

/// Build three independent gamma LUTs from the supplied per-channel exponents.
/// Each entry: `round((i / 255)^gamma * 255)`.
pub fn build_gamma_luts(gamma_r: f32, gamma_g: f32, gamma_b: f32) -> GammaLuts {
    #[cfg(test)]
    GAMMA_LUT_BUILDS.with(|n| n.set(n.get() + 1));
    let mut r = [0u8; 256];
    let mut g = [0u8; 256];
    let mut b = [0u8; 256];
    for i in 0..=255usize {
        let v = i as f32 / 255.0_f32;
        r[i] = (v.powf(gamma_r) * 255.0_f32).round() as u8;
        g[i] = (v.powf(gamma_g) * 255.0_f32).round() as u8;
        b[i] = (v.powf(gamma_b) * 255.0_f32).round() as u8;
    }
    GammaLuts { r, g, b }
}

// Per-thread so the plan-is-built-once tests are not disturbed by other tests
// building LUTs concurrently.
#[cfg(test)]
thread_local! {
    pub(super) static GAMMA_LUT_BUILDS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

#[cfg(test)]
pub(crate) fn gamma_lut_builds_on_this_thread() -> usize {
    GAMMA_LUT_BUILDS.with(|n| n.get())
}

/// Default gamma 2.2 / 2.2 / 2.2 tables — identical to the old unified
/// `GAMMA_LUT`, kept as a static to avoid re-computing on every frame.
static DEFAULT_GAMMA_LUTS: std::sync::LazyLock<Arc<GammaLuts>> =
    std::sync::LazyLock::new(|| Arc::new(build_gamma_luts(2.2, 2.2, 2.2)));

// EXACT comparison (`== 2.2_f32`): a near-2.2 user gamma must still go through
// `build_gamma_luts` to stay byte-identical with what a full build would have
// produced. Do NOT use a tolerance here.
fn uses_default_gamma(corrections: &ColorCorrectionConfig) -> bool {
    corrections.gamma_r == 2.2_f32
        && corrections.gamma_g == 2.2_f32
        && corrections.gamma_b == 2.2_f32
}

// ---------------------------------------------------------------------------
// Kelvin white-balance
// ---------------------------------------------------------------------------

/// Convert a colour temperature in Kelvin to per-channel RGB multipliers.
///
/// Uses the Tanner Helland curve-fit approximation, clamped to [0.0, 1.0] and
/// normalized so the maximum multiplier of each channel is 1.0.
///
/// 6500 K returns `[1.0, 1.0, 1.0]` (identity fast-path) so the default
/// configuration adds zero cost to the hot path.
///
/// The returned array is `[r_mul, g_mul, b_mul]`.
// The Tanner Helland constants deliberately exceed f32 representable precision;
// the extra digits document the original source values and do not affect the
// compiled output.
#[allow(clippy::excessive_precision)]
pub fn kelvin_to_rgb_multipliers(kelvin: u16) -> [f32; 3] {
    if kelvin == 6500 {
        return [1.0_f32, 1.0_f32, 1.0_f32];
    }

    let temp = kelvin as f32 / 100.0_f32;

    let r = if temp <= 66.0 {
        1.0_f32
    } else {
        let v = 329.698_727_446_f32 * (temp - 60.0_f32).powf(-0.133_204_759_2_f32);
        (v / 255.0_f32).clamp(0.0_f32, 1.0_f32)
    };

    let g = if temp <= 66.0 {
        let v = 99.470_802_586_f32 * temp.ln() - 161.119_568_166_f32;
        (v / 255.0_f32).clamp(0.0_f32, 1.0_f32)
    } else {
        let v = 288.122_169_528_f32 * (temp - 60.0_f32).powf(-0.075_514_849_2_f32);
        (v / 255.0_f32).clamp(0.0_f32, 1.0_f32)
    };

    let b = if temp >= 66.0 {
        1.0_f32
    } else if temp <= 19.0 {
        0.0_f32
    } else {
        let v = 138.517_731_223_f32 * (temp - 10.0_f32).ln() - 305.044_792_730_f32;
        (v / 255.0_f32).clamp(0.0_f32, 1.0_f32)
    };

    [r, g, b]
}

/// Apply Kelvin white-balance multipliers to a single pixel.
#[inline(always)]
pub fn apply_kelvin_to_pixel(rgb: [u8; 3], multipliers: &[f32; 3]) -> [u8; 3] {
    [
        (rgb[0] as f32 * multipliers[0]).round().clamp(0.0, 255.0) as u8,
        (rgb[1] as f32 * multipliers[1]).round().clamp(0.0, 255.0) as u8,
        (rgb[2] as f32 * multipliers[2]).round().clamp(0.0, 255.0) as u8,
    ]
}

// ---------------------------------------------------------------------------
// Saturation correction
// ---------------------------------------------------------------------------

/// Apply saturation correction to a single pixel using BT.601 luminance blend.
///
/// `saturation = 1.0` is the identity (epsilon fast-path, no arithmetic).
/// `saturation = 0.0` produces a pure greyscale output.
/// Values above 1.0 boost saturation beyond the original.
#[inline(always)]
pub fn apply_saturation_to_pixel(rgb: [u8; 3], saturation: f32) -> [u8; 3] {
    if (saturation - 1.0_f32).abs() < f32::EPSILON {
        return rgb;
    }

    let r = rgb[0] as f32;
    let g = rgb[1] as f32;
    let b = rgb[2] as f32;

    let luma = 0.299_f32 * r + 0.587_f32 * g + 0.114_f32 * b;

    let out_r = (luma + saturation * (r - luma)).round().clamp(0.0, 255.0) as u8;
    let out_g = (luma + saturation * (g - luma)).round().clamp(0.0, 255.0) as u8;
    let out_b = (luma + saturation * (b - luma)).round().clamp(0.0, 255.0) as u8;

    [out_r, out_g, out_b]
}

// ---------------------------------------------------------------------------
// Single-pixel colour correction
// ---------------------------------------------------------------------------

/// One pixel through a plan built for the call. For one-off colours (Solid,
/// the Hue solid path); anything per frame keeps an `EncoderPlan` instead, or
/// it pays for the plan (and, off 2.2, 768 `powf`s) on every call.
pub fn apply_color_correction_rgb(
    rgb: (u8, u8, u8),
    corrections: &ColorCorrectionConfig,
) -> (u8, u8, u8) {
    let [r, g, b] = EncoderPlan::new(corrections).correct([rgb.0, rgb.1, rgb.2]);
    (r, g, b)
}

/// Host-side brightness, for the outputs whose wire has no brightness field:
/// Adalight, WLED, and the twin overlay's copy of the strip.
#[inline(always)]
pub fn scale_brightness(pixel: [u8; 3], brightness: f32) -> [u8; 3] {
    pixel.map(|v| (v as f32 * brightness).round().clamp(0.0, 255.0) as u8)
}

// ---------------------------------------------------------------------------
// Encoder plan — colour corrections derived once, applied per pixel
// ---------------------------------------------------------------------------

/// Every colour correction an output applies per pixel, derived from a
/// `ColorCorrectionConfig` once: the serial encoders, `CorrectedWledSink`, the
/// Hue channels and the twin overlay all go through one. See
/// docs/architecture/capture-and-pipeline.md, "One colour pipeline".
///
/// Build it when the corrections change — sink or worker construction, or once
/// per Solid write — never per frame: a non-default gamma costs 768 `powf`s,
/// and a non-6500 K white point a `powf` and a `ln`. A new per-pixel stage is
/// one more field here plus one line in `correct` and `correct_precise`, and no
/// output can skip it.
#[derive(Clone)]
pub struct EncoderPlan {
    // Arc, not inline: 768 bytes inline would make `SerialSink` dwarf the
    // boxed WLED variant of the worker's `ActiveUsbSink`.
    luts: Arc<GammaLuts>,
    /// `None` at 6500 K, the identity.
    kelvin_muls: Option<[f32; 3]>,
    /// `None` at 1.0, the identity.
    saturation: Option<f32>,
    /// The exponents behind `luts`, for `correct_precise`.
    gamma: [f32; 3],
    /// Unlike the fields above, retunable on a running sink: it costs nothing
    /// to change, so it is patched in place rather than rebuilding the plan.
    color_order: LedColorOrder,
}

impl EncoderPlan {
    pub fn new(corrections: &ColorCorrectionConfig) -> Self {
        let luts = if uses_default_gamma(corrections) {
            Arc::clone(&DEFAULT_GAMMA_LUTS)
        } else {
            Arc::new(build_gamma_luts(
                corrections.gamma_r,
                corrections.gamma_g,
                corrections.gamma_b,
            ))
        };
        let kelvin_muls =
            (corrections.kelvin != 6500).then(|| kelvin_to_rgb_multipliers(corrections.kelvin));
        let saturation = ((corrections.saturation - 1.0_f32).abs() >= f32::EPSILON)
            .then_some(corrections.saturation);
        Self {
            luts,
            kelvin_muls,
            saturation,
            gamma: [
                corrections.gamma_r,
                corrections.gamma_g,
                corrections.gamma_b,
            ],
            color_order: LedColorOrder::Rgb,
        }
    }

    pub fn with_color_order(mut self, order: LedColorOrder) -> Self {
        self.color_order = order;
        self
    }

    /// Patches only the order; the LUTs and the other stages are untouched.
    pub fn set_color_order(&mut self, order: LedColorOrder) {
        self.color_order = order;
    }

    /// Corrected pixel in wire slot order. `Rgb` returns `correct` unchanged.
    #[inline(always)]
    pub(super) fn wire_rgb(&self, pixel: [u8; 3]) -> [u8; 3] {
        let corrected = self.correct(pixel);
        match self.color_order {
            LedColorOrder::Rgb => corrected,
            order => order.permute(corrected),
        }
    }

    /// Pipeline order: saturation → Kelvin → gamma LUT.
    #[inline(always)]
    pub fn correct(&self, pixel: [u8; 3]) -> [u8; 3] {
        let pixel = match self.saturation {
            Some(saturation) => apply_saturation_to_pixel(pixel, saturation),
            None => pixel,
        };
        let [r, g, b] = match &self.kelvin_muls {
            Some(muls) => apply_kelvin_to_pixel(pixel, muls),
            None => pixel,
        };
        [
            self.luts.r[r as usize],
            self.luts.g[g as usize],
            self.luts.b[b as usize],
        ]
    }

    /// `correct` without rounding between or after the stages, for Hue's
    /// 16-bit wire: `u8` there would step visibly in a dark fade, where gamma
    /// 2.2 leaves only a handful of levels. In 0–255 (gamma-encoded), out 0–1.
    pub fn correct_precise(&self, pixel: [f32; 3]) -> [f32; 3] {
        let [mut r, mut g, mut b] = pixel.map(|v| v.clamp(0.0, 255.0));
        if let Some(saturation) = self.saturation {
            let luma = 0.299_f32 * r + 0.587_f32 * g + 0.114_f32 * b;
            r = (luma + saturation * (r - luma)).clamp(0.0, 255.0);
            g = (luma + saturation * (g - luma)).clamp(0.0, 255.0);
            b = (luma + saturation * (b - luma)).clamp(0.0, 255.0);
        }
        if let Some(muls) = &self.kelvin_muls {
            r = (r * muls[0]).clamp(0.0, 255.0);
            g = (g * muls[1]).clamp(0.0, 255.0);
            b = (b * muls[2]).clamp(0.0, 255.0);
        }
        [
            (r / 255.0).powf(self.gamma[0]),
            (g / 255.0).powf(self.gamma[1]),
            (b / 255.0).powf(self.gamma[2]),
        ]
    }

    #[cfg(test)]
    pub(super) fn luts_ptr(&self) -> *const GammaLuts {
        Arc::as_ptr(&self.luts)
    }
}

impl Default for EncoderPlan {
    fn default() -> Self {
        Self::new(&ColorCorrectionConfig::default())
    }
}
