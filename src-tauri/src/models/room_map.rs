use serde::{Deserialize, Serialize};

#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RoomDimensions {
    pub width_meters: f64,
    pub depth_meters: f64,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct HueChannelPlacement {
    pub channel_index: u8,
    pub x: f64,
    pub y: f64,
    pub z: f64,
    pub label: Option<String>,
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

#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RoomMapConfig {
    pub dimensions: RoomDimensions,
    pub hue_channels: Vec<HueChannelPlacement>,
    pub usb_strips: Vec<UsbStripPlacement>,
    pub furniture: Vec<FurniturePlacement>,
    pub tv_anchor: Option<TvAnchorPlacement>,
    pub zones: Vec<ZoneDefinition>,
    pub background_image_path: Option<String>,
}
