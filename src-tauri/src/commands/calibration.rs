use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime, State, WebviewUrl, WebviewWindowBuilder};

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
pub struct OverlayRuntimeState {
    pub active_display_id: Option<String>,
    pub active_overlay_label: Option<String>,
}

#[derive(Default)]
pub struct OverlayState {
    pub runtime: std::sync::Mutex<OverlayRuntimeState>,
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

fn build_overlay_window_label(display_id: &str) -> String {
    let mut hasher = DefaultHasher::new();
    display_id.hash(&mut hasher);
    format!("calibration-overlay-{:016x}", hasher.finish())
}

fn close_overlay_window<R: Runtime>(app: &AppHandle<R>, window_label: &str) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(window_label) {
        window
            .close()
            .map_err(|error| format!("OVERLAY_WINDOW_CLOSE_FAILED: {error}"))?;
    }

    Ok(())
}

fn open_overlay_window<R: Runtime>(
    app: &AppHandle<R>,
    window_label: &str,
    target_display: &DisplayInfoPayload,
) -> Result<(), String> {
    let builder =
        WebviewWindowBuilder::new(app, window_label, WebviewUrl::App("index.html".into()))
            .decorations(false)
            .resizable(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .visible(true)
            .position(target_display.x as f64, target_display.y as f64)
            .inner_size(target_display.width as f64, target_display.height as f64);

    builder
        .build()
        .map_err(|error| format!("OVERLAY_WINDOW_OPEN_FAILED: {error}"))?;

    Ok(())
}

fn apply_overlay_open_transition(
    runtime: &mut OverlayRuntimeState,
    display_id: &str,
    next_window_label: &str,
    close_previous: impl FnOnce() -> Result<(), String>,
    open_next: impl FnOnce() -> Result<(), String>,
) -> DisplayOverlayCommandResult {
    let close_result = close_previous();
    if let Err(reason) = close_result {
        return overlay_error_result(
            "OVERLAY_OPEN_FAILED",
            "Could not open display overlay.",
            &reason,
        );
    }

    let open_result = open_next();
    if let Err(reason) = open_result {
        runtime.active_display_id = None;
        runtime.active_overlay_label = None;
        return overlay_error_result(
            "OVERLAY_OPEN_FAILED",
            "Could not open display overlay.",
            &reason,
        );
    }

    runtime.active_display_id = Some(display_id.to_string());
    runtime.active_overlay_label = Some(next_window_label.to_string());
    overlay_result("OVERLAY_OPENED", "Display overlay opened.")
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
    let displays = list_displays(app.clone())?;
    let Some(target_display) = displays.iter().find(|display| display.id == display_id) else {
        let available_ids = displays
            .iter()
            .map(|display| display.id.as_str())
            .collect::<Vec<_>>()
            .join(", ");
        let reason = if available_ids.is_empty() {
            format!("Requested display id='{display_id}' not found. No displays available.")
        } else {
            format!(
                "Requested display id='{display_id}' not found. Available ids: [{available_ids}]"
            )
        };
        eprintln!("[LumaSync] OVERLAY_OPEN_FAILED: {reason}");
        return Ok(overlay_error_result(
            "OVERLAY_OPEN_FAILED",
            "Could not open display overlay.",
            &reason,
        ));
    };

    let mut runtime = overlay_state
        .runtime
        .lock()
        .map_err(|error| format!("OVERLAY_STATE_LOCK_FAILED: {error}"))?;

    let previous_window_label = runtime.active_overlay_label.clone();
    let next_window_label = build_overlay_window_label(display_id.as_str());

    let result = apply_overlay_open_transition(
        &mut runtime,
        display_id.as_str(),
        next_window_label.as_str(),
        || {
            if let Some(label) = previous_window_label {
                close_overlay_window(&app, label.as_str())?;
            }
            Ok(())
        },
        || {
            close_overlay_window(&app, next_window_label.as_str())?;
            open_overlay_window(&app, next_window_label.as_str(), target_display)
        },
    );

    if !result.ok {
        if let Some(reason) = result.reason.as_deref() {
            eprintln!("[LumaSync] OVERLAY_OPEN_FAILED: {reason}");
        }
        return Ok(result);
    }

    eprintln!("[LumaSync] OVERLAY_OPENED");

    Ok(result)
}

#[tauri::command]
pub fn close_display_overlay<R: Runtime>(
    app: AppHandle<R>,
    overlay_state: State<'_, OverlayState>,
    display_id: String,
) -> Result<DisplayOverlayCommandResult, String> {
    let mut runtime = overlay_state
        .runtime
        .lock()
        .map_err(|error| format!("OVERLAY_STATE_LOCK_FAILED: {error}"))?;

    if runtime.active_display_id.as_deref() == Some(display_id.as_str()) {
        if let Some(active_overlay_label) = runtime.active_overlay_label.as_ref() {
            close_overlay_window(&app, active_overlay_label.as_str())?;
        }

        runtime.active_display_id = None;
        runtime.active_overlay_label = None;
    }

    Ok(overlay_result("OVERLAY_CLOSED", "Display overlay closed."))
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;

    use super::{apply_overlay_open_transition, OverlayRuntimeState};

    #[test]
    fn overlay_opened_sets_runtime_state() {
        let mut runtime = OverlayRuntimeState::default();
        let result = apply_overlay_open_transition(
            &mut runtime,
            "display-1",
            "window-1",
            || Ok(()),
            || Ok(()),
        );

        assert!(result.ok);
        assert_eq!(result.code, "OVERLAY_OPENED");
        assert_eq!(runtime.active_display_id.as_deref(), Some("display-1"));
        assert_eq!(runtime.active_overlay_label.as_deref(), Some("window-1"));
    }

    #[test]
    fn open_transition_closes_old_then_opens_new() {
        let mut runtime = OverlayRuntimeState {
            active_display_id: Some("display-1".to_string()),
            active_overlay_label: Some("window-1".to_string()),
        };
        let order = RefCell::new(Vec::new());

        let result = apply_overlay_open_transition(
            &mut runtime,
            "display-2",
            "window-2",
            || {
                order.borrow_mut().push("close-old");
                Ok(())
            },
            || {
                order.borrow_mut().push("open-new");
                Ok(())
            },
        );

        assert!(result.ok);
        assert_eq!(*order.borrow(), vec!["close-old", "open-new"]);
        assert_eq!(runtime.active_display_id.as_deref(), Some("display-2"));
        assert_eq!(runtime.active_overlay_label.as_deref(), Some("window-2"));
    }

    #[test]
    fn overlay_open_failed_keeps_state_inactive() {
        let mut runtime = OverlayRuntimeState {
            active_display_id: Some("display-1".to_string()),
            active_overlay_label: Some("window-1".to_string()),
        };

        let result = apply_overlay_open_transition(
            &mut runtime,
            "display-2",
            "window-2",
            || Ok(()),
            || Err("Permission denied".to_string()),
        );

        assert!(!result.ok);
        assert_eq!(result.code, "OVERLAY_OPEN_FAILED");
        assert_eq!(result.reason.as_deref(), Some("Permission denied"));
        assert_eq!(runtime.active_display_id, None);
        assert_eq!(runtime.active_overlay_label, None);
    }
}

#[tauri::command]
pub fn start_calibration_test_pattern(
    payload: StartCalibrationTestPatternPayload,
    connection_state: tauri::State<'_, SerialConnectionState>,
) -> Result<CalibrationCommandResponse, String> {
    eprintln!(
        "[LumaSync] start_calibration_test_pattern request: led_count={}, frame_ms={}, brightness={}",
        payload.led_indexes.len(),
        payload.frame_ms,
        payload.brightness
    );

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
        eprintln!("[LumaSync] start_calibration_test_pattern result: sending");
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

    eprintln!("[LumaSync] start_calibration_test_pattern result: preview-only");

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
    eprintln!("[LumaSync] stop_calibration_test_pattern request");
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
