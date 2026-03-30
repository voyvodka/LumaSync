use serde::{Deserialize, Serialize};

use crate::models::room_map::{HueChannelPlacement, RoomMapConfig};
use super::hue_onboarding::CommandStatus;

#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SaveRoomMapResponse {
    pub status: CommandStatus,
    pub version: u32,
}

#[tauri::command]
pub fn save_room_map(_config: RoomMapConfig) -> SaveRoomMapResponse {
    SaveRoomMapResponse {
        status: CommandStatus {
            code: "STUB_NOT_IMPLEMENTED".to_string(),
            message: "Phase 14 stub - implemented in Phase 17".to_string(),
            details: None,
        },
        version: 0,
    }
}

#[tauri::command]
pub fn load_room_map() -> CommandStatus {
    CommandStatus {
        code: "STUB_NOT_IMPLEMENTED".to_string(),
        message: "Phase 14 stub - implemented in Phase 17".to_string(),
        details: None,
    }
}

#[tauri::command]
pub fn update_hue_channel_positions(_channels: Vec<HueChannelPlacement>) -> CommandStatus {
    CommandStatus {
        code: "STUB_NOT_IMPLEMENTED".to_string(),
        message: "Phase 14 stub - implemented in Phase 16".to_string(),
        details: None,
    }
}
