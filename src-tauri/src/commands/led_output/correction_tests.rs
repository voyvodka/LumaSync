//! The correction stages one at a time — Kelvin, saturation, per-channel
//! gamma — and the single-pixel helper Hue and Solid use.

use super::correction::{
    apply_color_correction_rgb, apply_kelvin_to_pixel, apply_saturation_to_pixel, build_gamma_luts,
    kelvin_to_rgb_multipliers, ColorCorrectionConfig, EncoderPlan,
};
use super::encode::{encode_led_packet, encode_led_packet_with_kelvin, encode_lumasync_v1_packet};

// ---------------------------------------------------------------------------
// Kelvin white-balance
// ---------------------------------------------------------------------------

#[test]
fn kelvin_6500_returns_identity_multipliers() {
    let muls = kelvin_to_rgb_multipliers(6500);
    assert_eq!(muls, [1.0_f32, 1.0_f32, 1.0_f32]);
}

#[test]
fn kelvin_3200_produces_warm_tint() {
    let muls = kelvin_to_rgb_multipliers(3200);
    assert_eq!(muls[0], 1.0_f32, "R must be 1.0 below 6600 K");
    assert!(
        muls[2] < 0.7_f32,
        "B multiplier must be <0.7 at 3200 K, got {}",
        muls[2]
    );
}

#[test]
fn kelvin_9000_produces_cool_tint() {
    let muls = kelvin_to_rgb_multipliers(9000);
    assert_eq!(muls[2], 1.0_f32, "B must be 1.0 above 6600 K");
    assert!(
        muls[0] < 0.9_f32,
        "R multiplier must be <0.9 at 9000 K, got {}",
        muls[0]
    );
}

#[test]
fn kelvin_6500_packet_is_byte_exact_with_default_encode() {
    let frame = &[[255_u8, 128, 64]];
    let default_packet = encode_led_packet(1.0, frame);
    let kelvin_packet = encode_led_packet_with_kelvin(1.0, frame, 6500);
    assert_eq!(
        default_packet, kelvin_packet,
        "6500 K must be byte-exact identity"
    );
}

#[test]
fn kelvin_warm_tint_changes_blue_channel() {
    let muls = kelvin_to_rgb_multipliers(2700);
    let out = apply_kelvin_to_pixel([255, 255, 255], &muls);
    assert!(
        out[2] < 200,
        "Blue channel should be reduced at 2700 K, got {}",
        out[2]
    );
}

// ---------------------------------------------------------------------------
// Saturation correction
// ---------------------------------------------------------------------------

#[test]
fn saturation_1_0_is_identity() {
    let pixel = [200_u8, 100, 50];
    assert_eq!(apply_saturation_to_pixel(pixel, 1.0), pixel);
}

#[test]
fn saturation_0_0_produces_greyscale() {
    let pixel = [200_u8, 100, 50];
    let out = apply_saturation_to_pixel(pixel, 0.0);
    assert_eq!(out[0], out[1], "R and G must be equal at saturation 0");
    assert_eq!(out[1], out[2], "G and B must be equal at saturation 0");
}

#[test]
fn saturation_0_0_grey_matches_bt601_luma() {
    // Y = 0.299*200 + 0.587*100 + 0.114*50 = 59.8+58.7+5.7 = 124.2 → 124
    let pixel = [200_u8, 100, 50];
    let out = apply_saturation_to_pixel(pixel, 0.0);
    assert_eq!(out[0], 124, "luma should round to 124 for [200,100,50]");
}

#[test]
fn saturation_default_packet_is_byte_exact_with_encode_led_packet() {
    let frame = &[[200_u8, 100, 50], [10, 20, 30]];
    let default_packet = encode_led_packet(0.8, frame);
    let corrections_packet = encode_lumasync_v1_packet(0.8, frame, &EncoderPlan::default());
    assert_eq!(default_packet, corrections_packet);
}

// ---------------------------------------------------------------------------
// Per-channel gamma
// ---------------------------------------------------------------------------

#[test]
fn per_channel_gamma_luts_are_independent() {
    let luts = build_gamma_luts(1.0, 2.2, 2.2);
    assert_eq!(luts.r[128], 128, "R gamma 1.0 must be linear");
    assert_eq!(luts.g[128], 56, "G gamma 2.2 must match legacy (128→56)");
    assert_eq!(luts.b[128], 56, "B gamma 2.2 must match legacy (128→56)");
    assert_ne!(
        luts.r[128], luts.g[128],
        "R and G must differ with different gammas"
    );
}

#[test]
fn build_gamma_luts_222_matches_legacy_unified_lut() {
    let luts = build_gamma_luts(2.2, 2.2, 2.2);
    // Float-pipeline expected values for `(i/255)^2.2 * 255` rounded to
    // the nearest u8. The legacy integer LUT this test mirrors used
    // slightly different precision and recorded 13/148 at the 64/200
    // breakpoints; the f32 implementation lands at 12/149 — those are
    // what the wire actually carries today, so the goldens follow it.
    let checks: &[(usize, u8)] = &[
        (0, 0),
        (1, 0),
        (10, 0),
        (64, 12),
        (128, 56),
        (200, 149),
        (254, 253),
        (255, 255),
    ];
    for &(idx, expected) in checks {
        assert_eq!(luts.r[idx], expected, "R LUT at {idx}");
        assert_eq!(luts.g[idx], expected, "G LUT at {idx}");
        assert_eq!(luts.b[idx], expected, "B LUT at {idx}");
    }
}

// ---------------------------------------------------------------------------
// apply_color_correction_rgb — Hue single-pixel helper
// ---------------------------------------------------------------------------

#[test]
fn color_correction_rgb_identity_at_defaults() {
    // Default config (gamma 2.2 / 6500 K / sat 1.0): saturation identity,
    // Kelvin identity, but gamma 2.2 maps 128 → 56 and 255 → 255.
    let cfg = ColorCorrectionConfig::default();
    let out = apply_color_correction_rgb((255, 0, 128), &cfg);
    // Compare with what the USB batch encoder produces for the same pixel.
    let batch_out = encode_led_packet(1.0, &[[255, 0, 128]]);
    // Batch packet: [0xAA 0x55 brightness(255) count_lo count_hi R G B checksum]
    // RGB bytes are at index 5..8.
    assert_eq!(
        out,
        (batch_out[5], batch_out[6], batch_out[7]),
        "apply_color_correction_rgb must match the USB batch encoder pixel output"
    );
}

#[test]
fn color_correction_rgb_kelvin_3200_produces_warm_tint() {
    // At 3200 K the blue multiplier is <0.7. After gamma 2.2 the blue
    // channel of a pure white pixel must be significantly reduced.
    let cfg = ColorCorrectionConfig {
        kelvin: 3200,
        ..ColorCorrectionConfig::default()
    };
    let (r, _g, b) = apply_color_correction_rgb((255, 255, 255), &cfg);
    assert_eq!(
        r, 255,
        "red must be full at 3200 K (below 6600 K threshold)"
    );
    assert!(
        b < 180,
        "blue must be substantially reduced at 3200 K, got {b}"
    );
}

#[test]
fn color_correction_rgb_pipeline_order_matches_usb_encoder() {
    // Non-trivial config: saturation boost + warm Kelvin + default gamma.
    // Expected golden output is computed from the USB batch encoder so both
    // sides are proven identical rather than just separately plausible.
    let cfg = ColorCorrectionConfig {
        gamma_r: 2.2,
        gamma_g: 2.2,
        gamma_b: 2.2,
        kelvin: 3200,
        saturation: 1.5,
    };
    let pixel = [200_u8, 100, 50];
    let (r_out, g_out, b_out) = apply_color_correction_rgb((pixel[0], pixel[1], pixel[2]), &cfg);

    // The USB encoder applies the same pipeline via EncoderPlan.
    let packet = encode_lumasync_v1_packet(1.0, &[pixel], &EncoderPlan::new(&cfg));
    // RGB payload starts at index 5 (after 0xAA 0x55 brightness count_lo count_hi).
    let (batch_r, batch_g, batch_b) = (packet[5], packet[6], packet[7]);

    assert_eq!(
        (r_out, g_out, b_out),
        (batch_r, batch_g, batch_b),
        "Hue single-pixel helper must be byte-identical with USB batch encoder"
    );
}

#[test]
fn color_correction_rgb_saturation_zero_produces_greyscale() {
    let cfg = ColorCorrectionConfig {
        saturation: 0.0,
        kelvin: 6500, // identity Kelvin so only saturation changes the result
        gamma_r: 1.0, // linear gamma so luma is not distorted
        gamma_g: 1.0,
        gamma_b: 1.0,
    };
    let (r, g, b) = apply_color_correction_rgb((200, 100, 50), &cfg);
    assert_eq!(r, g, "R and G must be equal at saturation 0.0");
    assert_eq!(g, b, "G and B must be equal at saturation 0.0");
}

#[test]
fn default_plan_shares_the_static_lut_and_builds_nothing() {
    let _ = EncoderPlan::default();
    let before = super::correction::GAMMA_LUT_BUILDS.with(|n| n.get());
    let a = EncoderPlan::default();
    let b = EncoderPlan::new(&ColorCorrectionConfig::default());
    assert_eq!(
        super::correction::GAMMA_LUT_BUILDS.with(|n| n.get()),
        before
    );
    assert_eq!(a.luts_ptr(), b.luts_ptr());
}
