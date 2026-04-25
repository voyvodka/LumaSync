//! HueStream binary frame builder, channel data model, and colour conversions.
//!
//! Pure (no I/O) helpers carved out of the original `hue_stream_lifecycle.rs`
//! during the v1.5 G8 split. Behaviour and on-the-wire layout are preserved
//! exactly — every constant, frame layout, and rgb→xy coefficient matches the
//! pre-refactor implementation byte-for-byte.

use std::sync::Arc;

use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// HueStream binary protocol constants (v2.0, API version 1.0)
// ---------------------------------------------------------------------------

/// "HueStream" magic bytes.
pub(super) const HUESTREAM_MAGIC: &[u8; 9] = b"HueStream";
/// Protocol version: major=2, minor=0.
pub(super) const HUESTREAM_VERSION_MAJOR: u8 = 0x02;
pub(super) const HUESTREAM_VERSION_MINOR: u8 = 0x00;
/// Sequence number — 0x00 for non-sequenced mode (simplest).
pub(super) const HUESTREAM_SEQUENCE: u8 = 0x00;
/// Reserved bytes (2 bytes, must be 0x00).
pub(super) const HUESTREAM_RESERVED: [u8; 2] = [0x00, 0x00];
/// Color space: 0x00 = RGB, 0x01 = XY+Brightness.
pub(super) const HUESTREAM_COLOR_SPACE_RGB: u8 = 0x00;

// ---------------------------------------------------------------------------
// Channel data model
// ---------------------------------------------------------------------------

/// The screen region a Hue entertainment channel should receive colour from.
/// Derived from the channel's 3D position as reported by the bridge.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum HueScreenRegion {
    Top,
    Bottom,
    Left,
    Right,
    Center,
}

impl HueScreenRegion {
    pub fn as_str(&self) -> &'static str {
        match self {
            HueScreenRegion::Top => "top",
            HueScreenRegion::Bottom => "bottom",
            HueScreenRegion::Left => "left",
            HueScreenRegion::Right => "right",
            HueScreenRegion::Center => "center",
        }
    }
}

pub(crate) fn parse_screen_region(s: &str) -> Option<HueScreenRegion> {
    match s {
        "top" => Some(HueScreenRegion::Top),
        "bottom" => Some(HueScreenRegion::Bottom),
        "left" => Some(HueScreenRegion::Left),
        "right" => Some(HueScreenRegion::Right),
        "center" => Some(HueScreenRegion::Center),
        _ => None,
    }
}

/// A single resolved Hue entertainment channel: the lights it controls and
/// the screen region those lights should mirror.
#[derive(Clone, Debug)]
pub struct HueAreaChannel {
    /// Entertainment channel ID (0-based index used in HueStream frames).
    pub channel_id: u8,
    /// CLIP v2 light resource IDs belonging to this channel.
    pub light_ids: Vec<String>,
    /// Screen region derived from the channel's x/y position (or overridden by user).
    pub screen_region: HueScreenRegion,
    /// Raw position X reported by the bridge (-1 left ... +1 right).
    pub position_x: f32,
    /// Raw position Y reported by the bridge (-1 bottom ... +1 top).
    pub position_y: f32,
}

/// Serialisable summary of a single Hue entertainment channel for the UI.
#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct HueAreaChannelInfo {
    pub index: usize,
    pub position_x: f32,
    pub position_y: f32,
    pub light_count: usize,
    /// Auto-detected screen region ("left", "right", "top", "bottom", "center").
    pub auto_region: String,
}

// ---------------------------------------------------------------------------
// Background sender channel update payload + handle
// ---------------------------------------------------------------------------

#[derive(Debug)]
pub(crate) struct HueColorUpdate {
    /// Per-channel colours in channel order (one entry per `HueAreaChannel`).
    pub(crate) channel_colors: Vec<(u8, u8, u8)>,
    pub(crate) brightness: f32,
}

/// Lightweight, cloneable handle to the background Hue color sender thread.
/// Cloning only increments an Arc refcount -- cheap. When every clone drops,
/// the sender channel closes and the background thread exits on its own.
#[derive(Clone, Debug)]
pub struct HueColorSender {
    pub(crate) tx: Arc<std::sync::mpsc::SyncSender<HueColorUpdate>>,
    /// Number of channels; used by `try_send` to broadcast a solid colour.
    pub(crate) channel_count: usize,
}

impl HueColorSender {
    /// Broadcast the same colour to every channel. Used by the solid-colour path.
    pub fn try_send(&self, r: u8, g: u8, b: u8, brightness: f32) {
        let channel_colors = vec![(r, g, b); self.channel_count.max(1)];
        let _ = self.tx.try_send(HueColorUpdate {
            channel_colors,
            brightness,
        });
    }

    /// Send individual colours per channel. `colors` must be indexed the same
    /// way as the `HueAreaChannel` list used when the sender was spawned.
    pub fn try_send_channels(&self, colors: Vec<(u8, u8, u8)>, brightness: f32) {
        if colors.is_empty() {
            return;
        }
        let _ = self.tx.try_send(HueColorUpdate {
            channel_colors: colors,
            brightness,
        });
    }
}

// ---------------------------------------------------------------------------
// HueStream binary frame builder
// ---------------------------------------------------------------------------

/// Build a HueStream v2 binary frame for the entertainment API.
///
/// Frame layout (header = 16 bytes):
///   Bytes  0..8:  "HueStream" (9 bytes magic)
///   Byte   9:     API version major (0x02)
///   Byte  10:     API version minor (0x00)
///   Byte  11:     Sequence number (0x00 = non-sequenced)
///   Bytes 12..13: Reserved (0x00, 0x00)
///   Byte  14:     Color space (0x00 = RGB)
///   Byte  15:     Reserved (0x00)
///
/// Per light entry (7 bytes each):
///   Byte   0:     Channel ID (uint8)
///   Bytes 1..2:   Red   (uint16 BE, 0..65535)
///   Bytes 3..4:   Green (uint16 BE, 0..65535)
///   Bytes 5..6:   Blue  (uint16 BE, 0..65535)
///
/// Between the header and channel entries there is a 36-byte field containing
/// the entertainment_configuration resource UUID (ASCII string, e.g.
/// "1a8d99cc-967b-44f2-9202-43f976c0fa6b"). This field is mandatory per the
/// Hue Entertainment API v2.0 specification — the bridge uses it to route the
/// frame to the correct entertainment area when multiple sessions could be
/// active. Without it the bridge cannot parse the channel data and ignores
/// the frame entirely.
pub(crate) fn build_huestream_frame(
    area_id: &str,
    channels: &[HueAreaChannel],
    channel_colors: &[(u8, u8, u8)],
    brightness: f32,
) -> Vec<u8> {
    const UUID_LEN: usize = 36;
    let header_len = 16;
    let entry_len = 7;
    let mut frame = Vec::with_capacity(header_len + UUID_LEN + channels.len() * entry_len);

    // Header
    frame.extend_from_slice(HUESTREAM_MAGIC);
    frame.push(HUESTREAM_VERSION_MAJOR);
    frame.push(HUESTREAM_VERSION_MINOR);
    frame.push(HUESTREAM_SEQUENCE);
    frame.extend_from_slice(&HUESTREAM_RESERVED);
    frame.push(HUESTREAM_COLOR_SPACE_RGB);
    frame.push(0x00); // reserved

    // Entertainment configuration UUID (36 ASCII bytes), required by spec.
    // Pad or truncate defensively to always emit exactly UUID_LEN bytes so
    // channel offsets are deterministic even if the stored ID is malformed.
    let id_bytes = area_id.as_bytes();
    if id_bytes.len() >= UUID_LEN {
        frame.extend_from_slice(&id_bytes[..UUID_LEN]);
    } else {
        frame.extend_from_slice(id_bytes);
        frame.extend(std::iter::repeat_n(0u8, UUID_LEN - id_bytes.len()));
    }

    let brightness_clamped = brightness.clamp(0.0, 1.0);

    for (i, channel) in channels.iter().enumerate() {
        let (r, g, b) = channel_colors.get(i).copied().unwrap_or((0, 0, 0));

        // Scale 8-bit to 16-bit and apply brightness
        let r16 = ((f32::from(r) / 255.0) * brightness_clamped * 65535.0) as u16;
        let g16 = ((f32::from(g) / 255.0) * brightness_clamped * 65535.0) as u16;
        let b16 = ((f32::from(b) / 255.0) * brightness_clamped * 65535.0) as u16;

        frame.push(channel.channel_id);
        frame.extend_from_slice(&r16.to_be_bytes());
        frame.extend_from_slice(&g16.to_be_bytes());
        frame.extend_from_slice(&b16.to_be_bytes());
    }

    frame
}

// ---------------------------------------------------------------------------
// Colour-space conversions
// ---------------------------------------------------------------------------

/// Convert sRGB (0..255 per channel) to CIE 1931 xy chromaticity using the
/// Hue-style gamma + linear-RGB→XYZ matrix. The xy values are bridge-ready
/// for the `color.xy` field of CLIP v2 light PUTs.
pub(crate) fn rgb_to_xy(r: u8, g: u8, b: u8) -> (f64, f64) {
    let mut red = f64::from(r) / 255.0;
    let mut green = f64::from(g) / 255.0;
    let mut blue = f64::from(b) / 255.0;

    red = if red > 0.04045 {
        ((red + 0.055) / 1.055).powf(2.4)
    } else {
        red / 12.92
    };
    green = if green > 0.04045 {
        ((green + 0.055) / 1.055).powf(2.4)
    } else {
        green / 12.92
    };
    blue = if blue > 0.04045 {
        ((blue + 0.055) / 1.055).powf(2.4)
    } else {
        blue / 12.92
    };

    let x = red * 0.664_511 + green * 0.154_324 + blue * 0.162_028;
    let y = red * 0.283_881 + green * 0.668_433 + blue * 0.047_685;
    let z = red * 0.000_088 + green * 0.072_31 + blue * 0.986_039;
    let sum = x + y + z;

    if sum <= f64::EPSILON {
        return (0.3127, 0.3290);
    }

    (x / sum, y / sum)
}

// ---------------------------------------------------------------------------
// Channel position → screen region mapping + UI projection helpers
// ---------------------------------------------------------------------------

/// Map a Hue channel's 2D position (x: -1 left ... +1 right, y: -1 bottom ... +1 top)
/// to the screen region whose colour that channel should display.
pub(crate) fn channel_position_to_screen_region(x: f32, y: f32) -> HueScreenRegion {
    let abs_x = x.abs();
    let abs_y = y.abs();
    if abs_x >= abs_y {
        if x < -0.3 {
            HueScreenRegion::Left
        } else if x > 0.3 {
            HueScreenRegion::Right
        } else {
            HueScreenRegion::Center
        }
    } else if y > 0.3 {
        HueScreenRegion::Top
    } else if y < -0.3 {
        HueScreenRegion::Bottom
    } else {
        HueScreenRegion::Center
    }
}

// ---------------------------------------------------------------------------
// Zone-relative → world coordinate transform (v1.5 W1-A4)
// ---------------------------------------------------------------------------
//
// `HueChannelPlacement` may carry a `zone_id` + `zone_relative_position`
// pair (see `models::room_map`). At frame-build / channel-resolution time
// we resolve those into world space using the parent zone's
// `center{X,Y,Z}` + `scale{X,Y,Z}` transform:
//
//   world.x = center.x + scale.x * relative.x   (and analogously y, z)
//
// The transform helpers live next to `build_huestream_frame` so callers
// that already have a `HueAreaChannel` slice can refresh `position_x/y`
// + `screen_region` in-place without pulling in the zone authoring
// surface.

/// Resolve a zone-relative position into world space and clamp the
/// result into the `[-1, 1]` cube. Returns `Err("out_of_bounds")` when
/// the unclamped world position lies outside the cube on at least one
/// axis — callers can map that to `HUE_ZONE_CHANNEL_OUT_OF_BOUNDS` if
/// they want strict validation, or fall back to the clamped tuple via
/// [`resolve_zone_relative_clamped`] for best-effort streaming.
#[allow(dead_code)] // production wiring lands in W1-A4 sender follow-up; helper is exercised by frame::tests today
pub fn resolve_zone_relative(
    center: (f64, f64, f64),
    scale: (f64, f64, f64),
    relative: (f64, f64, f64),
) -> Result<(f64, f64, f64), &'static str> {
    let world = (
        center.0 + scale.0 * relative.0,
        center.1 + scale.1 * relative.1,
        center.2 + scale.2 * relative.2,
    );
    if !(-1.0..=1.0).contains(&world.0)
        || !(-1.0..=1.0).contains(&world.1)
        || !(-1.0..=1.0).contains(&world.2)
    {
        return Err("out_of_bounds");
    }
    Ok(world)
}

/// Best-effort variant of [`resolve_zone_relative`] that always returns
/// a tuple inside `[-1, 1]` and signals whether any axis was clamped.
/// Suitable for the streaming hot path where dropping a frame because a
/// single light briefly drifted out of the cube would be worse than
/// clamping it.
#[allow(dead_code)] // production wiring lands in W1-A4 sender follow-up; helper is exercised by frame::tests today
pub fn resolve_zone_relative_clamped(
    center: (f64, f64, f64),
    scale: (f64, f64, f64),
    relative: (f64, f64, f64),
) -> ((f64, f64, f64), bool) {
    let world = (
        center.0 + scale.0 * relative.0,
        center.1 + scale.1 * relative.1,
        center.2 + scale.2 * relative.2,
    );
    let cx = world.0.clamp(-1.0, 1.0);
    let cy = world.1.clamp(-1.0, 1.0);
    let cz = world.2.clamp(-1.0, 1.0);
    let clamped = (cx - world.0).abs() > f64::EPSILON
        || (cy - world.1).abs() > f64::EPSILON
        || (cz - world.2).abs() > f64::EPSILON;
    ((cx, cy, cz), clamped)
}

/// Refresh the world-space `position_x/y` + `screen_region` of a Hue
/// area channel using the parent zone's transform. The channel is
/// matched by its `channel_id`. Out-of-cube positions are clamped (best
/// effort) and the function returns `true` if any clamp actually fired —
/// callers can surface that to telemetry without aborting the frame.
///
/// `z` is intentionally not stored on `HueAreaChannel` (the bridge frame
/// only carries 2D screen-region routing); it is resolved purely so the
/// clamp signal accounts for ceiling/floor placements.
#[allow(dead_code)] // production wiring lands in W1-A4 sender follow-up; helper is exercised by frame::tests today
pub fn apply_zone_world_position(
    channels: &mut [HueAreaChannel],
    channel_id: u8,
    center: (f64, f64, f64),
    scale: (f64, f64, f64),
    relative: (f64, f64, f64),
) -> bool {
    let Some(channel) = channels.iter_mut().find(|c| c.channel_id == channel_id) else {
        return false;
    };
    let ((wx, wy, _wz), clamped) = resolve_zone_relative_clamped(center, scale, relative);
    channel.position_x = wx as f32;
    channel.position_y = wy as f32;
    channel.screen_region = channel_position_to_screen_region(wx as f32, wy as f32);
    clamped
}

pub(crate) fn channels_to_info(channels: &[HueAreaChannel]) -> Vec<HueAreaChannelInfo> {
    channels
        .iter()
        .enumerate()
        .map(|(index, ch)| HueAreaChannelInfo {
            index,
            position_x: ch.position_x,
            position_y: ch.position_y,
            light_count: ch.light_ids.len(),
            auto_region: ch.screen_region.as_str().to_string(),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_huestream_frame_produces_correct_header_and_channels() {
        let channels = vec![
            HueAreaChannel {
                channel_id: 0,
                light_ids: vec!["l1".to_string()],
                screen_region: HueScreenRegion::Left,
                position_x: -0.8,
                position_y: 0.0,
            },
            HueAreaChannel {
                channel_id: 1,
                light_ids: vec!["l2".to_string()],
                screen_region: HueScreenRegion::Right,
                position_x: 0.8,
                position_y: 0.0,
            },
        ];
        let colors = vec![(255, 0, 0), (0, 255, 0)];
        let area_id = "1a8d99cc-967b-44f2-9202-43f976c0fa6b";
        let frame = build_huestream_frame(area_id, &channels, &colors, 1.0);

        // Header: 9 magic + 1 major + 1 minor + 1 seq + 2 reserved + 1 color_space + 1 reserved = 16
        assert_eq!(&frame[0..9], b"HueStream");
        assert_eq!(frame[9], 0x02); // major
        assert_eq!(frame[10], 0x00); // minor
        assert_eq!(frame[11], 0x00); // sequence
        assert_eq!(frame[12], 0x00); // reserved
        assert_eq!(frame[13], 0x00); // reserved
        assert_eq!(frame[14], 0x00); // color space RGB
        assert_eq!(frame[15], 0x00); // reserved

        // Entertainment configuration UUID (bytes 16..52, 36 bytes ASCII)
        assert_eq!(&frame[16..52], area_id.as_bytes());

        // Channel 0: id=0, R=65535, G=0, B=0  (starts at byte 52)
        assert_eq!(frame[52], 0); // channel_id
        assert_eq!(frame[53..55], 0xFFFFu16.to_be_bytes()); // R
        assert_eq!(frame[55..57], 0x0000u16.to_be_bytes()); // G
        assert_eq!(frame[57..59], 0x0000u16.to_be_bytes()); // B

        // Channel 1: id=1, R=0, G=65535, B=0  (starts at byte 59)
        assert_eq!(frame[59], 1); // channel_id
        assert_eq!(frame[60..62], 0x0000u16.to_be_bytes()); // R
        assert_eq!(frame[62..64], 0xFFFFu16.to_be_bytes()); // G
        assert_eq!(frame[64..66], 0x0000u16.to_be_bytes()); // B

        // Total: 16 header + 36 UUID + 2*7 channels = 66
        assert_eq!(frame.len(), 66);
    }

    #[test]
    fn build_huestream_frame_applies_brightness() {
        let channels = vec![HueAreaChannel {
            channel_id: 0,
            light_ids: vec!["l1".to_string()],
            screen_region: HueScreenRegion::Center,
            position_x: 0.0,
            position_y: 0.0,
        }];
        let colors = vec![(255, 255, 255)];
        let frame = build_huestream_frame(
            "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
            &channels,
            &colors,
            0.5,
        );

        // Channel starts at byte 52 (16 header + 36 UUID). At 50% brightness, 255 -> ~32767.
        let r = u16::from_be_bytes([frame[53], frame[54]]);
        let g = u16::from_be_bytes([frame[55], frame[56]]);
        let b = u16::from_be_bytes([frame[57], frame[58]]);
        assert!(r > 32000 && r < 33000, "R={r} should be ~32767");
        assert!(g > 32000 && g < 33000, "G={g} should be ~32767");
        assert!(b > 32000 && b < 33000, "B={b} should be ~32767");
    }

    // -----------------------------------------------------------------------
    // Zone-relative → world transform (v1.5 W1-A4)
    // -----------------------------------------------------------------------

    #[test]
    fn resolve_zone_relative_returns_world_inside_unit_cube() {
        // Zone center (0.5, 0.5, 0) + scale (0.3, 0.3, 1) + relative (1, 1, 0)
        // = world (0.8, 0.8, 0).
        let world = resolve_zone_relative((0.5, 0.5, 0.0), (0.3, 0.3, 1.0), (1.0, 1.0, 0.0))
            .expect("expected in-cube world position");
        assert!((world.0 - 0.8).abs() < 1e-9, "expected x≈0.8, got {}", world.0);
        assert!((world.1 - 0.8).abs() < 1e-9, "expected y≈0.8, got {}", world.1);
        assert!(world.2.abs() < 1e-9, "expected z≈0, got {}", world.2);
    }

    #[test]
    fn resolve_zone_relative_rejects_out_of_cube_position() {
        // (0.9, 0, 0) + (0.5, 0, 0) * (1, 0, 0) = 1.4 → out of bounds.
        let result = resolve_zone_relative((0.9, 0.0, 0.0), (0.5, 0.0, 0.0), (1.0, 0.0, 0.0));
        assert!(result.is_err(), "expected out-of-bounds Err, got {result:?}");
    }

    #[test]
    fn resolve_zone_relative_clamped_clamps_and_signals() {
        let ((x, _, _), clamped) =
            resolve_zone_relative_clamped((0.9, 0.0, 0.0), (0.5, 0.0, 0.0), (1.0, 0.0, 0.0));
        assert!(clamped, "expected clamp signal");
        assert!((x - 1.0).abs() < 1e-9, "expected clamped x=1.0, got {x}");
    }

    #[test]
    fn apply_zone_world_position_refreshes_channel_position_and_region() {
        let mut channels = vec![HueAreaChannel {
            channel_id: 3,
            light_ids: vec!["l1".to_string()],
            screen_region: HueScreenRegion::Center,
            position_x: 0.0,
            position_y: 0.0,
        }];
        // Zone (0.5, 0.5, 0) + scale (0.3, 0.3, 1) + relative (1, 1, 0)
        // → world (0.8, 0.8, _) → screen_region "right" (|x|>=|y| && x>0.3).
        let clamped = apply_zone_world_position(
            &mut channels,
            3,
            (0.5, 0.5, 0.0),
            (0.3, 0.3, 1.0),
            (1.0, 1.0, 0.0),
        );
        assert!(!clamped, "in-cube position must not clamp");
        assert!((channels[0].position_x - 0.8).abs() < 1e-6);
        assert!((channels[0].position_y - 0.8).abs() < 1e-6);
        assert_eq!(channels[0].screen_region, HueScreenRegion::Right);
    }

    #[test]
    fn apply_zone_world_position_leaves_unrelated_channels_alone() {
        let mut channels = vec![
            HueAreaChannel {
                channel_id: 0,
                light_ids: vec!["l0".to_string()],
                screen_region: HueScreenRegion::Left,
                position_x: -0.8,
                position_y: 0.0,
            },
            HueAreaChannel {
                channel_id: 1,
                light_ids: vec!["l1".to_string()],
                screen_region: HueScreenRegion::Right,
                position_x: 0.8,
                position_y: 0.0,
            },
        ];
        let clamped = apply_zone_world_position(
            &mut channels,
            1,
            (0.0, 0.0, 0.0),
            (0.5, 0.5, 1.0),
            (-1.0, 0.0, 0.0),
        );
        assert!(!clamped);
        // Channel 0 untouched
        assert!((channels[0].position_x + 0.8).abs() < 1e-6);
        assert_eq!(channels[0].screen_region, HueScreenRegion::Left);
        // Channel 1 moved to (-0.5, 0.0) → screen_region "left"
        assert!((channels[1].position_x + 0.5).abs() < 1e-6);
        assert_eq!(channels[1].screen_region, HueScreenRegion::Left);
    }
}
