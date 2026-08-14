//! Display enumeration and the transparent click-through calibration overlay
//! window. Test patterns live in `lighting_mode::start_led_test_pattern` —
//! this module deliberately has no output path of its own.

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

use serde::{Deserialize, Serialize};
use tauri::{
    window::Color, AppHandle, LogicalPosition, LogicalSize, Manager, Position, Runtime, Size,
    State, WebviewUrl, WebviewWindowBuilder,
};

/// Metadata for one enumerated display, used to size and position the
/// calibration and LED-twin overlay windows.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DisplayInfoPayload {
    pub id: String,
    pub label: String,
    pub width: u32,
    pub height: u32,
    pub x: i32,
    pub y: i32,
    pub scale_factor: f64,
    pub is_primary: bool,
}

#[derive(Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct OverlayPreviewCountsPayload {
    pub top: u16,
    pub right: u16,
    pub bottom: u16,
    pub left: u16,
}

#[derive(Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct OverlayPreviewSequenceItemPayload {
    pub segment: String,
    pub local_index: u16,
}

/// Full preview state pushed into the calibration overlay webview on open
/// and on every live edit.
#[derive(Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct OverlayPreviewPayload {
    pub counts: OverlayPreviewCountsPayload,
    pub bottom_missing: u16,
    pub corner_ownership: String,
    pub visual_preset: String,
    pub sequence: Vec<OverlayPreviewSequenceItemPayload>,
    pub frame_ms: Option<u16>,
}

#[derive(Default)]
pub struct OverlayRuntimeState {
    pub active_display_id: Option<String>,
    pub active_overlay_label: Option<String>,
}

/// Tauri-managed state wrapping `OverlayRuntimeState` behind a mutex.
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

// Monotonic counter so every overlay open produces a fresh, unique label.
// `WebviewWindowBuilder::new` reserves labels in a registry that is NOT
// instantly freed when the prior window is destroyed (Tauri 2 destroy is
// asynchronous — see https://github.com/tauri-apps/tauri/issues/9627).
// On a frontend refresh while an overlay is open, the Rust process — and
// the registry — survives, so the next open call would collide on the
// hash-only label. Suffixing with a counter sidesteps the registry race
// entirely; `OverlayState` keeps the truth source for the active label.
static OVERLAY_LABEL_COUNTER: AtomicU64 = AtomicU64::new(0);

fn build_overlay_window_label(display_id: &str) -> String {
    let mut hasher = DefaultHasher::new();
    display_id.hash(&mut hasher);
    let seq = OVERLAY_LABEL_COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("calibration-overlay-{:016x}-{}", hasher.finish(), seq)
}

fn close_overlay_window<R: Runtime>(app: &AppHandle<R>, window_label: &str) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(window_label) {
        window
            .destroy()
            .map_err(|error| format!("OVERLAY_WINDOW_CLOSE_FAILED: {error}"))?;
    }

    Ok(())
}

/// Build a transparent, click-through, always-on-top overlay window sized and
/// positioned to fill `target_display`. Extracted from `open_overlay_window`
/// so the v1.6 LED-twin overlay can reuse the exact window recipe (transparent
/// background, ignore-cursor-events, Windows child-HWND clickthrough
/// propagation) without duplicating it. `init_script` is injected before any
/// page script runs — mirror of the calibration overlay's
/// `__LUMASYNC_OVERLAY_PREVIEW__` and the twin's `__LUMASYNC_TWIN_DISPLAY_ID__`.
pub fn build_transparent_overlay<R: Runtime>(
    app: &AppHandle<R>,
    window_label: &str,
    url: WebviewUrl,
    title: &str,
    target_display: &DisplayInfoPayload,
    init_script: Option<&str>,
) -> Result<tauri::WebviewWindow<R>, String> {
    let mut builder = WebviewWindowBuilder::new(app, window_label, url)
        .title(title)
        .decorations(false)
        .resizable(false)
        .closable(false)
        .fullscreen(false)
        .focused(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .shadow(false)
        .transparent(true)
        .background_color(Color(0, 0, 0, 0))
        .visible(true);
    if let Some(script) = init_script {
        builder = builder.initialization_script(script);
    }

    let window = builder
        .build()
        .map_err(|error| format!("OVERLAY_WINDOW_OPEN_FAILED: {error}"))?;

    // The display's known scale factor is used for logical coordinate
    // conversion. window.scale_factor() is unreliable immediately after
    // build() because the window may not have moved to the target monitor's
    // DPI context yet. Both platform branches used identical math, so this is
    // a single unified path now.
    let safe_scale = if target_display.scale_factor.is_finite() && target_display.scale_factor > 0.0
    {
        target_display.scale_factor
    } else {
        1.0
    };
    let logical_x = f64::from(target_display.x) / safe_scale;
    let logical_y = f64::from(target_display.y) / safe_scale;
    let logical_width = f64::from(target_display.width) / safe_scale;
    let logical_height = f64::from(target_display.height) / safe_scale;

    window
        .set_position(Position::Logical(LogicalPosition::new(
            logical_x, logical_y,
        )))
        .map_err(|error| format!("OVERLAY_WINDOW_POSITION_FAILED: {error}"))?;
    window
        .set_size(Size::Logical(LogicalSize::new(
            logical_width,
            logical_height,
        )))
        .map_err(|error| format!("OVERLAY_WINDOW_SIZE_FAILED: {error}"))?;
    window
        .set_ignore_cursor_events(true)
        .map_err(|error| format!("OVERLAY_WINDOW_CLICKTHROUGH_FAILED: {error}"))?;

    // On Windows, WebView2 creates child windows that do not inherit
    // WS_EX_TRANSPARENT from the parent. Propagate the flag to all child
    // windows so the overlay is truly click-through.
    #[cfg(target_os = "windows")]
    propagate_transparent_to_children(&window);

    Ok(window)
}

fn open_overlay_window<R: Runtime>(
    app: &AppHandle<R>,
    window_label: &str,
    target_display: &DisplayInfoPayload,
    preview: Option<&OverlayPreviewPayload>,
) -> Result<(), String> {
    let overlay_url = build_overlay_webview_url()?;
    let preview_json = serialize_overlay_preview_payload(preview)?;
    let preload_script = format!("window.__LUMASYNC_OVERLAY_PREVIEW__ = {preview_json};");

    let window = build_transparent_overlay(
        app,
        window_label,
        overlay_url,
        "Calibration Overlay",
        target_display,
        Some(preload_script.as_str()),
    )?;

    let _ = window.eval(
        "window.dispatchEvent(new CustomEvent('lumasync-overlay-preview', { detail: window.__LUMASYNC_OVERLAY_PREVIEW__ ?? null }));",
    );

    Ok(())
}

/// Walk every child HWND of the overlay window and apply WS_EX_TRANSPARENT | WS_EX_LAYERED
/// so that WebView2's internal child windows do not intercept mouse events. Without this,
/// the WebView2 host HWND (a child of our outer window) captures mouse events even though
/// the outer window has WS_EX_TRANSPARENT, making the overlay block all clicks behind it.
#[cfg(target_os = "windows")]
fn propagate_transparent_to_children<R: Runtime>(window: &tauri::WebviewWindow<R>) {
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};
    use windows_sys::Win32::Foundation::{HWND, LPARAM};
    use windows_sys::Win32::UI::WindowsAndMessaging::EnumChildWindows;

    let parent_hwnd: HWND = match window.window_handle() {
        Ok(handle) => match handle.as_raw() {
            // raw-window-handle 0.6: hwnd is NonZero<isize>, use .get()
            RawWindowHandle::Win32(h) => h.hwnd.get() as HWND,
            _ => return,
        },
        Err(_) => return,
    };

    unsafe extern "system" fn set_clickthrough(hwnd: HWND, _: LPARAM) -> i32 {
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            GetWindowLongPtrW, SetWindowLongPtrW, GWL_EXSTYLE, WS_EX_LAYERED, WS_EX_TRANSPARENT,
        };
        unsafe {
            let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
            SetWindowLongPtrW(
                hwnd,
                GWL_EXSTYLE,
                ex | WS_EX_TRANSPARENT as isize | WS_EX_LAYERED as isize,
            );
        }
        1
    }

    unsafe {
        EnumChildWindows(parent_hwnd, Some(set_clickthrough), 0);
    }
}

fn default_overlay_preview_payload() -> OverlayPreviewPayload {
    OverlayPreviewPayload {
        counts: OverlayPreviewCountsPayload {
            top: 16,
            right: 12,
            bottom: 16,
            left: 12,
        },
        bottom_missing: 0,
        corner_ownership: "horizontal".to_string(),
        visual_preset: "vivid".to_string(),
        sequence: vec![],
        frame_ms: Some(120),
    }
}

fn serialize_overlay_preview_payload(
    preview: Option<&OverlayPreviewPayload>,
) -> Result<String, String> {
    let resolved_preview = preview
        .cloned()
        .unwrap_or_else(default_overlay_preview_payload);
    serde_json::to_string(&resolved_preview)
        .map_err(|error| format!("OVERLAY_PREVIEW_SERIALIZE_FAILED: {error}"))
}

fn build_overlay_webview_url() -> Result<WebviewUrl, String> {
    Ok(WebviewUrl::App(PathBuf::from("calibration-overlay.html")))
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

/// List every enumerated display for the frontend's display picker. Falls
/// back to a single placeholder entry when the OS reports no monitors.
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
            scale_factor: 1.0,
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
                scale_factor: monitor.scale_factor(),
                is_primary,
            }
        })
        .collect();

    Ok(displays)
}

/// Open (or move) the calibration overlay onto the requested display,
/// closing any previously open overlay first.
#[tauri::command]
pub fn open_display_overlay<R: Runtime>(
    app: AppHandle<R>,
    overlay_state: State<'_, OverlayState>,
    display_id: String,
    preview: Option<OverlayPreviewPayload>,
) -> Result<DisplayOverlayCommandResult, String> {
    let displays = list_displays(app.clone())?;
    let target_display =
        if let Some(display) = displays.iter().find(|display| display.id == display_id) {
            display
        } else {
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
            if let Some(fallback_display) = displays
                .iter()
                .find(|display| display.is_primary)
                .or_else(|| displays.first())
            {
                fallback_display
            } else {
                return Ok(overlay_error_result(
                    "OVERLAY_OPEN_FAILED",
                    "Could not open display overlay.",
                    &reason,
                ));
            }
        };

    let resolved_display_id = target_display.id.as_str();

    let mut runtime = overlay_state
        .runtime
        .lock()
        .map_err(|error| format!("OVERLAY_STATE_LOCK_FAILED: {error}"))?;

    let previous_window_label = runtime.active_overlay_label.clone();
    let next_window_label = build_overlay_window_label(resolved_display_id);

    let result = apply_overlay_open_transition(
        &mut runtime,
        resolved_display_id,
        next_window_label.as_str(),
        || {
            if let Some(label) = previous_window_label {
                close_overlay_window(&app, label.as_str())?;
            }
            Ok(())
        },
        || {
            close_overlay_window(&app, next_window_label.as_str())?;
            open_overlay_window(
                &app,
                next_window_label.as_str(),
                target_display,
                preview.as_ref(),
            )
        },
    );

    if !result.ok {
        return Ok(result);
    }

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

    if runtime.active_display_id.as_deref() == Some(display_id.as_str())
        || runtime.active_overlay_label.is_some()
    {
        if let Some(active_overlay_label) = runtime.active_overlay_label.as_ref() {
            close_overlay_window(&app, active_overlay_label.as_str())?;
        }

        runtime.active_display_id = None;
        runtime.active_overlay_label = None;
    }

    Ok(overlay_result("OVERLAY_CLOSED", "Display overlay closed."))
}

/// Push an updated preview payload into the currently open calibration
/// overlay without reopening the window.
#[tauri::command]
pub fn update_display_overlay_preview<R: Runtime>(
    app: AppHandle<R>,
    overlay_state: State<'_, OverlayState>,
    preview: OverlayPreviewPayload,
) -> Result<DisplayOverlayCommandResult, String> {
    let runtime = overlay_state
        .runtime
        .lock()
        .map_err(|error| format!("OVERLAY_STATE_LOCK_FAILED: {error}"))?;

    let Some(active_overlay_label) = runtime.active_overlay_label.clone() else {
        return Ok(overlay_result(
            "OVERLAY_PREVIEW_SKIPPED",
            "No active display overlay.",
        ));
    };

    drop(runtime);

    let Some(window) = app.get_webview_window(active_overlay_label.as_str()) else {
        let reason = format!(
            "Active overlay window not found for label='{}'.",
            active_overlay_label
        );
        return Ok(overlay_error_result(
            "OVERLAY_PREVIEW_SYNC_FAILED",
            "Could not sync display overlay preview.",
            reason.as_str(),
        ));
    };

    let payload_json = serialize_overlay_preview_payload(Some(&preview))?;
    let sync_script = format!(
        "window.__LUMASYNC_OVERLAY_PREVIEW__ = {payload_json}; window.dispatchEvent(new CustomEvent('lumasync-overlay-preview', {{ detail: window.__LUMASYNC_OVERLAY_PREVIEW__ }}));"
    );

    if let Err(error) = window.eval(sync_script.as_str()) {
        let reason = format!("OVERLAY_PREVIEW_EVAL_FAILED: {error}");
        return Ok(overlay_error_result(
            "OVERLAY_PREVIEW_SYNC_FAILED",
            "Could not sync display overlay preview.",
            reason.as_str(),
        ));
    }

    Ok(overlay_result(
        "OVERLAY_PREVIEW_SYNCED",
        "Display overlay preview synced.",
    ))
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;

    use tauri::WebviewUrl;

    use super::{apply_overlay_open_transition, build_overlay_webview_url, OverlayRuntimeState};

    #[test]
    fn overlay_webview_url_uses_app_surface() {
        let url = build_overlay_webview_url().expect("app URL should parse");

        match url {
            WebviewUrl::App(path) => assert_eq!(path.to_string_lossy(), "calibration-overlay.html"),
            _ => panic!("expected app webview URL for overlay surface"),
        }
    }

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
