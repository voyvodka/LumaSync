//! Time-based smoothing, shared by every sink. A step is derived from the time
//! elapsed since the last one, so a preset responds the same at any loop rate
//! and whatever outputs the worker drives —
//! docs/architecture/capture-and-pipeline.md, "Smoothing is time-based".

use std::time::Duration;

/// The cadence the smoothing presets and the scene stage's per-frame rates were
/// tuned at: the Hue-only worker loop, ~25 Hz.
pub(crate) const SMOOTHING_REFERENCE_INTERVAL: Duration = Duration::from_millis(40);

fn reference_steps(dt: Duration) -> f32 {
    dt.as_secs_f32() / SMOOTHING_REFERENCE_INTERVAL.as_secs_f32()
}

/// Time constant for a preset coefficient `a`: `T·(1 − a)/a`, the lag behind a
/// steady ramp of the per-frame EWMA `a` at the reference cadence `T`, so the
/// lights trail moving content by what they did before. `None` is no smoothing.
pub(crate) fn smoothing_tau(alpha_at_reference: f32) -> Option<Duration> {
    let a = alpha_at_reference.clamp(0.0, 1.0);
    if a >= 1.0 {
        return None;
    }
    let a = a.max(1e-3);
    Some(SMOOTHING_REFERENCE_INTERVAL.mul_f32((1.0 - a) / a))
}

/// How far an exponential approach with this preset closes the gap in `dt`:
/// `1 − exp(−dt/τ)`. Two steps of `dt` land where one of `2·dt` does.
pub(crate) fn alpha_for_interval(alpha_at_reference: f32, dt: Duration) -> f32 {
    match smoothing_tau(alpha_at_reference) {
        None => 1.0,
        Some(tau) => 1.0 - (-dt.as_secs_f32() / tau.as_secs_f32()).exp(),
    }
}

/// A per-frame EWMA rate tuned at the reference cadence, for a gap of `dt`:
/// `1 − (1 − r)^(dt/T)`. Exactly `r` at the reference gap.
pub(crate) fn rate_for_interval(rate_at_reference: f32, dt: Duration) -> f32 {
    let r = rate_at_reference.clamp(0.0, 1.0);
    if dt == SMOOTHING_REFERENCE_INTERVAL {
        return r;
    }
    1.0 - (1.0 - r).powf(reference_steps(dt))
}

/// A per-frame decay (`x *= 0.85`) tuned at the reference cadence, for `dt`.
pub(crate) fn retention_for_interval(retention_at_reference: f32, dt: Duration) -> f32 {
    retention_at_reference
        .clamp(0.0, 1.0)
        .powf(reference_steps(dt))
}

/// One exponential smoother per light, in the space its targets arrive in
/// (gamma-encoded sRGB, 0–255). State is kept in `f32`: the `u8` state it
/// replaced stalled a few levels short of the target at low alpha.
///
/// The caller advances to the moment a new target arrives before setting it,
/// so the output at any instant depends on when targets arrived and nothing
/// else — not on how often `advance` was called in between.
#[derive(Debug, Default)]
pub(crate) struct TimeSmoother {
    state: Vec<[f32; 3]>,
    target: Vec<[f32; 3]>,
}

fn to_f32(rgb: &[u8; 3]) -> [f32; 3] {
    rgb.map(f32::from)
}

impl TimeSmoother {
    /// Start from `colors` with nothing left to move.
    pub(crate) fn seed(&mut self, colors: &[[u8; 3]]) {
        self.state.clear();
        self.state.extend(colors.iter().map(to_f32));
        self.target.clear();
        self.target.extend_from_slice(&self.state);
    }

    /// A new frame's colours. A different light count (another strip, an area
    /// switch) restarts from them rather than blending unrelated lights.
    pub(crate) fn set_target(&mut self, colors: &[[u8; 3]]) {
        if colors.len() != self.state.len() {
            self.seed(colors);
            return;
        }
        self.target.clear();
        self.target.extend(colors.iter().map(to_f32));
    }

    /// Move towards the target by what `dt` is worth at this coefficient.
    pub(crate) fn advance(&mut self, dt: Duration, alpha_at_reference: f32) {
        let k = alpha_for_interval(alpha_at_reference, dt);
        if k <= 0.0 {
            return;
        }
        for (state, target) in self.state.iter_mut().zip(&self.target) {
            for c in 0..3 {
                state[c] += k * (target[c] - state[c]);
            }
        }
    }

    pub(crate) fn state(&self) -> &[[f32; 3]] {
        &self.state
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const WHITE: [[u8; 3]; 1] = [[255, 255, 255]];
    const BLACK: [[u8; 3]; 1] = [[0, 0, 0]];

    /// A black-to-white step held for `span`, advanced in `steps` equal steps.
    fn step_response(steps: u32, span: Duration, alpha: f32) -> f32 {
        let mut smoother = TimeSmoother::default();
        smoother.seed(&BLACK);
        smoother.set_target(&WHITE);
        for _ in 0..steps {
            smoother.advance(span / steps, alpha);
        }
        smoother.state()[0][0]
    }

    /// Review item 17: smoothing ran once per loop iteration, so the same
    /// preset moved faster with a USB strip on (a faster loop) than on Hue
    /// alone. Time-based, the response at a given moment is the same at 20,
    /// 25 and 60 Hz.
    #[test]
    fn the_response_is_the_same_at_20_25_and_60_hz() {
        let span = Duration::from_millis(200);
        for alpha in [0.105, 0.15, 0.35, 0.6] {
            let at_20 = step_response(4, span, alpha);
            let at_25 = step_response(5, span, alpha);
            let at_60 = step_response(12, span, alpha);
            for (hz, value) in [(25, at_25), (60, at_60)] {
                assert!(
                    (value - at_20).abs() < 0.01,
                    "alpha {alpha}: {value} at {hz} Hz vs {at_20} at 20 Hz"
                );
            }
            assert!(
                at_20 > 1.0 && at_20 < 255.0,
                "alpha {alpha} never moved or snapped"
            );
        }
    }

    /// The per-frame EWMA `a` at the 40 ms reference cadence trails a steady
    /// ramp by `40·(1 − a)/a` ms; the time-based filter trails it by the same,
    /// so a preset keeps the lag it had on the Hue-only loop.
    #[test]
    fn a_preset_keeps_the_ramp_lag_of_the_per_frame_filter() {
        for (alpha, lag_ms) in [(0.15, 226.7), (0.35, 74.3), (0.6, 26.7)] {
            let mut smoother = TimeSmoother::default();
            smoother.seed(&BLACK);
            // 0.05 levels per ms, advanced a millisecond at a time.
            let step = Duration::from_millis(1);
            let mut level = 0.0f32;
            for _ in 0..3000 {
                smoother.advance(step, alpha);
                level += 0.05;
                smoother.target[0] = [level; 3];
            }
            let behind_ms = (level - smoother.state()[0][0]) / 0.05;
            assert!(
                (behind_ms - lag_ms).abs() < 1.5,
                "alpha {alpha}: trails by {behind_ms} ms, expected {lag_ms}"
            );
        }
    }

    #[test]
    fn alpha_one_is_no_smoothing_and_zero_time_is_no_movement() {
        assert_eq!(alpha_for_interval(1.0, Duration::ZERO), 1.0);
        assert_eq!(alpha_for_interval(0.35, Duration::ZERO), 0.0);
        assert_eq!(rate_for_interval(0.2, SMOOTHING_REFERENCE_INTERVAL), 0.2);
        assert_eq!(
            retention_for_interval(0.85, SMOOTHING_REFERENCE_INTERVAL),
            0.85
        );
    }

    /// The `u8` state this replaced rounded every step, and at the scene
    /// stage's floor (30 % of Moderate) it parked a few levels short of the
    /// target for good.
    #[test]
    fn a_low_alpha_reaches_the_target() {
        let mut smoother = TimeSmoother::default();
        smoother.seed(&[[250, 250, 250]]);
        smoother.set_target(&WHITE);
        for _ in 0..200 {
            smoother.advance(SMOOTHING_REFERENCE_INTERVAL, 0.105);
        }
        assert_eq!(smoother.state()[0][0].round(), 255.0);
    }

    #[test]
    fn a_new_light_count_restarts_from_the_target() {
        let mut smoother = TimeSmoother::default();
        smoother.seed(&BLACK);
        smoother.set_target(&[[10, 20, 30], [40, 50, 60]]);
        assert_eq!(smoother.state(), &[[10.0, 20.0, 30.0], [40.0, 50.0, 60.0]]);
    }
}
