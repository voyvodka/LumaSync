//! Palettes are blended in OKLCh — OKLab's polar form: lightness and chroma
//! move evenly and the hue takes the short way round, so a blend between two
//! vivid stops stays vivid. A straight OKLab line between distant hues cuts
//! through the grey middle — docs/architecture/capture-and-pipeline.md
//! ("Effects").

/// Linear-light RGB, 0..1.
pub(crate) type Linear = [f32; 3];

pub(crate) fn srgb_to_linear(c: f32) -> f32 {
    if c <= 0.040_45 {
        c / 12.92
    } else {
        ((c + 0.055) / 1.055).powf(2.4)
    }
}

pub(crate) fn linear_to_srgb(c: f32) -> f32 {
    let c = c.clamp(0.0, 1.0);
    if c <= 0.003_130_8 {
        c * 12.92
    } else {
        1.055 * c.powf(1.0 / 2.4) - 0.055
    }
}

pub(crate) fn linear_from_bytes(rgb: [u8; 3]) -> Linear {
    rgb.map(|c| srgb_to_linear(f32::from(c) / 255.0))
}

pub(crate) fn bytes_from_linear(rgb: Linear) -> [u8; 3] {
    rgb.map(|c| (linear_to_srgb(c) * 255.0).round() as u8)
}

fn linear_to_oklab([r, g, b]: Linear) -> [f32; 3] {
    let l = 0.412_221_46 * r + 0.536_332_55 * g + 0.051_445_995 * b;
    let m = 0.211_903_5 * r + 0.680_699_5 * g + 0.107_396_96 * b;
    let s = 0.088_302_46 * r + 0.281_718_85 * g + 0.629_978_7 * b;
    let (l, m, s) = (l.cbrt(), m.cbrt(), s.cbrt());
    [
        0.210_454_26 * l + 0.793_617_8 * m - 0.004_072_047 * s,
        1.977_998_5 * l - 2.428_592_2 * m + 0.450_593_7 * s,
        0.025_904_037 * l + 0.782_771_77 * m - 0.808_675_77 * s,
    ]
}

fn oklab_to_linear([l, a, b]: [f32; 3]) -> Linear {
    let l_ = l + 0.396_337_78 * a + 0.215_803_76 * b;
    let m_ = l - 0.105_561_346 * a - 0.063_854_17 * b;
    let s_ = l - 0.089_484_18 * a - 1.291_485_5 * b;
    let (l, m, s) = (l_ * l_ * l_, m_ * m_ * m_, s_ * s_ * s_);
    [
        4.076_741_7 * l - 3.307_711_6 * m + 0.230_969_94 * s,
        -1.268_438 * l + 2.609_757_4 * m - 0.341_319_38 * s,
        -0.004_196_086_3 * l - 0.703_418_6 * m + 1.707_614_7 * s,
    ]
    .map(|c| c.clamp(0.0, 1.0))
}

/// Below this chroma a stop has no hue worth keeping (white, grey, black):
/// the blend takes the other stop's hue instead of swinging through a third.
const ACHROMATIC: f32 = 0.02;

fn blend_lch(a: [f32; 3], b: [f32; 3], t: f32) -> [f32; 3] {
    let (ca, cb) = (a[1].hypot(a[2]), b[1].hypot(b[2]));
    let (ha, hb) = (a[2].atan2(a[1]), b[2].atan2(b[1]));
    let (ha, hb) = match (ca < ACHROMATIC, cb < ACHROMATIC) {
        (true, false) => (hb, hb),
        (false, true) => (ha, ha),
        _ => (ha, hb),
    };
    let mut dh = hb - ha;
    if dh > std::f32::consts::PI {
        dh -= std::f32::consts::TAU;
    } else if dh < -std::f32::consts::PI {
        dh += std::f32::consts::TAU;
    }
    let l = a[0] + (b[0] - a[0]) * t;
    let c = ca + (cb - ca) * t;
    let h = ha + dh * t;
    [l, c * h.cos(), c * h.sin()]
}

#[derive(Clone, Debug)]
pub(crate) struct Palette {
    /// OKLab stops; never empty.
    stops: Vec<[f32; 3]>,
    wrap: bool,
}

impl Palette {
    pub(crate) fn from_bytes(colors: &[[u8; 3]], wrap: bool) -> Self {
        let mut stops: Vec<[f32; 3]> = colors
            .iter()
            .map(|&c| linear_to_oklab(linear_from_bytes(c)))
            .collect();
        if stops.is_empty() {
            stops.push(linear_to_oklab([1.0, 1.0, 1.0]));
        }
        Self { stops, wrap }
    }

    /// `v` across the palette once: 0 is the first stop, 1 the last (or, for a
    /// wrapping palette, the first again).
    pub(crate) fn at(&self, v: f32) -> Linear {
        let n = self.stops.len();
        if n == 1 {
            return oklab_to_linear(self.stops[0]);
        }
        let v = if v.is_finite() { v } else { 0.0 };
        let (i, j, t) = if self.wrap {
            let pos = v.rem_euclid(1.0) * n as f32;
            let i = (pos.floor() as usize).min(n - 1);
            (i, (i + 1) % n, pos - i as f32)
        } else {
            let pos = v.clamp(0.0, 1.0) * (n - 1) as f32;
            let i = (pos.floor() as usize).min(n - 2);
            (i, i + 1, pos - i as f32)
        };
        oklab_to_linear(blend_lch(self.stops[i], self.stops[j], t))
    }

    /// A position that keeps moving (a wave, a cycle): a wrapping palette loops,
    /// any other plays there and back, so the lights never jump from the last
    /// stop to the first.
    pub(crate) fn cyclic(&self, v: f32) -> Linear {
        if self.wrap {
            self.at(v)
        } else {
            let f = v.rem_euclid(1.0);
            self.at(1.0 - (2.0 * f - 1.0).abs())
        }
    }
}
