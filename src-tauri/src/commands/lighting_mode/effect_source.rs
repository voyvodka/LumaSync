//! The Effect mode's frames: drawn in screen space and handed to the Ambilight
//! worker as if captured, so the strip's layout and Hue's room placement sample
//! them exactly as they sample the screen. docs/architecture/lighting-transaction.md
//! ("Effects").

use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use super::config::{AmbilightPayload, EffectColor, EffectId, EffectPayload};
use crate::commands::ambilight_capture::{
    AmbilightCaptureError, AmbilightFrameSource, CapturedFrame,
};
use crate::commands::test_pattern::{hsv_to_rgb, render_rainbow, DEFAULT_DISPLAY_ASPECT};

/// The payload the source re-reads every frame, so speed, colour and effect
/// change without a worker rebuild.
pub(crate) type EffectLiveSlot = Arc<Mutex<EffectPayload>>;

/// Long axis of the drawn frame. Effects change slowly across the frame, and
/// the sampler's windows are fractions of it, so a small frame samples the same
/// colours as a screen-sized one at a sliver of the cost.
const EFFECT_LONG_AXIS: u32 = 192;

/// The breath never goes fully dark: at zero the room reads as "off", not as
/// the bottom of a breath.
const BREATHE_FLOOR: f32 = 0.08;

/// The breath's colour before one is chosen: the app's amber.
const DEFAULT_BREATHE_COLOR: EffectColor = EffectColor {
    r: 255,
    g: 176,
    b: 32,
};

/// Seconds per loop at speed 0 and at speed 1; between them the period moves
/// on a log scale, so each step of the slider feels like the same change.
fn period_range(id: EffectId) -> (f32, f32) {
    match id {
        EffectId::Breathe => (12.0, 1.5),
        EffectId::Cycle => (90.0, 4.0),
        _ => (40.0, 3.0),
    }
}

pub(crate) fn loops_per_sec(id: EffectId, speed: f32) -> f32 {
    let (slow, fast) = period_range(id);
    let speed = if speed.is_finite() {
        speed.clamp(0.0, 1.0)
    } else {
        0.5
    };
    let period = slow * (fast / slow).powf(speed);
    1.0 / period
}

/// The settings an effect runs the Ambilight worker with: its brightness, and
/// no smoothing, border detection or saturation — the effect draws exactly the
/// frames it means.
pub(crate) fn effect_ambilight(effect: &EffectPayload) -> AmbilightPayload {
    AmbilightPayload {
        brightness: effect.brightness,
        black_border_detection: false,
        smoothing_alpha: Some(1.0),
        saturation: Some(1.0),
        lighting_smoothing_preset: None,
        hue_intensity_preset: None,
    }
}

pub(crate) fn create_effect_frame_source(
    live: EffectLiveSlot,
    phase_slot: Arc<AtomicU32>,
) -> Box<dyn AmbilightFrameSource> {
    Box::new(EffectFrameSource::new(live, phase_slot))
}

/// Phase is accumulated (`phase += dt × rate`), never derived from the clock,
/// so a speed change alters how fast it moves without jumping; `phase_slot`
/// carries it across a worker rebuild the same way.
struct EffectFrameSource {
    live: EffectLiveSlot,
    phase_slot: Arc<AtomicU32>,
    phase: f32,
    last_tick: Instant,
    width: u32,
    height: u32,
}

impl EffectFrameSource {
    fn new(live: EffectLiveSlot, phase_slot: Arc<AtomicU32>) -> Self {
        let phase = f32::from_bits(phase_slot.load(Ordering::Relaxed));
        let height = (EFFECT_LONG_AXIS as f32 / DEFAULT_DISPLAY_ASPECT).round() as u32;
        Self {
            live,
            phase_slot,
            phase: if phase.is_finite() {
                phase.rem_euclid(1.0)
            } else {
                0.0
            },
            last_tick: Instant::now(),
            width: EFFECT_LONG_AXIS,
            height,
        }
    }

    fn current(&self) -> EffectPayload {
        self.live
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }
}

/// One frame of `effect` at `phase` (0..1 of a loop).
pub(crate) fn render_effect(
    effect: &EffectPayload,
    phase: f32,
    w: usize,
    h: usize,
) -> Vec<[u8; 3]> {
    let mut pixels = Vec::with_capacity(w * h);
    match effect.id {
        EffectId::Breathe => {
            let color = effect
                .colors
                .as_ref()
                .and_then(|colors| colors.first().copied())
                .unwrap_or(DEFAULT_BREATHE_COLOR);
            // Eased in and out: a cosine, lifted so the bottom is the floor.
            let wave = 0.5 - 0.5 * (std::f32::consts::TAU * phase).cos();
            let level = BREATHE_FLOOR + (1.0 - BREATHE_FLOOR) * wave;
            let scale = |c: u8| (f32::from(c) * level).round() as u8;
            pixels.resize(w * h, [scale(color.r), scale(color.g), scale(color.b)]);
        }
        EffectId::Cycle => pixels.resize(w * h, hsv_to_rgb(phase, 1.0, 1.0)),
        _ => render_rainbow(&mut pixels, w, h, phase),
    }
    pixels
}

impl AmbilightFrameSource for EffectFrameSource {
    fn capture_frame(&mut self) -> Result<Arc<CapturedFrame>, AmbilightCaptureError> {
        let effect = self.current();
        let now = Instant::now();
        // Clamped so a stalled worker does not jump a whole loop on the next tick.
        let dt = now.duration_since(self.last_tick).as_secs_f32().min(0.5);
        self.last_tick = now;
        self.phase = (self.phase + dt * loops_per_sec(effect.id, effect.speed)).rem_euclid(1.0);
        self.phase_slot
            .store(self.phase.to_bits(), Ordering::Relaxed);
        let pixels = render_effect(
            &effect,
            self.phase,
            self.width as usize,
            self.height as usize,
        );
        Ok(Arc::new(CapturedFrame::new(
            self.width,
            self.height,
            pixels,
        )))
    }
}
