//! Byte-exact packets from every encoder, the SK6812 white extraction, and the
//! colour order's slot permutation.

use super::correction::{apply_color_correction_rgb, ColorCorrectionConfig, EncoderPlan};
use super::encode::{
    encode_adalight_packet, encode_led_packet, encode_lumasync_v1_packet, encode_packet_for_output,
    encode_packet_for_profile, encode_sk6812_packet, extract_rgbw,
};
use super::wire::{FirmwareProfile, LedChipType, LedColorOrder, WirePixelLayout};

// ---------------------------------------------------------------------------
// LumaSync v1 regression
// ---------------------------------------------------------------------------

#[test]
fn solid_payload_encodes_to_deterministic_packet() {
    // Gamma 2.2: gamma(128) = 56, gamma(255) = 255, gamma(0) = 0.
    let packet = encode_led_packet(0.5, &[[255, 0, 128]]);
    assert_eq!(packet, vec![0xAA, 0x55, 127, 1, 0, 255, 0, 56, 70]);
}

#[test]
fn default_corrections_produce_byte_exact_output() {
    let frame = &[[255_u8, 0, 128], [64, 200, 10]];
    let default_packet = encode_led_packet(0.75, frame);
    let corrections_packet = encode_lumasync_v1_packet(0.75, frame, &EncoderPlan::default());
    assert_eq!(
        default_packet, corrections_packet,
        "default corrections must be byte-exact with encode_led_packet"
    );
}

// ---------------------------------------------------------------------------
// Adalight encoder — byte-exact header verification
// ---------------------------------------------------------------------------

#[test]
fn adalight_header_is_byte_exact() {
    // 1 LED → count-1 = 0 → hi=0, lo=0, checksum = 0^0^0x55 = 0x55
    let packet = encode_adalight_packet(1.0, &[[255, 0, 0]], &EncoderPlan::default());
    assert_eq!(
        &packet[..6],
        &[0x41, 0x64, 0x61, 0x00, 0x00, 0x55],
        "Adalight 1-LED header must be [Ada, 0x00, 0x00, 0x55]"
    );
    // Gamma 2.2: 255→255, 0→0
    assert_eq!(&packet[6..], &[255, 0, 0]);
}

#[test]
fn adalight_header_count_is_big_endian_count_minus_one() {
    // 300 LEDs → count-1 = 299 = 0x012B → hi=0x01, lo=0x2B
    // checksum = 0x01 ^ 0x2B ^ 0x55 = 0x7F
    let colors: Vec<[u8; 3]> = vec![[0u8; 3]; 300];
    let packet = encode_adalight_packet(1.0, &colors, &EncoderPlan::default());
    assert_eq!(packet[3], 0x01, "HIGH byte of count-1 for 300 LEDs");
    assert_eq!(packet[4], 0x2B, "LOW byte of count-1 for 300 LEDs");
    assert_eq!(
        packet[5],
        0x01 ^ 0x2B ^ 0x55,
        "Adalight header checksum mismatch"
    );
}

#[test]
fn adalight_has_no_brightness_byte() {
    let colors = vec![[128_u8; 3]; 10];
    let packet = encode_adalight_packet(1.0, &colors, &EncoderPlan::default());
    assert_eq!(
        packet.len(),
        6 + 10 * 3,
        "Adalight packet length must be 6 header + N*3 RGB bytes (no brightness byte)"
    );
}

#[test]
fn lumasync_v1_profile_dispatch_matches_direct_encoder() {
    let frame = &[[100_u8, 150, 200]];
    let corrections = ColorCorrectionConfig::default();
    let direct = encode_led_packet(0.8, frame);
    let dispatched = encode_packet_for_profile(
        FirmwareProfile::LumaSyncV1,
        0.8,
        frame,
        &EncoderPlan::new(&corrections),
    );
    assert_eq!(
        direct, dispatched,
        "LumaSyncV1 dispatch must match direct encoder"
    );
}

#[test]
fn adalight_profile_dispatch_matches_direct_encoder() {
    let frame = &[[100_u8, 150, 200]];
    let corrections = ColorCorrectionConfig::default();
    let direct = encode_adalight_packet(0.8, frame, &EncoderPlan::new(&corrections));
    let dispatched = encode_packet_for_profile(
        FirmwareProfile::Adalight,
        0.8,
        frame,
        &EncoderPlan::new(&corrections),
    );
    assert_eq!(
        direct, dispatched,
        "Adalight dispatch must match direct encoder"
    );
}

// ---------------------------------------------------------------------------
// SK6812 RGBW encoder
// ---------------------------------------------------------------------------

/// extract_rgbw: [200, 100, 50] → W = min(200,100,50) = 50
///   R' = 200-50 = 150, G' = 100-50 = 50, B' = 50-50 = 0, W = 50
#[test]
fn extract_rgbw_w_equals_min_of_channels() {
    let [r, g, b, w] = extract_rgbw([200, 100, 50]);
    assert_eq!(w, 50, "W = min(200,100,50) = 50");
    assert_eq!(r, 150, "R' = 200 - 50 = 150");
    assert_eq!(g, 50, "G' = 100 - 50 = 50");
    assert_eq!(b, 0, "B' = 50 - 50 = 0");
}

#[test]
fn extract_rgbw_pure_white_extracts_full_w() {
    let [r, g, b, w] = extract_rgbw([255, 255, 255]);
    assert_eq!(w, 255, "pure white: W = 255");
    assert_eq!(r, 0, "R' = 0 for pure white");
    assert_eq!(g, 0, "G' = 0 for pure white");
    assert_eq!(b, 0, "B' = 0 for pure white");
}

#[test]
fn extract_rgbw_pure_color_has_zero_w() {
    // Pure red: no white component
    let [r, g, b, w] = extract_rgbw([255, 0, 0]);
    assert_eq!(w, 0, "pure red has no white component");
    assert_eq!(r, 255, "R' = 255 for pure red");
    assert_eq!(g, 0);
    assert_eq!(b, 0);
}

/// Canonical test from the task spec:
/// Input [200, 100, 50] (R, G, B after gamma 2.2 default correction at 6500K)
/// W = min(200,100,50) = 50
/// Output byte sequence in packet: R'=150, G'=50, B'=0, W=50
///
/// With default corrections (gamma 2.2, 6500K, sat 1.0) applied first:
///   gamma(200) = 148, gamma(100) = 36, gamma(50) = 9
///   W = min(148, 36, 9) = 9
///   R' = 148-9=139, G' = 36-9=27, B' = 9-9=0
///
/// For the raw extract_rgbw call on uncorrected input [200,100,50]:
///   R'=150, G'=50, B'=0, W=50  (direct, no LUT applied)
#[test]
fn sk6812_rgbw_encoder_pixel_byte_sequence_raw_extract() {
    // Verify extract_rgbw directly on the spec values [200, 100, 50]
    let rgbw = extract_rgbw([200, 100, 50]);
    assert_eq!(
        rgbw,
        [150, 50, 0, 50],
        "extract_rgbw([200,100,50]) must produce [150, 50, 0, 50]"
    );
}

#[test]
fn sk6812_packet_has_correct_framing_and_4_bytes_per_pixel() {
    let corrections = ColorCorrectionConfig::default();
    let frame = &[[255_u8, 0, 0], [0, 255, 0], [0, 0, 255]];
    let packet = encode_sk6812_packet(1.0, frame, &EncoderPlan::new(&corrections));

    // Header: [0xAA, 0x55, brightness, count_lo, count_hi]
    assert_eq!(packet[0], 0xAA, "magic byte 0");
    assert_eq!(packet[1], 0x55, "magic byte 1");
    assert_eq!(packet[2], 255, "brightness=1.0 → 255");
    assert_eq!(packet[3], 3, "count_lo for 3 LEDs");
    assert_eq!(packet[4], 0, "count_hi for 3 LEDs");

    // Payload: 3 pixels × 4 bytes = 12 bytes + header(5) + checksum(1) = 18
    assert_eq!(
        packet.len(),
        5 + 3 * 4 + 1,
        "SK6812 packet: 5 header + 3*4 RGBW + 1 checksum"
    );
}

#[test]
fn sk6812_packet_checksum_is_xor_of_all_preceding_bytes() {
    let corrections = ColorCorrectionConfig::default();
    let frame = &[[100_u8, 50, 25]];
    let packet = encode_sk6812_packet(0.5, frame, &EncoderPlan::new(&corrections));

    let expected_checksum = packet[..packet.len() - 1]
        .iter()
        .fold(0_u8, |acc, &b| acc ^ b);
    assert_eq!(
        *packet.last().unwrap(),
        expected_checksum,
        "SK6812 packet checksum must be XOR of all preceding bytes"
    );
}

#[test]
fn sk6812_w_channel_bypasses_lut_corrections_are_on_rgb_only() {
    // With a non-trivial gamma (1.0 = linear), corrections affect RGB channels
    // but W is extracted from the corrected values, not the raw input.
    let corrections = ColorCorrectionConfig {
        gamma_r: 1.0, // linear — corrected value == input value
        gamma_g: 1.0,
        gamma_b: 1.0,
        kelvin: 6500,    // identity
        saturation: 1.0, // identity
    };
    // With linear gamma + identity Kelvin + identity sat, corrected = input
    // W = min(100, 60, 20) = 20; R'=80, G'=40, B'=0, W=20
    let packet = encode_sk6812_packet(1.0, &[[100, 60, 20]], &EncoderPlan::new(&corrections));
    // pixel bytes start at index 5
    assert_eq!(packet[5], 80, "R' = 100-20 = 80");
    assert_eq!(packet[6], 40, "G' = 60-20 = 40");
    assert_eq!(packet[7], 0, "B' = 20-20 = 0");
    assert_eq!(packet[8], 20, "W = min(100,60,20) = 20");
}

#[test]
fn led_chip_type_default_is_ws2812b_grb() {
    assert_eq!(
        LedChipType::default(),
        LedChipType::Ws2812bGrb,
        "LedChipType default must be WS2812B_GRB for backward compat"
    );
}

#[test]
fn wire_pixel_layout_follows_the_encoder_dispatch() {
    for profile in [FirmwareProfile::LumaSyncV1, FirmwareProfile::Adalight] {
        for chip in [LedChipType::Ws2812bGrb, LedChipType::Sk6812Rgbw] {
            let bpp = WirePixelLayout::for_output(profile, chip).bytes_per_pixel();
            let two = encode_packet_for_output(
                profile,
                chip,
                1.0,
                &[[1, 2, 3]; 2],
                &EncoderPlan::default(),
            );
            let one =
                encode_packet_for_output(profile, chip, 1.0, &[[1, 2, 3]], &EncoderPlan::default());
            assert_eq!(
                two.len() - one.len(),
                bpp,
                "{profile:?} + {chip:?}: budget and encoder disagree on pixel size"
            );
        }
    }
    assert_eq!(
        WirePixelLayout::for_output(FirmwareProfile::Adalight, LedChipType::Sk6812Rgbw),
        WirePixelLayout::Rgb,
    );
}

// ---------------------------------------------------------------------------
// Colour order
// ---------------------------------------------------------------------------

const ORDER_FRAME: [[u8; 3]; 3] = [[200, 100, 50], [10, 20, 30], [255, 128, 0]];

fn linear_plan() -> EncoderPlan {
    EncoderPlan::new(&ColorCorrectionConfig {
        gamma_r: 1.0,
        gamma_g: 1.0,
        gamma_b: 1.0,
        kelvin: 6500,
        saturation: 1.0,
    })
}

/// The pixel bytes of each encoder at the default order, pinned as literals
/// so the identity order cannot drift from what shipped before it existed.
#[test]
fn default_color_order_keeps_every_encoder_byte_identical() {
    let lumasync = [0xAA, 0x55, 127, 3, 0, 149, 33, 7, 0, 1, 2, 255, 56, 0, 244];
    let adalight = [0x41, 0x64, 0x61, 0, 2, 87, 75, 17, 4, 0, 1, 1, 128, 28, 0];
    let sk6812 = [
        0xAA, 0x55, 127, 3, 0, 142, 26, 0, 7, 0, 1, 2, 0, 255, 56, 0, 0, 212,
    ];
    for plan in [
        EncoderPlan::default(),
        EncoderPlan::default().with_color_order(LedColorOrder::Rgb),
    ] {
        assert_eq!(
            encode_lumasync_v1_packet(0.5, &ORDER_FRAME, &plan),
            lumasync.to_vec()
        );
        assert_eq!(
            encode_adalight_packet(0.5, &ORDER_FRAME, &plan),
            adalight.to_vec()
        );
        assert_eq!(
            encode_sk6812_packet(0.5, &ORDER_FRAME, &plan),
            sk6812.to_vec()
        );
    }
    // The literals are the shared correction pipeline, not whatever the
    // encoder happens to produce today.
    for (i, &pixel) in ORDER_FRAME.iter().enumerate() {
        let (r, g, b) = apply_color_correction_rgb(
            (pixel[0], pixel[1], pixel[2]),
            &ColorCorrectionConfig::default(),
        );
        assert_eq!(&lumasync[5 + i * 3..8 + i * 3], &[r, g, b]);
    }
}

#[test]
fn every_color_order_permutes_the_wire_slots() {
    let cases = [
        (LedColorOrder::Rgb, [1, 2, 3]),
        (LedColorOrder::Rbg, [1, 3, 2]),
        (LedColorOrder::Grb, [2, 1, 3]),
        (LedColorOrder::Gbr, [2, 3, 1]),
        (LedColorOrder::Brg, [3, 1, 2]),
        (LedColorOrder::Bgr, [3, 2, 1]),
    ];
    for (order, wire) in cases {
        let plan = linear_plan().with_color_order(order);
        let v1 = encode_lumasync_v1_packet(1.0, &[[1, 2, 3]], &plan);
        assert_eq!(&v1[5..8], &wire, "{order:?} on LumaSync v1");
        assert_eq!(
            *v1.last().unwrap(),
            v1[..v1.len() - 1].iter().fold(0, |acc, b| acc ^ b),
            "{order:?}: the checksum covers the reordered bytes"
        );
        let ada = encode_adalight_packet(1.0, &[[1, 2, 3]], &plan);
        assert_eq!(&ada[6..9], &wire, "{order:?} on Adalight");
    }
}

#[test]
fn rgbw_reorders_rgb_and_keeps_w_in_the_fourth_slot() {
    // Linear: corrected == input, so W = min(200, 100, 50) = 50 and
    // R'G'B' = 150, 50, 0 before the order is applied.
    let cases = [
        (LedColorOrder::Rgb, [150, 50, 0, 50]),
        (LedColorOrder::Grb, [50, 150, 0, 50]),
        (LedColorOrder::Bgr, [0, 50, 150, 50]),
        (LedColorOrder::Brg, [0, 150, 50, 50]),
    ];
    for (order, wire) in cases {
        let plan = linear_plan().with_color_order(order);
        let packet = encode_sk6812_packet(1.0, &[[200, 100, 50]], &plan);
        assert_eq!(&packet[5..9], &wire, "{order:?} on SK6812");
    }
}

#[test]
fn color_order_serde_and_u8_round_trip() {
    for (order, wire) in [
        (LedColorOrder::Rgb, "\"rgb\""),
        (LedColorOrder::Rbg, "\"rbg\""),
        (LedColorOrder::Grb, "\"grb\""),
        (LedColorOrder::Gbr, "\"gbr\""),
        (LedColorOrder::Brg, "\"brg\""),
        (LedColorOrder::Bgr, "\"bgr\""),
    ] {
        assert_eq!(serde_json::to_string(&order).unwrap(), wire);
        assert_eq!(serde_json::from_str::<LedColorOrder>(wire).unwrap(), order);
        assert_eq!(LedColorOrder::from_u8(order as u8), order);
    }
    assert_eq!(LedColorOrder::from_u8(6), LedColorOrder::Rgb);
    assert_eq!(LedColorOrder::from_u8(u8::MAX), LedColorOrder::Rgb);
}
