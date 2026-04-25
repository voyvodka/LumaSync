use std::collections::HashMap;
use std::io::Write;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};

#[cfg(test)]
use super::device_connection::SerialConnectionState;

const OUTPUT_BAUD_RATE: u32 = 115_200;
const OUTPUT_TIMEOUT_MS: u64 = 500;

// ---------------------------------------------------------------------------
// FirmwareProfile — user-selectable serial encoding profile
//
// IMPORTANT: changing the on-wire format is a breaking change for any
// user-flashed firmware. New profiles are additive only. The active profile
// is stored in `shell.ts` `firmwareProfile` and must be surfaced as a
// user-visible "Firmware profile" setting — never switched silently.
// ---------------------------------------------------------------------------

/// Serial encoding profile — selects the on-wire frame format sent to the
/// LED controller firmware.
///
/// `LumaSyncV1` is the default. `Adalight` enables compatibility with
/// Prismatik, Hyperion, Boblight, and most DIY Arduino Adalight sketches.
/// (v1.4 G11)
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum FirmwareProfile {
    /// LumaSync v1 native protocol:
    /// `[0xAA 0x55] [brightness_u8] [led_count_u16_le] [R G B ...] [xor_checksum]`
    #[default]
    #[serde(rename = "lumasync-v1")]
    LumaSyncV1,
    /// Adalight-compatible protocol (no brightness byte, big-endian count-1):
    /// `[0x41 0x64 0x61] [HIGH(count-1)] [LOW(count-1)] [HIGH^LOW^0x55] [R G B ...]`
    Adalight,
}

// ---------------------------------------------------------------------------
// LedChipType — host-side chip encoding variant (v1.5 G3)
//
// Orthogonal axis to FirmwareProfile: FirmwareProfile selects the wire
// framing family (LumaSync v1 vs Adalight); LedChipType selects the
// per-pixel byte layout within the payload.
//
// WS2812B_GRB is the default and produces 3-byte RGB pixels (the existing
// path). SK6812_RGBW produces 4-byte RGBW pixels using W = min(R,G,B)
// extraction; colour corrections (saturation, Kelvin, gamma) are applied to
// R/G/B before extraction — the W channel bypasses the LUT so that the
// firmware-side native white temperature is preserved.
//
// APA102 is deferred to v2.0 (D8(b) companion firmware repo decision
// pending). Do not add it here until that milestone lands.
// ---------------------------------------------------------------------------

/// LED chip type — controls the per-pixel byte layout in the encoded payload.
///
/// Stored under `ShellState.selectedChipType` (optional, default
/// `WS2812B_GRB`). Changing this at runtime does NOT change the on-wire
/// framing header; it only affects the pixel bytes. (v1.5 G3)
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum LedChipType {
    /// WS2812B in GRB order (3 bytes per pixel: R, G, B after correction).
    /// Default — backward-compatible with all v1.x firmware.
    #[default]
    #[serde(rename = "ws2812b-grb")]
    Ws2812bGrb,
    /// SK6812 in RGBW order (4 bytes per pixel: R', G', B', W).
    ///
    /// White channel extraction: `W = min(R, G, B)` after colour corrections.
    /// Then `R' = R - W`, `G' = G - W`, `B' = B - W`.
    /// The W channel bypasses the gamma/Kelvin/saturation LUTs; firmware
    /// applies its own native white temperature on the W channel.
    #[serde(rename = "sk6812-rgbw")]
    Sk6812Rgbw,
}

// ---------------------------------------------------------------------------
// ColorCorrectionConfig — per-channel colour correction parameters
// ---------------------------------------------------------------------------

/// Per-channel colour correction parameters applied in the LED encoder hot path.
///
/// Defaults (gamma 2.2, 6500 K, saturation 1.0) reproduce the original
/// `encode_led_packet` output byte-for-byte. (v1.4 G4)
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ColorCorrectionConfig {
    /// Gamma exponent for the red channel (typical range 1.0–3.0).
    pub gamma_r: f32,
    /// Gamma exponent for the green channel (typical range 1.0–3.0).
    pub gamma_g: f32,
    /// Gamma exponent for the blue channel (typical range 1.0–3.0).
    pub gamma_b: f32,
    /// White-point colour temperature in Kelvin (typical range 2700–9000).
    /// 6500 K is the sRGB/D65 standard and produces an identity multiplier.
    pub kelvin: u16,
    /// Saturation multiplier (0.0 = greyscale, 1.0 = original, >1.0 = boost).
    pub saturation: f32,
}

impl Default for ColorCorrectionConfig {
    fn default() -> Self {
        Self {
            gamma_r: 2.2,
            gamma_g: 2.2,
            gamma_b: 2.2,
            kelvin: 6500,
            saturation: 1.0,
        }
    }
}

// ---------------------------------------------------------------------------
// Per-channel gamma lookup tables
// ---------------------------------------------------------------------------

/// Per-channel gamma lookup tables for WS2812B LEDs.
///
/// Splits the previously unified `GAMMA_LUT` into three independent tables so
/// that each channel can be corrected with a different exponent. The default
/// tables use gamma 2.2 for all three channels, preserving the existing wire
/// behaviour until the user selects different values.
pub struct GammaLuts {
    pub r: [u8; 256],
    pub g: [u8; 256],
    pub b: [u8; 256],
}

/// Build three independent gamma LUTs from the supplied per-channel exponents.
/// Each entry: `round((i / 255)^gamma * 255)`.
pub fn build_gamma_luts(gamma_r: f32, gamma_g: f32, gamma_b: f32) -> GammaLuts {
    let mut r = [0u8; 256];
    let mut g = [0u8; 256];
    let mut b = [0u8; 256];
    for i in 0..=255usize {
        let v = i as f32 / 255.0_f32;
        r[i] = (v.powf(gamma_r) * 255.0_f32).round() as u8;
        g[i] = (v.powf(gamma_g) * 255.0_f32).round() as u8;
        b[i] = (v.powf(gamma_b) * 255.0_f32).round() as u8;
    }
    GammaLuts { r, g, b }
}

/// Default gamma 2.2 / 2.2 / 2.2 tables — identical to the old unified
/// `GAMMA_LUT`, kept as a static to avoid re-computing on every frame.
static DEFAULT_GAMMA_LUTS: std::sync::LazyLock<GammaLuts> =
    std::sync::LazyLock::new(|| build_gamma_luts(2.2, 2.2, 2.2));

// ---------------------------------------------------------------------------
// Kelvin white-balance
// ---------------------------------------------------------------------------

/// Convert a colour temperature in Kelvin to per-channel RGB multipliers.
///
/// Uses the Tanner Helland curve-fit approximation, clamped to [0.0, 1.0] and
/// normalized so the maximum multiplier of each channel is 1.0.
///
/// 6500 K returns `[1.0, 1.0, 1.0]` (identity fast-path) so the default
/// configuration adds zero cost to the hot path.
///
/// The returned array is `[r_mul, g_mul, b_mul]`.
// The Tanner Helland constants deliberately exceed f32 representable precision;
// the extra digits document the original source values and do not affect the
// compiled output.
#[allow(clippy::excessive_precision)]
pub fn kelvin_to_rgb_multipliers(kelvin: u16) -> [f32; 3] {
    if kelvin == 6500 {
        return [1.0_f32, 1.0_f32, 1.0_f32];
    }

    let temp = kelvin as f32 / 100.0_f32;

    let r = if temp <= 66.0 {
        1.0_f32
    } else {
        let v = 329.698_727_446_f32 * (temp - 60.0_f32).powf(-0.133_204_759_2_f32);
        (v / 255.0_f32).clamp(0.0_f32, 1.0_f32)
    };

    let g = if temp <= 66.0 {
        let v = 99.470_802_586_f32 * temp.ln() - 161.119_568_166_f32;
        (v / 255.0_f32).clamp(0.0_f32, 1.0_f32)
    } else {
        let v = 288.122_169_528_f32 * (temp - 60.0_f32).powf(-0.075_514_849_2_f32);
        (v / 255.0_f32).clamp(0.0_f32, 1.0_f32)
    };

    let b = if temp >= 66.0 {
        1.0_f32
    } else if temp <= 19.0 {
        0.0_f32
    } else {
        let v = 138.517_731_223_f32 * (temp - 10.0_f32).ln() - 305.044_792_730_f32;
        (v / 255.0_f32).clamp(0.0_f32, 1.0_f32)
    };

    [r, g, b]
}

/// Apply Kelvin white-balance multipliers to a single pixel.
#[inline(always)]
pub fn apply_kelvin_to_pixel(rgb: [u8; 3], multipliers: &[f32; 3]) -> [u8; 3] {
    [
        (rgb[0] as f32 * multipliers[0]).round().clamp(0.0, 255.0) as u8,
        (rgb[1] as f32 * multipliers[1]).round().clamp(0.0, 255.0) as u8,
        (rgb[2] as f32 * multipliers[2]).round().clamp(0.0, 255.0) as u8,
    ]
}

// ---------------------------------------------------------------------------
// Saturation correction
// ---------------------------------------------------------------------------

/// Apply saturation correction to a single pixel using BT.601 luminance blend.
///
/// `saturation = 1.0` is the identity (epsilon fast-path, no arithmetic).
/// `saturation = 0.0` produces a pure greyscale output.
/// Values above 1.0 boost saturation beyond the original.
#[inline(always)]
pub fn apply_saturation_to_pixel(rgb: [u8; 3], saturation: f32) -> [u8; 3] {
    if (saturation - 1.0_f32).abs() < f32::EPSILON {
        return rgb;
    }

    let r = rgb[0] as f32;
    let g = rgb[1] as f32;
    let b = rgb[2] as f32;

    let luma = 0.299_f32 * r + 0.587_f32 * g + 0.114_f32 * b;

    let out_r = (luma + saturation * (r - luma)).round().clamp(0.0, 255.0) as u8;
    let out_g = (luma + saturation * (g - luma)).round().clamp(0.0, 255.0) as u8;
    let out_b = (luma + saturation * (b - luma)).round().clamp(0.0, 255.0) as u8;

    [out_r, out_g, out_b]
}

// ---------------------------------------------------------------------------
// Unified single-pixel colour correction — Hue pipeline helper
// ---------------------------------------------------------------------------

/// Apply the full colour-correction pipeline to a single pixel.
///
/// Pipeline order: saturation → Kelvin → gamma LUT.
///
/// This mirrors the order used inside `encode_led_packet_with_corrections`
/// (the USB batch encoder) so that Hue single-pixel output and USB batch
/// output produce identical colour rendering when given the same
/// `ColorCorrectionConfig`. Any change to the USB encoder order **must**
/// be reflected here to preserve LED-strip vs Hue bulb parity.
///
/// The function is intentionally allocation-free: it builds the gamma LUTs
/// on each call. For the Hue path (called once per channel per frame, not
/// per-LED on a 300-LED strip) this is negligible; pre-computed LUTs can be
/// threaded through as a follow-up optimisation if profiling shows cost.
pub fn apply_color_correction_rgb(
    rgb: (u8, u8, u8),
    corrections: &ColorCorrectionConfig,
) -> (u8, u8, u8) {
    // Step 1 — Saturation (BT.601 luminance blend).
    let [r, g, b] = apply_saturation_to_pixel([rgb.0, rgb.1, rgb.2], corrections.saturation);

    // Step 2 — Kelvin white-balance multipliers.
    let kelvin_muls = kelvin_to_rgb_multipliers(corrections.kelvin);
    let [r, g, b] = if corrections.kelvin == 6500 {
        [r, g, b]
    } else {
        apply_kelvin_to_pixel([r, g, b], &kelvin_muls)
    };

    // Step 3 — Per-channel gamma LUT.
    let luts = build_gamma_luts(
        corrections.gamma_r,
        corrections.gamma_g,
        corrections.gamma_b,
    );
    (luts.r[r as usize], luts.g[g as usize], luts.b[b as usize])
}

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LedOutputError {
    pub code: &'static str,
    pub details: Option<String>,
}

impl LedOutputError {
    fn new(code: &'static str, details: Option<String>) -> Self {
        Self { code, details }
    }

    pub fn as_reason(&self) -> String {
        match &self.details {
            Some(details) => format!("{}: {}", self.code, details),
            None => self.code.to_string(),
        }
    }
}

// ---------------------------------------------------------------------------
// LedPacketSender trait + SerialLedPacketSender
// ---------------------------------------------------------------------------

pub trait LedPacketSender: Send + Sync {
    fn send(&self, port_name: &str, packet: &[u8]) -> Result<(), LedOutputError>;
    fn disconnect_session(&self, port_name: &str);
}

type PortFactory = dyn Fn(&str) -> Result<Box<dyn Write + Send>, LedOutputError> + Send + Sync;

struct SerialLedPacketSender {
    sessions: Mutex<HashMap<String, Box<dyn Write + Send>>>,
    port_factory: Arc<PortFactory>,
}

impl SerialLedPacketSender {
    fn new(port_factory: Arc<PortFactory>) -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            port_factory,
        }
    }

    #[cfg(test)]
    fn with_port_factory_for_tests<F>(factory: F) -> Self
    where
        F: Fn(&str) -> Result<Box<dyn Write + Send>, LedOutputError> + Send + Sync + 'static,
    {
        Self::new(Arc::new(factory))
    }
}

impl Default for SerialLedPacketSender {
    fn default() -> Self {
        Self::new(Arc::new(|port_name: &str| {
            serialport::new(port_name, OUTPUT_BAUD_RATE)
                .timeout(Duration::from_millis(OUTPUT_TIMEOUT_MS))
                .open()
                .map(|port| port as Box<dyn Write + Send>)
                .map_err(|error| {
                    LedOutputError::new("LED_OUTPUT_PORT_OPEN_FAILED", Some(error.to_string()))
                })
        }))
    }
}

impl LedPacketSender for SerialLedPacketSender {
    fn send(&self, port_name: &str, packet: &[u8]) -> Result<(), LedOutputError> {
        let mut sessions = self.sessions.lock().map_err(|error| {
            LedOutputError::new("LED_OUTPUT_SESSION_LOCK_FAILED", Some(error.to_string()))
        })?;

        if !sessions.contains_key(port_name) {
            let opened = (self.port_factory)(port_name)?;
            sessions.insert(port_name.to_string(), opened);
        }

        let Some(port) = sessions.get_mut(port_name) else {
            return Err(LedOutputError::new(
                "LED_OUTPUT_PORT_UNAVAILABLE",
                Some("Port session could not be created for output write.".to_string()),
            ));
        };

        let write_result = port.write_all(packet).map_err(|error| {
            LedOutputError::new("LED_OUTPUT_WRITE_FAILED", Some(error.to_string()))
        });
        let flush_result = if write_result.is_ok() {
            port.flush().map_err(|error| {
                LedOutputError::new("LED_OUTPUT_FLUSH_FAILED", Some(error.to_string()))
            })
        } else {
            Ok(())
        };
        let result = write_result.and(flush_result);

        if result.is_err() {
            sessions.remove(port_name);
        }

        result
    }

    fn disconnect_session(&self, port_name: &str) {
        if let Ok(mut sessions) = self.sessions.lock() {
            sessions.remove(port_name);
        }
    }
}

// ---------------------------------------------------------------------------
// LedOutputBridge
// ---------------------------------------------------------------------------

#[derive(Clone)]
pub struct LedOutputBridge {
    sender: Arc<dyn LedPacketSender>,
}

impl LedOutputBridge {
    pub fn new() -> Self {
        Self {
            sender: Arc::new(SerialLedPacketSender::default()),
        }
    }

    #[cfg(test)]
    pub fn from_sender(sender: Arc<dyn LedPacketSender>) -> Self {
        Self { sender }
    }

    /// Drops the cached port handle for `port_name`.
    pub fn disconnect_session(&self, port_name: &str) {
        self.sender.disconnect_session(port_name);
    }

    #[cfg(test)]
    pub fn send_packet(
        &self,
        connection_state: &SerialConnectionState,
        packet: &[u8],
    ) -> Result<(), LedOutputError> {
        let status = connection_state
            .last_status
            .lock()
            .map_err(|error| {
                LedOutputError::new(
                    "LED_OUTPUT_CONNECTION_STATE_LOCK_FAILED",
                    Some(error.to_string()),
                )
            })?
            .clone();

        if !status.connected {
            return Err(LedOutputError::new(
                "LED_OUTPUT_DEVICE_NOT_CONNECTED",
                Some("Last known device state is disconnected.".to_string()),
            ));
        }

        let port_name = status.port_name.ok_or_else(|| {
            LedOutputError::new(
                "LED_OUTPUT_PORT_UNAVAILABLE",
                Some("No connected serial port is recorded in connection state.".to_string()),
            )
        })?;

        self.send_packet_to_port(&port_name, packet)
    }

    pub fn send_packet_to_port(
        &self,
        port_name: &str,
        packet: &[u8],
    ) -> Result<(), LedOutputError> {
        self.sender.send(port_name, packet)
    }
}

impl Default for LedOutputBridge {
    fn default() -> Self {
        Self::new()
    }
}

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
    encode_led_packet_with_corrections(brightness, rgb_triplets, 6500, 1.0)
}

/// Encode a LumaSync v1 packet with full per-channel colour corrections.
///
/// Pipeline order: saturation → Kelvin → gamma LUT
///
/// Wire format: `[0xAA 0x55] [brightness_u8] [led_count_u16_le] [R G B ...] [xor_checksum]`
pub fn encode_led_packet_with_corrections(
    brightness: f32,
    rgb_triplets: &[[u8; 3]],
    kelvin: u16,
    saturation: f32,
) -> Vec<u8> {
    let clamped_brightness = (brightness.clamp(0.0, 1.0) * 255.0).floor() as u8;
    let led_count = u16::try_from(rgb_triplets.len()).unwrap_or(u16::MAX);

    let mut packet = Vec::with_capacity(2 + 1 + 2 + (rgb_triplets.len() * 3) + 1);
    packet.push(0xAA);
    packet.push(0x55);
    packet.push(clamped_brightness);
    packet.extend_from_slice(&led_count.to_le_bytes());

    let luts = &*DEFAULT_GAMMA_LUTS;
    let kelvin_muls = kelvin_to_rgb_multipliers(kelvin);
    let kelvin_identity = kelvin == 6500;
    let sat_identity = (saturation - 1.0_f32).abs() < f32::EPSILON;

    for &pixel in rgb_triplets {
        let after_sat = if sat_identity {
            pixel
        } else {
            apply_saturation_to_pixel(pixel, saturation)
        };

        let [r, g, b] = if kelvin_identity {
            after_sat
        } else {
            apply_kelvin_to_pixel(after_sat, &kelvin_muls)
        };

        packet.extend_from_slice(&[luts.r[r as usize], luts.g[g as usize], luts.b[b as usize]]);
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
    encode_led_packet_with_corrections(brightness, rgb_triplets, kelvin, 1.0)
}

/// Encode an Adalight-compatible packet.
///
/// Wire format (no brightness byte):
/// `[0x41 0x64 0x61] [HIGH(count-1)] [LOW(count-1)] [HIGH^LOW^0x55] [R G B ...]`
///
/// Colour corrections (saturation, Kelvin, gamma) are applied before packing
/// in the same order as the LumaSync v1 encoder.
pub fn encode_adalight_packet(
    rgb_triplets: &[[u8; 3]],
    corrections: &ColorCorrectionConfig,
) -> Vec<u8> {
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

    let luts = build_gamma_luts(
        corrections.gamma_r,
        corrections.gamma_g,
        corrections.gamma_b,
    );
    let kelvin_muls = kelvin_to_rgb_multipliers(corrections.kelvin);
    let kelvin_identity = corrections.kelvin == 6500;
    let sat_identity = (corrections.saturation - 1.0_f32).abs() < f32::EPSILON;

    for &pixel in rgb_triplets {
        let after_sat = if sat_identity {
            pixel
        } else {
            apply_saturation_to_pixel(pixel, corrections.saturation)
        };

        let [r, g, b] = if kelvin_identity {
            after_sat
        } else {
            apply_kelvin_to_pixel(after_sat, &kelvin_muls)
        };

        packet.extend_from_slice(&[luts.r[r as usize], luts.g[g as usize], luts.b[b as usize]]);
    }

    packet
}

/// Dispatch encoder based on `FirmwareProfile`.
///
/// For `LumaSyncV1` the brightness value is encoded in the packet header.
/// For `Adalight` the brightness byte is absent — it is handled in firmware.
pub fn encode_packet_for_profile(
    profile: FirmwareProfile,
    brightness: f32,
    rgb_triplets: &[[u8; 3]],
    corrections: &ColorCorrectionConfig,
) -> Vec<u8> {
    match profile {
        FirmwareProfile::LumaSyncV1 => encode_led_packet_with_corrections(
            brightness,
            rgb_triplets,
            corrections.kelvin,
            corrections.saturation,
        ),
        FirmwareProfile::Adalight => encode_adalight_packet(rgb_triplets, corrections),
    }
}

// ---------------------------------------------------------------------------
// SK6812 RGBW encoder (v1.5 G3)
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
    corrections: &ColorCorrectionConfig,
) -> Vec<u8> {
    let clamped_brightness = (brightness.clamp(0.0, 1.0) * 255.0).floor() as u8;
    let led_count = u16::try_from(rgb_triplets.len()).unwrap_or(u16::MAX);

    // 4 bytes per pixel for RGBW
    let mut packet = Vec::with_capacity(2 + 1 + 2 + (rgb_triplets.len() * 4) + 1);
    packet.push(0xAA);
    packet.push(0x55);
    packet.push(clamped_brightness);
    packet.extend_from_slice(&led_count.to_le_bytes());

    let luts = build_gamma_luts(
        corrections.gamma_r,
        corrections.gamma_g,
        corrections.gamma_b,
    );
    let kelvin_muls = kelvin_to_rgb_multipliers(corrections.kelvin);
    let kelvin_identity = corrections.kelvin == 6500;
    let sat_identity = (corrections.saturation - 1.0_f32).abs() < f32::EPSILON;

    for &pixel in rgb_triplets {
        // Step 1 — saturation
        let after_sat = if sat_identity {
            pixel
        } else {
            apply_saturation_to_pixel(pixel, corrections.saturation)
        };

        // Step 2 — Kelvin
        let [r, g, b] = if kelvin_identity {
            after_sat
        } else {
            apply_kelvin_to_pixel(after_sat, &kelvin_muls)
        };

        // Step 3 — gamma LUT (RGB only; W bypasses)
        let corrected = [luts.r[r as usize], luts.g[g as usize], luts.b[b as usize]];

        // Step 4 — W extraction
        let [r_prime, g_prime, b_prime, w] = extract_rgbw(corrected);
        packet.extend_from_slice(&[r_prime, g_prime, b_prime, w]);
    }

    let checksum = packet.iter().fold(0_u8, |acc, byte| acc ^ byte);
    packet.push(checksum);
    packet
}

// ---------------------------------------------------------------------------
// Test-only helpers used by lighting_mode.rs and led_output tests
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// SerialSink — `LedSink` implementation backed by `LedOutputBridge`
//
// Wire format is preserved exactly unless the user explicitly changes the
// Firmware Profile setting. Never change the wire format silently.
// ---------------------------------------------------------------------------

/// A `LedSink` implementation that encodes frames and writes them to a serial
/// port via `LedOutputBridge`. Supports both LumaSync v1 and Adalight profiles,
/// and WS2812B (3-byte) or SK6812 RGBW (4-byte) chip encodings.
///
/// Used as the production USB output sink in the ambilight worker (v1.4+).
/// The ambilight worker holds a concrete `SerialSink` and calls `set_brightness`
/// each iteration so the live-brightness atomic stays in sync without circular
/// module dependencies.
pub struct SerialSink {
    bridge: LedOutputBridge,
    port_name: Option<String>,
    brightness: f32,
    profile: FirmwareProfile,
    corrections: ColorCorrectionConfig,
    chip_type: LedChipType,
}

impl SerialSink {
    /// Create a sink using the default LumaSync v1 profile, default corrections,
    /// and default chip type (WS2812B GRB).
    ///
    /// Used by tests only — `#[cfg(test)]` keeps it out of the production binary.
    /// Production code uses `with_profile_and_corrections` to pass explicit settings.
    #[cfg(test)]
    pub fn new(bridge: LedOutputBridge, port_name: Option<String>, brightness: f32) -> Self {
        Self {
            bridge,
            port_name,
            brightness,
            profile: FirmwareProfile::default(),
            corrections: ColorCorrectionConfig::default(),
            chip_type: LedChipType::default(),
        }
    }

    /// Create a sink with an explicit firmware profile and colour correction config.
    /// Chip type defaults to `WS2812B_GRB` (backward compat).
    pub fn with_profile_and_corrections(
        bridge: LedOutputBridge,
        port_name: Option<String>,
        brightness: f32,
        profile: FirmwareProfile,
        corrections: ColorCorrectionConfig,
    ) -> Self {
        Self {
            bridge,
            port_name,
            brightness,
            profile,
            corrections,
            chip_type: LedChipType::default(),
        }
    }

    /// Create a sink with an explicit firmware profile, colour correction config,
    /// and chip type. (v1.5 G3)
    ///
    /// Forward-looking API: production hot path currently calls
    /// `with_profile_and_corrections` (default chip = WS2812B). UI wiring of
    /// the user-selectable chip type will graduate this constructor in the
    /// next Wave 2 polish commit; covered by unit tests in the meantime.
    #[allow(dead_code)]
    pub fn with_chip_type(
        bridge: LedOutputBridge,
        port_name: Option<String>,
        brightness: f32,
        profile: FirmwareProfile,
        corrections: ColorCorrectionConfig,
        chip_type: LedChipType,
    ) -> Self {
        Self {
            bridge,
            port_name,
            brightness,
            profile,
            corrections,
            chip_type,
        }
    }

    /// Update brightness without stopping the sink.
    ///
    /// Called by the ambilight worker each iteration to keep the sink in sync
    /// with the live `AmbilightLiveSettings` atomic.
    pub fn set_brightness(&mut self, brightness: f32) {
        self.brightness = brightness.clamp(0.0, 1.0);
    }

    /// Switch the firmware profile at runtime (e.g. user changed the setting).
    ///
    /// Not yet wired to the UI settings toggle (v1.4 G11); kept for the
    /// profile-switching path that will land in the same milestone.
    #[allow(dead_code)]
    pub fn set_profile(&mut self, profile: FirmwareProfile) {
        self.profile = profile;
    }

    /// Replace the colour correction config at runtime.
    ///
    /// Will be called from the settings save path once the per-channel
    /// correction UI lands (v1.4 G4).
    #[allow(dead_code)]
    pub fn set_corrections(&mut self, corrections: ColorCorrectionConfig) {
        self.corrections = corrections;
    }

    /// Switch the chip type at runtime (e.g. user changed the LED chip setting).
    ///
    /// Changing chip type while streaming is safe: the next frame will use the
    /// new encoding. The caller is responsible for ensuring the firmware expects
    /// the new byte layout before switching.
    #[allow(dead_code)]
    pub fn set_chip_type(&mut self, chip_type: LedChipType) {
        self.chip_type = chip_type;
    }
}

impl super::led_sink::LedSink for SerialSink {
    fn name(&self) -> &'static str {
        "serial"
    }

    fn start(&mut self) -> Result<(), String> {
        Ok(())
    }

    fn send_frame(&mut self, colors: &[[u8; 3]]) -> Result<(), String> {
        let port = match &self.port_name {
            Some(p) => p.clone(),
            None => return Ok(()),
        };

        let packet = match self.chip_type {
            LedChipType::Ws2812bGrb => {
                encode_packet_for_profile(self.profile, self.brightness, colors, &self.corrections)
            }
            LedChipType::Sk6812Rgbw => {
                // SK6812 RGBW encoding is only supported with the LumaSync v1
                // profile. Adalight has no provision for 4-byte pixels.
                // If the user somehow sets Adalight + SK6812, fall through to
                // the WS2812B path so output is never silently dropped.
                if self.profile == FirmwareProfile::LumaSyncV1 {
                    encode_sk6812_packet(self.brightness, colors, &self.corrections)
                } else {
                    encode_packet_for_profile(
                        self.profile,
                        self.brightness,
                        colors,
                        &self.corrections,
                    )
                }
            }
        };

        self.bridge
            .send_packet_to_port(&port, &packet)
            .map_err(|e| e.as_reason())
    }

    fn stop(&mut self) -> Result<(), String> {
        if let Some(ref port) = self.port_name {
            self.bridge.disconnect_session(port);
        }
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use std::io::Write;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};

    use super::{
        apply_color_correction_rgb, apply_kelvin_to_pixel, apply_saturation_to_pixel,
        apply_solid_payload, build_gamma_luts, encode_adalight_packet, encode_led_packet,
        encode_led_packet_with_corrections, encode_led_packet_with_kelvin,
        encode_packet_for_profile, encode_sk6812_packet, extract_rgbw, kelvin_to_rgb_multipliers,
        send_ambilight_frame, ColorCorrectionConfig, FirmwareProfile, LedChipType, LedOutputBridge,
        LedOutputError, LedPacketSender, SerialSink,
    };
    use crate::commands::device_connection::{
        CommandStatus, SerialConnectionState, SerialConnectionStatus,
    };
    use crate::commands::led_sink::LedSink;

    #[derive(Default)]
    struct FakeSender {
        writes: Mutex<Vec<(String, Vec<u8>)>>,
        fail_with: Option<&'static str>,
        disconnected: Mutex<Vec<String>>,
    }

    #[derive(Default)]
    struct FakePort {
        writes: Vec<u8>,
    }

    impl Write for FakePort {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.writes.extend_from_slice(buf);
            Ok(buf.len())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    impl FakeSender {
        fn successful() -> Self {
            Self::default()
        }

        fn failing(code: &'static str) -> Self {
            Self {
                writes: Mutex::new(Vec::new()),
                fail_with: Some(code),
                disconnected: Mutex::new(Vec::new()),
            }
        }

        fn writes(&self) -> Vec<(String, Vec<u8>)> {
            self.writes.lock().expect("writes lock poisoned").clone()
        }

        fn disconnected_ports(&self) -> Vec<String> {
            self.disconnected
                .lock()
                .expect("disconnected lock poisoned")
                .clone()
        }
    }

    impl LedPacketSender for FakeSender {
        fn send(&self, port_name: &str, packet: &[u8]) -> Result<(), LedOutputError> {
            if let Some(code) = self.fail_with {
                return Err(LedOutputError::new(
                    code,
                    Some("forced failure".to_string()),
                ));
            }

            self.writes
                .lock()
                .expect("writes lock poisoned")
                .push((port_name.to_string(), packet.to_vec()));
            Ok(())
        }

        fn disconnect_session(&self, port_name: &str) {
            self.disconnected
                .lock()
                .expect("disconnected lock poisoned")
                .push(port_name.to_string());
        }
    }

    fn connected_state(port_name: &str) -> SerialConnectionState {
        SerialConnectionState {
            last_status: Mutex::new(SerialConnectionStatus {
                port_name: Some(port_name.to_string()),
                connected: true,
                status: CommandStatus {
                    code: "CONNECT_OK".to_string(),
                    message: "Connected".to_string(),
                    details: None,
                },
                updated_at_unix_ms: 0,
            }),
        }
    }

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
        let corrections_packet = encode_led_packet_with_corrections(0.75, frame, 6500, 1.0);
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
        let packet = encode_adalight_packet(&[[255, 0, 0]], &ColorCorrectionConfig::default());
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
        let packet = encode_adalight_packet(&colors, &ColorCorrectionConfig::default());
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
        let packet = encode_adalight_packet(&colors, &ColorCorrectionConfig::default());
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
        let dispatched =
            encode_packet_for_profile(FirmwareProfile::LumaSyncV1, 0.8, frame, &corrections);
        assert_eq!(
            direct, dispatched,
            "LumaSyncV1 dispatch must match direct encoder"
        );
    }

    #[test]
    fn adalight_profile_dispatch_matches_direct_encoder() {
        let frame = &[[100_u8, 150, 200]];
        let corrections = ColorCorrectionConfig::default();
        let direct = encode_adalight_packet(frame, &corrections);
        let dispatched =
            encode_packet_for_profile(FirmwareProfile::Adalight, 0.8, frame, &corrections);
        assert_eq!(
            direct, dispatched,
            "Adalight dispatch must match direct encoder"
        );
    }

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
        let corrections_packet = encode_led_packet_with_corrections(0.8, frame, 6500, 1.0);
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
        let checks: &[(usize, u8)] = &[
            (0, 0),
            (1, 0),
            (10, 0),
            (64, 13),
            (128, 56),
            (200, 148),
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
    // Bridge / sender
    // ---------------------------------------------------------------------------

    #[test]
    fn bridge_uses_connected_port_and_returns_coded_write_error() {
        let success_sender = Arc::new(FakeSender::successful());
        let success_bridge = LedOutputBridge::from_sender(success_sender.clone());
        let state = connected_state("COM9");

        apply_solid_payload(&success_bridge, &state, 1, 2, 3, 1.0)
            .expect("successful write should not error");
        assert_eq!(success_sender.writes().len(), 1);
        assert_eq!(success_sender.writes()[0].0, "COM9");

        let failing_sender = Arc::new(FakeSender::failing("LED_OUTPUT_WRITE_FAILED"));
        let failing_bridge = LedOutputBridge::from_sender(failing_sender);
        let error = apply_solid_payload(&failing_bridge, &state, 1, 2, 3, 1.0)
            .expect_err("write failure should bubble up");
        assert_eq!(error.code, "LED_OUTPUT_WRITE_FAILED");
    }

    #[test]
    fn ambilight_frame_uses_same_packet_rules_as_solid() {
        let sender = Arc::new(FakeSender::successful());
        let bridge = LedOutputBridge::from_sender(sender.clone());
        let state = connected_state("COM7");

        let frame = [[10, 20, 30], [5, 15, 25]];
        send_ambilight_frame(&bridge, &state, &frame, 0.25).expect("frame send should succeed");

        let writes = sender.writes();
        assert_eq!(writes.len(), 1);
        assert_eq!(writes[0].1, encode_led_packet(0.25, &frame));
    }

    #[test]
    fn serial_sender_reuses_open_port_for_repeated_hot_path_writes() {
        let open_count = Arc::new(AtomicUsize::new(0));
        let open_count_for_factory = Arc::clone(&open_count);
        let sender = super::SerialLedPacketSender::with_port_factory_for_tests(move |_port_name| {
            open_count_for_factory.fetch_add(1, Ordering::SeqCst);
            Ok(Box::new(FakePort::default()))
        });

        sender.send("COM42", &[1, 2, 3]).expect("first write");
        sender
            .send("COM42", &[4, 5, 6])
            .expect("second write reuses session");
        assert_eq!(open_count.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn disconnect_session_removes_cached_handle_and_forces_reopen() {
        let open_count = Arc::new(AtomicUsize::new(0));
        let open_count_for_factory = Arc::clone(&open_count);
        let sender = super::SerialLedPacketSender::with_port_factory_for_tests(move |_port_name| {
            open_count_for_factory.fetch_add(1, Ordering::SeqCst);
            Ok(Box::new(FakePort::default()))
        });

        sender.send("COM42", &[1, 2, 3]).expect("first write");
        assert_eq!(
            open_count.load(Ordering::SeqCst),
            1,
            "one open after first send"
        );

        sender.disconnect_session("COM42");

        sender
            .send("COM42", &[4, 5, 6])
            .expect("send after disconnect reopens");
        assert_eq!(
            open_count.load(Ordering::SeqCst),
            2,
            "port must be reopened after disconnect_session"
        );
    }

    #[test]
    fn bridge_disconnect_session_delegates_to_sender() {
        let sender = Arc::new(FakeSender::successful());
        let bridge = LedOutputBridge::from_sender(sender.clone());

        bridge.disconnect_session("COM5");

        assert_eq!(sender.disconnected_ports(), vec!["COM5".to_string()]);
    }

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
    fn serial_sink_stop_disconnects_session() {
        let sender = Arc::new(FakeSender::successful());
        let bridge = LedOutputBridge::from_sender(sender.clone());
        let mut sink = SerialSink::new(bridge, Some("COM8".to_string()), 0.8);

        sink.start().unwrap();
        sink.send_frame(&[[10, 20, 30]]).unwrap();
        sink.stop().expect("stop should succeed");

        assert!(sender.disconnected_ports().contains(&"COM8".to_string()));
    }

    #[test]
    fn serial_sink_implements_led_sink_trait_object() {
        let sender = Arc::new(FakeSender::successful());
        let bridge = LedOutputBridge::from_sender(sender.clone());
        let mut sink: Box<dyn LedSink> =
            Box::new(SerialSink::new(bridge, Some("COM1".to_string()), 1.0));

        assert_eq!(sink.name(), "serial");
        sink.start().unwrap();
        sink.send_frame(&[[50, 100, 150]]).unwrap();
        sink.stop().unwrap();
        assert_eq!(sender.writes().len(), 1);
    }

    #[test]
    fn serial_sink_adalight_profile_encodes_correct_header() {
        let sender = Arc::new(FakeSender::successful());
        let bridge = LedOutputBridge::from_sender(sender.clone());
        let mut sink = SerialSink::with_profile_and_corrections(
            bridge,
            Some("COM5".to_string()),
            1.0,
            FirmwareProfile::Adalight,
            ColorCorrectionConfig::default(),
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
        let (r_out, g_out, b_out) =
            apply_color_correction_rgb((pixel[0], pixel[1], pixel[2]), &cfg);

        // The USB encoder applies the same pipeline via encode_led_packet_with_corrections.
        let packet = encode_led_packet_with_corrections(1.0, &[pixel], cfg.kelvin, cfg.saturation);
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

    // ---------------------------------------------------------------------------
    // SK6812 RGBW encoder (v1.5 G3)
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
        let packet = encode_sk6812_packet(1.0, frame, &corrections);

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
        let packet = encode_sk6812_packet(0.5, frame, &corrections);

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
        let packet = encode_sk6812_packet(1.0, &[[100, 60, 20]], &corrections);
        // pixel bytes start at index 5
        assert_eq!(packet[5], 80, "R' = 100-20 = 80");
        assert_eq!(packet[6], 40, "G' = 60-20 = 40");
        assert_eq!(packet[7], 0, "B' = 20-20 = 0");
        assert_eq!(packet[8], 20, "W = min(100,60,20) = 20");
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

        let expected = encode_sk6812_packet(1.0, &frame, &ColorCorrectionConfig::default());
        assert_eq!(
            writes[0].1, expected,
            "SerialSink with SK6812 must use RGBW encoder"
        );
    }

    #[test]
    fn serial_sink_ws2812b_chip_type_default_is_backward_compat() {
        let sender = Arc::new(FakeSender::successful());
        let bridge = LedOutputBridge::from_sender(sender.clone());
        // with_profile_and_corrections defaults to WS2812B_GRB
        let mut sink = SerialSink::with_profile_and_corrections(
            bridge,
            Some("COM6".to_string()),
            1.0,
            FirmwareProfile::LumaSyncV1,
            ColorCorrectionConfig::default(),
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

    #[test]
    fn led_chip_type_default_is_ws2812b_grb() {
        assert_eq!(
            LedChipType::default(),
            LedChipType::Ws2812bGrb,
            "LedChipType default must be WS2812B_GRB for backward compat"
        );
    }
}
