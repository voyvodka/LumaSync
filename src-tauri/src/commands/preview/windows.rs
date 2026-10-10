//! The preview's windows. Both load `index.html`; `src/main.tsx` routes by
//! label. The twin learns its layout and display when it subscribes.

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

use tauri::{
    window::Color, AppHandle, LogicalPosition, LogicalSize, Manager, Position, Runtime, WebviewUrl,
    WebviewWindow, WebviewWindowBuilder,
};

use crate::commands::calibration::{build_transparent_overlay, DisplayInfoPayload};
use crate::commands::shell_state;

/// Mirrors `LED_TWIN_OVERLAY_LABEL_PREFIX` in `src/shared/contracts/preview.ts`.
/// Both preview labels end in a counter, never reused: a label stays reserved
/// until its destroy completes (see calibration.rs `OVERLAY_LABEL_COUNTER`), and
/// a closed window's late `Destroyed` must not be mistaken for the next
/// session's.
pub const LED_TWIN_OVERLAY_LABEL_PREFIX: &str = "led-twin-overlay-";

/// Mirrors `LED_CONTROL_POPUP_LABEL_PREFIX` in `src/shared/contracts/preview.ts`.
pub const LED_CONTROL_POPUP_LABEL_PREFIX: &str = "led-control-popup-";

static LABEL_COUNTER: AtomicU64 = AtomicU64::new(0);

/// macOS places a window in a Space when it is first shown. Shown before
/// `elevate_overlay_window` gives it `CanJoinAllSpaces | FullScreenAuxiliary`,
/// it lands on the desktop, not over the full-screen app the user is in; so
/// there both preview windows are built hidden and shown once elevated.
const SHOW_AFTER_ELEVATING: bool = cfg!(target_os = "macos");

pub(super) fn next_twin_label() -> String {
    let seq = LABEL_COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("{LED_TWIN_OVERLAY_LABEL_PREFIX}{seq}")
}

pub(super) fn next_popup_label() -> String {
    let seq = LABEL_COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("{LED_CONTROL_POPUP_LABEL_PREFIX}{seq}")
}

pub fn is_preview_window(label: &str) -> bool {
    label.starts_with(LED_TWIN_OVERLAY_LABEL_PREFIX)
        || label.starts_with(LED_CONTROL_POPUP_LABEL_PREFIX)
}

/// The click-through twin over `display`, raised into full-screen Spaces on
/// macOS so it stays over a full-screen film or game.
pub(super) fn build_twin<R: Runtime>(
    app: &AppHandle<R>,
    label: &str,
    display: &DisplayInfoPayload,
) -> Result<WebviewWindow<R>, String> {
    let window = build_transparent_overlay(
        app,
        label,
        WebviewUrl::App(PathBuf::from("index.html")),
        "LumaSync LED Twin",
        display,
        None,
        !SHOW_AFTER_ELEVATING,
    )?;
    #[cfg(target_os = "macos")]
    crate::macos_window::elevate_overlay_window(&window);
    super::exclusion::protect(&window);
    if SHOW_AFTER_ELEVATING {
        window
            .show()
            .map_err(|error| format!("could not show the LED twin: {error}"))?;
    }
    Ok(window)
}

/// A regular (Dock) app's windows are not put over another app's full-screen
/// Space, whatever their collection behaviour, and activating it switches the
/// user to the Space its main window lives on. While a session is open the app
/// runs as an accessory, which may float over full-screen apps; its Dock icon
/// goes for that time and comes back when the session ends.
pub(super) fn float_over_full_screen<R: Runtime>(app: &AppHandle<R>, float: bool) {
    #[cfg(target_os = "macos")]
    {
        let policy = if float {
            tauri::ActivationPolicy::Accessory
        } else {
            tauri::ActivationPolicy::Regular
        };
        if let Err(error) = app.set_activation_policy(policy) {
            log::warn!("[preview] activation policy not changed (float={float}): {error}");
        }
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (app, float);
}

/// The app the user was in when the preview opened, if not this one — on
/// macOS, where closing hands focus back to it rather than to the main window.
pub(super) fn app_in_front() -> Option<i32> {
    #[cfg(target_os = "macos")]
    return crate::macos_window::frontmost_other_app();
    #[cfg(not(target_os = "macos"))]
    None
}

const POPUP_WIDTH: f64 = 320.0;
const POPUP_HEIGHT: f64 = 460.0;
const POPUP_MIN_WIDTH: f64 = 300.0;
const POPUP_MIN_HEIGHT: f64 = 420.0;

/// The control popup, where the user last left it.
pub(super) fn build_popup<R: Runtime>(
    app: &AppHandle<R>,
    label: &str,
) -> Result<WebviewWindow<R>, String> {
    let zoom = shell_state::persisted(app).map_or(1.0, |state| state.ui_zoom());
    let (width, height) = (POPUP_WIDTH * zoom, POPUP_HEIGHT * zoom);
    let builder =
        WebviewWindowBuilder::new(app, label, WebviewUrl::App(PathBuf::from("index.html")))
            .title("LumaSync LED Controls")
            .inner_size(width, height)
            .min_inner_size(POPUP_MIN_WIDTH * zoom, POPUP_MIN_HEIGHT * zoom)
            .decorations(false)
            .resizable(false)
            .skip_taskbar(true)
            .always_on_top(true)
            .focused(!SHOW_AFTER_ELEVATING)
            .visible(!SHOW_AFTER_ELEVATING)
            // Opaque amber-dark: the popup is a control surface, not an overlay.
            .background_color(Color(18, 16, 14, 255));
    // Set before the first show, unlike the twin's: the popup is opaque.
    #[cfg(target_os = "windows")]
    let builder = builder.content_protected(super::exclusion::supported());
    let window = builder
        .build()
        .map_err(|error| format!("could not create the control popup: {error}"))?;

    if let Some((cx, cy)) = shell_state::persisted(app).and_then(|state| state.popup_center()) {
        let _ = window.set_position(Position::Logical(LogicalPosition::new(
            cx - width / 2.0,
            cy - height / 2.0,
        )));
    } else {
        let _ = window.center();
    }

    if zoom != 1.0 {
        if let Err(error) = window.set_zoom(zoom) {
            log::warn!("[ui-zoom] control popup zoom failed: {error}");
        }
    }

    #[cfg(target_os = "macos")]
    crate::macos_window::elevate_overlay_window(&window);
    super::exclusion::protect(&window);
    if SHOW_AFTER_ELEVATING {
        window
            .show()
            .and_then(|()| window.set_focus())
            .map_err(|error| format!("could not show the control popup: {error}"))?;
    }
    Ok(window)
}

/// Settings → Interface size, on the control popup: its frame grows with it so
/// its layout keeps its 320×460 viewport. The main window zooms itself, inside
/// the content fade that hides the reflow (`useUIMode`); zooming it from here
/// too reflowed the visible page a moment before or after that. Off the store's
/// lock, since a window call there would wait on the main thread while holding
/// it. The value is read when the task runs, not passed in: tasks from quick
/// changes (⌘+ held) may run in any order, and whichever runs last applies the
/// latest.
pub fn apply_ui_zoom_later<R: Runtime>(app: &AppHandle<R>) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let zoom = shell_state::persisted(&app).map_or(1.0, |state| state.ui_zoom());
        let popups = app
            .webview_windows()
            .into_iter()
            .filter(|(label, _)| label.starts_with(LED_CONTROL_POPUP_LABEL_PREFIX));
        for (_, popup) in popups {
            let resized = popup
                .set_min_size(Some(LogicalSize::new(
                    POPUP_MIN_WIDTH * zoom,
                    POPUP_MIN_HEIGHT * zoom,
                )))
                .and_then(|()| {
                    popup.set_size(LogicalSize::new(POPUP_WIDTH * zoom, POPUP_HEIGHT * zoom))
                })
                .and_then(|()| popup.set_zoom(zoom));
            if let Err(error) = resized {
                log::warn!("[ui-zoom] control popup zoom failed: {error}");
            }
        }
    });
}
