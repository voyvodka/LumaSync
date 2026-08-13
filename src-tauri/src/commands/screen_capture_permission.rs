//! macOS Screen Recording (TCC) permission probe and its System Settings
//! deep link. Which CoreGraphics call goes where, and why only the start
//! path may prompt: `docs/architecture/capture-and-pipeline.md`.

use serde::Serialize;
use tauri::{AppHandle, Runtime};
use tauri_plugin_opener::OpenerExt;

/// Stable codes shared with `SCREEN_CAPTURE_PERMISSION_STATUS` in
/// `src/shared/contracts/capture.ts`.
pub mod codes {
    pub const GRANTED: &str = "SCREEN_CAPTURE_PERMISSION_GRANTED";
    pub const DENIED: &str = "SCREEN_CAPTURE_PERMISSION_DENIED";
    pub const NOT_REQUIRED: &str = "SCREEN_CAPTURE_PERMISSION_NOT_REQUIRED";
    pub const SETTINGS_OPENED: &str = "SCREEN_CAPTURE_SETTINGS_OPENED";
    pub const SETTINGS_UNSUPPORTED: &str = "SCREEN_CAPTURE_SETTINGS_UNSUPPORTED";
    pub const SETTINGS_OPEN_FAILED: &str = "SCREEN_CAPTURE_SETTINGS_OPEN_FAILED";
}

/// Where a platform stands on screen-recording consent. `NotRequired` is a
/// real third state, not a stand-in for granted: Windows and X11 have no
/// consent gate at all, so a caller must not offer to "fix" anything there.
// Every platform constructs a strict subset: macOS never `NotRequired`, the
// others never `Granted`/`Denied`. Allowed unconditionally rather than as a
// cfg matrix that drifts each time a backend lands.
#[allow(dead_code)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ScreenCaptureAccess {
    Granted,
    Denied,
    NotRequired,
}

impl ScreenCaptureAccess {
    pub fn as_code(self) -> &'static str {
        match self {
            Self::Granted => codes::GRANTED,
            Self::Denied => codes::DENIED,
            Self::NotRequired => codes::NOT_REQUIRED,
        }
    }

    /// True when capture cannot possibly work until the user acts.
    // Unused on any platform whose backend has no consent gate — not a
    // macOS-only concern: a Wayland/PipeWire portal path calls it on day one.
    #[allow(dead_code)]
    pub fn blocks_capture(self) -> bool {
        matches!(self, Self::Denied)
    }
}

#[cfg(target_os = "macos")]
mod imp {
    use super::ScreenCaptureAccess;

    // Declared inline like `main_display_id_ffi` in `ambilight_capture.rs`:
    // ScreenCaptureKit already links CoreGraphics, and both symbols are 10.15+.
    extern "C" {
        fn CGPreflightScreenCaptureAccess() -> bool;
        fn CGRequestScreenCaptureAccess() -> bool;
    }

    pub(super) fn preflight() -> ScreenCaptureAccess {
        if unsafe { CGPreflightScreenCaptureAccess() } {
            ScreenCaptureAccess::Granted
        } else {
            ScreenCaptureAccess::Denied
        }
    }

    /// Prompts when the TCC decision is undetermined. The system shows that
    /// prompt once per binary for the lifetime of the install — see the
    /// module header before moving this call anywhere.
    pub(super) fn request() -> ScreenCaptureAccess {
        if unsafe { CGRequestScreenCaptureAccess() } {
            ScreenCaptureAccess::Granted
        } else {
            ScreenCaptureAccess::Denied
        }
    }

    pub(super) const SETTINGS_URL: Option<&str> =
        Some("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture");
}

#[cfg(not(target_os = "macos"))]
mod imp {
    use super::ScreenCaptureAccess;

    pub(super) fn preflight() -> ScreenCaptureAccess {
        ScreenCaptureAccess::NotRequired
    }

    pub(super) fn request() -> ScreenCaptureAccess {
        ScreenCaptureAccess::NotRequired
    }

    pub(super) const SETTINGS_URL: Option<&str> = None;
}

/// Non-prompting probe. Safe from any thread and any number of times.
pub fn preflight_screen_capture_access() -> ScreenCaptureAccess {
    imp::preflight()
}

/// Preflight, then request once if the answer was negative. Reserved for the
/// capture start path: the request arm is what makes the OS prompt appear on
/// first run, so no other caller may take this branch.
// Same reason as `blocks_capture`: only a consent-gated backend calls this, and
// today only macOS has one. This allow also covers `imp::request`, which the
// lint treats as reachable again once its sole caller is an allowed root.
#[allow(dead_code)]
pub fn ensure_screen_capture_access() -> ScreenCaptureAccess {
    match imp::preflight() {
        ScreenCaptureAccess::Granted => ScreenCaptureAccess::Granted,
        ScreenCaptureAccess::NotRequired => ScreenCaptureAccess::NotRequired,
        ScreenCaptureAccess::Denied => {
            let requested = imp::request();
            log::info!(
                "[screen-capture-permission] preflight denied, requested access — result={}",
                requested.as_code()
            );
            requested
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenCapturePermissionResult {
    pub code: &'static str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenCaptureSettingsResult {
    pub code: &'static str,
    pub message: Option<String>,
}

/// Report whether screen capture is permitted, without prompting.
///
/// Never throws: a frontend polling this before enabling Ambilight has no
/// error branch to write, and `NOT_REQUIRED` is not a failure.
#[tauri::command]
pub fn get_screen_capture_permission() -> ScreenCapturePermissionResult {
    ScreenCapturePermissionResult {
        code: preflight_screen_capture_access().as_code(),
    }
}

/// Open the Screen Recording pane of System Settings so a denied user has
/// somewhere to go. macOS only; every other platform reports unsupported
/// rather than failing, because nothing there needs granting.
#[tauri::command]
pub async fn open_screen_capture_settings<R: Runtime>(
    app: AppHandle<R>,
) -> ScreenCaptureSettingsResult {
    let Some(url) = imp::SETTINGS_URL else {
        return ScreenCaptureSettingsResult {
            code: codes::SETTINGS_UNSUPPORTED,
            message: Some("No screen-recording permission pane on this platform.".to_string()),
        };
    };

    match app.opener().open_url(url, None::<String>) {
        Ok(()) => ScreenCaptureSettingsResult {
            code: codes::SETTINGS_OPENED,
            message: None,
        },
        Err(error) => {
            log::warn!("[screen-capture-permission] settings deep link failed: {error}");
            ScreenCaptureSettingsResult {
                code: codes::SETTINGS_OPEN_FAILED,
                message: Some(error.to_string()),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_denied_blocks_capture() {
        // `NotRequired` is the Windows/X11 answer — offering the user a
        // permission fix there would be a lie.
        assert!(ScreenCaptureAccess::Denied.blocks_capture());
        assert!(!ScreenCaptureAccess::Granted.blocks_capture());
        assert!(!ScreenCaptureAccess::NotRequired.blocks_capture());
    }

    #[test]
    fn codes_match_the_contract_strings() {
        assert_eq!(
            ScreenCaptureAccess::Granted.as_code(),
            "SCREEN_CAPTURE_PERMISSION_GRANTED"
        );
        assert_eq!(
            ScreenCaptureAccess::Denied.as_code(),
            "SCREEN_CAPTURE_PERMISSION_DENIED"
        );
        assert_eq!(
            ScreenCaptureAccess::NotRequired.as_code(),
            "SCREEN_CAPTURE_PERMISSION_NOT_REQUIRED"
        );
    }

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn platforms_without_a_consent_gate_never_report_denied() {
        assert_eq!(
            preflight_screen_capture_access(),
            ScreenCaptureAccess::NotRequired
        );
        assert_eq!(
            ensure_screen_capture_access(),
            ScreenCaptureAccess::NotRequired
        );
    }

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn no_settings_pane_is_offered_where_there_is_nothing_to_grant() {
        // Drives the UNSUPPORTED early-return in `open_screen_capture_settings`.
        // A `Some` here would send Linux/Windows at an `x-apple.` URL.
        assert!(imp::SETTINGS_URL.is_none());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_points_at_the_screen_recording_pane() {
        assert_eq!(
            imp::SETTINGS_URL,
            Some("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn preflight_never_reports_not_required_on_macos() {
        // The probe must answer the TCC question, not opt out of it.
        assert_ne!(
            preflight_screen_capture_access(),
            ScreenCaptureAccess::NotRequired
        );
    }
}
