//! Persisted room-map model — room dimensions plus Hue channel, USB strip,
//! furniture, and TV-anchor placements. Rust mirror of
//! `src/shared/contracts/roomMap.ts`; the two must move together.

use serde::{Deserialize, Serialize};

/// Physical room size, used to scale the top-down room-map editor.
#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RoomDimensions {
    pub width_meters: f64,
    pub depth_meters: f64,
}

/// Zone-relative position used by `HueChannelPlacement.zone_relative_position`.
/// Same `[-1, 1]` coordinate space as Hue native, but scoped to the parent
/// `HueZone.center` + `HueZone.scale` frame. World-space resolves at
/// frame-build time via `world = center + scale * relative`.
#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ZoneRelativePosition {
    pub x: f64,
    pub y: f64,
    pub z: f64,
}

/// Placement of one Hue entertainment channel — absolute `x/y/z`, or
/// zone-relative when `zone_id` is set.
#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct HueChannelPlacement {
    pub channel_index: u8,
    pub x: f64,
    pub y: f64,
    pub z: f64,
    #[serde(default)]
    pub label: Option<String>,
    /// v1.5 W1-A3 — when present, channel is logically grouped under
    /// `HueZone.id`. `zone_relative_position` is then the authoritative
    /// source of truth and `x/y/z` above are derived at runtime.
    #[serde(default)]
    pub zone_id: Option<String>,
    /// v1.5 W1-A3 — zone-relative position (authoritative when `zone_id`
    /// resolves to a Hue zone). Ignored on serialise when absent.
    #[serde(default)]
    pub zone_relative_position: Option<ZoneRelativePosition>,
}

/// Placement of one USB LED strip run along a wall edge.
#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct UsbStripPlacement {
    pub id: String,
    pub wall_side: String,
    pub led_count: u32,
    pub offset_ratio: f64,
    pub x: f64,
    pub y: f64,
}

/// A furniture rectangle, drawn purely as a visual reference in the editor —
/// nothing in the lighting path reads it.
#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FurniturePlacement {
    pub id: String,
    pub name: String,
    pub width_meters: f64,
    pub depth_meters: f64,
    pub rotation: f64,
    pub x: f64,
    pub y: f64,
}

/// The TV/screen rectangle — the anchor every edge and zone position is
/// expressed relative to.
#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TvAnchorPlacement {
    pub width_meters: f64,
    pub height_meters: f64,
    pub x: f64,
    pub y: f64,
}

/// A spatial 3D zone tied to one entertainment area. Channels join via
/// `HueChannelPlacement.zone_id` and resolve as `world = center + scale *
/// zoneRelativePosition`. Zones are Hue-only — see docs/architecture/hue.md.
#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct HueZone {
    pub id: String,
    pub name: String,
    /// Parent entertainment area id.
    pub entertainment_area_id: String,
    /// Zone center X in `[-1, 1]`.
    pub center_x: f64,
    /// Zone center Y in `[-1, 1]`.
    pub center_y: f64,
    /// Zone center Z in `[-1, 1]`.
    pub center_z: f64,
    /// Per-axis zone-to-world scale (X).
    pub scale_x: f64,
    /// Per-axis zone-to-world scale (Y).
    pub scale_y: f64,
    /// Per-axis zone-to-world scale (Z).
    pub scale_z: f64,
    /// Channel indices assigned to this zone, bounded by the bridge
    /// per-area cap (`HUE_AREA_CHANNEL_LIMIT = 10`).
    pub channel_indices: Vec<u8>,
    /// Optional UI hint for the zone outline color.
    #[serde(default)]
    pub border_color: Option<String>,
    /// @deprecated v1.5 — collapsed onto `border_color`. Kept on the
    /// model so pre-v1.5 persisted configs deserialise without loss; new
    /// authoring flows MUST NOT write this field.
    #[serde(default)]
    pub center_color: Option<String>,
}

/// The full persisted room-map document — dimensions plus every placement kind.
#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RoomMapConfig {
    pub dimensions: RoomDimensions,
    pub hue_channels: Vec<HueChannelPlacement>,
    pub usb_strips: Vec<UsbStripPlacement>,
    pub furniture: Vec<FurniturePlacement>,
    pub tv_anchor: Option<TvAnchorPlacement>,
    /// Canonical Hue zone list. Authoritative source for v1.5 W4-F2+.
    pub zones: Vec<HueZone>,
    /// @deprecated v1.5 W4-F2 — read-only deserialization tolerance for
    /// pre-W4-F2 persisted records that wrote Hue zones into a separate
    /// `hueZones` field. Frontend migration shim folds this into `zones`
    /// before round-tripping. New writes MUST go into `zones`.
    #[serde(default)]
    pub hue_zones: Option<Vec<HueZone>>,
    pub background_image_path: Option<String>,
}
