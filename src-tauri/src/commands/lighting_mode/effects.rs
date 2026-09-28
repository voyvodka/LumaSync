//! The Effect mode's engine: a pattern evaluated at every light the worker
//! drives, coloured through a palette. It replaces the screen the v1 effects
//! drew and sampled, which averaged a rainbow to grey on a few Hue lamps —
//! docs/architecture/capture-and-pipeline.md ("Effects").

mod catalogue;
mod emitters;
mod noise;
mod palette;
mod patterns;

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::commands::hue::frame::HueAreaChannel;
use crate::commands::led_calibration::{LedSegmentCounts, LedSequenceItem};
use crate::models::room_map::RoomGeometry;

use super::config::{EffectId, EffectPayload};
use super::effect_source::EffectLiveSlot;
use catalogue::palette_for;
use emitters::{hue_emitters, screen_in_room, strip_emitters, Bounds, Emitter};
use palette::{bytes_from_linear, Palette};
use patterns::{EffectClock, Frame};

#[cfg(test)]
pub(crate) use catalogue::{palette_for as palette_for_test, CATALOGUE, CATALOGUE_JSON};
#[cfg(test)]
pub(crate) use palette::{bytes_from_linear as bytes_from_linear_test, Palette as PaletteTest};

/// Where an effect has got to, kept on the runtime owner so a worker rebuild —
/// a layout or output change — carries on instead of starting over.
#[derive(Debug, Default)]
pub(crate) struct EffectClockState {
    loops: f64,
    seconds: f64,
    id: Option<EffectId>,
}

pub(crate) type EffectClockSlot = Arc<Mutex<EffectClockState>>;

/// What the worker's pipeline needs to draw an effect: the payload a retune
/// replaces in place, and the clock.
#[derive(Clone)]
pub(crate) struct EffectDraw {
    pub live: EffectLiveSlot,
    pub clock: EffectClockSlot,
}

/// Seconds per loop at speed 0 and at speed 1; between them the period moves
/// on a log scale, so each step of the slider feels like the same change.
fn period_range(id: EffectId) -> (f32, f32) {
    match id {
        EffectId::Wave => (40.0, 3.0),
        EffectId::Cycle => (90.0, 4.0),
        EffectId::Breathe => (12.0, 1.5),
        EffectId::Candle => (1.6, 0.2),
        EffectId::Fireplace => (2.5, 0.3),
        EffectId::Drift => (60.0, 6.0),
        EffectId::Gradient => (120.0, 20.0),
        EffectId::Ocean => (30.0, 4.0),
        EffectId::Aurora => (40.0, 5.0),
        EffectId::Twinkle => (8.0, 1.0),
        EffectId::Comet => (20.0, 1.5),
        EffectId::Scanner => (12.0, 1.0),
        EffectId::Chase => (20.0, 1.5),
        EffectId::Plasma => (60.0, 5.0),
        EffectId::Sunrise | EffectId::NaturalLight => (60.0, 60.0),
    }
}

pub(crate) fn loops_per_sec(id: EffectId, speed: f32) -> f32 {
    let (slow, fast) = period_range(id);
    let speed = if speed.is_finite() {
        speed.clamp(0.0, 1.0)
    } else {
        0.5
    };
    1.0 / (slow * (fast / slow).powf(speed))
}

/// A stall (a sleeping laptop, a debugger) does not skip the effect ahead.
const MAX_STEP: Duration = Duration::from_millis(500);
/// Local time is read this often, not per frame.
const DAY_CLOCK_EVERY: Duration = Duration::from_secs(5);

fn day_hours_now() -> f32 {
    use chrono::Timelike;
    let now = chrono::Local::now();
    now.hour() as f32 + now.minute() as f32 / 60.0 + now.second() as f32 / 3600.0
}

/// The lights of one worker, resolved once and again when the room or the Hue
/// channels change.
struct Lights {
    strip: Vec<Emitter>,
    hue: Vec<Emitter>,
    bounds: Bounds,
}

/// The pipeline's effect stage: advances the clock and colours every light.
pub(crate) struct EffectStage {
    draw: EffectDraw,
    lights: Option<Lights>,
    last_step: Option<Instant>,
    day_hours: f32,
    day_read: Option<Instant>,
    palette: Option<(EffectPayload, Palette)>,
}

/// What one step drew, sRGB bytes in each output's own order.
pub(crate) struct Drawn {
    pub strip: Vec<[u8; 3]>,
    pub hue: Vec<[u8; 3]>,
}

impl EffectStage {
    pub(crate) fn new(draw: EffectDraw) -> Self {
        Self {
            draw,
            lights: None,
            last_step: None,
            day_hours: 12.0,
            day_read: None,
            palette: None,
        }
    }

    /// The room or the Hue channels changed: resolve the lights again.
    pub(crate) fn invalidate(&mut self) {
        self.lights = None;
    }

    fn payload(&self) -> EffectPayload {
        self.draw
            .live
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    fn advance_clock(&mut self, effect: &EffectPayload, now: Instant) -> EffectClock {
        let dt = self
            .last_step
            .map_or(Duration::ZERO, |at| now.saturating_duration_since(at))
            .min(MAX_STEP)
            .as_secs_f64();
        self.last_step = Some(now);
        if self
            .day_read
            .is_none_or(|at| now.saturating_duration_since(at) >= DAY_CLOCK_EVERY)
        {
            self.day_hours = day_hours_now();
            self.day_read = Some(now);
        }
        let mut state = self
            .draw
            .clock
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if state.id != Some(effect.id) {
            state.id = Some(effect.id);
            state.seconds = 0.0;
        }
        state.loops += dt * f64::from(loops_per_sec(effect.id, effect.speed));
        state.seconds += dt;
        EffectClock {
            loops: state.loops,
            seconds: state.seconds,
            day_hours: self.day_hours,
        }
    }

    fn palette(&mut self, effect: &EffectPayload) -> &Palette {
        let stale = self.palette.as_ref().is_none_or(|(seen, _)| {
            seen.id != effect.id || seen.palette != effect.palette || seen.colors != effect.colors
        });
        if stale {
            self.palette = Some((effect.clone(), palette_for(effect)));
        }
        &self.palette.as_ref().expect("set above").1
    }

    /// One step at `now`: the strip's LEDs in strip order, and Hue's channels
    /// in `hue_channels` order.
    pub(crate) fn draw(
        &mut self,
        now: Instant,
        sequence: &[LedSequenceItem],
        counts: &LedSegmentCounts,
        hue_channels: Option<&[HueAreaChannel]>,
        geometry: Option<&RoomGeometry>,
    ) -> Drawn {
        let effect = self.payload();
        let clock = self.advance_clock(&effect, now);
        if self.lights.is_none() {
            let screen = screen_in_room(geometry);
            let strip = strip_emitters(sequence, counts, &screen);
            let hue = hue_channels
                .map(|channels| hue_emitters(channels, geometry, &screen))
                .unwrap_or_default();
            let bounds = Bounds::over(strip.iter().chain(hue.iter()), screen);
            self.lights = Some(Lights { strip, hue, bounds });
        }
        let palette = self.palette(&effect).clone();
        let lights = self.lights.as_ref().expect("set above");
        let frame = Frame {
            effect: &effect,
            palette: &palette,
            clock,
            bounds: &lights.bounds,
        };
        let encode = |set: &[Emitter]| {
            frame
                .render(set)
                .into_iter()
                .map(bytes_from_linear)
                .collect()
        };
        Drawn {
            strip: encode(&lights.strip),
            hue: encode(&lights.hue),
        }
    }
}
