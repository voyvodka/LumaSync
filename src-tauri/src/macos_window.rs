// macOS-only window tweaks applied at startup.
//
// LumaSync uses a custom amber title bar (Tauri `titleBarStyle: "Overlay"`).
// In native fullscreen the system draws its own auto-hiding title bar overlay
// on top of ours — two title bars stacked, ugly. Tauri/tao has an open
// upstream bug (tauri-apps/tauri#5115, tao#548) that re-applies
// `NSTitledWindow` styleMask during fullscreen transitions, so a delegate
// patch loses the race.
//
// Two-step fix:
//   1. `NSWindowCollectionBehavior::FullScreenNone` — disables the ⌃⌘F
//      shortcut and the Window menu's "Enter Full Screen" item, but leaves
//      the green title-bar button as a working "zoom" affordance with no
//      visual change.
//   2. Explicitly disable the standard zoom button via `setEnabled(false)`
//      so the green dot renders in its disabled state. Together this kills
//      every fullscreen pathway visibly and consistently. Manual edge
//      resize and double-click-to-zoom on the title bar are unaffected.

use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2_app_kit::{NSWindow, NSWindowButton, NSWindowCollectionBehavior};
use tauri::WebviewWindow;

pub fn forbid_native_fullscreen(window: &WebviewWindow) {
    let raw = match window.ns_window() {
        Ok(ptr) => ptr,
        Err(err) => {
            log::warn!("[macos_window] ns_window unavailable: {err}");
            return;
        }
    };

    if raw.is_null() {
        return;
    }

    // SAFETY: Tauri returns a retained NSWindow pointer for the main window.
    // We borrow it for the duration of this call only and never store it.
    unsafe {
        let ns_window: Retained<NSWindow> =
            Retained::retain(raw as *mut AnyObject as *mut NSWindow)
                .expect("NSWindow pointer must be non-null");

        // Disable ⌃⌘F and the Window menu item.
        ns_window.setCollectionBehavior(NSWindowCollectionBehavior::FullScreenNone);

        // Render the green title-bar button in its disabled state.
        if let Some(zoom_button) = ns_window.standardWindowButton(NSWindowButton::ZoomButton) {
            zoom_button.setEnabled(false);
        }
    }
}

/// Elevate an overlay / popup window so it floats over a macOS fullscreen
/// Space. The LED-twin overlay and the control popup must remain visible even
/// when another app owns the active fullscreen Space (e.g. a fullscreen game /
/// video the user is calibrating against). Sets `canJoinAllSpaces |
/// fullScreenAuxiliary` collection behaviour plus a raised window level, using
/// the same objc2 NSWindow pattern as `forbid_native_fullscreen`. (v1.6 LED
/// Preview — Phase 1.)
pub fn elevate_overlay_window<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>) {
    let raw = match window.ns_window() {
        Ok(ptr) => ptr,
        Err(err) => {
            log::warn!("[macos_window] ns_window unavailable for elevate: {err}");
            return;
        }
    };

    if raw.is_null() {
        return;
    }

    // SAFETY: Tauri returns a retained NSWindow pointer; we borrow it for the
    // duration of this call only and never store it.
    unsafe {
        let ns_window: Retained<NSWindow> =
            Retained::retain(raw as *mut AnyObject as *mut NSWindow)
                .expect("NSWindow pointer must be non-null");

        ns_window.setCollectionBehavior(
            NSWindowCollectionBehavior::CanJoinAllSpaces
                | NSWindowCollectionBehavior::FullScreenAuxiliary,
        );

        // NSStatusWindowLevel (25): above normal/floating windows so the
        // overlay + control popup stay visible over fullscreen content.
        let level: objc2_app_kit::NSWindowLevel = 25;
        ns_window.setLevel(level);
    }
}
