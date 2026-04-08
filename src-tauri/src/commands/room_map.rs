use reqwest::blocking::Client as BlockingClient;
use serde::{Deserialize, Serialize};
use serde_json::json;
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
pub fn update_hue_channel_positions(
    channels: Vec<HueChannelPlacement>,
    bridge_ip: String,
    username: String,
    area_id: String,
) -> CommandStatus {
    // Build TLS-skip HTTP client (Hue bridges use self-signed certificates)
    let client = match BlockingClient::builder()
        .danger_accept_invalid_certs(true)
        .timeout(std::time::Duration::from_millis(5_000))
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            return CommandStatus {
                code: "CHAN_WB_NETWORK_ERROR".to_string(),
                message: format!("Failed to build HTTP client: {e}"),
                details: None,
            };
        }
    };

    // Build CLIP v2 channel positions payload
    let channel_positions: Vec<serde_json::Value> = channels
        .iter()
        .map(|ch| {
            json!({
                "channel_id": ch.channel_index,
                "position": {
                    "x": ch.x,
                    "y": ch.y,
                    "z": ch.z
                }
            })
        })
        .collect();

    let body = json!({ "channels": channel_positions });

    let endpoint = format!(
        "https://{}/clip/v2/resource/entertainment_configuration/{}",
        bridge_ip, area_id
    );

    let response = match client
        .put(&endpoint)
        .header("hue-application-key", &username)
        .json(&body)
        .send()
    {
        Ok(r) => r,
        Err(e) => {
            return CommandStatus {
                code: "CHAN_WB_NETWORK_ERROR".to_string(),
                message: format!("Could not reach the bridge: {e}"),
                details: None,
            };
        }
    };

    let status = response.status();
    if status.is_success() {
        CommandStatus {
            code: "HUE_CHANNEL_POSITIONS_UPDATED".to_string(),
            message: "Positions saved to bridge.".to_string(),
            details: None,
        }
    } else {
        let body_text = response.text().unwrap_or_default();
        CommandStatus {
            code: "CHAN_WB_SCHEMA_REJECTED".to_string(),
            message: format!("Bridge rejected: {status}"),
            details: Some(body_text),
        }
    }
}
