//! Golden values for the Hue colour path: a known sRGB sample through the
//! stages the ambilight worker and the DTLS sender run — the default
//! `EncoderPlan` (gamma 2.2), the per-bulb gamut clip, and the 16-bit wire —
//! to the three `u16`s of the packet. The stage table is in
//! docs/architecture/hue.md, "Where a Hue colour is gamma-encoded and where it
//! is linear".
//!
//! Reference computation, independent of this crate (the values below were
//! produced by a separate model of it):
//!
//! 1. `lin = (v / 255) ^ 2.2` per channel — the gamma stage.
//! 2. `X, Y, Z = M · lin` with Hue's wide-gamut matrix
//!    (`0.664511 0.154324 0.162028 / 0.283881 0.668433 0.047685 /
//!    0.000088 0.072310 0.986039`), `x = X/(X+Y+Z)`, `y = Y/(X+Y+Z)`.
//!    **No EOTF**: `lin` is already linear light.
//! 3. Outside the bulb's triangle, `(x, y)` moves to the nearest point on
//!    it; `Y` is kept (Bug H2) and `M⁻¹` gives the linear RGB back, each
//!    component clamped to 0–1.
//! 4. `wire = floor(lin × brightness × 65535)`, brightness 1 here.
//!
//! Worked example, mid-grey 128: `128/255 = 0.501961`, `^2.2 = 0.219520`,
//! `× 65535 = 14386.3` → `14386` on all three channels. Its chromaticity is the
//! matrix's own white `(0.3227, 0.3290)`, inside every gamut, so no bulb
//! changes it.
//!
//! Before the fix, step 2 applied the sRGB EOTF to `lin` a second time and
//! step 3 re-encoded the result into the linear slot. Grey and in-gamut
//! colours came through unchanged (the clip only replaces a colour it moved),
//! but every clipped colour gained a large share of the channels it lacked —
//! pure red on a gamut B bulb went out as `[62083, 16104, 0]`, a quarter green.

use std::collections::HashMap;

use super::frame::{
    clip_channels_to_gamut, encode_huestream_frame, linear_rgb_to_xy, HueAreaChannel, HueRgb,
    HueScreenRegion,
};
use super::sender::{HueGamutType, HueLightMetadata};
use crate::commands::led_output::EncoderPlan;

const AREA: &str = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
/// `powf` comes from the platform's libm, which may differ by an ulp; two
/// wire steps either way cover that and nothing a real regression does.
const WIRE_TOLERANCE: i32 = 2;

fn channel() -> HueAreaChannel {
    HueAreaChannel {
        channel_id: 0,
        light_ids: vec!["bulb".to_string()],
        screen_region: HueScreenRegion::Center,
        position_x: 0.0,
        position_y: 0.0,
        position_z: None,
    }
}

/// The pipeline's gamma stage, as the worker runs it.
fn linear(srgb: [u8; 3]) -> HueRgb {
    EncoderPlan::default().correct_precise(srgb.map(f32::from))
}

/// `None` is a bulb the metadata fetch did not identify: no clip.
fn wire(srgb: [u8; 3], gamut: Option<HueGamutType>) -> [u16; 3] {
    let channels = [channel()];
    let mut metadata = HashMap::new();
    if let Some(gamut_type) = gamut {
        metadata.insert(
            "bulb".to_string(),
            HueLightMetadata {
                light_id: "bulb".to_string(),
                archetype: None,
                gamut_type,
            },
        );
    }
    let mut colors = [linear(srgb)];
    clip_channels_to_gamut(&channels, &mut colors, &metadata);
    let mut frame = Vec::new();
    encode_huestream_frame(AREA, &channels, &colors, 1.0, &mut frame);
    let entry = &frame[53..59];
    [0, 2, 4].map(|i| u16::from_be_bytes([entry[i], entry[i + 1]]))
}

fn assert_wire(name: &str, srgb: [u8; 3], gamut: Option<HueGamutType>, expected: [u16; 3]) {
    let got = wire(srgb, gamut);
    let close = got
        .iter()
        .zip(expected)
        .all(|(&g, e)| (i32::from(g) - i32::from(e)).abs() <= WIRE_TOLERANCE);
    assert!(
        close,
        "{name} {srgb:?} on gamut {gamut:?}: wire {got:?}, expected {expected:?}"
    );
}

const MID_GREY: [u8; 3] = [128, 128, 128];
const RED: [u8; 3] = [255, 0, 0];
const GREEN: [u8; 3] = [0, 255, 0];
const BLUE: [u8; 3] = [0, 0, 255];
const ORANGE: [u8; 3] = [255, 128, 0];
const DARK_BLUE: [u8; 3] = [20, 30, 90];
const SKIN: [u8; 3] = [224, 172, 105];

use HueGamutType::{A, B, C};

#[test]
fn the_gamma_stage_output_is_the_reference_linear_value() {
    // Step 1 on its own, so a failure below can be placed.
    for (srgb, expected) in [
        (MID_GREY, [0.219_520; 3]),
        (ORANGE, [1.0, 0.219_520, 0.0]),
        (DARK_BLUE, [0.003_697, 0.009_021, 0.101_145]),
        (SKIN, [0.751_895, 0.420_508, 0.141_980]),
    ] {
        let got = linear(srgb);
        for (g, e) in got.iter().zip(expected) {
            assert!((g - e).abs() < 1e-5, "{srgb:?}: {got:?} vs {expected:?}");
        }
    }
}

#[test]
fn chromaticity_is_read_from_linear_light() {
    // Step 2. With the old second EOTF these read, in order,
    // (0.3227, 0.3290, Y 0.0395), (0.6816, 0.3154), (0.1490, 0.0790) and
    // (0.5750, 0.3816): mid-tones darker and every colour more saturated.
    for (srgb, (ex, ey, e_big_y)) in [
        (MID_GREY, (0.3227, 0.3290, 0.2195)),
        (ORANGE, (0.6100, 0.3761, 0.4306)),
        (DARK_BLUE, (0.1527, 0.0898, 0.0119)),
        (SKIN, (0.4666, 0.3981, 0.5013)),
    ] {
        let [r, g, b] = linear(srgb).map(f64::from);
        let (x, y, big_y) = linear_rgb_to_xy(r, g, b);
        assert!(
            (x - ex).abs() < 1e-3 && (y - ey).abs() < 1e-3 && (big_y - e_big_y).abs() < 1e-3,
            "{srgb:?}: ({x:.4}, {y:.4}, Y {big_y:.4}), expected ({ex}, {ey}, Y {e_big_y})"
        );
    }
}

#[test]
fn mid_grey_and_skin_tone_reach_the_wire_unchanged_on_every_bulb() {
    for gamut in [None, Some(A), Some(B), Some(C)] {
        assert_wire("mid-grey", MID_GREY, gamut, [14_386; 3]);
        assert_wire("skin tone", SKIN, gamut, [49_275, 27_557, 9_304]);
    }
}

#[test]
fn an_unidentified_bulb_gets_the_gamma_stage_output_as_it_is() {
    assert_wire("red", RED, None, [65_535, 0, 0]);
    assert_wire("green", GREEN, None, [0, 65_535, 0]);
    assert_wire("blue", BLUE, None, [0, 0, 65_535]);
    assert_wire("orange", ORANGE, None, [65_535, 14_386, 0]);
    assert_wire("dark blue", DARK_BLUE, None, [242, 591, 6_628]);
}

/// Fails before the fix: the clip's second EOTF and re-encode put
/// `[62083, 16104, 0]` on the wire for red on gamut B, `[52792, 57265, 14726]`
/// for green and `[19463, 0, 64391]` for blue.
#[test]
fn the_primaries_are_clipped_in_linear_light() {
    for (gamut, red, green, blue) in [
        (A, [65_535, 0, 29], [5_252, 63_304, 2], [30, 2_465, 30_798]),
        (
            B,
            [57_956, 3_223, 0],
            [40_191, 48_272, 2_708],
            [4_702, 0, 62_963],
        ),
        (
            C,
            [62_637, 1_237, 0],
            [3, 65_286, 3_462],
            [2_124, 9, 52_754],
        ),
    ] {
        assert_wire("red", RED, Some(gamut), red);
        assert_wire("green", GREEN, Some(gamut), green);
        assert_wire("blue", BLUE, Some(gamut), blue);
    }
}

/// Before the fix orange sat inside gamut C (its doubly linearised
/// chromaticity was redder) and went out unclipped, and dark blue was clipped
/// on gamut A although it is inside that triangle.
#[test]
fn orange_and_dark_blue_are_judged_against_the_triangle_by_their_real_chromaticity() {
    assert_wire("orange", ORANGE, Some(A), [65_535, 14_378, 29]);
    assert_wire("orange", ORANGE, Some(B), [65_535, 14_216, 556]);
    assert_wire("orange", ORANGE, Some(C), [65_535, 14_212, 583]);
    assert_wire("dark blue", DARK_BLUE, Some(A), [242, 591, 6_628]);
    assert_wire("dark blue", DARK_BLUE, Some(B), [946, 199, 7_929]);
    assert_wire("dark blue", DARK_BLUE, Some(C), [265, 582, 6_620]);
}
