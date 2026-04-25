use serde::{Deserialize, Serialize};

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
    /// is set). Ignored on serialise when absent.
    #[serde(default)]
    pub zone_relative_position: Option<ZoneRelativePosition>,
}

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

#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TvAnchorPlacement {
    pub width_meters: f64,
    pub height_meters: f64,
    pub x: f64,
    pub y: f64,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ZoneDefinition {
    pub id: String,
    pub name: String,
    pub light_ids: Vec<String>,
}

/// v1.5 W1-A3 — logical Hue zone (subset of an entertainment area).
/// Mirror of `HueZone` in `src/shared/contracts/roomMap.ts`. Persisted on
/// the frontend `shellStore` inside `RoomMapConfig.hue_zones`; the
/// authoring commands in `commands::hue::zone` round-trip it without
/// owning persistence themselves.
#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct HueZone {
    pub id: String,
    pub name: String,
    pub entertainment_area_id: String,
    pub center_x: f64,
    pub center_y: f64,
    pub center_z: f64,
    pub scale_x: f64,
    pub scale_y: f64,
    pub scale_z: f64,
    pub channel_indices: Vec<u8>,
    #[serde(default)]
    pub border_color: Option<String>,
    #[serde(default)]
    pub center_color: Option<String>,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RoomMapConfig {
    pub dimensions: RoomDimensions,
    pub hue_channels: Vec<HueChannelPlacement>,
    pub usb_strips: Vec<UsbStripPlacement>,
    pub furniture: Vec<FurniturePlacement>,
    pub tv_anchor: Option<TvAnchorPlacement>,
    pub zones: Vec<ZoneDefinition>,
    /// v1.5 W1-A3 — logical Hue zones (subsets of an entertainment area).
    /// Absent ⇒ legacy flat mode (channels use absolute Hue coordinates).
    #[serde(default)]
    pub hue_zones: Option<Vec<HueZone>>,
    pub background_image_path: Option<String>,
}
