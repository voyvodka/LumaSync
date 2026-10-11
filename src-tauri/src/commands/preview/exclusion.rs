//! Keeping the preview's own windows out of the live capture, so the twin and
//! the popup never light the strip.
//!
//! - macOS: the capture filter leaves out every window of this app while a
//!   session is open (`ambilight_capture::set_own_windows_excluded`), and lets
//!   them back in when it ends, so outside a preview the app is captured as
//!   before.
//! - Windows 10 2004 and later: each preview window is excluded from capture
//!   (`WDA_EXCLUDEFROMCAPTURE`, via tao's content protection). Earlier builds
//!   treat that flag as `WDA_MONITOR` and show the window black in the
//!   capture, so there it is never set.
//! - Linux, and Windows before 2004: nothing can exclude a window, so the twin
//!   is hidden while Ambilight captures. The popup stays: hiding the remote
//!   would leave nothing to stop the preview with.
//!
//! Whether the twin is on screen is decided in one place,
//! `sync_twin_visibility`: not hidden by the user, and not held for capture.

use tauri::{AppHandle, Manager, Runtime, WebviewWindow};

use super::session::PreviewSessionState;
use crate::commands::ambilight_capture;

/// Whether a preview window can be kept out of the capture on this machine.
pub fn supported() -> bool {
    #[cfg(target_os = "macos")]
    return true;
    #[cfg(target_os = "windows")]
    {
        static SUPPORTED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
        return *SUPPORTED.get_or_init(|| windows_build() >= 19041);
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    return false;
}

#[cfg(target_os = "windows")]
fn windows_build() -> u32 {
    use windows_sys::Wdk::System::SystemServices::RtlGetVersion;
    use windows_sys::Win32::System::SystemInformation::OSVERSIONINFOW;

    // `GetVersionEx` answers what the manifest claims; `RtlGetVersion` the truth.
    let mut info = OSVERSIONINFOW {
        dwOSVersionInfoSize: std::mem::size_of::<OSVERSIONINFOW>() as u32,
        ..Default::default()
    };
    if unsafe { RtlGetVersion(&mut info) } == 0 {
        info.dwBuildNumber
    } else {
        0
    }
}

/// Called on a preview window as soon as it is built. The twin is built
/// through the shared overlay builder, so it is protected a moment after its
/// first show, while its page is still empty and transparent.
pub(super) fn protect<R: Runtime>(window: &WebviewWindow<R>) {
    #[cfg(target_os = "windows")]
    if supported() {
        if let Err(error) = window.set_content_protected(true) {
            log::warn!(
                "[preview] {} not excluded from capture: {error}",
                window.label()
            );
        }
    }
    #[cfg(not(target_os = "windows"))]
    let _ = window;
}

/// Before any preview window is shown.
pub(super) fn session_opening() {
    ambilight_capture::set_own_windows_excluded(true);
}

/// After every preview window is gone.
pub(super) fn session_ended() {
    ambilight_capture::set_own_windows_excluded(false);
}

/// Once the session is registered: retry an exclusion that could not find the
/// app before it had a window, and where nothing can exclude the twin, match
/// it to the capture as it is now — a start or stop between the build and the
/// registration found no twin to act on.
pub(super) fn session_opened<R: Runtime>(app: &AppHandle<R>) {
    ambilight_capture::set_own_windows_excluded(true);
    if !supported() {
        sync_twin_visibility(app);
    }
}

/// The twin is off screen because Ambilight captures and nothing here can
/// keep it out of the frame.
pub(super) fn twin_held_for_capture() -> bool {
    !supported() && ambilight_capture::capture_active()
}

/// Puts the twin on screen or takes it off, from the session's flag and the
/// capture as they are when this runs on the main thread — not as they were
/// when it was asked for. A user's switch and a capture start on two threads
/// can ask in either order; whichever runs last leaves the current state.
pub(super) fn sync_twin_visibility<R: Runtime>(app: &AppHandle<R>) {
    let handle = app.clone();
    let posted = app.run_on_main_thread(move || {
        let Some((label, hidden)) = handle
            .try_state::<PreviewSessionState>()
            .and_then(|state| state.twin_visibility())
        else {
            return;
        };
        if let Some(twin) = handle.get_webview_window(&label) {
            let _ = if hidden || twin_held_for_capture() {
                twin.hide()
            } else {
                twin.show()
            };
        }
    });
    if let Err(error) = posted {
        log::warn!("[preview] twin visibility not updated: {error}");
    }
}

/// Where nothing can exclude the twin, hide it while Ambilight captures and
/// bring it back when capture stops. The capture starts and stops on the
/// worker, under the lighting lock, so the window call is posted to the main
/// thread rather than made here.
pub fn install<R: Runtime>(app: &AppHandle<R>) {
    if supported() {
        return;
    }
    let app = app.clone();
    ambilight_capture::on_capture_active_changed(Box::new(move |_| {
        sync_twin_visibility(&app);
        super::session::emit_session(&app);
    }));
}
