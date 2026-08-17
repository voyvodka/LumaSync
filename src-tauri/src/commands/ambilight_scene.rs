//! Scene-adaptive stage between the region samplers and the per-sink smoothers.
//!
//! One frame in, one decision out: how much to relate neighbouring lights, how
//! far each light leans towards the frame's ambience colour, and how fast every
//! sink may move this frame. Reasoning and the tuning story are in
//! `docs/architecture/capture-and-pipeline.md` §"Scene-adaptive stage".
//!
//! Sink-agnostic on purpose: it sees light colours plus a topology, never a
//! strip, a Hue channel or a WLED device.

use super::ambilight_capture::{BlackBorderInsets, CapturedFrame};

// Tuning constants — tuned, not derived (no published number exists for this
// viewing situation); expressed in u′v′ / Y so a value means the same at every hue.

/// Frame-statistics stride, both axes. 640×360 → ~3 600 samples.
const STATS_STRIDE: usize = 8;
/// Bits per channel for the change histogram (Lienhart: 2 or 3). 2 → 64 bins.
const HIST_BITS: u32 = 2;
const HIST_BINS: usize = 1 << (3 * HIST_BITS);

/// Chroma difference unit — Δu′v′ of this size counts as "one unit" of Δ.
const CHROMA_UNIT: f32 = 0.05;
/// Luminance difference unit, in linear Y (0..1).
const LUMA_UNIT: f32 = 0.25;
/// Below this linear Y a light's chroma is treated as noise (weight ramps to 0).
const CHROMA_TRUST_Y: f32 = 0.20;

/// σ_r = clamp(k · median adjacent Δ, min, max), in Δ units.
const RANGE_GAIN: f32 = 2.0;
const RANGE_SIGMA_MIN: f32 = 0.35;
const RANGE_SIGMA_MAX: f32 = 3.0;
/// EWMA rate for the σ_r envelope (both directions).
const RANGE_ENVELOPE_RATE: f32 = 0.2;

/// Chain radius, in lights, over which chroma is related.
const CHAIN_RADIUS: usize = 5;
/// Spatial σ for chroma (wide) and luminance (narrow) — in lights for chains,
/// in position units for point sets.
const CHROMA_SPATIAL_SIGMA_CHAIN: f32 = 2.5;
const LUMA_SPATIAL_SIGMA_CHAIN: f32 = 1.5;
const CHROMA_SPATIAL_SIGMA_POINTS: f32 = 0.6;
const LUMA_SPATIAL_SIGMA_POINTS: f32 = 0.3;

/// α floor as a fraction of the preset ceiling.
const ALPHA_FLOOR_RATIO: f32 = 0.3;
/// Change-envelope release per frame (attack is instant).
const CHANGE_RELEASE: f32 = 0.85;
/// smoothstep bounds on the change envelope that map floor → ceiling.
const CHANGE_LO: f32 = 0.008;
const CHANGE_HI: f32 = 0.15;

/// Ambience memory follows the frame mean at `alpha · AMBIENCE_RATE`.
const AMBIENCE_RATE: f32 = 0.25;
/// Ambience lean for an on-screen light, from a structured to a flat frame.
const AMBIENCE_LEAN_MIN: f32 = 0.05;
const AMBIENCE_LEAN_MAX: f32 = 0.35;
/// Mean Δ between the lights and the ambience colour at or above which the
/// frame counts as fully structured (leaning would wash it out).
const CONTRAST_REF: f32 = 1.5;

// ---------------------------------------------------------------------------
// Colour helpers
// ---------------------------------------------------------------------------

fn srgb_to_linear_lut() -> [f32; 256] {
    let mut lut = [0f32; 256];
    for (i, v) in lut.iter_mut().enumerate() {
        let c = i as f32 / 255.0;
        *v = if c <= 0.04045 {
            c / 12.92
        } else {
            ((c + 0.055) / 1.055).powf(2.4)
        };
    }
    lut
}

fn linear_to_srgb_u8(c: f32) -> u8 {
    let c = c.clamp(0.0, 1.0);
    let s = if c <= 0.003_130_8 {
        c * 12.92
    } else {
        1.055 * c.powf(1.0 / 2.4) - 0.055
    };
    (s * 255.0).round().clamp(0.0, 255.0) as u8
}

/// Linear sRGB (D65) → (Y, u′, v′). Black maps to D65 white chroma so a black
/// light differs from anything only in luminance.
fn linear_to_yuv(rgb: [f32; 3]) -> (f32, f32, f32) {
    let [r, g, b] = rgb;
    let x = 0.4124 * r + 0.3576 * g + 0.1805 * b;
    let y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    let z = 0.0193 * r + 0.1192 * g + 0.9505 * b;
    let denom = x + 15.0 * y + 3.0 * z;
    if denom <= 1e-6 {
        return (0.0, 0.1978, 0.4683);
    }
    (y, 4.0 * x / denom, 9.0 * y / denom)
}

fn smoothstep(lo: f32, hi: f32, x: f32) -> f32 {
    let t = ((x - lo) / (hi - lo)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

/// Perceptual distance² between two lights, in Δ units. Chroma counts only as
/// far as the darker of the two is bright enough for its chroma to mean
/// anything; luminance always counts.
fn light_distance_sq(a: (f32, f32, f32), b: (f32, f32, f32)) -> f32 {
    let du = a.1 - b.1;
    let dv = a.2 - b.2;
    let chroma_trust = (a.0.min(b.0) / CHROMA_TRUST_Y).clamp(0.0, 1.0);
    let chroma = (du * du + dv * dv) / (CHROMA_UNIT * CHROMA_UNIT);
    let dy = (a.0 - b.0) / LUMA_UNIT;
    chroma_trust * chroma + dy * dy
}

// ---------------------------------------------------------------------------
// Topology
// ---------------------------------------------------------------------------

/// How the lights of one set sit relative to each other.
#[derive(Clone, Debug)]
pub enum LightTopology {
    /// Lights in physical order along a strip. `closed` when the last light is
    /// physically next to the first (a full perimeter).
    Chain { closed: bool },
    /// Free-standing lights at 2-D positions in one shared unit (Hue space).
    Points(Vec<(f32, f32)>),
}

/// Per-set state that has to survive across frames.
#[derive(Clone, Debug, Default)]
pub struct LightSetState {
    range_sigma: Option<f32>,
    last_median: f32,
    last_spread: f32,
    last_lean: f32,
}

impl LightSetState {
    /// (σ_r, median adjacent Δ, mean Δ to ambience, ambience lean) of the last
    /// `process` call — observability for tuning, read by the worker log.
    pub fn debug_tuple(&self) -> (f32, f32, f32, f32) {
        (
            self.range_sigma.unwrap_or(0.0),
            self.last_median,
            self.last_spread,
            self.last_lean,
        )
    }
}

/// Where a light sits relative to the screen: `1.0` on the screen edge, → `0`
/// far away. Drives how much of the frame-wide ambience it receives.
pub fn hue_default_screen_affinity(position_y: f32) -> f32 {
    // Hue +y is the TV wall, −y behind the viewer (docs/architecture/hue.md).
    ((position_y.clamp(-1.0, 1.0) + 1.0) / 2.0).clamp(0.0, 1.0)
}

// ---------------------------------------------------------------------------
// Analyzer
// ---------------------------------------------------------------------------

/// Cross-frame scene state plus scratch buffers. One per worker.
#[derive(Debug)]
pub struct SceneAnalyzer {
    lut: [f32; 256],
    hist_prev: Option<[u32; HIST_BINS]>,
    hist_cur: [u32; HIST_BINS],
    change_env: f32,
    last_change: f32,
    frame_mean: [f32; 3],
    ambience: Option<[f32; 3]>,
    /// α resolved for the current frame by `observe_frame`.
    alpha: f32,
    // Scratch, reused so the hot path allocates nothing after warm-up.
    lin: Vec<[f32; 3]>,
    yuv: Vec<(f32, f32, f32)>,
    adjacent: Vec<f32>,
    wide: Vec<[f32; 3]>,
    y_narrow: Vec<f32>,
}

impl Default for SceneAnalyzer {
    fn default() -> Self {
        Self::new()
    }
}

impl SceneAnalyzer {
    pub fn new() -> Self {
        Self {
            lut: srgb_to_linear_lut(),
            hist_prev: None,
            hist_cur: [0; HIST_BINS],
            change_env: 0.0,
            last_change: 0.0,
            frame_mean: [0.0; 3],
            ambience: None,
            alpha: 0.0,
            lin: Vec::new(),
            yuv: Vec::new(),
            adjacent: Vec::new(),
            wide: Vec::new(),
            y_narrow: Vec::new(),
        }
    }

    /// One pass over the frame (inside the border insets): frame mean, change
    /// histogram, and from those the movement envelope, this frame's α, and
    /// the ambience memory. Call once per frame, before `process`.
    pub fn observe_frame(
        &mut self,
        frame: &CapturedFrame,
        insets: &BlackBorderInsets,
        alpha_ceiling: f32,
    ) {
        let w = frame.width as usize;
        let h = frame.height as usize;
        let alpha_ceiling = alpha_ceiling.clamp(0.05, 1.0);
        let alpha_floor = alpha_ceiling * ALPHA_FLOOR_RATIO;

        self.hist_cur = [0; HIST_BINS];
        let mut sum = [0f32; 3];
        let mut count = 0u32;
        if w > 0 && h > 0 && !frame.pixels_rgb.is_empty() {
            let top = (h as f32 * insets.top) as usize;
            let bottom = h
                .saturating_sub((h as f32 * insets.bottom) as usize)
                .max(top + 1);
            let left = (w as f32 * insets.left) as usize;
            let right = w
                .saturating_sub((w as f32 * insets.right) as usize)
                .max(left + 1);
            let shift = 8 - HIST_BITS;
            let mut row = top;
            while row < bottom {
                let mut col = left;
                while col < right {
                    if let Some(px) = frame.pixels_rgb.get(row * w + col) {
                        sum[0] += self.lut[px[0] as usize];
                        sum[1] += self.lut[px[1] as usize];
                        sum[2] += self.lut[px[2] as usize];
                        let bin = (((px[0] >> shift) as usize) << (2 * HIST_BITS))
                            | (((px[1] >> shift) as usize) << HIST_BITS)
                            | ((px[2] >> shift) as usize);
                        self.hist_cur[bin] += 1;
                        count += 1;
                    }
                    col += STATS_STRIDE;
                }
                row += STATS_STRIDE;
            }
        }

        let change = match (count, self.hist_prev.as_ref()) {
            (0, _) | (_, None) => 0.0,
            (n, Some(prev)) => {
                let l1: u32 = self
                    .hist_cur
                    .iter()
                    .zip(prev.iter())
                    .map(|(a, b)| a.abs_diff(*b))
                    .sum();
                (l1 as f32 / (2.0 * n as f32)).clamp(0.0, 1.0)
            }
        };
        if count > 0 {
            self.hist_prev = Some(self.hist_cur);
            let n = count as f32;
            self.frame_mean = [sum[0] / n, sum[1] / n, sum[2] / n];
        }

        // Instant attack, slow release: a cut is followed at once, a lull is
        // trusted only after it has lasted.
        self.last_change = change;
        self.change_env = if change > self.change_env {
            change
        } else {
            self.change_env * CHANGE_RELEASE
        };
        self.alpha = alpha_floor
            + (alpha_ceiling - alpha_floor) * smoothstep(CHANGE_LO, CHANGE_HI, self.change_env);

        if count > 0 {
            let rate = (self.alpha * AMBIENCE_RATE).clamp(0.0, 1.0);
            self.ambience = Some(match self.ambience {
                None => self.frame_mean,
                Some(prev) => [
                    prev[0] + rate * (self.frame_mean[0] - prev[0]),
                    prev[1] + rate * (self.frame_mean[1] - prev[1]),
                    prev[2] + rate * (self.frame_mean[2] - prev[2]),
                ],
            });
        }
    }

    /// EWMA α every sink must use this frame. Never above the ceiling passed to
    /// `observe_frame`.
    pub fn alpha(&self) -> f32 {
        self.alpha
    }

    /// Movement envelope in [0, 1] — exposed for telemetry and tests.
    pub fn change_envelope(&self) -> f32 {
        self.change_env
    }

    /// Raw histogram change of the last frame, before the envelope.
    pub fn last_change(&self) -> f32 {
        self.last_change
    }

    /// Ambience colour as sRGB, if a frame has been observed.
    pub fn ambience_srgb(&self) -> Option<[u8; 3]> {
        self.ambience.map(|a| {
            [
                linear_to_srgb_u8(a[0]),
                linear_to_srgb_u8(a[1]),
                linear_to_srgb_u8(a[2]),
            ]
        })
    }

    /// Relate the lights of one set to each other and to the ambience colour,
    /// in place. `affinity` is per light (`1.0` = on the screen edge); a
    /// shorter slice is treated as `1.0` for the missing tail.
    pub fn process(
        &mut self,
        colors: &mut [[u8; 3]],
        topology: &LightTopology,
        affinity: &[f32],
        state: &mut LightSetState,
    ) {
        let n = colors.len();
        if n == 0 {
            return;
        }
        self.lin.clear();
        self.yuv.clear();
        for c in colors.iter() {
            let lin = [
                self.lut[c[0] as usize],
                self.lut[c[1] as usize],
                self.lut[c[2] as usize],
            ];
            self.lin.push(lin);
            self.yuv.push(linear_to_yuv(lin));
        }

        // Per-frame separation scale: what "unusually different" means here.
        self.adjacent.clear();
        match topology {
            LightTopology::Chain { closed } => {
                for i in 0..n.saturating_sub(1) {
                    self.adjacent
                        .push(light_distance_sq(self.yuv[i], self.yuv[i + 1]).sqrt());
                }
                if *closed && n > 2 {
                    self.adjacent
                        .push(light_distance_sq(self.yuv[n - 1], self.yuv[0]).sqrt());
                }
            }
            LightTopology::Points(pos) => {
                for i in 0..n {
                    for j in (i + 1)..n {
                        if pos.len() > i && pos.len() > j {
                            self.adjacent
                                .push(light_distance_sq(self.yuv[i], self.yuv[j]).sqrt());
                        }
                    }
                }
            }
        }
        let median = if self.adjacent.is_empty() {
            0.0
        } else {
            let mid = self.adjacent.len() / 2;
            *self
                .adjacent
                .select_nth_unstable_by(mid, |a, b| a.total_cmp(b))
                .1
        };
        let target_sigma = (RANGE_GAIN * median).clamp(RANGE_SIGMA_MIN, RANGE_SIGMA_MAX);
        let sigma_r = match state.range_sigma {
            None => target_sigma,
            Some(prev) => prev + RANGE_ENVELOPE_RATE * (target_sigma - prev),
        };
        state.range_sigma = Some(sigma_r);
        state.last_median = median;
        let inv_2sr2 = 1.0 / (2.0 * sigma_r * sigma_r);

        // Bilateral pass: wide kernel on RGB (chroma), narrow kernel on Y.
        self.wide.clear();
        self.wide.resize(n, [0.0; 3]);
        self.y_narrow.clear();
        self.y_narrow.resize(n, 0.0);
        let (chroma_sigma, luma_sigma) = match topology {
            LightTopology::Chain { .. } => (CHROMA_SPATIAL_SIGMA_CHAIN, LUMA_SPATIAL_SIGMA_CHAIN),
            LightTopology::Points(_) => (CHROMA_SPATIAL_SIGMA_POINTS, LUMA_SPATIAL_SIGMA_POINTS),
        };
        let inv_2sc2 = 1.0 / (2.0 * chroma_sigma * chroma_sigma);
        let inv_2sy2 = 1.0 / (2.0 * luma_sigma * luma_sigma);

        for i in 0..n {
            let mut acc = [0f32; 3];
            let mut wsum_c = 0f32;
            let mut acc_y = 0f32;
            let mut wsum_y = 0f32;
            let mut visit = |j: usize, dist_sq: f32, this: &Self| {
                let range = (-light_distance_sq(this.yuv[i], this.yuv[j]) * inv_2sr2).exp();
                let wc = (-dist_sq * inv_2sc2).exp() * range;
                let wy = (-dist_sq * inv_2sy2).exp() * range;
                acc[0] += wc * this.lin[j][0];
                acc[1] += wc * this.lin[j][1];
                acc[2] += wc * this.lin[j][2];
                wsum_c += wc;
                acc_y += wy * this.yuv[j].0;
                wsum_y += wy;
            };
            match topology {
                LightTopology::Chain { closed } => {
                    for k in 1..=CHAIN_RADIUS {
                        let d = (k * k) as f32;
                        if i >= k {
                            visit(i - k, d, self);
                        } else if *closed && n > CHAIN_RADIUS * 2 {
                            visit(n - (k - i), d, self);
                        }
                        if i + k < n {
                            visit(i + k, d, self);
                        } else if *closed && n > CHAIN_RADIUS * 2 {
                            visit(i + k - n, d, self);
                        }
                    }
                }
                LightTopology::Points(pos) => {
                    if let Some(&(xi, yi)) = pos.get(i) {
                        for (j, &(xj, yj)) in pos.iter().enumerate().take(n) {
                            if j != i {
                                let dx = xi - xj;
                                let dy = yi - yj;
                                visit(j, dx * dx + dy * dy, self);
                            }
                        }
                    }
                }
            }
            // Self weight is 1 on both kernels.
            acc[0] += self.lin[i][0];
            acc[1] += self.lin[i][1];
            acc[2] += self.lin[i][2];
            wsum_c += 1.0;
            acc_y += self.yuv[i].0;
            wsum_y += 1.0;

            self.wide[i] = [acc[0] / wsum_c, acc[1] / wsum_c, acc[2] / wsum_c];
            self.y_narrow[i] = acc_y / wsum_y;
        }

        // Ambience lean for an on-screen light this frame. Structure is how far
        // the lights sit from the ambience colour — not neighbour contrast, which
        // reads a two-flat-region frame (sky over grass) as flat.
        let ambience = self.ambience.unwrap_or(self.frame_mean);
        let ambience_yuv = linear_to_yuv(ambience);
        let spread = self
            .yuv
            .iter()
            .map(|&l| light_distance_sq(l, ambience_yuv).sqrt())
            .sum::<f32>()
            / n as f32;
        let contrast = (spread / CONTRAST_REF).clamp(0.0, 1.0);
        let lean = AMBIENCE_LEAN_MIN + (AMBIENCE_LEAN_MAX - AMBIENCE_LEAN_MIN) * (1.0 - contrast);
        state.last_spread = spread;
        state.last_lean = lean;

        for (i, color) in colors.iter_mut().enumerate() {
            let wide = self.wide[i];
            let y_wide = 0.2126 * wide[0] + 0.7152 * wide[1] + 0.0722 * wide[2];
            let scale = if y_wide > 1e-6 {
                self.y_narrow[i] / y_wide
            } else {
                1.0
            };
            let filtered = [wide[0] * scale, wide[1] * scale, wide[2] * scale];
            let aff = affinity.get(i).copied().unwrap_or(1.0).clamp(0.0, 1.0);
            let b = 1.0 - aff * (1.0 - lean);
            let out = [
                filtered[0] + b * (ambience[0] - filtered[0]),
                filtered[1] + b * (ambience[1] - filtered[1]),
                filtered[2] + b * (ambience[2] - filtered[2]),
            ];
            *color = [
                linear_to_srgb_u8(out[0]),
                linear_to_srgb_u8(out[1]),
                linear_to_srgb_u8(out[2]),
            ];
        }
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(w: usize, h: usize, f: impl Fn(usize, usize) -> [u8; 3]) -> CapturedFrame {
        let mut px = Vec::with_capacity(w * h);
        for y in 0..h {
            for x in 0..w {
                px.push(f(x, y));
            }
        }
        CapturedFrame {
            width: w as u32,
            height: h as u32,
            pixels_rgb: px,
        }
    }

    fn uniform(rgb: [u8; 3]) -> CapturedFrame {
        frame(64, 36, |_, _| rgb)
    }

    /// Deterministic pseudo-noise, no RNG dependency.
    fn noise(i: usize, amp: i32) -> i32 {
        let mut x = (i as u64).wrapping_add(0x9E37_79B9_7F4A_7C15);
        x = (x ^ (x >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        x = (x ^ (x >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        x ^= x >> 31;
        (x % (2 * amp as u64 + 1)) as i32 - amp
    }

    /// Neighbour-difference variance split into (chroma in u′v′, luminance Y) —
    /// the design claim is that chroma is related far more than luminance.
    fn neighbour_variance(colors: &[[u8; 3]]) -> (f32, f32) {
        let lut = srgb_to_linear_lut();
        let yuv: Vec<_> = colors
            .iter()
            .map(|c| linear_to_yuv([lut[c[0] as usize], lut[c[1] as usize], lut[c[2] as usize]]))
            .collect();
        let mut chroma = 0f32;
        let mut luma = 0f32;
        for w in yuv.windows(2) {
            let du = w[0].1 - w[1].1;
            let dv = w[0].2 - w[1].2;
            chroma += du * du + dv * dv;
            let dy = w[0].0 - w[1].0;
            luma += dy * dy;
        }
        let n = (colors.len() - 1) as f32;
        (chroma / n, luma / n)
    }

    #[test]
    fn coherence_relates_chroma_strongly_and_luminance_gently() {
        let mut a = SceneAnalyzer::new();
        a.observe_frame(&uniform([120, 90, 60]), &BlackBorderInsets::default(), 0.35);
        let mut colors: Vec<[u8; 3]> = (0..60)
            .map(|i| {
                [
                    (120 + noise(i, 25)).clamp(0, 255) as u8,
                    (90 + noise(i + 1000, 25)).clamp(0, 255) as u8,
                    (60 + noise(i + 2000, 25)).clamp(0, 255) as u8,
                ]
            })
            .collect();
        let (chroma_before, luma_before) = neighbour_variance(&colors);
        let mut state = LightSetState::default();
        a.process(
            &mut colors,
            &LightTopology::Chain { closed: false },
            &[],
            &mut state,
        );
        let (chroma_after, luma_after) = neighbour_variance(&colors);
        assert!(
            chroma_after * 8.0 < chroma_before,
            "chroma before={chroma_before} after={chroma_after}"
        );
        assert!(
            luma_after * 2.0 < luma_before,
            "luma before={luma_before} after={luma_after}"
        );
        assert!(
            chroma_before / chroma_after > luma_before / luma_after,
            "chroma must be related more than luminance: chroma {chroma_before}->{chroma_after}, luma {luma_before}->{luma_after}"
        );
    }

    #[test]
    fn genuine_boundary_survives_the_filter() {
        // Sky over grass: a strip whose first half is blue and second half green.
        let mut a = SceneAnalyzer::new();
        a.observe_frame(
            &frame(
                64,
                36,
                |_, y| if y < 18 { [40, 90, 220] } else { [40, 160, 50] },
            ),
            &BlackBorderInsets::default(),
            0.35,
        );
        let mut colors: Vec<[u8; 3]> = (0..40)
            .map(|i| if i < 20 { [40, 90, 220] } else { [40, 160, 50] })
            .collect();
        let mut state = LightSetState::default();
        a.process(
            &mut colors,
            &LightTopology::Chain { closed: false },
            &[],
            &mut state,
        );
        // Away from the boundary each side keeps its own colour…
        assert!(
            colors[5][2] > 150 && colors[5][1] < 130,
            "sky side {:?}",
            colors[5]
        );
        assert!(
            colors[34][1] > 120 && colors[34][2] < 110,
            "grass side {:?}",
            colors[34]
        );
        // …and the boundary is still a step, not a ramp across the whole strip.
        let step = colors[19][2] as i32 - colors[20][2] as i32;
        assert!(
            step > 60,
            "boundary step {step}, {:?} / {:?}",
            colors[19],
            colors[20]
        );
    }

    #[test]
    fn affinity_zero_yields_ambience_and_one_keeps_region() {
        let mut a = SceneAnalyzer::new();
        // Frame is mid grey; the region colours are strongly red — a structured
        // frame (high contrast between the two lights) so the on-screen lean is small.
        a.observe_frame(
            &uniform([128, 128, 128]),
            &BlackBorderInsets::default(),
            0.35,
        );
        let ambience = a.ambience_srgb().unwrap();
        let mut colors = vec![[220, 30, 30], [30, 30, 220]];
        let mut state = LightSetState::default();
        a.process(
            &mut colors,
            &LightTopology::Points(vec![(-0.8, 0.9), (0.8, -0.9)]),
            &[1.0, 0.0],
            &mut state,
        );
        assert!(
            colors[0][0] > 180 && colors[0][2] < 90,
            "on-screen light {:?}",
            colors[0]
        );
        for c in 0..3 {
            assert!(
                (colors[1][c] as i32 - ambience[c] as i32).abs() <= 2,
                "far light {:?} vs ambience {:?}",
                colors[1],
                ambience
            );
        }
    }

    #[test]
    fn alpha_never_exceeds_ceiling_and_reaches_floor_when_static() {
        let mut a = SceneAnalyzer::new();
        let ceiling = 0.35;
        let insets = BlackBorderInsets::default();
        for i in 0..200usize {
            let f = if i % 17 == 0 {
                uniform([
                    (i * 37 % 256) as u8,
                    (i * 91 % 256) as u8,
                    (i * 13 % 256) as u8,
                ])
            } else {
                uniform([10, 10, 10])
            };
            a.observe_frame(&f, &insets, ceiling);
            assert!(a.alpha() <= ceiling + 1e-6, "alpha {} > ceiling", a.alpha());
            assert!(a.alpha() >= ceiling * ALPHA_FLOOR_RATIO - 1e-6);
        }
        for _ in 0..60 {
            a.observe_frame(&uniform([10, 10, 10]), &insets, ceiling);
        }
        assert!(
            (a.alpha() - ceiling * ALPHA_FLOOR_RATIO).abs() < 1e-3,
            "{}",
            a.alpha()
        );
    }

    // Measured on film content (Big Buck Bunny, 25 fps capture): ordinary motion
    // gives change ≈ 0.007–0.012, a hard cut ≈ 0.3. The window must let ordinary
    // motion lift alpha partway and a cut saturate it.
    #[test]
    fn ordinary_motion_lifts_alpha_partway_and_a_cut_saturates() {
        assert!(smoothstep(CHANGE_LO, CHANGE_HI, 0.012) > 0.0);
        assert!(smoothstep(CHANGE_LO, CHANGE_HI, 0.012) < 0.2);
        assert!(smoothstep(CHANGE_LO, CHANGE_HI, 0.005) == 0.0);
        assert!(smoothstep(CHANGE_LO, CHANGE_HI, 0.3) == 1.0);
    }

    #[test]
    fn hard_change_hits_ceiling_and_releases_gradually() {
        let mut a = SceneAnalyzer::new();
        let insets = BlackBorderInsets::default();
        for _ in 0..30 {
            a.observe_frame(&uniform([200, 40, 40]), &insets, 0.6);
        }
        assert!(a.alpha() < 0.2);
        a.observe_frame(&uniform([40, 40, 200]), &insets, 0.6);
        assert!((a.alpha() - 0.6).abs() < 1e-3, "{}", a.alpha());
        let mut last = a.alpha();
        let mut released = 0;
        for _ in 0..40 {
            a.observe_frame(&uniform([40, 40, 200]), &insets, 0.6);
            assert!(a.alpha() <= last + 1e-6);
            if a.alpha() < last {
                released += 1;
            }
            last = a.alpha();
        }
        assert!(
            released >= 5,
            "release should span several frames, got {released}"
        );
        assert!(last < 0.2);
    }

    #[test]
    fn slow_drift_keeps_alpha_at_floor() {
        let mut a = SceneAnalyzer::new();
        let insets = BlackBorderInsets::default();
        for i in 0..120u8 {
            a.observe_frame(&uniform([100 + i / 2, 80, 60]), &insets, 0.35);
        }
        assert!(a.alpha() < 0.35 * ALPHA_FLOOR_RATIO + 0.02, "{}", a.alpha());
    }

    #[test]
    fn ambience_memory_follows_a_cut_but_drifts_inside_a_scene() {
        let mut a = SceneAnalyzer::new();
        let insets = BlackBorderInsets::default();
        for _ in 0..60 {
            a.observe_frame(&uniform([200, 40, 40]), &insets, 0.35);
        }
        let before = a.ambience_srgb().unwrap();
        assert!(before[0] > 180 && before[2] < 60);
        a.observe_frame(&uniform([40, 40, 200]), &insets, 0.35);
        let one_frame = a.ambience_srgb().unwrap();
        // Moved, but not all the way — memory, not a reset.
        assert!(
            one_frame[2] > before[2] + 10 && one_frame[2] < 190,
            "{:?}",
            one_frame
        );
        for _ in 0..200 {
            a.observe_frame(&uniform([40, 40, 200]), &insets, 0.35);
        }
        let settled = a.ambience_srgb().unwrap();
        assert!(settled[2] > 190 && settled[0] < 60, "{:?}", settled);
    }

    #[test]
    fn deterministic_for_identical_input() {
        let run = || {
            let mut a = SceneAnalyzer::new();
            let mut state = LightSetState::default();
            let mut out = Vec::new();
            for i in 0..10usize {
                a.observe_frame(
                    &frame(64, 36, |x, y| {
                        [(x * 4) as u8, (y * 7) as u8, (i * 20) as u8]
                    }),
                    &BlackBorderInsets::default(),
                    0.35,
                );
                let mut colors: Vec<[u8; 3]> = (0..30)
                    .map(|k| [(k * 8) as u8, 100, (255 - k * 8) as u8])
                    .collect();
                a.process(
                    &mut colors,
                    &LightTopology::Chain { closed: true },
                    &[],
                    &mut state,
                );
                out.push(colors);
            }
            out
        };
        assert_eq!(run(), run());
    }

    #[test]
    fn empty_frame_and_empty_set_are_harmless() {
        let mut a = SceneAnalyzer::new();
        a.observe_frame(
            &CapturedFrame {
                width: 0,
                height: 0,
                pixels_rgb: Vec::new(),
            },
            &BlackBorderInsets::default(),
            0.35,
        );
        let mut empty: Vec<[u8; 3]> = Vec::new();
        let mut state = LightSetState::default();
        a.process(
            &mut empty,
            &LightTopology::Chain { closed: true },
            &[],
            &mut state,
        );
        let mut one = vec![[10, 20, 30]];
        a.process(&mut one, &LightTopology::Points(vec![]), &[], &mut state);
        assert_eq!(one.len(), 1);
    }

    #[test]
    fn hue_affinity_maps_tv_wall_to_one_and_behind_viewer_to_zero() {
        assert!((hue_default_screen_affinity(1.0) - 1.0).abs() < 1e-6);
        assert!(hue_default_screen_affinity(-1.0).abs() < 1e-6);
        assert!((hue_default_screen_affinity(0.0) - 0.5).abs() < 1e-6);
    }

    #[test]
    #[ignore = "timing print only — run with --ignored --nocapture"]
    fn cost_on_a_full_frame() {
        use std::time::Instant;
        let mut a = SceneAnalyzer::new();
        let f = frame(640, 360, |x, y| {
            [(x % 256) as u8, (y % 256) as u8, ((x + y) % 256) as u8]
        });
        let insets = BlackBorderInsets::default();
        let mut colors: Vec<[u8; 3]> = (0..200)
            .map(|k| {
                [
                    (k * 3 % 256) as u8,
                    (k * 7 % 256) as u8,
                    (k * 11 % 256) as u8,
                ]
            })
            .collect();
        let mut state = LightSetState::default();
        // Warm up.
        for _ in 0..10 {
            a.observe_frame(&f, &insets, 0.35);
            a.process(
                &mut colors,
                &LightTopology::Chain { closed: true },
                &[],
                &mut state,
            );
        }
        let t = Instant::now();
        for _ in 0..100 {
            a.observe_frame(&f, &insets, 0.35);
        }
        let observe_us = t.elapsed().as_secs_f64() * 1e6 / 100.0;
        let t = Instant::now();
        for _ in 0..100 {
            a.process(
                &mut colors,
                &LightTopology::Chain { closed: true },
                &[],
                &mut state,
            );
        }
        let process_us = t.elapsed().as_secs_f64() * 1e6 / 100.0;
        println!("observe_frame ≈ {observe_us:.1} µs, process(200 LEDs) ≈ {process_us:.1} µs");
    }
}
