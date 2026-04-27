use serde::{Deserialize, Serialize};

#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RoomDimensions {
    pub width_meters: f64,
    pub depth_meters: f64,
}

/// Zone-relative position used by `HueChannelPlacement.zone_relative_position`.
/// Same `[-1, 1]` coordinate space as Hue native, but scoped to the parent
/// `Zone.center` + `Zone.scale` frame. World-space resolves at frame-build
/// time via `world = center + scale * relative`.
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
    /// `Zone.id` (with `zoneType = "hue"`). `zone_relative_position` is
    /// then the authoritative source of truth and `x/y/z` above are
    /// derived at runtime. Logical zones (`zoneType = "logical"`) never
    /// own zone-relative coordinates — channels referencing a logical
    /// zone keep their absolute placement.
    #[serde(default)]
    pub zone_id: Option<String>,
    /// v1.5 W1-A3 — zone-relative position (authoritative when `zone_id`
    /// resolves to a Hue zone). Ignored on serialise when absent.
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

/// v1.5 W4-F discriminator for the unified `Zone` struct.
///
/// - `Logical` — USB-side region grouping. No bridge interaction; carries
///   `channel_indices` plus an optional `region` hint and (optionally) a
///   `border_color` for the strip badge. Hue-only fields
///   (`entertainment_area_id`, `center_*`, `scale_*`) MUST be `None`.
/// - `Hue` — Hue entertainment-area subset. Owns `entertainment_area_id`,
///   `center_*`, and `scale_*`; channels referencing this zone via
///   `HueChannelPlacement.zone_id` resolve as
///   `world = center + scale * zoneRelativePosition`.
#[derive(Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub enum ZoneType {
    Logical,
    Hue,
}

/// v1.5 W4-F unified zone descriptor. Replaces both the legacy
/// `ZoneDefinition` (USB-side region grouping) and the v1.5 W1-A `HueZone`
/// (entertainment-area subset). Mirror of `Zone` in
/// `src/shared/contracts/roomMap.ts`.
///
/// All Hue-only fields are `Option<>` so the same struct can serialise
/// both zone types. Validation in `commands::room_map::zone` branches on
/// `zone_type`:
/// - `ZoneType::Hue` ⇒ `entertainment_area_id`, `center_*`, `scale_*` MUST
///   be `Some(_)` (else `ZONE_TYPE_INVALID`).
/// - `ZoneType::Logical` ⇒ Hue-only fields MUST be `None` (else
///   `ZONE_TYPE_INVALID`).
#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Zone {
    pub id: String,
    pub name: String,
    /// Discriminator — drives the validation branch and downstream
    /// resolve / cap behaviour in `frame.rs` and the Tauri commands.
    pub zone_type: ZoneType,
    /// Channel indices assigned to this zone.
    /// - `ZoneType::Hue` ⇒ entertainment-area channel indices, bounded by
    ///   the bridge per-area cap (`HUE_AREA_CHANNEL_LIMIT = 10`).
    /// - `ZoneType::Logical` ⇒ USB-side LED indices, no bridge cap.
    pub channel_indices: Vec<u8>,
    /// Parent entertainment area id. Required when `zone_type == Hue`,
    /// MUST be `None` when `zone_type == Logical`.
    #[serde(default)]
    pub entertainment_area_id: Option<String>,
    /// Hue-only — zone center X in `[-1, 1]`.
    #[serde(default)]
    pub center_x: Option<f64>,
    /// Hue-only — zone center Y in `[-1, 1]`.
    #[serde(default)]
    pub center_y: Option<f64>,
    /// Hue-only — zone center Z in `[-1, 1]`.
    #[serde(default)]
    pub center_z: Option<f64>,
    /// Hue-only — per-axis zone-to-world scale.
    #[serde(default)]
    pub scale_x: Option<f64>,
    /// Hue-only — per-axis zone-to-world scale.
    #[serde(default)]
    pub scale_y: Option<f64>,
    /// Hue-only — per-axis zone-to-world scale.
    #[serde(default)]
    pub scale_z: Option<f64>,
    /// Logical-only — region hint (USB-side region-assignment system).
    #[serde(default)]
    pub region: Option<String>,
    /// Optional UI hint for the zone outline color (both types).
    #[serde(default)]
    pub border_color: Option<String>,
    /// @deprecated v1.5 — collapsed onto `border_color` (legacy `HueZone`
    /// field). Kept on the model so pre-v1.5 persisted configs deserialise
    /// without loss; new authoring flows MUST NOT write this field.
    #[serde(default)]
    pub center_color: Option<String>,
}

/// @deprecated v1.5 W4-F — superseded by `Zone` with
/// `zone_type = ZoneType::Logical`. Kept as a migration-shim type so the
/// frontend `toLogicalZone` helper has a Rust mirror when round-tripping
/// legacy persisted records during the `schemaVersion 1 → 2` migration.
#[allow(dead_code)] // v1.5 W4-F migration-shim type — kept so frontend toLogicalZone has a Rust mirror
#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ZoneDefinition {
    pub id: String,
    pub name: String,
    pub light_ids: Vec<String>,
}

/// @deprecated v1.5 W4-F — superseded by `Zone` with
/// `zone_type = ZoneType::Hue`. Kept as a migration-shim type so the
/// frontend `toHueZone` helper has a Rust mirror when round-tripping
/// legacy persisted records during the `schemaVersion 1 → 2` migration.
/// New authoring flows MUST NOT write this struct — write a `Zone` with
/// `zone_type = ZoneType::Hue` instead.
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
    /// v1.5 W4-F — unified zone list. Replaces both the legacy
    /// `ZoneDefinition[]` and the deprecated `hue_zones` field below.
    pub zones: Vec<Zone>,
    /// @deprecated v1.5 W4-F — read-only fallback during the
    /// `schemaVersion 1 → 2` migration shim window. New writes MUST go
    /// into `zones` with `zone_type = ZoneType::Hue`.
    #[serde(default)]
    pub hue_zones: Option<Vec<HueZone>>,
    pub background_image_path: Option<String>,
}
