use std::time::{Duration, Instant};

#[derive(Clone, Debug)]
pub struct RuntimeQualityConfig {
    pub base_interval_ms: u64,
    pub min_interval_ms: u64,
    pub max_interval_ms: u64,
    pub pressure_ewma_alpha: f32,
}

impl Default for RuntimeQualityConfig {
    fn default() -> Self {
        Self {
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
    observed_cost_ewma_ms: Option<f32>,
    last_sent_at: Option<Instant>,
}

impl RuntimeQualityController {
    pub fn new(config: RuntimeQualityConfig) -> Self {
        Self {
            config,
            observed_cost_ewma_ms: None,
            last_sent_at: None,
        }
    }

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

    /// Current smoothed capture+send cost in milliseconds. Returns 0.0 before
    /// the first observation lands.
    pub fn observed_cost_ms(&self) -> f32 {
        self.observed_cost_ewma_ms.unwrap_or(0.0)
    }

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

#[cfg(test)]
mod tests {
    use super::{RuntimeQualityConfig, RuntimeQualityController};

    #[test]
    fn adapts_interval_under_pressure() {
        let mut controller = RuntimeQualityController::new(RuntimeQualityConfig {
            base_interval_ms: 16,
            min_interval_ms: 8,
            max_interval_ms: 64,
            pressure_ewma_alpha: 1.0,
        });

        let base_interval = controller.current_send_interval();
        assert_eq!(base_interval.as_millis(), 16);

        controller.observe_timing(36.0, 20.0);

        let adapted_interval = controller.current_send_interval();
        assert!(adapted_interval > base_interval);
        assert!(adapted_interval.as_millis() <= 64);
    }
}
