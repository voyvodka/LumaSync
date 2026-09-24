//! `SerialSink` over a recording sender: what it writes for each profile and
//! chip, that its plan is built once, and the colour order it patches live.

use std::sync::Arc;

use super::correction::{ColorCorrectionConfig, EncoderPlan};
use super::encode::{encode_led_packet, encode_sk6812_packet};
use super::serial::LedOutputBridge;
use super::sink::SerialSink;
use super::test_support::FakeSender;
use super::wire::{FirmwareProfile, LedChipType, LedColorOrder};
use crate::commands::led_sink::LedSink;

// ---------------------------------------------------------------------------
// SerialSink tests
// ---------------------------------------------------------------------------

#[test]
fn serial_sink_send_frame_writes_encoded_packet() {
    let sender = Arc::new(FakeSender::successful());
    let bridge = LedOutputBridge::from_sender(sender.clone());
    let mut sink = SerialSink::new(bridge, Some("COM3".to_string()), 1.0);

    sink.start().expect("start should succeed");
    let frame = [[255_u8, 0, 0], [0, 255, 0]];
    sink.send_frame(&frame).expect("send_frame should succeed");

    let writes = sender.writes();
    assert_eq!(writes.len(), 1);
    assert_eq!(writes[0].0, "COM3");
    assert_eq!(writes[0].1, encode_led_packet(1.0, &frame));
}

#[test]
fn serial_sink_no_port_send_is_noop() {
    let sender = Arc::new(FakeSender::successful());
    let bridge = LedOutputBridge::from_sender(sender.clone());
    let mut sink = SerialSink::new(bridge, None, 1.0);

    sink.start().unwrap();
    sink.send_frame(&[[1, 2, 3]])
        .expect("no-port send is a no-op");
    assert_eq!(sender.writes().len(), 0);
}

#[test]
fn serial_sink_stop_preserves_cached_session_to_avoid_dtr_reset() {
    // v1.5 hardware repro #47 — closing the serial handle on every
    // worker shutdown forces the next packet to reopen the port,
    // which on CH340 / Arduino Nano toggles DTR and resets the MCU.
    // The bootloader then eats the next ~1 s of incoming bytes,
    // so the strip ends up frozen at the post-reset zeroed buffer.
    // The fix: SerialSink::stop must NOT call `disconnect_session`.
    // Explicit disconnect remains available on the bridge for
    // user-driven "disconnect device" actions and for the per-write
    // failure path inside `SerialLedPacketSender::send`.
    let sender = Arc::new(FakeSender::successful());
    let bridge = LedOutputBridge::from_sender(sender.clone());
    let mut sink = SerialSink::new(bridge, Some("COM8".to_string()), 0.8);

    sink.start().unwrap();
    sink.send_frame(&[[10, 20, 30]]).unwrap();
    sink.stop().expect("stop should succeed");

    assert!(
        !sender.disconnected_ports().contains(&"COM8".to_string()),
        "SerialSink::stop must not drop the cached port handle (DTR-pulse safety)"
    );
    assert_eq!(
        sender.writes().len(),
        1,
        "stop must not emit any extra writes (no off-frame side effects)"
    );
}

#[test]
fn led_output_bridge_disconnect_session_still_drops_handle_when_called_explicitly() {
    // The disconnect API is preserved as a deliberate caller-driven
    // primitive for future "disconnect device" UI hooks. Removing it
    // from SerialSink::stop does NOT remove it from the bridge —
    // explicit callers must keep working unchanged.
    let sender = Arc::new(FakeSender::successful());
    let bridge = LedOutputBridge::from_sender(sender.clone());

    bridge.disconnect_session("COM-EXPLICIT");

    assert!(
        sender
            .disconnected_ports()
            .contains(&"COM-EXPLICIT".to_string()),
        "explicit bridge.disconnect_session must still drop the handle"
    );
}

#[test]
fn serial_sink_implements_led_sink_trait_object() {
    let sender = Arc::new(FakeSender::successful());
    let bridge = LedOutputBridge::from_sender(sender.clone());
    let mut sink: Box<dyn LedSink> =
        Box::new(SerialSink::new(bridge, Some("COM1".to_string()), 1.0));

    sink.start().unwrap();
    sink.send_frame(&[[50, 100, 150]]).unwrap();
    sink.stop().unwrap();
    assert_eq!(sender.writes().len(), 1);
}

#[test]
fn serial_sink_adalight_profile_encodes_correct_header() {
    let sender = Arc::new(FakeSender::successful());
    let bridge = LedOutputBridge::from_sender(sender.clone());
    let mut sink = SerialSink::with_chip_type(
        bridge,
        Some("COM5".to_string()),
        1.0,
        FirmwareProfile::Adalight,
        ColorCorrectionConfig::default(),
        LedChipType::default(),
    );

    sink.start().unwrap();
    sink.send_frame(&[[255, 0, 0]])
        .expect("Adalight send should succeed");

    let writes = sender.writes();
    assert_eq!(writes.len(), 1);
    let pkt = &writes[0].1;
    // Adalight header: "Ada" + 0x00 + 0x00 + 0x55 for 1 LED
    assert_eq!(&pkt[..6], &[0x41, 0x64, 0x61, 0x00, 0x00, 0x55]);
}

#[test]
fn serial_sink_sk6812_chip_type_uses_rgbw_encoder() {
    let sender = Arc::new(FakeSender::successful());
    let bridge = LedOutputBridge::from_sender(sender.clone());
    let mut sink = SerialSink::with_chip_type(
        bridge,
        Some("COM4".to_string()),
        1.0,
        FirmwareProfile::LumaSyncV1,
        ColorCorrectionConfig::default(),
        LedChipType::Sk6812Rgbw,
    );

    sink.start().unwrap();
    let frame = [[200_u8, 100, 50]];
    sink.send_frame(&frame).expect("SK6812 send should succeed");

    let writes = sender.writes();
    assert_eq!(writes.len(), 1);

    let expected = encode_sk6812_packet(1.0, &frame, &EncoderPlan::default());
    assert_eq!(
        writes[0].1, expected,
        "SerialSink with SK6812 must use RGBW encoder"
    );
}

#[test]
fn serial_sink_ws2812b_chip_type_default_is_backward_compat() {
    let sender = Arc::new(FakeSender::successful());
    let bridge = LedOutputBridge::from_sender(sender.clone());
    let mut sink = SerialSink::with_chip_type(
        bridge,
        Some("COM6".to_string()),
        1.0,
        FirmwareProfile::LumaSyncV1,
        ColorCorrectionConfig::default(),
        LedChipType::default(),
    );

    sink.start().unwrap();
    let frame = [[100_u8, 150, 200]];
    sink.send_frame(&frame).unwrap();

    let writes = sender.writes();
    let expected = encode_led_packet(1.0, &frame);
    assert_eq!(
        writes[0].1, expected,
        "default chip type must produce byte-exact WS2812B output"
    );
}

// ---------------------------------------------------------------------------
// EncoderPlan — one plan feeds every serial encoder
// ---------------------------------------------------------------------------

const GOLDEN_FRAME: [[u8; 3]; 4] = [[200, 100, 50], [128, 64, 32], [255, 255, 255], [0, 7, 250]];

fn custom_corrections() -> ColorCorrectionConfig {
    ColorCorrectionConfig {
        gamma_r: 1.8,
        gamma_g: 2.0,
        gamma_b: 2.6,
        kelvin: 4000,
        saturation: 1.3,
    }
}

const ENCODERS: [(FirmwareProfile, LedChipType); 3] = [
    (FirmwareProfile::LumaSyncV1, LedChipType::Ws2812bGrb),
    (FirmwareProfile::Adalight, LedChipType::Ws2812bGrb),
    (FirmwareProfile::LumaSyncV1, LedChipType::Sk6812Rgbw),
];

// Brightness 0.8 on v1 frames exercises the header byte. Adalight is written
// at 1.0: it ignored brightness before, so only its full-brightness bytes
// are comparable with the captured ones.
fn golden_brightness(profile: FirmwareProfile) -> f32 {
    match profile {
        FirmwareProfile::LumaSyncV1 => 0.8,
        FirmwareProfile::Adalight => 1.0,
    }
}

fn sink_writes(
    profile: FirmwareProfile,
    chip: LedChipType,
    corrections: ColorCorrectionConfig,
    frame: &[[u8; 3]],
) -> Vec<u8> {
    sink_writes_at(
        golden_brightness(profile),
        profile,
        chip,
        corrections,
        frame,
    )
}

fn sink_writes_at(
    brightness: f32,
    profile: FirmwareProfile,
    chip: LedChipType,
    corrections: ColorCorrectionConfig,
    frame: &[[u8; 3]],
) -> Vec<u8> {
    let sender = Arc::new(FakeSender::successful());
    let bridge = LedOutputBridge::from_sender(sender.clone());
    let mut sink = SerialSink::with_chip_type(
        bridge,
        Some("COM9".into()),
        brightness,
        profile,
        corrections,
        chip,
    );
    sink.send_frame(frame).expect("send should succeed");
    sender.writes().remove(0).1
}

/// Bytes captured from the pre-plan encoders; the plan must not move one.
#[test]
fn default_corrections_are_byte_identical_to_the_pre_plan_encoders() {
    let expected: [&[u8]; 3] = [
        &[
            170, 85, 204, 4, 0, 149, 33, 7, 56, 12, 3, 255, 255, 255, 0, 0, 244, 184,
        ],
        &[
            65, 100, 97, 0, 3, 86, 149, 33, 7, 56, 12, 3, 255, 255, 255, 0, 0, 244,
        ],
        &[
            170, 85, 204, 4, 0, 142, 26, 0, 7, 53, 9, 0, 3, 0, 0, 0, 255, 0, 0, 244, 0, 144,
        ],
    ];
    for ((profile, chip), bytes) in ENCODERS.into_iter().zip(expected) {
        let written = sink_writes(
            profile,
            chip,
            ColorCorrectionConfig::default(),
            &GOLDEN_FRAME,
        );
        assert_eq!(written, bytes, "{profile:?} + {chip:?} drifted at defaults");
    }
}

/// Adalight and SK6812 already honoured gamma; only their LUT build moved.
#[test]
fn custom_corrections_on_adalight_and_sk6812_are_byte_identical_to_before() {
    let adalight = sink_writes(
        FirmwareProfile::Adalight,
        LedChipType::Ws2812bGrb,
        custom_corrections(),
        &GOLDEN_FRAME,
    );
    assert_eq!(
        adalight,
        [65, 100, 97, 0, 3, 86, 200, 22, 0, 90, 9, 0, 255, 166, 84, 0, 0, 84]
    );
    let rgbw = sink_writes(
        FirmwareProfile::LumaSyncV1,
        LedChipType::Sk6812Rgbw,
        custom_corrections(),
        &GOLDEN_FRAME,
    );
    assert_eq!(
        rgbw,
        [170, 85, 204, 4, 0, 200, 22, 0, 0, 90, 9, 0, 0, 171, 82, 0, 84, 0, 0, 84, 0, 67]
    );
}

/// The default setup used to hardcode gamma 2.2, so the sliders did nothing
/// on it. Its pixels must now match the Adalight pixels for the same config.
#[test]
fn v1_ws2812b_serial_sink_applies_the_user_gamma() {
    let v1 = sink_writes(
        FirmwareProfile::LumaSyncV1,
        LedChipType::Ws2812bGrb,
        custom_corrections(),
        &GOLDEN_FRAME,
    );
    let adalight = sink_writes(
        FirmwareProfile::Adalight,
        LedChipType::Ws2812bGrb,
        custom_corrections(),
        &GOLDEN_FRAME,
    );
    assert_eq!(&v1[..5], &[0xAA, 0x55, 204, 4, 0]);
    assert_eq!(&v1[5..v1.len() - 1], &adalight[6..]);

    let linear = ColorCorrectionConfig {
        gamma_r: 1.0,
        gamma_g: 1.0,
        gamma_b: 1.0,
        ..ColorCorrectionConfig::default()
    };
    let mid_grey = [[128_u8, 128, 128]];
    let at_linear = sink_writes(
        FirmwareProfile::LumaSyncV1,
        LedChipType::Ws2812bGrb,
        linear,
        &mid_grey,
    );
    let at_default = sink_writes(
        FirmwareProfile::LumaSyncV1,
        LedChipType::Ws2812bGrb,
        ColorCorrectionConfig::default(),
        &mid_grey,
    );
    assert_eq!(&at_linear[5..8], &[128, 128, 128], "gamma 1.0 is linear");
    assert_eq!(&at_default[5..8], &[56, 56, 56], "gamma 2.2 maps 128 to 56");
}

#[test]
fn serial_sink_builds_its_gamma_lut_once_not_per_frame() {
    for (profile, chip) in ENCODERS {
        let sender = Arc::new(FakeSender::successful());
        let bridge = LedOutputBridge::from_sender(sender.clone());
        let before = super::correction::GAMMA_LUT_BUILDS.with(|n| n.get());
        let mut sink = SerialSink::with_chip_type(
            bridge,
            Some("COM9".into()),
            1.0,
            profile,
            custom_corrections(),
            chip,
        );
        let lut = sink.plan_luts_ptr();
        for _ in 0..10 {
            sink.send_frame(&GOLDEN_FRAME).unwrap();
        }
        let builds = super::correction::GAMMA_LUT_BUILDS.with(|n| n.get()) - before;
        assert_eq!(
            builds, 1,
            "{profile:?} + {chip:?} rebuilt its LUT per frame"
        );
        assert_eq!(sink.plan_luts_ptr(), lut);
        assert_eq!(sender.writes().len(), 10);
    }
}

/// Adalight firmware has no brightness input, so the slider did nothing
/// under that profile until the host scaled the pixels itself.
#[test]
fn adalight_scales_brightness_into_the_corrected_pixels() {
    let frame = [[255_u8, 128, 0]];
    let full = sink_writes_at(
        1.0,
        FirmwareProfile::Adalight,
        LedChipType::Ws2812bGrb,
        ColorCorrectionConfig::default(),
        &frame,
    );
    let half = sink_writes_at(
        0.5,
        FirmwareProfile::Adalight,
        LedChipType::Ws2812bGrb,
        ColorCorrectionConfig::default(),
        &frame,
    );
    let off = sink_writes_at(
        0.0,
        FirmwareProfile::Adalight,
        LedChipType::Ws2812bGrb,
        ColorCorrectionConfig::default(),
        &frame,
    );
    // Gamma 2.2 first (128 → 56), then brightness: 255 * 0.5 → 128, 56 * 0.5 → 28.
    assert_eq!(&full[6..], &[255, 56, 0]);
    assert_eq!(&half[6..], &[128, 28, 0]);
    assert_eq!(&off[6..], &[0, 0, 0]);
    assert_eq!(&half[..6], &full[..6], "the header carries no brightness");
}

/// A live order change must not rebuild the LUTs — a non-default gamma
/// costs 768 `powf`s, and the worker applies the order every frame.
#[test]
fn serial_sink_set_color_order_patches_only_the_order() {
    let sender = Arc::new(FakeSender::successful());
    let mut sink = SerialSink::with_chip_type(
        LedOutputBridge::from_sender(sender.clone()),
        Some("COM-ORDER".to_string()),
        1.0,
        FirmwareProfile::LumaSyncV1,
        ColorCorrectionConfig {
            gamma_r: 1.0,
            gamma_g: 1.0,
            gamma_b: 1.0,
            ..ColorCorrectionConfig::default()
        },
        LedChipType::Ws2812bGrb,
    );
    let luts = sink.plan_luts_ptr();
    sink.send_frame(&[[1, 2, 3]]).expect("send");
    sink.set_color_order(LedColorOrder::Bgr);
    assert_eq!(
        sink.plan_luts_ptr(),
        luts,
        "the LUTs are reused, not rebuilt"
    );
    sink.send_frame(&[[1, 2, 3]]).expect("send");

    let writes = sender.writes();
    assert_eq!(&writes[0].1[5..8], &[1, 2, 3]);
    assert_eq!(&writes[1].1[5..8], &[3, 2, 1]);
}
