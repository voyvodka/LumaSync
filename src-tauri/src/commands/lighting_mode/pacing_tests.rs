//! The serial send budget and the adaptive send gate, away from any worker.

use std::time::{Duration, Instant};

use super::pacing::{AmbilightWorkerQualityState, SerialSendBudget};
use crate::commands::led_output::{FirmwareProfile, LedChipType};
use crate::commands::runtime_quality::RuntimeQualityConfig;

// -----------------------------------------------------------------------
// SerialSendBudget — the 115 200-baud clamp
// -----------------------------------------------------------------------

#[test]
fn send_budget_never_sends_faster_than_the_wire() {
    for leds in [1u16, 30, 60, 100, 200, 320, 1000, 4000] {
        for chip in [LedChipType::Ws2812bGrb, LedChipType::Sk6812Rgbw] {
            let config = SerialSendBudget::for_strip(leds, FirmwareProfile::LumaSyncV1, chip)
                .into_quality_config();
            let wire_ms =
                SerialSendBudget::for_strip(leds, FirmwareProfile::LumaSyncV1, chip).wire_ms;
            let controller = AmbilightWorkerQualityState::new(config.clone());
            let interval = controller.current_send_interval().as_millis() as u64;
            assert!(
                interval >= wire_ms,
                "leds={leds} chip={chip:?}: interval {interval}ms is below the {wire_ms}ms wire floor",
            );
            assert!(
                config.max_interval_ms >= config.min_interval_ms,
                "leds={leds} chip={chip:?}: max cap must never sit below the wire floor",
            );
        }
    }
}

#[test]
fn send_budget_flags_every_overrun_however_small() {
    // 60 GRB LEDs: 186 B/frame, 16 ms requested vs 17 ms wire — the 16 ms
    // hard floor in the derive helper already overruns here.
    assert!(
        SerialSendBudget::for_strip(60, FirmwareProfile::LumaSyncV1, LedChipType::Ws2812bGrb)
            .exceeds_link_budget()
    );
    // 100 GRB LEDs: 27 ms requested vs 27 ms wire — exactly at budget.
    assert!(!SerialSendBudget::for_strip(
        100,
        FirmwareProfile::LumaSyncV1,
        LedChipType::Ws2812bGrb
    )
    .exceeds_link_budget());
    let rgbw =
        SerialSendBudget::for_strip(100, FirmwareProfile::LumaSyncV1, LedChipType::Sk6812Rgbw);
    assert_eq!(rgbw.bytes_per_frame, 406);
    assert_eq!(rgbw.wire_ms, 36);
    // 4000 LEDs: the 10 fps floor asks for 100 ms, the wire needs ~1.04 s.
    let long =
        SerialSendBudget::for_strip(4000, FirmwareProfile::LumaSyncV1, LedChipType::Ws2812bGrb);
    assert!(long.exceeds_link_budget());
    assert_eq!(long.requested_ms, 100);
    assert_eq!(long.wire_ms, 1043);
}

#[test]
fn link_constrained_reports_degradation_not_rounding() {
    // A 60-LED strip is clamped by 1 ms (16 → 17) but still runs ~59 fps —
    // reporting that as a problem would cry wolf on the commonest setup.
    let common =
        SerialSendBudget::for_strip(60, FirmwareProfile::LumaSyncV1, LedChipType::Ws2812bGrb);
    assert!(common.exceeds_link_budget());
    assert!(!common.is_link_constrained());

    // 200 LEDs runs at ~19 fps — genuinely degraded, worth telling the user.
    assert!(
        SerialSendBudget::for_strip(200, FirmwareProfile::LumaSyncV1, LedChipType::Ws2812bGrb)
            .is_link_constrained()
    );
    // Same LED count, opposite verdict: RGBW's extra byte per pixel drops
    // 100 LEDs from ~37.6 fps to ~28.4 fps.
    assert!(!SerialSendBudget::for_strip(
        100,
        FirmwareProfile::LumaSyncV1,
        LedChipType::Ws2812bGrb
    )
    .is_link_constrained());
    assert!(
        SerialSendBudget::for_strip(100, FirmwareProfile::LumaSyncV1, LedChipType::Sk6812Rgbw)
            .is_link_constrained()
    );
}

#[test]
fn send_budget_lifts_the_default_cap_above_the_wire_floor() {
    // The 80 ms default `max_interval_ms` would otherwise clamp a long
    // strip's interval BELOW its physical floor — permanent backpressure
    // against the 500 ms serial write timeout.
    let default_cap = RuntimeQualityConfig::default().max_interval_ms;
    assert_eq!(default_cap, 80);

    let long =
        SerialSendBudget::for_strip(4000, FirmwareProfile::LumaSyncV1, LedChipType::Ws2812bGrb);
    let config = long.into_quality_config();
    assert_eq!(config.min_interval_ms, 1043);
    assert_eq!(config.max_interval_ms, 1043);

    let short =
        SerialSendBudget::for_strip(60, FirmwareProfile::LumaSyncV1, LedChipType::Ws2812bGrb);
    assert_eq!(short.into_quality_config().max_interval_ms, default_cap);
}

#[test]
fn send_budget_widens_for_rgbw_at_the_same_led_count() {
    let grb =
        SerialSendBudget::for_strip(150, FirmwareProfile::LumaSyncV1, LedChipType::Ws2812bGrb);
    let rgbw =
        SerialSendBudget::for_strip(150, FirmwareProfile::LumaSyncV1, LedChipType::Sk6812Rgbw);
    assert!(rgbw.wire_ms > grb.wire_ms);
    assert!(rgbw.link_max_fps < grb.link_max_fps);
    assert!(rgbw.into_quality_config().min_interval_ms > grb.into_quality_config().min_interval_ms);
}

/// Adalight has no RGBW frame, so an SK6812 strip under it ships three
/// bytes a pixel; budgeting four capped it a quarter below the link.
#[test]
fn send_budget_sizes_adalight_sk6812_by_the_three_byte_frame_it_sends() {
    let ada_rgbw =
        SerialSendBudget::for_strip(164, FirmwareProfile::Adalight, LedChipType::Sk6812Rgbw);
    let grb =
        SerialSendBudget::for_strip(164, FirmwareProfile::LumaSyncV1, LedChipType::Ws2812bGrb);
    assert_eq!(ada_rgbw, grb);
    assert_eq!(ada_rgbw.bytes_per_frame, 164 * 3 + 6);
    assert!(ada_rgbw.link_max_fps > 23.0);
}

#[test]
fn send_budget_floor_holds_when_observed_cost_is_negligible() {
    // Pressure adaptation only ever widens the interval; the floor is what
    // stops a cheap capture from driving the link past its budget.
    let mut controller = AmbilightWorkerQualityState::new(
        SerialSendBudget::for_strip(200, FirmwareProfile::LumaSyncV1, LedChipType::Ws2812bGrb)
            .into_quality_config(),
    );
    controller.observe_capture_and_send_cost(0.1, 0.1);
    assert_eq!(controller.current_send_interval().as_millis() as u64, 53);
}

/// The strip's send gate, now that smoothing is out of it: open on the
/// first call, shut until the interval has passed, then open again.
#[test]
fn quality_runtime_gate_opens_once_per_interval() {
    let mut quality = AmbilightWorkerQualityState::new(RuntimeQualityConfig {
        base_interval_ms: 60,
        min_interval_ms: 8,
        max_interval_ms: 120,
        pressure_ewma_alpha: 1.0,
    });
    let base = Instant::now();
    assert!(quality.should_send_now(base));
    assert!(!quality.should_send_now(base + Duration::from_millis(59)));
    assert!(quality.should_send_now(base + Duration::from_millis(60)));
}

#[test]
fn quality_runtime_adapts_send_interval_under_high_cost() {
    let mut quality = AmbilightWorkerQualityState::new(RuntimeQualityConfig {
        base_interval_ms: 16,
        min_interval_ms: 8,
        max_interval_ms: 80,
        pressure_ewma_alpha: 1.0,
    });

    let baseline = quality.current_send_interval();
    quality.observe_capture_and_send_cost(28.0, 24.0);
    let adapted = quality.current_send_interval();

    assert!(adapted > baseline);
}
