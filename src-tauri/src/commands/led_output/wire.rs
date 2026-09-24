//! What a serial frame looks like on the wire: the framing profile, the
//! chip's pixel layout, and the host-side colour order.

use serde::{Deserialize, Serialize};

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
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum FirmwareProfile {
    /// LumaSync v1 native protocol:
    /// `[0xAA 0x55] [brightness_u8] [led_count_u16_le] [R G B ...] [xor_checksum]`
    #[default]
    #[serde(rename = "lumasync-v1")]
    LumaSyncV1,
    /// Adalight-compatible protocol (no brightness byte — the host scales the
    /// pixels instead — and big-endian count-1):
    /// `[0x41 0x64 0x61] [HIGH(count-1)] [LOW(count-1)] [HIGH^LOW^0x55] [R G B ...]`
    Adalight,
}

// ---------------------------------------------------------------------------
// LedChipType — host-side chip encoding variant
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
// APA102 is deferred to v2.0 (it waits on the companion firmware repo
// decision). Do not add it here until that milestone lands.
// ---------------------------------------------------------------------------

/// LED chip type — controls the per-pixel byte layout in the encoded payload.
///
/// Stored under `ShellState.selectedChipType` (optional, default
/// `WS2812B_GRB`). Changing this at runtime does NOT change the on-wire
/// framing header; it only affects the pixel bytes.
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

/// Host-side colour-order correction, applied on top of whatever order the
/// firmware already reorders into — not the strip's datasheet order. `Rgb` is
/// the identity and leaves every byte as it was before the setting existed.
///
/// Wire slot `i` carries logical channel `order[i]`, after the correction
/// LUTs. On SK6812 RGBW it permutes R'G'B' only; W stays in the fourth slot.
/// Serial only: WLED owns its colour order on the device.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
#[repr(u8)]
pub enum LedColorOrder {
    #[default]
    Rgb,
    Rbg,
    Grb,
    Gbr,
    Brg,
    Bgr,
}

impl LedColorOrder {
    /// Which logical channel (0 R, 1 G, 2 B) each wire slot carries.
    pub fn source_slots(self) -> [usize; 3] {
        match self {
            Self::Rgb => [0, 1, 2],
            Self::Rbg => [0, 2, 1],
            Self::Grb => [1, 0, 2],
            Self::Gbr => [1, 2, 0],
            Self::Brg => [2, 0, 1],
            Self::Bgr => [2, 1, 0],
        }
    }

    /// Inverse of `self as u8`, for the worker's live atomic. Unknown ⇒ `Rgb`.
    pub fn from_u8(value: u8) -> Self {
        match value {
            1 => Self::Rbg,
            2 => Self::Grb,
            3 => Self::Gbr,
            4 => Self::Brg,
            5 => Self::Bgr,
            _ => Self::Rgb,
        }
    }

    #[inline(always)]
    pub(super) fn permute(self, channels: [u8; 3]) -> [u8; 3] {
        let [x, y, z] = self.source_slots();
        [channels[x], channels[y], channels[z]]
    }
}

/// The pixel layout a profile + chip pair actually puts on the wire.
///
/// SK6812 RGBW is only encodable under LumaSync v1: Adalight has no provision
/// for 4-byte pixels, so Adalight + SK6812 falls back to 3-byte pixels rather
/// than dropping output silently. `encode_packet_for_output` dispatches on this
/// and the 115 200-baud frame budget sizes frames from it, so the two cannot
/// disagree — the budget once charged that fallback 4 bytes a pixel and
/// capped its frame rate a quarter below what the link carries.
///
/// It is also what a LumaSync firmware advertises it expects, in the PONG's
/// high nibble (`device_handshake.rs`), serialised as `"rgb"` / `"rgbw"`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum WirePixelLayout {
    Rgb,
    Rgbw,
}

impl WirePixelLayout {
    pub fn for_output(profile: FirmwareProfile, chip_type: LedChipType) -> Self {
        match (chip_type, profile) {
            (LedChipType::Sk6812Rgbw, FirmwareProfile::LumaSyncV1) => Self::Rgbw,
            _ => Self::Rgb,
        }
    }

    pub fn bytes_per_pixel(self) -> usize {
        match self {
            Self::Rgb => 3,
            Self::Rgbw => 4,
        }
    }
}
