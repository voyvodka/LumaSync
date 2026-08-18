//! Display enumeration and the transparent click-through calibration overlay
//! window. Test patterns live in `lighting_mode::start_led_test_pattern` —
//! this module deliberately has no output path of its own.

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

use serde::{Deserialize, Serialize};
use tauri::{
    AppHandle, LogicalPosition, LogicalSize, Manager, Position, Runtime, Size, State, WebviewUrl,
    WebviewWindowBuilder,
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
        // No `background_color`: wry forces (0,0,0,0) on a transparent webview
        // anyway, while tao's window layer drops the alpha and erases the client
        // area with an opaque brush. `focusable(false)` keeps the overlay out of
        // the activation chain (WS_EX_NOACTIVATE on Windows).
        // See docs/architecture/ui-and-shell.md.
        .focusable(false)
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

    // WebView2's children do not inherit the parent's ex-style; see
    // docs/architecture/ui-and-shell.md for what may and may not be ORed on.
    #[cfg(target_os = "windows")]
    {
        propagate_transparent_to_children(&window, "initial");
        schedule_clickthrough_resweeps(&window);
    }

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

/// Re-sweep schedule, in milliseconds after the initial synchronous sweep.
///
/// WebView2 does not have all of its child HWNDs in place when `build()` returns —
/// the render-widget child appears when content loads, later still — so the sweep
/// on the next line can find nothing to mark. The tail outlasts a cold WebView2
/// start on a slow machine, and the ex-style bits are idempotent, so a sweep that
/// finds an already-marked child costs nothing.
#[cfg(target_os = "windows")]
const CLICKTHROUGH_RESWEEP_DELAYS_MS: [u64; 5] = [50, 150, 400, 1000, 2500];

/// Mark the children WebView2 had not created yet when the overlay was built.
/// See `CLICKTHROUGH_RESWEEP_DELAYS_MS` for why one sweep is not enough.
#[cfg(target_os = "windows")]
fn schedule_clickthrough_resweeps<R: Runtime>(window: &tauri::WebviewWindow<R>) {
    let app = window.app_handle().clone();
    let label = window.label().to_string();

    std::thread::spawn(move || {
        for delay_ms in CLICKTHROUGH_RESWEEP_DELAYS_MS {
            std::thread::sleep(std::time::Duration::from_millis(delay_ms));

            // The overlay closes on its own schedule; a sweep still pending then
            // has nothing left to mark.
            if app.get_webview_window(&label).is_none() {
                return;
            }

            let sweep_app = app.clone();
            let sweep_label = label.clone();
            let dispatched = app.run_on_main_thread(move || {
                if let Some(window) = sweep_app.get_webview_window(&sweep_label) {
                    propagate_transparent_to_children(&window, &format!("resweep+{delay_ms}ms"));
                }
            });
            if dispatched.is_err() {
                return;
            }
        }
    });
}

/// What the Windows child-HWND sweep is allowed to OR onto each descendant.
///
/// `WS_EX_LAYERED` is deliberately NOT the default: a window handed that bit by
/// `SetWindowLongPtr` stays invisible until somebody calls
/// `SetLayeredWindowAttributes`/`UpdateLayeredWindow` on it, and nothing does for
/// WebView2's windows. See docs/architecture/ui-and-shell.md.
#[cfg(target_os = "windows")]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum ChildSweepMode {
    /// Touch no child at all — the top-level's own click-through has to carry it.
    Off,
    /// `WS_EX_TRANSPARENT` only. Default.
    Transparent,
    /// `WS_EX_TRANSPARENT | WS_EX_LAYERED` — reproduces the <= 1.5.5 behaviour,
    /// kept only so the two can be compared on one machine.
    TransparentLayered,
}

/// Read `LUMASYNC_WIN_OVERLAY_SWEEP` once per process.
#[cfg(target_os = "windows")]
fn child_sweep_mode() -> ChildSweepMode {
    static MODE: std::sync::OnceLock<ChildSweepMode> = std::sync::OnceLock::new();
    *MODE.get_or_init(|| {
        let raw = std::env::var("LUMASYNC_WIN_OVERLAY_SWEEP").unwrap_or_default();
        let mode = match raw.trim().to_ascii_lowercase().as_str() {
            "" | "transparent" => ChildSweepMode::Transparent,
            "off" | "none" => ChildSweepMode::Off,
            "transparent+layered" | "layered" => ChildSweepMode::TransparentLayered,
            other => {
                log::warn!(
                    "[overlay-sweep] unknown LUMASYNC_WIN_OVERLAY_SWEEP='{other}' — using 'transparent'"
                );
                ChildSweepMode::Transparent
            }
        };
        log::info!("[overlay-sweep] child sweep mode = {mode:?}");
        mode
    })
}

/// Per-sweep counters, handed to `EnumChildWindows` through its `LPARAM`.
#[cfg(target_os = "windows")]
struct ChildSweepTally {
    tag: String,
    added_bits: isize,
    found: u32,
    changed: u32,
    already: u32,
    failed: u32,
    frame_failed: u32,
}

/// Walk every child HWND of the overlay window and OR the configured
/// click-through bits onto it, because WebView2's host and render-widget windows
/// do not inherit the parent's `WS_EX_TRANSPARENT`. The bits are idempotent, so a
/// sweep that finds an already-marked window changes nothing.
///
/// `tag` names the sweep ("initial" / "resweep+400ms") in the log.
#[cfg(target_os = "windows")]
fn propagate_transparent_to_children<R: Runtime>(window: &tauri::WebviewWindow<R>, tag: &str) {
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};
    use windows_sys::Win32::Foundation::{HWND, LPARAM};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        EnumChildWindows, WS_EX_LAYERED, WS_EX_TRANSPARENT,
    };

    let mode = child_sweep_mode();
    let added_bits: isize = match mode {
        ChildSweepMode::Off => {
            log::debug!("[overlay-sweep] {tag}: skipped (LUMASYNC_WIN_OVERLAY_SWEEP=off)");
            return;
        }
        ChildSweepMode::Transparent => WS_EX_TRANSPARENT as isize,
        ChildSweepMode::TransparentLayered => (WS_EX_TRANSPARENT | WS_EX_LAYERED) as isize,
    };

    let parent_hwnd: HWND = match window.window_handle() {
        Ok(handle) => match handle.as_raw() {
            // raw-window-handle 0.6: hwnd is NonZero<isize>, use .get()
            RawWindowHandle::Win32(h) => h.hwnd.get() as HWND,
            _ => return,
        },
        Err(_) => return,
    };

    let mut tally = ChildSweepTally {
        tag: tag.to_string(),
        added_bits,
        found: 0,
        changed: 0,
        already: 0,
        failed: 0,
        frame_failed: 0,
    };

    unsafe {
        EnumChildWindows(
            parent_hwnd,
            Some(mark_child_clickthrough),
            &mut tally as *mut ChildSweepTally as LPARAM,
        );
    }

    log::info!(
        "[overlay-sweep] {}: mode={:?} bits={:#x} found={} changed={} already={} set-failed={} frame-failed={}",
        tally.tag,
        mode,
        tally.added_bits,
        tally.found,
        tally.changed,
        tally.already,
        tally.failed,
        tally.frame_failed
    );
}

/// `EnumChildWindows` callback. `lparam` is the `ChildSweepTally` the caller kept
/// alive for the duration of the enumeration.
#[cfg(target_os = "windows")]
unsafe extern "system" fn mark_child_clickthrough(
    hwnd: windows_sys::Win32::Foundation::HWND,
    lparam: windows_sys::Win32::Foundation::LPARAM,
) -> i32 {
    use windows_sys::Win32::Foundation::{GetLastError, SetLastError};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetClassNameW, GetWindowLongPtrW, GetWindowThreadProcessId, SetWindowLongPtrW,
        SetWindowPos, GWL_EXSTYLE, SWP_FRAMECHANGED, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE,
        SWP_NOZORDER,
    };

    // SAFETY: `EnumChildWindows` passes back exactly the pointer we handed it,
    // and the tally outlives the enumeration on the calling stack frame.
    let tally = unsafe { &mut *(lparam as *mut ChildSweepTally) };
    tally.found += 1;

    let mut class_buffer = [0u16; 128];
    let class_len =
        unsafe { GetClassNameW(hwnd, class_buffer.as_mut_ptr(), class_buffer.len() as i32) };
    let class_name = if class_len > 0 {
        String::from_utf16_lossy(&class_buffer[..class_len as usize])
    } else {
        String::from("<unknown>")
    };

    let mut owner_pid: u32 = 0;
    unsafe { GetWindowThreadProcessId(hwnd, &mut owner_pid) };

    let ex_before = unsafe { GetWindowLongPtrW(hwnd, GWL_EXSTYLE) };
    let ex_wanted = ex_before | tally.added_bits;

    if ex_before == ex_wanted {
        tally.already += 1;
        log::debug!(
            "[overlay-sweep] {}: hwnd={:#x} class='{}' pid={} ex={:#x} (already marked)",
            tally.tag,
            hwnd as usize,
            class_name,
            owner_pid,
            ex_before
        );
        return 1;
    }

    // SetWindowLongPtrW returns 0 both for "previous value was 0" and for
    // failure, so the error has to be read out of the thread's last-error slot —
    // a cross-process/UIPI refusal on WebView2's windows must not look like success.
    unsafe { SetLastError(0) };
    let previous_ex = unsafe { SetWindowLongPtrW(hwnd, GWL_EXSTYLE, ex_wanted) };
    let set_error = unsafe { GetLastError() };
    if previous_ex == 0 && set_error != 0 {
        tally.failed += 1;
        log::debug!(
            "[overlay-sweep] {}: hwnd={:#x} class='{}' pid={} ex={:#x} -> {:#x} SET FAILED err={}",
            tally.tag,
            hwnd as usize,
            class_name,
            owner_pid,
            ex_before,
            ex_wanted,
            set_error
        );
        return 1;
    }

    // An ex-style written with SetWindowLongPtr is cached until a frame change is
    // forced; without this the new bits are not in effect.
    unsafe { SetLastError(0) };
    let framed = unsafe {
        SetWindowPos(
            hwnd,
            std::ptr::null_mut(),
            0,
            0,
            0,
            0,
            SWP_FRAMECHANGED | SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE,
        )
    };
    let frame_error = if framed == 0 {
        unsafe { GetLastError() }
    } else {
        0
    };
    if framed == 0 {
        tally.frame_failed += 1;
    }

    let ex_after = unsafe { GetWindowLongPtrW(hwnd, GWL_EXSTYLE) };
    tally.changed += 1;
    log::debug!(
        "[overlay-sweep] {}: hwnd={:#x} class='{}' pid={} ex={:#x} -> {:#x} frame-err={}",
        tally.tag,
        hwnd as usize,
        class_name,
        owner_pid,
        ex_before,
        ex_after,
        frame_error
    );

    1
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

/// Result of the window work an overlay open performs, carried back to the
/// bookkeeping step so the two can be separated by a lock release.
#[derive(Debug, PartialEq, Eq)]
enum OverlayOpenOutcome {
    Opened,
    ClosePreviousFailed(String),
    OpenNextFailed(String),
}

/// Close the previous overlay, then open the next one. Split out of
/// `apply_overlay_open_transition` so the window calls — `destroy()` and
/// `build()` — run with the `OverlayState` lock *released*; see
/// docs/architecture/ui-and-shell.md for the nested-message-pump reason.
fn run_overlay_open_transition(
    close_previous: impl FnOnce() -> Result<(), String>,
    open_next: impl FnOnce() -> Result<(), String>,
) -> OverlayOpenOutcome {
    if let Err(reason) = close_previous() {
        return OverlayOpenOutcome::ClosePreviousFailed(reason);
    }

    if let Err(reason) = open_next() {
        return OverlayOpenOutcome::OpenNextFailed(reason);
    }

    OverlayOpenOutcome::Opened
}

/// Commit the bookkeeping for an already-performed open. A failure to close the
/// previous overlay leaves the recorded state alone — that overlay is still up —
/// while a failure to open the next one clears it, since nothing is showing.
fn apply_overlay_open_transition(
    runtime: &mut OverlayRuntimeState,
    display_id: &str,
    next_window_label: &str,
    outcome: OverlayOpenOutcome,
) -> DisplayOverlayCommandResult {
    match outcome {
        OverlayOpenOutcome::ClosePreviousFailed(reason) => overlay_error_result(
            "OVERLAY_OPEN_FAILED",
            "Could not open display overlay.",
            &reason,
        ),
        OverlayOpenOutcome::OpenNextFailed(reason) => {
            runtime.active_display_id = None;
            runtime.active_overlay_label = None;
            overlay_error_result(
                "OVERLAY_OPEN_FAILED",
                "Could not open display overlay.",
                &reason,
            )
        }
        OverlayOpenOutcome::Opened => {
            runtime.active_display_id = Some(display_id.to_string());
            runtime.active_overlay_label = Some(next_window_label.to_string());
            overlay_result("OVERLAY_OPENED", "Display overlay opened.")
        }
    }
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

    // Read what we need and let the lock go before touching any window: on
    // Windows `build()` runs a nested message pump that can re-enter this
    // command on the same thread, and `std::sync::Mutex` is not reentrant.
    // See docs/architecture/ui-and-shell.md.
    let (previous_window_label, next_window_label) = {
        let runtime = overlay_state
            .runtime
            .lock()
            .map_err(|error| format!("OVERLAY_STATE_LOCK_FAILED: {error}"))?;
        (
            runtime.active_overlay_label.clone(),
            build_overlay_window_label(resolved_display_id),
        )
    };

    let outcome = run_overlay_open_transition(
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

    let mut runtime = overlay_state
        .runtime
        .lock()
        .map_err(|error| format!("OVERLAY_STATE_LOCK_FAILED: {error}"))?;

    Ok(apply_overlay_open_transition(
        &mut runtime,
        resolved_display_id,
        next_window_label.as_str(),
        outcome,
    ))
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

/// Close whichever calibration overlay is open, on whatever display.
///
/// `close_display_overlay` takes a display id because its callers know one.
/// The tray rescue does not, and must not have to ask the frontend for it —
/// see `close_all_overlays` in `lib.rs` for why that path stays in the backend.
pub(crate) fn close_any_display_overlay<R: Runtime>(
    app: &AppHandle<R>,
    overlay_state: &OverlayState,
) -> Result<(), String> {
    let mut runtime = overlay_state
        .runtime
        .lock()
        .map_err(|error| format!("OVERLAY_STATE_LOCK_FAILED: {error}"))?;

    apply_overlay_close_all_transition(&mut runtime, |label| close_overlay_window(app, label))
}

/// Clear the bookkeeping whether or not the destroy worked, then report the
/// destroy's outcome. A label left pointing at a window that could not be
/// closed makes the *next* open refuse as well, which turns one stuck overlay
/// into a permanently unusable surface — and the rescue exists precisely for
/// the case where things are already going wrong.
fn apply_overlay_close_all_transition(
    runtime: &mut OverlayRuntimeState,
    close: impl FnOnce(&str) -> Result<(), String>,
) -> Result<(), String> {
    let close_result = match runtime.active_overlay_label.as_deref() {
        Some(label) => close(label),
        None => Ok(()),
    };

    runtime.active_display_id = None;
    runtime.active_overlay_label = None;

    close_result
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

    use super::{
        apply_overlay_close_all_transition, apply_overlay_open_transition,
        build_overlay_webview_url, run_overlay_open_transition, OverlayOpenOutcome,
        OverlayRuntimeState,
    };

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
            OverlayOpenOutcome::Opened,
        );

        assert!(result.ok);
        assert_eq!(result.code, "OVERLAY_OPENED");
        assert_eq!(runtime.active_display_id.as_deref(), Some("display-1"));
        assert_eq!(runtime.active_overlay_label.as_deref(), Some("window-1"));
    }

    /// The tray rescue is reached when an overlay is already misbehaving, so a
    /// destroy that fails must not leave the label behind — the next open reads
    /// it as "one is still up" and the surface never recovers.
    #[test]
    fn close_all_clears_the_bookkeeping_even_when_the_destroy_fails() {
        let mut runtime = OverlayRuntimeState {
            active_display_id: Some("display-1".to_string()),
            active_overlay_label: Some("window-1".to_string()),
        };

        let result = apply_overlay_close_all_transition(&mut runtime, |label| {
            assert_eq!(label, "window-1");
            Err("OVERLAY_WINDOW_CLOSE_FAILED: wedged".to_string())
        });

        assert!(
            result.is_err(),
            "the destroy failure must still be reported"
        );
        assert_eq!(runtime.active_display_id, None);
        assert_eq!(runtime.active_overlay_label, None);
    }

    #[test]
    fn close_all_with_no_overlay_open_does_not_reach_the_destroy() {
        let mut runtime = OverlayRuntimeState::default();

        let result = apply_overlay_close_all_transition(&mut runtime, |_| {
            panic!("nothing is open, so nothing should be destroyed")
        });

        assert!(result.is_ok());
        assert_eq!(runtime.active_overlay_label, None);
    }

    #[test]
    fn open_transition_closes_old_then_opens_new() {
        let mut runtime = OverlayRuntimeState {
            active_display_id: Some("display-1".to_string()),
            active_overlay_label: Some("window-1".to_string()),
        };
        let order = RefCell::new(Vec::new());

        let outcome = run_overlay_open_transition(
            || {
                order.borrow_mut().push("close-old");
                Ok(())
            },
            || {
                order.borrow_mut().push("open-new");
                Ok(())
            },
        );

        assert_eq!(outcome, OverlayOpenOutcome::Opened);
        assert_eq!(*order.borrow(), vec!["close-old", "open-new"]);

        let result = apply_overlay_open_transition(&mut runtime, "display-2", "window-2", outcome);

        assert!(result.ok);
        assert_eq!(runtime.active_display_id.as_deref(), Some("display-2"));
        assert_eq!(runtime.active_overlay_label.as_deref(), Some("window-2"));
    }

    /// A close that fails means the previous overlay is still on screen, so the
    /// state must keep pointing at it — clearing it here would hide the window
    /// from both `close_display_overlay` and the tray rescue.
    #[test]
    fn open_transition_that_cannot_close_the_old_one_never_opens_a_new_one() {
        let mut runtime = OverlayRuntimeState {
            active_display_id: Some("display-1".to_string()),
            active_overlay_label: Some("window-1".to_string()),
        };

        let outcome = run_overlay_open_transition(
            || Err("OVERLAY_WINDOW_CLOSE_FAILED: wedged".to_string()),
            || panic!("the new overlay must not be opened when the old one is still up"),
        );

        let result = apply_overlay_open_transition(&mut runtime, "display-2", "window-2", outcome);

        assert!(!result.ok);
        assert_eq!(result.code, "OVERLAY_OPEN_FAILED");
        assert_eq!(runtime.active_display_id.as_deref(), Some("display-1"));
        assert_eq!(runtime.active_overlay_label.as_deref(), Some("window-1"));
    }

    #[test]
    fn overlay_open_failed_keeps_state_inactive() {
        let mut runtime = OverlayRuntimeState {
            active_display_id: Some("display-1".to_string()),
            active_overlay_label: Some("window-1".to_string()),
        };

        let outcome =
            run_overlay_open_transition(|| Ok(()), || Err("Permission denied".to_string()));

        let result = apply_overlay_open_transition(&mut runtime, "display-2", "window-2", outcome);

        assert!(!result.ok);
        assert_eq!(result.code, "OVERLAY_OPEN_FAILED");
        assert_eq!(result.reason.as_deref(), Some("Permission denied"));
        assert_eq!(runtime.active_display_id, None);
        assert_eq!(runtime.active_overlay_label, None);
    }
}
