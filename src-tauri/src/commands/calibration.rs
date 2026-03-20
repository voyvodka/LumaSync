use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime, State};

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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DisplayInfoPayload {
    pub id: String,
    pub label: String,
    pub width: u32,
    pub height: u32,
    pub x: i32,
    pub y: i32,
    pub is_primary: bool,
}

#[derive(Default)]
pub struct OverlayState {
    pub active_display_id: std::sync::Mutex<Option<String>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DisplayOverlayCommandResult {
    pub ok: bool,
    pub code: String,
    pub message: String,
    pub reason: Option<String>,
}

fn overlay_result(code: &str, message: &str) -> DisplayOverlayCommandResult {
    DisplayOverlayCommandResult {
        ok: true,
        code: code.to_string(),
        message: message.to_string(),
        reason: None,
    }
}

fn overlay_error_result(code: &str, message: &str, reason: &str) -> DisplayOverlayCommandResult {
    DisplayOverlayCommandResult {
        ok: false,
        code: code.to_string(),
        message: message.to_string(),
        reason: Some(reason.to_string()),
    }
}

#[tauri::command]
pub fn list_displays<R: Runtime>(app: AppHandle<R>) -> Result<Vec<DisplayInfoPayload>, String> {
    let monitors = app
        .available_monitors()
        .map_err(|error| format!("DISPLAY_LIST_FAILED: {error}"))?;

    if monitors.is_empty() {
        return Ok(vec![DisplayInfoPayload {
            id: "primary".to_string(),
            label: "Primary Display".to_string(),
            width: 0,
            height: 0,
            x: 0,
            y: 0,
            is_primary: true,
        }]);
    }

    let primary_name = app
        .primary_monitor()
        .ok()
        .flatten()
        .and_then(|monitor| monitor.name().map(|name| name.to_string()));

    let displays = monitors
        .into_iter()
        .enumerate()
        .map(|(index, monitor)| {
            let name = monitor
                .name()
                .map(|value| value.to_string())
                .unwrap_or_else(|| format!("Display {}", index + 1));
            let position = monitor.position();
            let size = monitor.size();
            let is_primary = primary_name
                .as_ref()
                .is_some_and(|primary| primary == &name);

            DisplayInfoPayload {
                id: format!("{}:{}:{}", name, position.x, position.y),
                label: name,
                width: size.width,
                height: size.height,
                x: position.x,
                y: position.y,
                is_primary,
            }
        })
        .collect();

    Ok(displays)
}

#[tauri::command]
pub fn open_display_overlay<R: Runtime>(
    app: AppHandle<R>,
    overlay_state: State<'_, OverlayState>,
    display_id: String,
) -> Result<DisplayOverlayCommandResult, String> {
    let displays = list_displays(app)?;
    let exists = displays.iter().any(|display| display.id == display_id);
    if !exists {
        return Ok(overlay_error_result(
            "OVERLAY_OPEN_FAILED",
            "Could not open display overlay.",
            "Requested display was not found.",
        ));
    }

    let mut active = overlay_state
        .active_display_id
        .lock()
        .map_err(|error| format!("OVERLAY_STATE_LOCK_FAILED: {error}"))?;
    *active = Some(display_id);

    Ok(overlay_result("OVERLAY_OPENED", "Display overlay opened."))
}

#[tauri::command]
pub fn close_display_overlay(
    overlay_state: State<'_, OverlayState>,
    display_id: String,
) -> Result<DisplayOverlayCommandResult, String> {
    let mut active = overlay_state
        .active_display_id
        .lock()
        .map_err(|error| format!("OVERLAY_STATE_LOCK_FAILED: {error}"))?;

    if active.as_deref() == Some(display_id.as_str()) {
        *active = None;
    }

    Ok(overlay_result("OVERLAY_CLOSED", "Display overlay closed."))
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
