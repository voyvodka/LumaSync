//! Adaptive frame smoothing and send-pacing for the ambilight worker loop —
//! trades latency for stability under CPU/USB pressure without dropping
//! below the strip's minimum refresh rate.

use std::time::{Duration, Instant};

/// Tuning knobs for `RuntimeQualityController`'s smoothing and adaptive pacing.
#[derive(Clone, Debug)]
pub struct RuntimeQualityConfig {
    pub smoothing_alpha: f32,
    pub base_interval_ms: u64,
    pub min_interval_ms: u64,
    pub max_interval_ms: u64,
    pub pressure_ewma_alpha: f32,
}

impl Default for RuntimeQualityConfig {
    fn default() -> Self {
        Self {
            smoothing_alpha: 0.35,
            base_interval_ms: 16,
            min_interval_ms: 8,
            max_interval_ms: 80,
            pressure_ewma_alpha: 0.25,
        }
    }
}

/// One frame's measured capture and send cost, in milliseconds.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct RuntimeTimingSample {
    pub capture_cost_ms: f32,
    pub send_cost_ms: f32,
}

/// Smooths per-LED colour transitions and adapts the send interval to
/// observed frame cost, so a slow capture/USB write degrades gracefully
/// instead of stalling the worker loop.
#[derive(Debug)]
pub struct RuntimeQualityController {
    config: RuntimeQualityConfig,
    previous_frame: Vec<[u8; 3]>,
    observed_cost_ewma_ms: Option<f32>,
    last_sent_at: Option<Instant>,
}

impl RuntimeQualityController {
    /// Build a controller with no smoothing history and no observed cost yet.
    pub fn new(config: RuntimeQualityConfig) -> Self {
        Self {
            config,
            previous_frame: Vec::new(),
            observed_cost_ewma_ms: None,
            last_sent_at: None,
        }
    }

    /// Blend `target_frame` toward the previous smoothed frame by
    /// `smoothing_alpha`, returning the new per-LED colours to send.
    /// A change in LED count resets smoothing and snaps to `target_frame`.
    pub fn smooth(&mut self, target_frame: &[[u8; 3]]) -> Vec<[u8; 3]> {
        if self.previous_frame.len() != target_frame.len() {
            self.previous_frame = target_frame.to_vec();
            return self.previous_frame.clone();
        }

        let alpha = self.config.smoothing_alpha.clamp(0.0, 1.0);
        // Update previous_frame in-place and collect result in a single pass.
        // Eliminates the extra clone() that the old version required.
        self.previous_frame
            .iter_mut()
            .zip(target_frame.iter())
            .map(|(previous, target)| {
                let smoothed = [
                    lerp_channel(previous[0], target[0], alpha),
                    lerp_channel(previous[1], target[1], alpha),
                    lerp_channel(previous[2], target[2], alpha),
                ];
                *previous = smoothed;
                smoothed
            })
            .collect()
    }

    /// Feed one frame's capture/send cost into the EWMA that
    /// `current_send_interval` uses to detect pressure.
    pub fn observe_timing(&mut self, capture_ms: f32, send_ms: f32) {
        let sample = RuntimeTimingSample {
            capture_cost_ms: capture_ms,
            send_cost_ms: send_ms,
        };
        let sample_cost = (sample.capture_cost_ms + sample.send_cost_ms).max(0.0);
        let ewma_alpha = self.config.pressure_ewma_alpha.clamp(0.0, 1.0);

        self.observed_cost_ewma_ms = Some(match self.observed_cost_ewma_ms {
            Some(previous) => (ewma_alpha * sample_cost) + ((1.0 - ewma_alpha) * previous),
            None => sample_cost,
        });
    }

    /// Interval to wait before the next send, stretched above
    /// `base_interval_ms` when observed cost indicates the loop is under
    /// pressure, clamped to `[min_interval_ms, max_interval_ms]`.
    pub fn current_send_interval(&self) -> Duration {
        let base_interval_ms = self.config.base_interval_ms.max(1);
        let min_interval_ms = self.config.min_interval_ms.max(1);
        let max_interval_ms = self.config.max_interval_ms.max(min_interval_ms);

        let adaptive_ms = match self.observed_cost_ewma_ms {
            Some(observed) if observed > 0.0 => {
                let pressure_ratio = (observed / base_interval_ms as f32).max(1.0);
                (base_interval_ms as f32 * pressure_ratio).round() as u64
            }
            _ => base_interval_ms,
        };

        Duration::from_millis(adaptive_ms.clamp(min_interval_ms, max_interval_ms))
    }

    /// Update the smoothing strength at runtime (e.g. user changed the setting).
    pub fn set_smoothing_alpha(&mut self, alpha: f32) {
        self.config.smoothing_alpha = alpha.clamp(0.0, 1.0);
    }

    /// Borrow the most recently smoothed (post-EWMA) per-LED buffer WITHOUT
    /// consuming it.
    ///
    /// `smooth()` updates `previous_frame` in place, so after each
    /// `queue_processed_frame` this slice holds the exact post-EWMA RGB the
    /// strip is converging toward — in physical strip order. The v1.6 LED
    /// Preview twin emit reads this to enrich the edge-signal without
    /// disturbing the send pipeline (`RuntimeFrameSlot` still owns the copy
    /// that goes to the sink). Empty before the first frame is smoothed.
    pub fn last_smoothed(&self) -> &[[u8; 3]] {
        &self.previous_frame
    }

    /// Current smoothed capture+send cost in milliseconds. Returns 0.0 before
    /// the first observation lands.
    pub fn observed_cost_ms(&self) -> f32 {
        self.observed_cost_ewma_ms.unwrap_or(0.0)
    }

    /// Gate for the worker loop: `true` (and records `now` as the last send)
    /// once `current_send_interval` has elapsed since the previous send.
    pub fn should_send_now(&mut self, now: Instant) -> bool {
        let Some(last_sent_at) = self.last_sent_at else {
            self.last_sent_at = Some(now);
            return true;
        };

        if now.duration_since(last_sent_at) >= self.current_send_interval() {
            self.last_sent_at = Some(now);
            return true;
        }

        false
    }
}

/// Single-slot coalescing buffer between capture and send: a frame that
/// arrives before the previous one was sent overwrites it rather than queuing,
/// so the worker always sends the latest frame instead of falling behind.
#[derive(Debug, Default)]
pub struct RuntimeFrameSlot {
    latest: Option<Vec<[u8; 3]>>,
}

impl RuntimeFrameSlot {
    /// Build an empty slot.
    pub fn new() -> Self {
        Self { latest: None }
    }

    /// Store `frame`, overwriting whatever was pending. Returns `true` when
    /// an unsent frame was dropped (useful for slot-overwrite telemetry).
    pub fn push(&mut self, frame: Vec<[u8; 3]>) -> bool {
        let replaced = self.latest.is_some();
        self.latest = Some(frame);
        replaced
    }

    /// Take and clear the pending frame, if any.
    pub fn take_latest(&mut self) -> Option<Vec<[u8; 3]>> {
        self.latest.take()
    }
}

fn lerp_channel(previous: u8, target: u8, alpha: f32) -> u8 {
    let previous = previous as f32;
    let target = target as f32;
    (previous + alpha * (target - previous))
        .round()
        .clamp(0.0, 255.0) as u8
}

#[cfg(test)]
mod tests {
    use super::{RuntimeFrameSlot, RuntimeQualityConfig, RuntimeQualityController};

    #[test]
    fn smoothes_step_changes() {
        let mut controller = RuntimeQualityController::new(RuntimeQualityConfig {
            smoothing_alpha: 0.5,
            ..RuntimeQualityConfig::default()
        });

        let baseline = controller.smooth(&[[0, 0, 0]]);
        assert_eq!(baseline, vec![[0, 0, 0]]);

        let first_step = controller.smooth(&[[255, 255, 255]]);
        assert_eq!(first_step, vec![[128, 128, 128]]);

        let second_step = controller.smooth(&[[255, 255, 255]]);
        assert!(second_step[0][0] > first_step[0][0]);
        assert!(second_step[0][0] < 255);
    }

    #[test]
    fn resets_on_led_count_change() {
        let mut controller = RuntimeQualityController::new(RuntimeQualityConfig {
            smoothing_alpha: 0.3,
            ..RuntimeQualityConfig::default()
        });

        let _ = controller.smooth(&[[10, 10, 10], [20, 20, 20]]);
        let changed = controller.smooth(&[[200, 100, 50]]);

        assert_eq!(changed, vec![[200, 100, 50]]);
    }

    #[test]
    fn adapts_interval_under_pressure() {
        let mut controller = RuntimeQualityController::new(RuntimeQualityConfig {
            base_interval_ms: 16,
            min_interval_ms: 8,
            max_interval_ms: 64,
            pressure_ewma_alpha: 1.0,
            ..RuntimeQualityConfig::default()
        });

        let base_interval = controller.current_send_interval();
        assert_eq!(base_interval.as_millis(), 16);

        controller.observe_timing(36.0, 20.0);

        let adapted_interval = controller.current_send_interval();
        assert!(adapted_interval > base_interval);
        assert!(adapted_interval.as_millis() <= 64);
    }

    #[test]
    fn coalesces_to_latest_frame() {
        let mut slot = RuntimeFrameSlot::new();

        slot.push(vec![[1, 1, 1]]);
        slot.push(vec![[2, 2, 2]]);
        slot.push(vec![[3, 3, 3]]);

        assert_eq!(slot.take_latest(), Some(vec![[3, 3, 3]]));
        assert_eq!(slot.take_latest(), None);
    }
}
