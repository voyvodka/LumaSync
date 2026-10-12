//! The preview's windows. Both load `index.html`; `src/main.tsx` routes by
//! label. The twin learns its layout and display when it subscribes.

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

use tauri::{
    window::Color, AppHandle, LogicalPosition, LogicalSize, Manager, Position, Runtime, WebviewUrl,
    WebviewWindow, WebviewWindowBuilder,
};
#[cfg(target_os = "windows")]
use tauri::{PhysicalPosition, PhysicalSize};

use crate::commands::calibration::{build_transparent_overlay, DisplayInfoPayload};
use crate::commands::shell_state;

/// Mirrors `LED_TWIN_OVERLAY_LABEL_PREFIX` in `src/shared/contracts/preview.ts`.
/// Both preview labels end in a counter, never given to a second window: a
/// label stays reserved until its destroy completes (see calibration.rs
/// `OVERLAY_LABEL_COUNTER`), and a destroyed window's late `Destroyed` must not
/// be mistaken for the next session's. A kept window keeps its label from one
/// session to the next.
pub const LED_TWIN_OVERLAY_LABEL_PREFIX: &str = "led-twin-overlay-";

/// Mirrors `LED_PREVIEW_SCENE_LABEL_PREFIX` in `src/shared/contracts/preview.ts`.
pub const LED_PREVIEW_SCENE_LABEL_PREFIX: &str = "led-preview-scene-";

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

pub(super) fn next_scene_label() -> String {
    let seq = LABEL_COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("{LED_PREVIEW_SCENE_LABEL_PREFIX}{seq}")
}

pub fn is_preview_window(label: &str) -> bool {
    label.starts_with(LED_TWIN_OVERLAY_LABEL_PREFIX)
        || label.starts_with(LED_CONTROL_POPUP_LABEL_PREFIX)
        || label.starts_with(LED_PREVIEW_SCENE_LABEL_PREFIX)
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

/// A kept twin or scene window, moved onto `display` and loaded afresh so it
/// reads the session it now belongs to. Kept rather than rebuilt: a destroyed
/// webview window stays in memory for the life of the process (tao keeps its
/// NSWindow on macOS), so a new one per session or scene grew without end.
pub(super) fn reuse_on_display<R: Runtime>(
    window: &WebviewWindow<R>,
    display: &DisplayInfoPayload,
) -> Result<(), String> {
    // Windows converts a logical position with the scale of the monitor the
    // window is on *now* — the previous display — so a kept window crossing
    // to a display of another scale lands off by their ratio. The monitor's
    // own physical numbers need no conversion. macOS places in points, which
    // the target's scale gives.
    #[cfg(target_os = "windows")]
    let placed = window
        .set_position(Position::Physical(PhysicalPosition::new(
            display.x, display.y,
        )))
        .and_then(|()| {
            window.set_size(PhysicalSize::new(
                display.width.max(1),
                display.height.max(1),
            ))
        });
    #[cfg(not(target_os = "windows"))]
    let placed = {
        let scale = if display.scale_factor.is_finite() && display.scale_factor > 0.0 {
            display.scale_factor
        } else {
            1.0
        };
        window
            .set_position(Position::Logical(LogicalPosition::new(
                f64::from(display.x) / scale,
                f64::from(display.y) / scale,
            )))
            .and_then(|()| {
                window.set_size(LogicalSize::new(
                    f64::from(display.width) / scale,
                    f64::from(display.height) / scale,
                ))
            })
    };
    placed
        .and_then(|()| window.reload())
        .and_then(|()| window.show())
        .map_err(|error| format!("could not bring {} back: {error}", window.label()))
}

/// A popup kept from an earlier session, loaded afresh: it reads the new
/// session on mount.
pub(super) fn reuse_popup<R: Runtime>(window: &WebviewWindow<R>) -> Result<(), String> {
    window
        .reload()
        .and_then(|()| window.show())
        .and_then(|()| window.set_focus())
        .map_err(|error| format!("could not bring the control popup back: {error}"))
}

/// The scene over `display`, under the twin and the popup: click-through like
/// the twin, its page drawing the scene opaque. Never kept out of the capture —
/// lighting the strip from it is the point. Answers the window number the
/// capture filter excepts it by (macOS).
pub(super) fn build_scene<R: Runtime>(
    app: &AppHandle<R>,
    label: &str,
    display: &DisplayInfoPayload,
) -> Result<(WebviewWindow<R>, Option<u32>), String> {
    let window = build_transparent_overlay(
        app,
        label,
        WebviewUrl::App(PathBuf::from("index.html")),
        "LumaSync LED Scene",
        display,
        None,
        !SHOW_AFTER_ELEVATING,
    )?;
    #[cfg(target_os = "macos")]
    crate::macos_window::elevate_overlay_window(&window);
    if SHOW_AFTER_ELEVATING {
        window
            .show()
            .map_err(|error| format!("could not show the scene: {error}"))?;
    }
    #[cfg(target_os = "macos")]
    let number = crate::macos_window::window_number(&window);
    #[cfg(not(target_os = "macos"))]
    let number = None;
    Ok((window, number))
}

/// The twin and the popup back over the scene, which shares their level and,
/// shown last, lies on top of them.
pub(super) fn raise_over_scene<R: Runtime>(app: &AppHandle<R>, labels: &[String]) {
    for label in labels {
        let Some(window) = app.get_webview_window(label) else {
            continue;
        };
        #[cfg(target_os = "macos")]
        crate::macos_window::order_front_regardless(&window);
        #[cfg(not(target_os = "macos"))]
        let _ = window
            .set_always_on_top(false)
            .and_then(|()| window.set_always_on_top(true));
    }
}

/// A regular (Dock) app's windows are not put over another app's full-screen
/// Space by their collection behaviour alone, and activating it switches the
/// user to the Space its main window lives on. While a session is open the app
/// runs as an accessory, which may float over full-screen apps; its Dock icon
/// goes for that time and comes back when the session ends. Turning an active
/// app into an accessory deactivates it, so a session opened from inside the
/// app waits until the user is in another one (`watch_front_app`).
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

/// While a session is open, note each app the user goes to (macOS).
pub fn watch_front_app<R: Runtime>(app: &AppHandle<R>) {
    #[cfg(target_os = "macos")]
    {
        use std::ptr::NonNull;

        use block2::RcBlock;
        use objc2_app_kit::{NSWorkspace, NSWorkspaceDidActivateApplicationNotification};
        use objc2_foundation::NSNotification;

        let app = app.clone();
        let block = RcBlock::new(move |_: NonNull<NSNotification>| {
            if let Some(pid) = crate::macos_window::frontmost_other_app() {
                super::session::on_other_app_activated(&app, pid);
            }
        });
        let center = NSWorkspace::sharedWorkspace().notificationCenter();
        // SAFETY: AppKit's notification-name constant; no object filter and no
        // queue, so the block runs on the posting thread, NSWorkspace's main
        // thread. It only clones an `AppHandle`, which is Send.
        let token = unsafe {
            center.addObserverForName_object_queue_usingBlock(
                Some(NSWorkspaceDidActivateApplicationNotification),
                None,
                None,
                &block,
            )
        };
        // Lives as long as the app; nothing ever removes it.
        std::mem::forget(token);
    }
    #[cfg(not(target_os = "macos"))]
    let _ = app;
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
/// The scene tiles, the modes and the compact window's tallest stage (Effect) without scrolling.
const POPUP_HEIGHT: f64 = 560.0;
const POPUP_MIN_WIDTH: f64 = 300.0;
const POPUP_MIN_HEIGHT: f64 = 480.0;
/// Kept clear above and below the popup on a screen too short for it.
const POPUP_SCREEN_MARGIN: f64 = 24.0;

/// The popup's frame at `zoom`: its viewport times the interface size, and never
/// taller than the screen it opens on (the primary display's work area) — a
/// small screen at a large size scrolls the popup rather than cut it off.
fn popup_frame<R: Runtime>(app: &AppHandle<R>, zoom: f64) -> (LogicalSize<f64>, LogicalSize<f64>) {
    let room = app
        .primary_monitor()
        .ok()
        .flatten()
        .map(|monitor| f64::from(monitor.work_area().size.height) / monitor.scale_factor())
        .filter(|room| room.is_finite() && *room > 0.0)
        .map_or(f64::INFINITY, |room| room - 2.0 * POPUP_SCREEN_MARGIN);
    let height = (POPUP_HEIGHT * zoom).min(room);
    let min_height = (POPUP_MIN_HEIGHT * zoom).min(height);
    (
        LogicalSize::new(POPUP_WIDTH * zoom, height),
        LogicalSize::new(POPUP_MIN_WIDTH * zoom, min_height),
    )
}

/// The control popup, where the user last left it.
pub(super) fn build_popup<R: Runtime>(
    app: &AppHandle<R>,
    label: &str,
) -> Result<WebviewWindow<R>, String> {
    let zoom = shell_state::persisted(app).map_or(1.0, |state| state.ui_zoom());
    let (frame, min_frame) = popup_frame(app, zoom);
    let (width, height) = (frame.width, frame.height);
    let builder =
        WebviewWindowBuilder::new(app, label, WebviewUrl::App(PathBuf::from("index.html")))
            .title("LumaSync LED Controls")
            .inner_size(width, height)
            .min_inner_size(min_frame.width, min_frame.height)
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
/// its layout keeps its 320×560 viewport. The main window zooms itself, inside
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
        let (frame, min_frame) = popup_frame(&app, zoom);
        for (_, popup) in popups {
            let resized = popup
                .set_min_size(Some(min_frame))
                .and_then(|()| popup.set_size(frame))
                .and_then(|()| popup.set_zoom(zoom));
            if let Err(error) = resized {
                log::warn!("[ui-zoom] control popup zoom failed: {error}");
            }
        }
    });
}
