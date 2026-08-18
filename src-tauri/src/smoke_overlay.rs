//! Debug-only CI hook that opens the calibration overlay on a file trigger, so
//! an external Windows probe can measure a real overlay without a human at the
//! machine. Windows overlay behaviour is unverifiable anywhere else — see
//! docs/architecture/build-and-release.md and docs/architecture/ui-and-shell.md.

use std::path::PathBuf;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager, Runtime};

use crate::commands::calibration::{list_displays, open_display_overlay, OverlayState};

const POLL_INTERVAL: Duration = Duration::from_millis(250);
const MAX_WAIT: Duration = Duration::from_secs(180);
const RECT_SETTLE: Duration = Duration::from_millis(1_500);
/// The teardown queues `close()` and `show()` onto the event loop, so a count
/// taken straight after the call reads the state before either landed.
const RESCUE_SETTLE: Duration = Duration::from_millis(1_500);
/// Suffix of the second trigger file, beside the first: `<trigger>.close`.
const CLOSE_TRIGGER_SUFFIX: &str = ".close";

/// Watch `LUMASYNC_SMOKE_OVERLAY_TRIGGER` for the probe's go-signal and open the
/// calibration overlay when it lands. No-op when the variable is unset, which is
/// every run that is not the overlay smoke test.
pub fn spawn_trigger_watcher<R: Runtime>(app: &AppHandle<R>) {
    let Some(raw_path) = std::env::var_os("LUMASYNC_SMOKE_OVERLAY_TRIGGER") else {
        return;
    };
    let trigger = PathBuf::from(raw_path);
    if trigger.as_os_str().is_empty() {
        log::warn!("[smoke-overlay] trigger path is set but empty — not arming the watcher");
        return;
    }

    // Pre-existing file would fire instantly and measure a window the probe has
    // not taken its baseline against yet.
    if trigger.exists() {
        log::warn!(
            "[smoke-overlay] trigger {} already exists at startup — the probe must delete it first",
            trigger.display()
        );
    }
    // Same hazard one step later: a stale close trigger tears the overlay down
    // before the probe has photographed it.
    let close_trigger = close_trigger_for(&trigger);
    if close_trigger.exists() {
        log::warn!(
            "[smoke-overlay] close trigger {} already exists at startup — the probe must delete it first",
            close_trigger.display()
        );
    }

    log::info!("[smoke-overlay] armed, watching {}", trigger.display());

    let app = app.clone();
    let spawned = std::thread::Builder::new()
        .name("smoke-overlay-trigger".into())
        .spawn(move || {
            let deadline = Instant::now() + MAX_WAIT;
            while !trigger.exists() {
                if Instant::now() >= deadline {
                    log::warn!(
                        "[smoke-overlay] trigger {} never appeared within {} s — giving up",
                        trigger.display(),
                        MAX_WAIT.as_secs()
                    );
                    return;
                }
                std::thread::sleep(POLL_INTERVAL);
            }

            log::info!("[smoke-overlay] trigger seen at {}", trigger.display());

            let main_thread_app = app.clone();
            if let Err(error) =
                app.run_on_main_thread(move || open_and_report(&main_thread_app, close_trigger))
            {
                log::error!("[smoke-overlay] open failed: RUN_ON_MAIN_THREAD_FAILED: {error}");
            }
        });

    if let Err(error) = spawned {
        log::error!("[smoke-overlay] open failed: WATCHER_THREAD_SPAWN_FAILED: {error}");
    }
}

/// Runs on the main thread. Opens the overlay on the primary display through the
/// same command path the frontend uses, then logs the resulting physical rect so
/// the external probe knows where to look.
fn open_and_report<R: Runtime>(app: &AppHandle<R>, close_trigger: PathBuf) {
    let displays = match list_displays(app.clone()) {
        Ok(displays) => displays,
        Err(error) => {
            log::error!("[smoke-overlay] open failed: {error}");
            return;
        }
    };

    let Some(target) = displays
        .iter()
        .find(|display| display.is_primary)
        .or_else(|| displays.first())
    else {
        log::error!("[smoke-overlay] open failed: DISPLAY_LIST_EMPTY");
        return;
    };
    let display_id = target.id.clone();
    let scale_factor = target.scale_factor;

    let Some(overlay_state) = app.try_state::<OverlayState>() else {
        log::error!("[smoke-overlay] open failed: OVERLAY_STATE_UNMANAGED");
        return;
    };

    let result = match open_display_overlay(app.clone(), overlay_state, display_id.clone(), None) {
        Ok(result) => result,
        Err(error) => {
            log::error!("[smoke-overlay] open failed: {error}");
            return;
        }
    };
    if !result.ok {
        log::error!(
            "[smoke-overlay] open failed: {} {}",
            result.code,
            result.reason.as_deref().unwrap_or(result.message.as_str())
        );
        return;
    }

    let Some(overlay_state) = app.try_state::<OverlayState>() else {
        log::error!("[smoke-overlay] open failed: OVERLAY_STATE_UNMANAGED");
        return;
    };
    let label = match overlay_state.runtime.lock() {
        Ok(runtime) => runtime.active_overlay_label.clone(),
        Err(error) => {
            log::error!("[smoke-overlay] open failed: OVERLAY_STATE_LOCK_FAILED: {error}");
            return;
        }
    };

    let Some(label) = label else {
        log::error!("[smoke-overlay] open failed: OVERLAY_LABEL_MISSING");
        return;
    };
    if app.get_webview_window(&label).is_none() {
        log::error!("[smoke-overlay] open failed: OVERLAY_WINDOW_MISSING label={label}");
        return;
    }

    log::info!("[smoke-overlay] opening label={label} display={display_id}");
    schedule_rect_report(app.clone(), label, display_id, scale_factor, close_trigger);
}

/// `<trigger>.close`, as a sibling of the open trigger rather than a second
/// path to configure: one variable cannot get out of step with itself.
fn close_trigger_for(trigger: &std::path::Path) -> PathBuf {
    let mut name = trigger.as_os_str().to_os_string();
    name.push(CLOSE_TRIGGER_SUFFIX);
    PathBuf::from(name)
}

/// `set_position`/`set_size` are queued onto the event loop rather than applied
/// inline, so the geometry read straight after `build()` is still the builder's
/// default. The probe is steered by this rect, so it has to be the settled one.
fn schedule_rect_report<R: Runtime>(
    app: AppHandle<R>,
    label: String,
    display_id: String,
    scale_factor: f64,
    close_trigger: PathBuf,
) {
    let spawned = std::thread::Builder::new()
        .name("smoke-overlay-rect".into())
        .spawn(move || {
            std::thread::sleep(RECT_SETTLE);
            let rect_app = app.clone();
            let _ = rect_app
                .run_on_main_thread(move || report_rect(&app, &label, &display_id, scale_factor));
            watch_for_rescue(rect_app, close_trigger);
        });
    if let Err(error) = spawned {
        log::error!("[smoke-overlay] open failed: RECT_THREAD_SPAWN_FAILED: {error}");
    }
}

/// R29's other half. The overlay opening is only half the report: the tray's
/// "Close Overlays" item is the one surface left when an overlay swallows the
/// desktop, and nothing outside a Windows desktop can prove it still works.
/// Runs on the rect thread, which has done its job by the time this is called.
fn watch_for_rescue<R: Runtime>(app: AppHandle<R>, close_trigger: PathBuf) {
    let deadline = Instant::now() + MAX_WAIT;
    while !close_trigger.exists() {
        if Instant::now() >= deadline {
            log::warn!(
                "[smoke-overlay] close trigger {} never appeared within {} s — no rescue measured",
                close_trigger.display(),
                MAX_WAIT.as_secs()
            );
            return;
        }
        std::thread::sleep(POLL_INTERVAL);
    }

    log::info!(
        "[smoke-overlay] close trigger seen at {}",
        close_trigger.display()
    );

    // The exact function the tray item calls, on the thread it calls it from.
    let rescue_app = app.clone();
    if let Err(error) = app.run_on_main_thread(move || crate::close_all_overlays(&rescue_app)) {
        log::error!("[smoke-overlay] rescue failed: RUN_ON_MAIN_THREAD_FAILED: {error}");
        return;
    }

    std::thread::sleep(RESCUE_SETTLE);
    let report_app = app.clone();
    if let Err(error) = app.run_on_main_thread(move || report_rescue(&report_app)) {
        log::error!("[smoke-overlay] rescue failed: RUN_ON_MAIN_THREAD_FAILED: {error}");
    }
}

/// Counts *visible* non-main windows, not every non-main window: the tray item
/// hides the LED control popup rather than closing it, and a hidden window
/// covers nothing. What R29 is about is what is left on the screen.
fn report_rescue<R: Runtime>(app: &AppHandle<R>) {
    let still_open = app
        .webview_windows()
        .iter()
        .filter(|(label, window)| label.as_str() != "main" && window.is_visible().unwrap_or(false))
        .count();
    let main_visible = app
        .get_webview_window("main")
        .and_then(|window| window.is_visible().ok())
        .unwrap_or(false);

    log::info!("[smoke-overlay] rescued overlays={still_open} main_visible={main_visible}");
}

fn report_rect<R: Runtime>(app: &AppHandle<R>, label: &str, display_id: &str, scale_factor: f64) {
    let Some(window) = app.get_webview_window(label) else {
        log::error!("[smoke-overlay] open failed: OVERLAY_WINDOW_MISSING label={label}");
        return;
    };

    let position = match window.outer_position() {
        Ok(position) => position,
        Err(error) => {
            log::error!("[smoke-overlay] open failed: OVERLAY_OUTER_POSITION_FAILED: {error}");
            return;
        }
    };
    let size = match window.outer_size() {
        Ok(size) => size,
        Err(error) => {
            log::error!("[smoke-overlay] open failed: OVERLAY_OUTER_SIZE_FAILED: {error}");
            return;
        }
    };

    log::info!(
        "[smoke-overlay] opened label={} display={} outer={},{} {}x{} scale={}",
        label,
        display_id,
        position.x,
        position.y,
        size.width,
        size.height,
        scale_factor
    );
}
