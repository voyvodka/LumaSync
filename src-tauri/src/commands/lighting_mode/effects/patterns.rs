//! What each effect shows at one light and one moment. A pattern gives a
//! palette position and a level; the level is perceptual (0 dark, 1 full) and
//! is applied in linear light, so a breath or a flicker dims the way the eye
//! expects rather than the way the bytes do.

use std::f32::consts::{PI, TAU};
use std::sync::LazyLock;

use super::catalogue::CATALOGUE;
use super::emitters::{Bounds, Emitter};
use super::noise::{fbm1, fbm2, hash01};
use super::palette::{linear_from_bytes, Linear, Palette};
use crate::commands::led_output::kelvin_to_rgb_multipliers;
use crate::commands::lighting_mode::config::{EffectDirection, EffectId, EffectPayload};

/// The moment an effect is drawn at.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub(crate) struct EffectClock {
    /// Loops run at the effect's speed, accumulated so a speed change never
    /// jumps; the fraction is the loop's phase.
    pub loops: f64,
    /// Now, in Unix milliseconds: a sunrise counts from its saved start.
    pub unix_ms: u64,
    /// Local time of day in hours, 0..24 (natural light).
    pub day_hours: f32,
}

/// The dimmest a breath or a twinkle's rest goes: dark reads as "off".
const REST_LEVEL: f32 = 0.1;

/// Sunrise's own ramp: a dark red that warms through orange to a soft white.
const SUNRISE_STOPS: [[u8; 3]; 6] = [
    [40, 2, 0],
    [120, 20, 0],
    [255, 80, 0],
    [255, 150, 60],
    [255, 214, 170],
    [255, 240, 224],
];

static SUNRISE: LazyLock<Palette> = LazyLock::new(|| Palette::from_bytes(&SUNRISE_STOPS, false));

/// Natural light through the day: (hour, kelvin, level).
const DAYLIGHT: [(f32, f32, f32); 8] = [
    (0.0, 2000.0, 0.2),
    (6.0, 2200.0, 0.25),
    (8.0, 3500.0, 0.75),
    (12.0, 5500.0, 1.0),
    (17.0, 4500.0, 0.9),
    (20.0, 3000.0, 0.6),
    (22.5, 2200.0, 0.35),
    (24.0, 2000.0, 0.2),
];

fn unit(value: Option<f32>, default: f32) -> f32 {
    value
        .filter(|v| v.is_finite())
        .unwrap_or(default)
        .clamp(0.0, 1.0)
}

fn smoothstep(edge0: f32, edge1: f32, x: f32) -> f32 {
    let t = ((x - edge0) / (edge1 - edge0)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

fn scaled(rgb: Linear, level: f32) -> Linear {
    let gain = level.clamp(0.0, 1.0).powf(2.2);
    rgb.map(|c| c * gain)
}

/// Where a light sits along the effect's direction, 0..1 across all lights.
fn along(direction: EffectDirection, e: &Emitter, bounds: &Bounds) -> f32 {
    match direction {
        EffectDirection::LeftToRight => bounds.across(0, e.pos[0]),
        EffectDirection::RightToLeft => 1.0 - bounds.across(0, e.pos[0]),
        EffectDirection::BottomToTop => bounds.across(2, e.pos[2]),
        EffectDirection::TopToBottom => 1.0 - bounds.across(2, e.pos[2]),
        EffectDirection::Outward => bounds.outward(e.pos),
        EffectDirection::Around => e.u,
    }
}

/// The inputs every light of one frame shares.
pub(crate) struct Frame<'a> {
    pub effect: &'a EffectPayload,
    pub palette: &'a Palette,
    pub clock: EffectClock,
    pub bounds: &'a Bounds,
}

impl Frame<'_> {
    fn size(&self) -> f32 {
        unit(self.effect.size, CATALOGUE.defaults.size)
    }

    fn intensity(&self) -> f32 {
        unit(self.effect.intensity, CATALOGUE.defaults.intensity)
    }

    fn phase(&self) -> f32 {
        self.clock.loops.rem_euclid(1.0) as f32
    }

    /// The colour of every light in `set` (one output's lights), linear.
    pub(crate) fn render(&self, set: &[Emitter]) -> Vec<Linear> {
        set.iter().map(|e| self.at(e, set.len())).collect()
    }

    fn at(&self, e: &Emitter, set_len: usize) -> Linear {
        let phase = self.phase();
        let loops = self.clock.loops;
        let direction = self.effect.direction.unwrap_or_default();
        let (x, z) = (
            self.bounds.across(0, e.pos[0]),
            self.bounds.across(2, e.pos[2]),
        );
        match self.effect.id {
            EffectId::Cycle => self.palette.cyclic(phase),
            EffectId::Wave => {
                let cycles = 0.6 + (1.0 - self.size()) * 2.4;
                self.palette
                    .cyclic(along(direction, e, self.bounds) * cycles - phase)
            }
            EffectId::Gradient => {
                let spread = 0.2 + 0.8 * self.size();
                self.palette
                    .at(0.5 + (along(direction, e, self.bounds) - 0.5) * spread)
            }
            EffectId::Breathe => {
                let breath = 0.5 - 0.5 * (TAU * phase).cos();
                // A new colour each breath, changed at the dark bottom.
                let colour = self
                    .palette
                    .at((loops.floor() * 0.618_034).rem_euclid(1.0) as f32);
                scaled(colour, REST_LEVEL + (1.0 - REST_LEVEL) * breath)
            }
            EffectId::Candle => {
                let flicker = fbm1(e.seed, loops);
                let depth = 0.15 + 0.6 * self.intensity();
                let colour = self.palette.at(0.35 + 0.3 * flicker);
                scaled(colour, 1.0 - depth * (1.0 - flicker))
            }
            EffectId::Fireplace => {
                let reach = 0.35 + 0.65 * self.size();
                let base = (1.0 - z / reach).clamp(0.0, 1.0);
                let flame = fbm2(e.seed, f64::from(e.pos[0]) * 3.0, loops);
                let lick = self.intensity();
                let heat = base * (1.0 - 0.5 * lick) + flame * (0.25 + 0.55 * lick);
                self.palette.at(heat.clamp(0.0, 1.0))
            }
            EffectId::Drift => {
                let n = fbm2(
                    0x5eed,
                    f64::from(e.pos[0]) * 1.3 + f64::from(e.pos[1]) * 0.7,
                    f64::from(e.pos[2]) * 1.3 + loops * 0.5,
                );
                self.palette.at(smoothstep(0.15, 0.85, n))
            }
            EffectId::Ocean => {
                let cycles = 0.8 + (1.0 - self.size()) * 2.2;
                let swell = (TAU * (x * cycles - phase)).sin();
                let chop = (TAU * (z * 0.9 + x * 0.6 * cycles + phase * 0.7)).sin();
                let foam = fbm2(0x0cea, f64::from(x) * 4.0, loops * 0.8);
                let v = 0.5 + 0.28 * swell + 0.14 * chop + 0.2 * (foam - 0.5);
                scaled(self.palette.at(v), 0.72 + 0.28 * (0.5 + 0.5 * swell))
            }
            EffectId::Aurora => {
                let hue = fbm2(0xa0a0, f64::from(x) * 1.8 + loops * 0.3, loops * 0.15);
                let curtain = fbm2(
                    0xa1a1,
                    f64::from(x) * 3.2 - loops * 0.25,
                    f64::from(z) + loops * 0.1,
                );
                let open = 0.55 - 0.35 * self.intensity();
                let level = 0.08 + 0.92 * smoothstep(open - 0.15, open + 0.3, curtain);
                scaled(self.palette.at(hue), level)
            }
            EffectId::Twinkle => {
                let rate = 0.6 + 0.8 * hash01(e.seed, 1);
                let t = loops * f64::from(rate) + f64::from(hash01(e.seed, 2));
                let round = t.floor() as i64;
                let f = (t - t.floor()) as f32;
                let density = 0.15 + 0.7 * self.intensity();
                let lit = hash01(e.seed ^ 0x7777, round) < density;
                let pulse = if lit { (PI * f).sin().powi(2) } else { 0.0 };
                let colour = self.palette.at(hash01(e.seed ^ 0x3333, round));
                scaled(colour, 0.06 + 0.94 * pulse)
            }
            EffectId::Comet => {
                // On a few lights the tail reaches back past the previous one, so the
                // room is never dark between hops.
                let tail = (0.04 + 0.36 * self.size()).max(2.0 / set_len.max(1) as f32);
                let behind = (phase - e.u).rem_euclid(1.0);
                let level = if behind < tail {
                    (1.0 - behind / tail).powi(2)
                } else {
                    0.0
                };
                scaled(self.palette.cyclic(loops as f32 * 0.21 + behind), level)
            }
            EffectId::Scanner => {
                let head = 1.0 - (2.0 * phase - 1.0).abs();
                let width = (0.02 + 0.2 * self.size()).max(0.6 / set_len.max(1) as f32);
                let level = (1.0 - (x - head).abs() / width).max(0.0).powf(1.5);
                scaled(self.palette.at(0.5), level)
            }
            EffectId::Chase => {
                let count = (2.0 + ((1.0 - self.size()) * 10.0).round()).min(set_len.max(1) as f32);
                let slot = e.u * count - phase * 2.0;
                let s = slot.rem_euclid(1.0);
                let on = smoothstep(0.0, 0.08, s) * (1.0 - smoothstep(0.42, 0.5, s));
                let colour = self.palette.cyclic(slot.floor() / count);
                scaled(colour, 0.03 + 0.97 * on)
            }
            EffectId::Plasma => {
                let k = 1.5 + (1.0 - self.size()) * 4.0;
                let a = (x * k * PI + TAU * phase).sin();
                let b = ((z * 1.3 + x * 0.6) * k * PI - TAU * phase * 1.3).sin();
                self.palette.cyclic(0.5 + 0.25 * (a + b))
            }
            EffectId::Sunrise => {
                let minutes = f64::from(
                    self.effect
                        .duration_minutes
                        .unwrap_or(CATALOGUE.defaults.duration_minutes)
                        .max(1),
                );
                let elapsed_ms = self
                    .effect
                    .started_at_ms
                    .map_or(0, |start| self.clock.unix_ms.saturating_sub(start));
                let progress = (elapsed_ms as f64 / (minutes * 60_000.0)).clamp(0.0, 1.0) as f32;
                scaled(SUNRISE.at(progress), 0.04 + 0.96 * progress.powf(1.2))
            }
            EffectId::NaturalLight => {
                let (kelvin, level) = daylight(self.clock.day_hours);
                let [r, g, b] = kelvin_to_rgb_multipliers(kelvin.round() as u16);
                let byte = |m: f32| (m * 255.0).round().clamp(0.0, 255.0) as u8;
                scaled(linear_from_bytes([byte(r), byte(g), byte(b)]), level)
            }
        }
    }
}

fn daylight(hours: f32) -> (f32, f32) {
    let h = if hours.is_finite() {
        hours.rem_euclid(24.0)
    } else {
        12.0
    };
    for pair in DAYLIGHT.windows(2) {
        let ((h0, k0, l0), (h1, k1, l1)) = (pair[0], pair[1]);
        if h >= h0 && h <= h1 {
            let t = smoothstep(0.0, 1.0, (h - h0) / (h1 - h0));
            return (k0 + (k1 - k0) * t, l0 + (l1 - l0) * t);
        }
    }
    (2000.0, 0.2)
}
