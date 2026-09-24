//! How fast the worker captures and sends: the serial link's send budget, the
//! adaptive send gate, and the capture interval that follows the output plan.

use std::time::{Duration, Instant};

use log::{info, warn};

use super::usb_output::UsbOutputPlan;
use crate::commands::ambilight_capture::DEFAULT_CAPTURE_INTERVAL;
use crate::commands::led_calibration::{
    derive_base_interval_ms_for, frame_wire_bytes, frame_wire_time_ms, link_max_fps,
};
use crate::commands::led_output::{FirmwareProfile, LedChipType, WirePixelLayout};
use crate::commands::runtime_quality::{RuntimeQualityConfig, RuntimeQualityController};

pub(super) struct AmbilightWorkerQualityState {
    controller: RuntimeQualityController,
}

impl AmbilightWorkerQualityState {
    pub(super) fn new(config: RuntimeQualityConfig) -> Self {
        Self {
            controller: RuntimeQualityController::new(config),
        }
    }

    /// The strip's send gate: `true` at most once per send interval.
    pub(super) fn should_send_now(&mut self, now: Instant) -> bool {
        self.controller.should_send_now(now)
    }

    pub(super) fn observe_capture_and_send_cost(&mut self, capture_ms: f32, send_ms: f32) {
        self.controller.observe_timing(capture_ms, send_ms);
    }

    pub(super) fn observed_cost_ms(&self) -> f32 {
        self.controller.observed_cost_ms()
    }

    pub(super) fn current_send_interval(&self) -> Duration {
        self.controller.current_send_interval()
    }
}

/// Below this many frames per second the ambient effect visibly steps, so the
/// serial budget is worth surfacing rather than silently absorbing.
const LINK_CONSTRAINED_FPS: f32 = 30.0;

/// Resolved 115 200-baud send budget for one calibrated strip.
///
/// Exists so the clamp arithmetic is unit-testable away from the worker.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) struct SerialSendBudget {
    /// Total on-wire size of one frame, header included.
    pub(super) bytes_per_frame: usize,
    /// Interval the LED-count heuristic asks for, before the physical clamp.
    pub(super) requested_ms: u64,
    /// Time the link physically needs to shift one frame — the hard floor.
    pub(super) wire_ms: u64,
    pub(super) link_max_fps: f32,
}

impl SerialSendBudget {
    pub(super) fn for_strip(
        total_leds: u16,
        profile: FirmwareProfile,
        chip_type: LedChipType,
    ) -> Self {
        let bytes_per_pixel = WirePixelLayout::for_output(profile, chip_type).bytes_per_pixel();
        Self {
            bytes_per_frame: frame_wire_bytes(total_leds, bytes_per_pixel),
            requested_ms: derive_base_interval_ms_for(total_leds, bytes_per_pixel) as u64,
            wire_ms: frame_wire_time_ms(total_leds, bytes_per_pixel),
            link_max_fps: link_max_fps(total_leds, bytes_per_pixel),
        }
    }

    /// True when the LED-count heuristic asks for a rate the link cannot carry.
    /// Holds even for a 1 ms shortfall, so it drives the clamp, not the log.
    pub(super) fn exceeds_link_budget(self) -> bool {
        self.requested_ms < self.wire_ms
    }

    /// True when the strip is long enough that 115 200 baud materially degrades
    /// the effect — worth telling the user about, unlike a 1 ms rounding clamp.
    /// ~126 LEDs on GRB, ~94 on RGBW.
    pub(super) fn is_link_constrained(self) -> bool {
        self.link_max_fps < LINK_CONSTRAINED_FPS
    }

    pub(super) fn into_quality_config(self) -> RuntimeQualityConfig {
        // `wire_ms` pins BOTH bounds: the 10 fps floor in the derive helper and
        // the 80 ms default cap each breach the baud budget on a long strip.
        let default_max_ms = RuntimeQualityConfig::default().max_interval_ms;
        RuntimeQualityConfig {
            base_interval_ms: self.requested_ms,
            min_interval_ms: self.wire_ms,
            max_interval_ms: default_max_ms.max(self.wire_ms),
            ..RuntimeQualityConfig::default()
        }
    }
}

/// Resolve the worker's send cadence for its resolved USB-channel sink.
///
/// Pure and side-effect free (besides logging) so the WLED-vs-serial budget
/// divergence is unit-testable without spinning up a worker thread: only a
/// real serial link is bound by the 115 200-baud budget; WLED rides UDP and
/// gets the same capture-paced defaults as a Hue-only session, and the
/// returned `SerialSendBudget` is `None` in both non-serial cases so the
/// caller's telemetry `link_max_fps` stays at its `0.0` "no serial link"
/// default.
pub(super) fn resolve_quality_config(
    usb_plan: &Option<UsbOutputPlan>,
    total_leds: u16,
    profile: FirmwareProfile,
    chip_type: LedChipType,
) -> (RuntimeQualityConfig, Option<SerialSendBudget>) {
    match usb_plan {
        Some(UsbOutputPlan::Serial(_)) => {
            let budget = SerialSendBudget::for_strip(total_leds, profile, chip_type);
            if budget.is_link_constrained() {
                warn!(
                    "[ambilight-worker] strip exceeds the 115 200-baud budget — \
                     leds={total_leds} profile={profile:?} chip={chip_type:?} bytes_per_frame={} \
                     link_max_fps={:.1} (below {LINK_CONSTRAINED_FPS:.0}); \
                     send interval clamped to {}ms. Shorten the strip or split it \
                     across controllers for a smoother effect.",
                    budget.bytes_per_frame, budget.link_max_fps, budget.wire_ms
                );
            } else {
                info!(
                    "[ambilight-worker] serial budget — leds={total_leds} profile={profile:?} chip={chip_type:?} \
                     bytes_per_frame={} link_max_fps={:.1} send_interval={}ms clamped={}",
                    budget.bytes_per_frame,
                    budget.link_max_fps,
                    budget.requested_ms.max(budget.wire_ms),
                    budget.exceeds_link_budget()
                );
            }
            (budget.into_quality_config(), Some(budget))
        }
        Some(UsbOutputPlan::Wled(_)) => {
            // No baud budget to clamp against -- let capture-cost pacing
            // govern the rate via the plain defaults (~60 fps target).
            info!("[ambilight-worker] wled sink — unconstrained by a serial link budget");
            (RuntimeQualityConfig::default(), None)
        }
        None => {
            // Hue-only path. Bridge enforces 50 ms minimum (20 Hz); target
            // ~25 FPS capture to stay just above the send rate without
            // flooding the queue.
            let config = RuntimeQualityConfig {
                base_interval_ms: 40,
                min_interval_ms: 30,
                max_interval_ms: 100,
                ..RuntimeQualityConfig::default()
            };
            (config, None)
        }
    }
}

/// A strip is fed at 30 Hz — more than Hue's 20 Hz floor can use, and enough
/// for the strip's own glide between frames — but never faster than its link
/// takes a frame. Hue alone gets its floor. See
/// docs/architecture/capture-and-pipeline.md, "Capture rate follows the output
/// plan".
const STRIP_CAPTURE_INTERVAL: Duration = Duration::from_millis(33);

pub(super) fn capture_interval_for(
    strip: Option<&UsbOutputPlan>,
    strip_budget_ms: Option<u64>,
) -> Duration {
    match strip {
        None => DEFAULT_CAPTURE_INTERVAL,
        Some(_) => strip_budget_ms
            .map(Duration::from_millis)
            .map_or(STRIP_CAPTURE_INTERVAL, |wire| {
                wire.max(STRIP_CAPTURE_INTERVAL)
            })
            .min(DEFAULT_CAPTURE_INTERVAL),
    }
}
