//! Room-map shapes that actually cross the IPC boundary: Hue channel
//! placements, the zones they belong to, and the `RoomGeometry` projection the
//! ambilight worker samples by. Rust mirror of the matching half of
//! `src/shared/contracts/roomMap.ts`; the two must move together.
//!
//! The room-map *document* is not mirrored here. It is persisted frontend-side
//! through the shellStore and no Rust command receives it, so a `RoomMapConfig`
//! struct here would be an unread copy free to drift — which is exactly what
//! happened to the one that shipped with the `save_room_map` stub.

use serde::{Deserialize, Serialize};

use crate::commands::hue::state_store::HueChannelPlacementOverride;

/// Physical room size in metres.
#[derive(Clone, Serialize, Deserialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RoomDimensions {
    pub width_meters: f64,
    pub depth_meters: f64,
    pub height_meters: f64,
}

/// The TV footprint in the room-metre frame: origin where the TV wall meets the
/// left wall, +x right, +y away from the TV wall, +z up. `x`/`y` are the
/// footprint's top-left corner, and `height` is its depth along y — not the
/// screen's height.
#[derive(Clone, Serialize, Deserialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TvAnchorPlacement {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub locked: Option<bool>,
    /// Absent ⇒ `DEFAULT_TV_MOUNT_HEIGHT_FRACTION` of the room height, resolved
    /// at runtime so it follows a room-height edit.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mount_height_meters: Option<f64>,
}

/// What the ambilight worker samples Hue channels by. A wire projection of the
/// room map, present only while a TV anchor exists — that presence is the
/// room-aware gate. `hue_placements` repeats the stream-start projection
/// because the stream's copy is fixed at start and a drag must reach the
/// running worker without restarting the stream.
#[derive(Clone, Serialize, Deserialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RoomGeometry {
    pub dimensions: RoomDimensions,
    pub tv: TvAnchorPlacement,
    #[serde(default)]
    pub hue_placements: Vec<HueChannelPlacementOverride>,
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

/// Where a placement's `z` came from. Absent means unknown: a legacy record
/// whose `0` may be a placeholder rather than a height anyone chose.
#[derive(Clone, Copy, Serialize, Deserialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum HueChannelHeightOrigin {
    Bridge,
    User,
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
    /// Mirrored for the same reason as `locked`: the zone commands echo the
    /// list back, so an unmirrored field is erased on every zone assignment.
    #[serde(default)]
    pub z_origin: Option<HueChannelHeightOrigin>,
    #[serde(default)]
    pub label: Option<String>,
    /// Mirrored so the zone commands stop dropping it: they echo the channel
    /// list back and the frontend re-applies it wholesale, so a field missing
    /// here is a field erased by assigning a channel to a zone.
    #[serde(default)]
    pub locked: Option<bool>,
    /// Parent entertainment area — `channel_index` is unique only within one.
    #[serde(default)]
    pub entertainment_area_id: Option<String>,
    /// The bridge's own channel identity. `channel_index` above is our ordinal
    /// and is NOT interchangeable with it. Absent means never resolved, and the
    /// write-back must refuse rather than fall back to the ordinal — sending
    /// the ordinal as a `channel_id` is the defect this field exists to end.
    #[serde(default)]
    pub channel_id: Option<u8>,
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
