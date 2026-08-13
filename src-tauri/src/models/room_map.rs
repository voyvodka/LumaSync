//! Room-map shapes that actually cross the IPC boundary: Hue channel
//! placements and the zones they belong to. Rust mirror of the matching
//! half of `src/shared/contracts/roomMap.ts`; the two must move together.
//!
//! The room-map *document* is not mirrored here. It is persisted frontend-side
//! through the shellStore and no Rust command receives it, so a `RoomMapConfig`
//! struct here would be an unread copy free to drift — which is exactly what
//! happened to the one that shipped with the `save_room_map` stub.

use serde::{Deserialize, Serialize};

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
