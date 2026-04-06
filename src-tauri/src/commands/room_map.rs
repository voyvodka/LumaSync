use serde::{Deserialize, Serialize};
use tauri::Manager;

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
pub async fn copy_background_image(
    app_handle: tauri::AppHandle,
    src_path: String,
) -> Result<String, String> {
    use std::path::PathBuf;
    let app_data_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data dir: {}", e))?;
    let bg_dir = app_data_dir.join("room-map-backgrounds");
    std::fs::create_dir_all(&bg_dir)
        .map_err(|e| format!("Failed to create background dir: {}", e))?;
    let src = PathBuf::from(&src_path);
    let filename = src
        .file_name()
        .ok_or_else(|| "Invalid source path: no filename".to_string())?;
    let dest = bg_dir.join(filename);
    std::fs::copy(&src, &dest)
        .map_err(|e| format!("Failed to copy background image: {}", e))?;
    Ok(dest.to_string_lossy().to_string())
}

#[tauri::command]
pub fn update_hue_channel_positions(_channels: Vec<HueChannelPlacement>) -> CommandStatus {
    CommandStatus {
        code: "STUB_NOT_IMPLEMENTED".to_string(),
        message: "Phase 14 stub - implemented in Phase 16".to_string(),
        details: None,
    }
}
