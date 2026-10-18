//! The latency scene's measurement: pipeline delay, from the moment a frame
//! was captured to the moment the output that carries it was sent. The scene
//! flips the screen between black and white; a frame on the far side of a flip
//! starts a sample, and the first send after it ends one. What the strip then
//! does with the bytes, and the display's own delay, are not in it.

use std::collections::VecDeque;
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::commands::ambilight_capture::CapturedFrame;

/// `LatencyResult` in `src/shared/contracts/preview.ts`.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LatencyResult {
    /// The newest samples, oldest first, in milliseconds.
    pub samples_ms: Vec<f32>,
    pub median_ms: f32,
    /// Flips that reached no output in time, or were overtaken by the next.
    pub dropped: u32,
}

/// Hands a new result to the preview session; without the Tauri runtime type.
pub type LatencySink = Arc<dyn Fn(&LatencyResult) + Send + Sync>;

/// Samples kept for the median: a few seconds of flips.
const KEPT: usize = 15;
/// Above this a frame reads as the white half of the scene, below `DARK` as the
/// black; between, a transition caught mid-way, which decides nothing.
const BRIGHT: f32 = 0.6;
const DARK: f32 = 0.25;
/// A flip whose send has not come by then was lost, not slow.
const LOST_AFTER: Duration = Duration::from_millis(500);

#[derive(Default)]
pub(super) struct LatencyMeter {
    lit: Option<bool>,
    pending: Option<Instant>,
    samples: VecDeque<f32>,
    dropped: u32,
}

impl LatencyMeter {
    /// A newly captured frame at `level` (0..1 mean light). The first frame
    /// only says where the scene is; each change after it starts a sample.
    pub(super) fn observe_frame(&mut self, level: f32, captured_at: Instant) {
        let lit = if level >= BRIGHT {
            true
        } else if level <= DARK {
            false
        } else {
            return;
        };
        let previous = self.lit.replace(lit);
        if previous.is_none() || previous == Some(lit) {
            return;
        }
        if self.pending.replace(captured_at).is_some() {
            self.dropped += 1;
        }
    }

    /// An output went out at `sent_at`. `Some` when that ended a sample.
    pub(super) fn observe_sent(&mut self, sent_at: Instant) -> Option<LatencyResult> {
        let captured_at = self.pending.take()?;
        let delay = sent_at.saturating_duration_since(captured_at);
        if delay > LOST_AFTER {
            self.dropped += 1;
        } else {
            if self.samples.len() == KEPT {
                self.samples.pop_front();
            }
            self.samples.push_back(delay.as_secs_f32() * 1000.0);
        }
        Some(self.result())
    }

    fn result(&self) -> LatencyResult {
        let mut sorted: Vec<f32> = self.samples.iter().copied().collect();
        sorted.sort_by(f32::total_cmp);
        let median_ms = match sorted.len() {
            0 => 0.0,
            n if n % 2 == 1 => sorted[n / 2],
            n => (sorted[n / 2 - 1] + sorted[n / 2]) / 2.0,
        };
        LatencyResult {
            samples_ms: self.samples.iter().copied().collect(),
            median_ms,
            dropped: self.dropped,
        }
    }
}

/// The frame's mean light, 0..1, from a sparse grid: a flip is the whole
/// screen, so a thousand pixels say as much as all of them.
pub(super) fn frame_level(frame: &CapturedFrame) -> f32 {
    let pixels = &frame.pixels_rgb;
    if pixels.is_empty() {
        return 0.0;
    }
    let step = (pixels.len() / 1024).max(1);
    let (sum, count) = pixels
        .iter()
        .step_by(step)
        .fold((0u64, 0u64), |(sum, count), [r, g, b]| {
            (
                sum + u64::from(*r) + u64::from(*g) + u64::from(*b),
                count + 1,
            )
        });
    sum as f32 / (count as f32 * 3.0 * 255.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ms(n: u64) -> Duration {
        Duration::from_millis(n)
    }

    #[test]
    fn a_flip_followed_by_a_send_is_one_sample() {
        let t0 = Instant::now();
        let mut meter = LatencyMeter::default();
        meter.observe_frame(0.0, t0);
        assert_eq!(meter.observe_sent(t0 + ms(5)), None, "no flip yet");

        meter.observe_frame(1.0, t0 + ms(500));
        let result = meter.observe_sent(t0 + ms(523)).expect("a sample");

        assert_eq!(result.samples_ms.len(), 1);
        assert!((result.median_ms - 23.0).abs() < 0.01);
        assert_eq!(result.dropped, 0);
        assert_eq!(meter.observe_sent(t0 + ms(540)), None, "one send ends it");
    }

    #[test]
    fn a_mid_transition_frame_decides_nothing() {
        let t0 = Instant::now();
        let mut meter = LatencyMeter::default();
        meter.observe_frame(0.0, t0);
        meter.observe_frame(0.45, t0 + ms(500));
        assert_eq!(meter.observe_sent(t0 + ms(510)), None);
        meter.observe_frame(0.9, t0 + ms(533));
        let result = meter.observe_sent(t0 + ms(550)).expect("a sample");
        assert!((result.median_ms - 17.0).abs() < 0.01);
    }

    #[test]
    fn a_flip_overtaken_or_sent_too_late_is_dropped() {
        let t0 = Instant::now();
        let mut meter = LatencyMeter::default();
        meter.observe_frame(0.0, t0);
        meter.observe_frame(1.0, t0 + ms(500));
        meter.observe_frame(0.0, t0 + ms(1000));
        let late = meter.observe_sent(t0 + ms(1600)).expect("an answer");
        assert_eq!(late.dropped, 2);
        assert!(late.samples_ms.is_empty());
    }

    #[test]
    fn the_median_keeps_the_newest_samples() {
        let t0 = Instant::now();
        let mut meter = LatencyMeter::default();
        meter.observe_frame(0.0, t0);
        let mut last = None;
        for i in 0..20u64 {
            let at = t0 + ms(500 * (i + 1));
            meter.observe_frame(if i % 2 == 0 { 1.0 } else { 0.0 }, at);
            last = meter.observe_sent(at + ms(10 + i));
        }
        let result = last.expect("samples");
        assert_eq!(result.samples_ms.len(), KEPT);
        assert!(
            (result.samples_ms[0] - 15.0).abs() < 0.01,
            "the oldest five are gone"
        );
        assert!((result.median_ms - 22.0).abs() < 0.01);
    }

    #[test]
    fn the_level_of_a_white_frame_is_one_and_of_a_black_zero() {
        let white = CapturedFrame::new(64, 40, vec![[255, 255, 255]; 64 * 40]);
        let black = CapturedFrame::new(64, 40, vec![[0, 0, 0]; 64 * 40]);
        assert!((frame_level(&white) - 1.0).abs() < 1e-6);
        assert!(frame_level(&black).abs() < 1e-6);
    }
}
