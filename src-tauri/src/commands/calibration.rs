use serde::{Deserialize, Serialize};

use super::device_connection::{CommandStatus, SerialConnectionState};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartCalibrationTestPatternPayload {
    pub led_indexes: Vec<u16>,
    pub frame_ms: u16,
    pub brightness: u8,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CalibrationCommandResponse {
    pub active: bool,
    pub preview_only: bool,
    pub status: CommandStatus,
}

#[tauri::command]
pub fn start_calibration_test_pattern(
    payload: StartCalibrationTestPatternPayload,
    connection_state: tauri::State<'_, SerialConnectionState>,
) -> Result<CalibrationCommandResponse, String> {
    if payload.led_indexes.is_empty() {
        return Err("CALIBRATION_PATTERN_INVALID: ledIndexes cannot be empty.".to_string());
    }

    if payload.frame_ms == 0 {
        return Err("CALIBRATION_PATTERN_INVALID: frameMs must be greater than zero.".to_string());
    }

    if payload.brightness == 0 {
        return Err(
            "CALIBRATION_PATTERN_INVALID: brightness must be greater than zero.".to_string(),
        );
    }

    let connected = connection_state
        .last_status
        .lock()
        .map(|status| status.connected)
        .map_err(|error| format!("CALIBRATION_STATE_READ_FAILED: {error}"))?;

    if connected {
        return Ok(CalibrationCommandResponse {
            active: true,
            preview_only: false,
            status: CommandStatus {
                code: "CALIBRATION_PATTERN_STARTED".to_string(),
                message: "Calibration test pattern started.".to_string(),
                details: None,
            },
        });
    }

    Ok(CalibrationCommandResponse {
        active: false,
        preview_only: true,
        status: CommandStatus {
            code: "CALIBRATION_PREVIEW_ONLY".to_string(),
            message: "Device is disconnected, running preview-only mode.".to_string(),
            details: Some("Connect a device to mirror preview on physical LEDs.".to_string()),
        },
    })
}

#[tauri::command]
pub fn stop_calibration_test_pattern(
    connection_state: tauri::State<'_, SerialConnectionState>,
) -> Result<CalibrationCommandResponse, String> {
    let connected = connection_state
        .last_status
        .lock()
        .map(|status| status.connected)
        .map_err(|error| format!("CALIBRATION_STATE_READ_FAILED: {error}"))?;

    Ok(CalibrationCommandResponse {
        active: false,
        preview_only: !connected,
        status: CommandStatus {
            code: "CALIBRATION_PATTERN_STOPPED".to_string(),
            message: "Calibration test pattern stopped.".to_string(),
            details: None,
        },
    })
}
