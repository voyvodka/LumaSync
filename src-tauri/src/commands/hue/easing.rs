//! What each DTLS packet carries: a step from the last colour sent towards the
//! newest target, not the target itself. Reasoning in docs/architecture/hue.md,
//! "The sender eases between targets".

use std::time::{Duration, Instant};

use super::frame::{HueMotion, HueRgb};

/// Closer than this on every channel of the 16-bit wire counts as arrived.
const SETTLED: f32 = 0.5 / 65_535.0;

/// Per-channel easing state of one DTLS session, in wire space: the colour
/// after the pipeline's gamma stage and before brightness, which is linear
/// light, so a blend here is the physical mix of the two colours.
#[derive(Debug)]
pub(crate) struct HueEasing {
    current: Vec<HueRgb>,
    target: Vec<HueRgb>,
    brightness: f32,
    brightness_target: f32,
    /// One sender tick: an eased step closes `1 - 1/e` of the gap per tick.
    tau: Duration,
    /// `None` while settled, so the first step after a pause is one tick long
    /// rather than the length of the pause.
    last_step: Option<Instant>,
    primed: bool,
}

impl HueEasing {
    pub(crate) fn new(channel_count: usize, tau: Duration) -> Self {
        Self {
            current: vec![[0.0; 3]; channel_count],
            target: vec![[0.0; 3]; channel_count],
            brightness: 1.0,
            brightness_target: 1.0,
            tau,
            last_step: None,
            primed: false,
        }
    }

    /// The newest target. `Snap` (solid colour, test patterns) and the first
    /// target of the session are shown as they are.
    pub(crate) fn retarget(&mut self, colors: &[HueRgb], brightness: f32, motion: HueMotion) {
        let brightness = brightness.clamp(0.0, 1.0);
        let snap =
            matches!(motion, HueMotion::Snap) || !self.primed || colors.len() != self.current.len();
        self.target.clear();
        self.target.extend_from_slice(colors);
        self.brightness_target = brightness;
        if snap {
            self.current.clear();
            self.current.extend_from_slice(colors);
            self.brightness = brightness;
            self.last_step = None;
        }
        self.primed = true;
    }

    pub(crate) fn settled(&self) -> bool {
        (self.brightness - self.brightness_target).abs() < SETTLED
            && self
                .current
                .iter()
                .zip(&self.target)
                .all(|(c, t)| (0..3).all(|i| (c[i] - t[i]).abs() < SETTLED))
    }

    /// Advance to `now` and return what the packet should carry. The step is
    /// `1 - exp(-dt / tau)` of the remaining gap, with `dt` capped at two
    /// ticks so a late wake-up cannot turn into a jump.
    pub(crate) fn step(&mut self, now: Instant) -> (&[HueRgb], f32) {
        if !self.settled() {
            let dt = self
                .last_step
                .map_or(self.tau, |at| now.saturating_duration_since(at))
                .min(self.tau * 2);
            let k = 1.0 - (-dt.as_secs_f32() / self.tau.as_secs_f32().max(1e-6)).exp();
            for (current, target) in self.current.iter_mut().zip(&self.target) {
                for i in 0..3 {
                    current[i] += k * (target[i] - current[i]);
                }
            }
            self.brightness += k * (self.brightness_target - self.brightness);
            self.last_step = Some(now);
            if self.settled() {
                self.current.clone_from(&self.target);
                self.brightness = self.brightness_target;
                self.last_step = None;
            }
        }
        (&self.current, self.brightness)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const TICK: Duration = Duration::from_millis(50);

    fn eased() -> HueEasing {
        let mut easing = HueEasing::new(1, TICK);
        easing.retarget(&[[0.0; 3]], 1.0, HueMotion::Ease);
        easing
    }

    /// Each 50 ms packet is a fraction of the gap, never the whole jump: a
    /// black-to-white cut goes out as a run of shrinking steps.
    #[test]
    fn each_tick_moves_a_bounded_fraction_of_the_gap() {
        let mut easing = eased();
        easing.retarget(&[[1.0; 3]], 1.0, HueMotion::Ease);
        let start = Instant::now();
        let bound = 1.0 - (-2.0f32).exp();
        let mut previous = 0.0f32;
        for n in 1..=12u32 {
            let (colors, _) = easing.step(start + TICK * n);
            let value = colors[0][0];
            let step = value - previous;
            assert!(step >= 0.0, "tick {n} moved away from the target");
            // The last step may close a gap below `SETTLED` outright.
            assert!(
                step <= bound * (1.0 - previous) + SETTLED,
                "tick {n} jumped {step} of a {} gap",
                1.0 - previous
            );
            previous = value;
        }
        assert!(
            previous > 0.99,
            "12 ticks should nearly arrive, got {previous}"
        );
    }

    #[test]
    fn it_converges_and_then_holds_still() {
        let mut easing = eased();
        easing.retarget(&[[0.2, 0.4, 0.8]], 0.5, HueMotion::Ease);
        let start = Instant::now();
        for n in 1..=60u32 {
            easing.step(start + TICK * n);
        }
        assert!(easing.settled());
        let (colors, brightness) = easing.step(start + TICK * 61);
        assert_eq!(colors, &[[0.2, 0.4, 0.8]]);
        assert_eq!(brightness, 0.5);
    }

    /// A target replaced before the sender got to it is never eased towards.
    #[test]
    fn the_newest_target_wins() {
        let mut easing = eased();
        easing.retarget(&[[1.0, 0.0, 0.0]], 1.0, HueMotion::Ease);
        easing.retarget(&[[0.0, 0.0, 1.0]], 1.0, HueMotion::Ease);
        let start = Instant::now();
        for n in 1..=20u32 {
            let (colors, _) = easing.step(start + TICK * n);
            assert_eq!(colors[0][0], 0.0, "tick {n} moved towards the replaced red");
        }
        assert_eq!(easing.step(start + TICK * 21).0, &[[0.0, 0.0, 1.0]]);
    }

    /// A long gap between steps (the sender slept on a quiet mailbox) is
    /// capped, so the next packet is a step and not a jump.
    #[test]
    fn a_late_tick_is_capped_at_two_ticks() {
        let mut easing = eased();
        easing.retarget(&[[1.0; 3]], 1.0, HueMotion::Ease);
        let start = Instant::now();
        easing.step(start);
        let (colors, _) = easing.step(start + Duration::from_secs(5));
        let first = 1.0 - (-1.0f32).exp();
        let capped = first + (1.0 - first) * (1.0 - (-2.0f32).exp());
        assert!((colors[0][0] - capped).abs() < 1e-5, "got {}", colors[0][0]);
    }

    #[test]
    fn snap_and_the_first_target_are_shown_as_they_are() {
        let mut easing = HueEasing::new(1, TICK);
        easing.retarget(&[[0.7, 0.1, 0.0]], 0.8, HueMotion::Ease);
        assert_eq!(easing.step(Instant::now()).0, &[[0.7, 0.1, 0.0]]);
        easing.retarget(&[[0.0, 0.0, 0.3]], 0.8, HueMotion::Snap);
        assert_eq!(easing.step(Instant::now()).0, &[[0.0, 0.0, 0.3]]);
    }
}
