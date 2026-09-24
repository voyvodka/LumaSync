//! The packet encoders: LumaSync v1, Adalight and SK6812 RGBW framing over
//! pixels an `EncoderPlan` has already corrected.

#[cfg(test)]
use super::correction::ColorCorrectionConfig;
use super::correction::{scale_brightness, EncoderPlan};
#[cfg(test)]
use super::serial::{LedOutputBridge, LedOutputError};
use super::wire::{FirmwareProfile, LedChipType, WirePixelLayout};
#[cfg(test)]
use crate::commands::device_connection::SerialConnectionState;

// ---------------------------------------------------------------------------
// Packet encoders
// ---------------------------------------------------------------------------

/// Encode using the default profile (LumaSync v1) and default corrections.
/// This is the backward-compat entry point — its output is byte-exact with
/// every previous version of `encode_led_packet`.
///
/// Used by test helpers only — `#[cfg(test)]` keeps it out of the production
/// binary while retaining full regression coverage in the test suite.
#[cfg(test)]
pub fn encode_led_packet(brightness: f32, rgb_triplets: &[[u8; 3]]) -> Vec<u8> {
    encode_lumasync_v1_packet(brightness, rgb_triplets, &EncoderPlan::default())
}

/// Encode a LumaSync v1 packet, applying every correction in `plan`.
///
/// Wire format: `[0xAA 0x55] [brightness_u8] [led_count_u16_le] [R G B ...] [xor_checksum]`
pub fn encode_lumasync_v1_packet(
    brightness: f32,
    rgb_triplets: &[[u8; 3]],
    plan: &EncoderPlan,
) -> Vec<u8> {
    let clamped_brightness = (brightness.clamp(0.0, 1.0) * 255.0).floor() as u8;
    let led_count = u16::try_from(rgb_triplets.len()).unwrap_or(u16::MAX);

    let mut packet = Vec::with_capacity(2 + 1 + 2 + (rgb_triplets.len() * 3) + 1);
    packet.push(0xAA);
    packet.push(0x55);
    packet.push(clamped_brightness);
    packet.extend_from_slice(&led_count.to_le_bytes());

    for &pixel in rgb_triplets {
        packet.extend_from_slice(&plan.wire_rgb(pixel));
    }

    let checksum = packet.iter().fold(0_u8, |acc, byte| acc ^ byte);
    packet.push(checksum);
    packet
}

/// Backward-compat wrapper: Kelvin only, saturation defaults to 1.0.
/// Used by tests only — kept test-gated to avoid a dead_code warning in
/// non-test builds while retaining the regression coverage.
#[cfg(test)]
pub fn encode_led_packet_with_kelvin(
    brightness: f32,
    rgb_triplets: &[[u8; 3]],
    kelvin: u16,
) -> Vec<u8> {
    let plan = EncoderPlan::new(&ColorCorrectionConfig {
        kelvin,
        ..ColorCorrectionConfig::default()
    });
    encode_lumasync_v1_packet(brightness, rgb_triplets, &plan)
}

/// Encode an Adalight-compatible packet.
///
/// Wire format (no brightness byte):
/// `[0x41 0x64 0x61] [HIGH(count-1)] [LOW(count-1)] [HIGH^LOW^0x55] [R G B ...]`
///
/// Colour corrections (saturation, Kelvin, gamma) are applied before packing
/// in the same order as the LumaSync v1 encoder. Brightness is scaled into the
/// corrected pixels: Adalight firmware has no brightness input from the host,
/// so without this the brightness slider did nothing under this profile. The
/// scaling matches `CorrectedWledSink`, and 1.0 leaves every byte unchanged.
pub fn encode_adalight_packet(
    brightness: f32,
    rgb_triplets: &[[u8; 3]],
    plan: &EncoderPlan,
) -> Vec<u8> {
    let brightness = brightness.clamp(0.0, 1.0);
    let count = rgb_triplets.len();
    let count_minus_one = u16::try_from(count.saturating_sub(1)).unwrap_or(u16::MAX);
    let hi = (count_minus_one >> 8) as u8;
    let lo = (count_minus_one & 0xFF) as u8;
    let header_checksum = hi ^ lo ^ 0x55;

    let mut packet = Vec::with_capacity(6 + count * 3);
    // "Ada" magic
    packet.push(0x41);
    packet.push(0x64);
    packet.push(0x61);
    packet.push(hi);
    packet.push(lo);
    packet.push(header_checksum);

    for &pixel in rgb_triplets {
        packet.extend_from_slice(&scale_brightness(plan.wire_rgb(pixel), brightness));
    }

    packet
}

/// Dispatch encoder based on `FirmwareProfile`.
///
/// For `LumaSyncV1` the brightness value is encoded in the packet header and
/// applied by LumaSync firmware. Adalight has no brightness byte, so the host
/// scales the pixels instead.
pub fn encode_packet_for_profile(
    profile: FirmwareProfile,
    brightness: f32,
    rgb_triplets: &[[u8; 3]],
    plan: &EncoderPlan,
) -> Vec<u8> {
    match profile {
        FirmwareProfile::LumaSyncV1 => encode_lumasync_v1_packet(brightness, rgb_triplets, plan),
        FirmwareProfile::Adalight => encode_adalight_packet(brightness, rgb_triplets, plan),
    }
}

/// Dispatch on both wire axes — framing (`FirmwareProfile`) and pixel layout
/// (`LedChipType`, resolved through `WirePixelLayout`). Every serial write goes
/// through here so Solid and the ambilight worker can never disagree on the
/// bytes for the same strip.
pub fn encode_packet_for_output(
    profile: FirmwareProfile,
    chip_type: LedChipType,
    brightness: f32,
    rgb_triplets: &[[u8; 3]],
    plan: &EncoderPlan,
) -> Vec<u8> {
    match WirePixelLayout::for_output(profile, chip_type) {
        WirePixelLayout::Rgbw => encode_sk6812_packet(brightness, rgb_triplets, plan),
        WirePixelLayout::Rgb => encode_packet_for_profile(profile, brightness, rgb_triplets, plan),
    }
}

// ---------------------------------------------------------------------------
// SK6812 RGBW encoder
//
// White channel extraction algorithm: W = min(R, G, B) after colour
// corrections. Remaining channels: R' = R - W, G' = G - W, B' = B - W.
//
// The W channel bypasses the gamma/Kelvin/saturation LUTs because the
// SK6812 white LED has its own native colour temperature and the firmware
// should control it directly. Applying host-side correction to W would
// double-correct the warm/cool balance already baked into the emitter.
// ---------------------------------------------------------------------------

/// Extract the RGBW pixel bytes from a corrected RGB triple.
///
/// Algorithm: `W = min(R, G, B)`, then subtract W from each channel.
/// Returns `[R', G', B', W]` for direct wire emission.
///
/// The caller is responsible for applying colour corrections (saturation,
/// Kelvin, gamma LUT) to the input before calling this function. The W
/// channel is intentionally left uncorrected.
#[inline(always)]
pub fn extract_rgbw(corrected_rgb: [u8; 3]) -> [u8; 4] {
    let [r, g, b] = corrected_rgb;
    let w = r.min(g).min(b);
    [r - w, g - w, b - w, w]
}

/// Encode a LumaSync v1 packet for SK6812 RGBW strips.
///
/// The framing header is identical to the WS2812B path
/// (`[0xAA 0x55] [brightness] [led_count_u16_le] ... [xor_checksum]`),
/// but each pixel occupies 4 bytes instead of 3. The `led_count` field
/// records the number of LED *pixels* (not bytes), consistent with the
/// WS2812B encoder.
///
/// Colour corrections are applied to the R/G/B channels before W extraction.
/// The W channel bypasses corrections (see module doc above).
pub fn encode_sk6812_packet(
    brightness: f32,
    rgb_triplets: &[[u8; 3]],
    plan: &EncoderPlan,
) -> Vec<u8> {
    let clamped_brightness = (brightness.clamp(0.0, 1.0) * 255.0).floor() as u8;
    let led_count = u16::try_from(rgb_triplets.len()).unwrap_or(u16::MAX);

    // 4 bytes per pixel for RGBW
    let mut packet = Vec::with_capacity(2 + 1 + 2 + (rgb_triplets.len() * 4) + 1);
    packet.push(0xAA);
    packet.push(0x55);
    packet.push(clamped_brightness);
    packet.extend_from_slice(&led_count.to_le_bytes());

    for &pixel in rgb_triplets {
        // W is extracted after correction, so it never passes through the LUT.
        // min() ignores channel order, so reordering first permutes R'G'B'
        // exactly and W stays in the fourth slot.
        packet.extend_from_slice(&extract_rgbw(plan.wire_rgb(pixel)));
    }

    let checksum = packet.iter().fold(0_u8, |acc, byte| acc ^ byte);
    packet.push(checksum);
    packet
}

// ---------------------------------------------------------------------------
// Test-only helpers used by lighting_mode.rs and led_output tests
// ---------------------------------------------------------------------------

/// Test helper: encode a single solid RGB colour and write it through the
/// bridge, mirroring the Solid mode command's output path.
#[cfg(test)]
pub fn apply_solid_payload(
    bridge: &LedOutputBridge,
    connection_state: &SerialConnectionState,
    r: u8,
    g: u8,
    b: u8,
    brightness: f32,
) -> Result<(), LedOutputError> {
    let packet = encode_led_packet(brightness, &[[r, g, b]]);
    bridge.send_packet(connection_state, &packet)
}

/// Test helper: encode a full ambilight frame and write it through the
/// bridge, mirroring the Ambilight mode command's output path.
#[cfg(test)]
pub fn send_ambilight_frame(
    bridge: &LedOutputBridge,
    connection_state: &SerialConnectionState,
    frame: &[[u8; 3]],
    brightness: f32,
) -> Result<(), LedOutputError> {
    let packet = encode_led_packet(brightness, frame);
    bridge.send_packet(connection_state, &packet)
}
