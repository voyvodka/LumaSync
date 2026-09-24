use super::correction::{
    apply_color_correction_rgb, apply_kelvin_to_pixel, apply_saturation_to_pixel, build_gamma_luts,
    kelvin_to_rgb_multipliers, scale_brightness, ColorCorrectionConfig, EncoderPlan, GammaLuts,
};
use super::encode::encode_adalight_packet;

/// `lighting_mode::apply_saturation_rgb`, the live-saturation copy.
fn legacy_live_saturation(rgb: (u8, u8, u8), factor: f32) -> (u8, u8, u8) {
    if (factor - 1.0).abs() < f32::EPSILON {
        return rgb;
    }
    let r = rgb.0 as f32;
    let g = rgb.1 as f32;
    let b = rgb.2 as f32;
    let l = 0.299 * r + 0.587 * g + 0.114 * b;
    let nr = l + factor * (r - l);
    let ng = l + factor * (g - l);
    let nb = l + factor * (b - l);
    (
        nr.round().clamp(0.0, 255.0) as u8,
        ng.round().clamp(0.0, 255.0) as u8,
        nb.round().clamp(0.0, 255.0) as u8,
    )
}

/// `apply_color_correction_rgb_with_luts`, which recomputed the Kelvin
/// multipliers for every pixel; WLED, Hue and the twin went through it.
fn legacy_correction(
    rgb: (u8, u8, u8),
    corrections: &ColorCorrectionConfig,
    luts: &GammaLuts,
) -> (u8, u8, u8) {
    let [r, g, b] = apply_saturation_to_pixel([rgb.0, rgb.1, rgb.2], corrections.saturation);
    let [r, g, b] = if corrections.kelvin == 6500 {
        [r, g, b]
    } else {
        let kelvin_muls = kelvin_to_rgb_multipliers(corrections.kelvin);
        apply_kelvin_to_pixel([r, g, b], &kelvin_muls)
    };
    (luts.r[r as usize], luts.g[g as usize], luts.b[b as usize])
}

/// `CorrectedWledSink::send_frame` and the twin feed's brightness step.
fn legacy_brightness(rgb: (u8, u8, u8), brightness: f32) -> [u8; 3] {
    [
        (rgb.0 as f32 * brightness).round().clamp(0.0, 255.0) as u8,
        (rgb.1 as f32 * brightness).round().clamp(0.0, 255.0) as u8,
        (rgb.2 as f32 * brightness).round().clamp(0.0, 255.0) as u8,
    ]
}

fn corrections() -> Vec<ColorCorrectionConfig> {
    let mut all = Vec::new();
    for kelvin in [2700u16, 4000, 5000, 6500, 9000] {
        for saturation in [0.0f32, 0.8, 1.0, 1.2, 1.8] {
            for gamma in [(2.2f32, 2.2f32, 2.2f32), (2.4, 2.2, 2.0), (1.0, 1.8, 2.8)] {
                all.push(ColorCorrectionConfig {
                    gamma_r: gamma.0,
                    gamma_g: gamma.1,
                    gamma_b: gamma.2,
                    kelvin,
                    saturation,
                });
            }
        }
    }
    all
}

fn pixels() -> impl Iterator<Item = [u8; 3]> {
    (0..=255u16)
        .step_by(5)
        .flat_map(|r| [(r, 0u16, 255u16), (r, 128, 30), (r, r, r), (r, 255 - r, 90)])
        .map(|(r, g, b)| [r as u8, g as u8, b as u8])
}

#[test]
fn live_saturation_is_the_calibration_saturation_byte_for_byte() {
    for factor in [0.5f32, 0.8, 1.0, 1.3, 2.0] {
        for [r, g, b] in pixels() {
            let (lr, lg, lb) = legacy_live_saturation((r, g, b), factor);
            assert_eq!(
                apply_saturation_to_pixel([r, g, b], factor),
                [lr, lg, lb],
                "{factor} on ({r},{g},{b})"
            );
        }
    }
}

/// WLED and the twin: the plan's correction then `scale_brightness` is
/// the per-pixel-Kelvin correction and brightness they ran before.
#[test]
fn strip_bytes_match_the_pipeline_before_item_27() {
    for config in corrections() {
        let plan = EncoderPlan::new(&config);
        let luts = build_gamma_luts(config.gamma_r, config.gamma_g, config.gamma_b);
        for [r, g, b] in pixels() {
            let legacy = legacy_correction((r, g, b), &config, &luts);
            assert_eq!(
                plan.correct([r, g, b]),
                [legacy.0, legacy.1, legacy.2],
                "{config:?} on ({r},{g},{b})"
            );
            assert_eq!(
                apply_color_correction_rgb((r, g, b), &config),
                legacy,
                "one-off wrapper, {config:?}"
            );
            for brightness in [0.0f32, 0.37, 0.8, 1.0] {
                assert_eq!(
                    scale_brightness(plan.correct([r, g, b]), brightness),
                    legacy_brightness(legacy, brightness),
                    "{config:?} at {brightness}"
                );
            }
        }
    }
}

/// Adalight scaled its pixels with a closure of its own.
#[test]
fn adalight_packets_are_unchanged() {
    let config = ColorCorrectionConfig {
        gamma_r: 2.4,
        gamma_g: 2.2,
        gamma_b: 2.0,
        kelvin: 5000,
        saturation: 1.2,
    };
    let plan = EncoderPlan::new(&config);
    let luts = build_gamma_luts(2.4, 2.2, 2.0);
    let strip: Vec<[u8; 3]> = pixels().collect();
    for brightness in [0.25f32, 0.8, 1.0] {
        let packet = encode_adalight_packet(brightness, &strip, &plan);
        let mut expected = packet[..6].to_vec();
        for &[r, g, b] in &strip {
            expected.extend_from_slice(&legacy_brightness(
                legacy_correction((r, g, b), &config, &luts),
                brightness,
            ));
        }
        assert_eq!(packet, expected, "brightness {brightness}");
    }
}

/// Hue takes the same stages without the rounding, so it lands on the
/// 8-bit result give or take the rounding the 8-bit path does between
/// stages — and in the dark, where gamma leaves the 8-bit table only a
/// handful of levels, it keeps every input level apart.
#[test]
fn hue_precision_follows_the_same_stages() {
    for config in corrections() {
        let plan = EncoderPlan::new(&config);
        for pixel in pixels() {
            let precise = plan.correct_precise(pixel.map(f32::from));
            let rounded = plan.correct(pixel);
            for c in 0..3 {
                let gamma = [config.gamma_r, config.gamma_g, config.gamma_b][c];
                // Saturation and Kelvin each round to a whole level before
                // the LUT; the LUT's slope is at most `gamma` levels per level.
                let allowed = 0.5 + gamma;
                assert!(
                    (precise[c] * 255.0 - f32::from(rounded[c])).abs() <= allowed,
                    "{config:?} {pixel:?} channel {c}: {} vs {}",
                    precise[c] * 255.0,
                    rounded[c]
                );
            }
        }
    }
    let plan = EncoderPlan::default();
    let dark: Vec<u8> = (10..=30u8).map(|v| plan.correct([v, v, v])[0]).collect();
    let precise: Vec<f32> = (10..=30u8)
        .map(|v| plan.correct_precise([f32::from(v); 3])[0])
        .collect();
    assert!(
        dark.windows(2).any(|w| w[0] == w[1]),
        "the 8-bit table has flat steps here"
    );
    assert!(
        precise.windows(2).all(|w| w[1] > w[0]),
        "every level stays distinct"
    );
}
