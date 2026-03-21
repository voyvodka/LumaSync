use std::time::{Duration, Instant};

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

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct RuntimeTimingSample {
    pub capture_cost_ms: f32,
    pub send_cost_ms: f32,
}

#[derive(Debug)]
pub struct RuntimeQualityController {
    config: RuntimeQualityConfig,
    previous_frame: Vec<[u8; 3]>,
    observed_cost_ewma_ms: Option<f32>,
    last_sent_at: Option<Instant>,
}

impl RuntimeQualityController {
    pub fn new(config: RuntimeQualityConfig) -> Self {
        Self {
            config,
            previous_frame: Vec::new(),
            observed_cost_ewma_ms: None,
            last_sent_at: None,
        }
    }

    pub fn smooth_frame(&mut self, target_frame: &[[u8; 3]]) -> Vec<[u8; 3]> {
        self.previous_frame = target_frame.to_vec();
        self.previous_frame.clone()
    }

    pub fn observe_timing(&mut self, sample: RuntimeTimingSample) {
        let _ = sample;
    }

    pub fn current_interval(&self) -> Duration {
        Duration::from_millis(self.config.base_interval_ms.max(1))
    }

    pub fn should_send_now(&mut self, now: Instant) -> bool {
        let Some(last_sent_at) = self.last_sent_at else {
            self.last_sent_at = Some(now);
            return true;
        };

        if now.duration_since(last_sent_at) >= self.current_interval() {
            self.last_sent_at = Some(now);
            return true;
        }

        false
    }
}

#[derive(Debug, Default)]
pub struct RuntimeFrameSlot {
    latest: Option<Vec<[u8; 3]>>,
}

impl RuntimeFrameSlot {
    pub fn new() -> Self {
        Self { latest: None }
    }

    pub fn push(&mut self, frame: Vec<[u8; 3]>) {
        self.latest = Some(frame);
    }

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
    use super::{
        RuntimeFrameSlot, RuntimeQualityConfig, RuntimeQualityController, RuntimeTimingSample,
    };

    #[test]
    fn smoothes_step_changes() {
        let mut controller = RuntimeQualityController::new(RuntimeQualityConfig {
            smoothing_alpha: 0.5,
            ..RuntimeQualityConfig::default()
        });

        let baseline = controller.smooth_frame(&[[0, 0, 0]]);
        assert_eq!(baseline, vec![[0, 0, 0]]);

        let first_step = controller.smooth_frame(&[[255, 255, 255]]);
        assert_eq!(first_step, vec![[128, 128, 128]]);

        let second_step = controller.smooth_frame(&[[255, 255, 255]]);
        assert!(second_step[0][0] > first_step[0][0]);
        assert!(second_step[0][0] < 255);
    }

    #[test]
    fn resets_on_led_count_change() {
        let mut controller = RuntimeQualityController::new(RuntimeQualityConfig {
            smoothing_alpha: 0.3,
            ..RuntimeQualityConfig::default()
        });

        let _ = controller.smooth_frame(&[[10, 10, 10], [20, 20, 20]]);
        let changed = controller.smooth_frame(&[[200, 100, 50]]);

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

        let base_interval = controller.current_interval();
        assert_eq!(base_interval.as_millis(), 16);

        controller.observe_timing(RuntimeTimingSample {
            capture_cost_ms: 36.0,
            send_cost_ms: 20.0,
        });

        let adapted_interval = controller.current_interval();
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
