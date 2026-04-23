//! Platform notification commands (v1.4 W3-O).
//!
//! Wraps `tauri-plugin-notification` behind a never-throws contract that
//! mirrors the Hue discipline: every command returns a discriminated
//! `NotificationResult` whose `status` field drives the frontend branch,
//! never an uncaught exception. This matches the shape defined in
//! `src/shared/contracts/platform.ts`.
//!
//! Platform nuances:
//!   - macOS: the plugin's desktop `permission_state()` always returns
//!     `Granted` today, so real denials surface as errors on `show()`
//!     rather than as an explicit Denied state. We map a failed show
//!     into `status: "denied"` with the `NOTIF_PERMISSION_DENIED`
//!     code. When Apple eventually lands a proper permission bridge
//!     the `request_notification_permission` command becomes the
//!     canonical JIT prompt trigger.
//!   - Windows: toast visibility depends on AppUserModelID being set
//!     in the bundle. This is handled by `tauri.conf.json` identifier
//!     `com.lumasync.app` — verified pre-release.
//!   - Linux: libnotify is reachable on all mainstream desktops; if the
//!     DBus call fails we surface `NOTIF_UNSUPPORTED_OS` so the
//!     frontend falls back to an in-app banner.

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Runtime};
use tauri_plugin_notification::NotificationExt;

/// Payload for [`show_notification`]. Mirrors `NotificationPayload` in
/// the TypeScript platform contract.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationPayload {
    pub title: String,
    pub body: String,
    /// Severity. Currently only logged server-side for debugging; the
    /// native toast itself does not render a per-kind icon because the
    /// desktop plugin does not expose icon customization. Kept in the
    /// payload so the contract stays stable when platform support
    /// improves (macOS UNNotificationCategory etc.).
    pub kind: NotificationKind,
}

/// Severity of a notification. Currently drives the i18n copy bucket on
/// the frontend only; the OS toast itself renders without per-kind
/// styling because Tauri's plugin does not expose icon customization
/// on the desktop surface yet.
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum NotificationKind {
    Info,
    Warn,
    Error,
}

impl NotificationKind {
    fn as_log_label(&self) -> &'static str {
        match self {
            Self::Info => "info",
            Self::Warn => "warn",
            Self::Error => "error",
        }
    }
}

/// Stable status codes shared with the frontend. Mirrors
/// `NOTIFICATION_RESULT_CODES` in the platform contract. Additive
/// string union: never rename existing codes; append new ones only.
pub mod codes {
    /// Permission (or implicit OS grant) is active. Informative only —
    /// the frontend branches on `NotificationResult::Shown`, not on
    /// this constant — but kept public so future status payloads can
    /// reference it without a magic string.
    #[allow(dead_code)]
    pub const PERMISSION_GRANTED: &str = "NOTIF_PERMISSION_GRANTED";
    pub const PERMISSION_DENIED: &str = "NOTIF_PERMISSION_DENIED";
    pub const UNSUPPORTED_OS: &str = "NOTIF_UNSUPPORTED_OS";
}

/// Discriminated union returned by every platform notification command.
/// Serializes with `status` as the discriminant so the frontend can
/// `switch (result.status)` without ever parsing strings.
#[derive(Debug, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum NotificationResult {
    /// The OS accepted the notification (permission granted, toast
    /// scheduled). `code` is informative only.
    Shown,
    /// The user (or OS policy) rejected the permission or the plugin
    /// reported a denial on `show()`.
    Denied {
        code: &'static str,
        message: Option<String>,
    },
    /// The OS does not expose a notification surface we can reach
    /// (headless VM, broken DBus, obsolete Windows build).
    Unsupported {
        code: &'static str,
        message: Option<String>,
    },
}

impl NotificationResult {
    fn denied(message: impl Into<String>) -> Self {
        Self::Denied {
            code: codes::PERMISSION_DENIED,
            message: Some(message.into()),
        }
    }

    fn unsupported(message: impl Into<String>) -> Self {
        Self::Unsupported {
            code: codes::UNSUPPORTED_OS,
            message: Some(message.into()),
        }
    }
}

/// Request permission to post OS notifications. On macOS this triggers
/// the system prompt the first time the app calls it; subsequent calls
/// resolve silently with the cached state. On Linux / Windows the
/// plugin resolves immediately with `Granted`.
///
/// Returns `status: "shown"` when permission is (or already was)
/// granted; the naming is a minor contract smell because the command
/// does not "show" anything, but we reuse the same result variant so
/// the frontend has a single success branch to handle.
#[tauri::command]
pub async fn request_notification_permission<R: Runtime>(
    app: AppHandle<R>,
) -> Result<NotificationResult, String> {
    match app.notification().request_permission() {
        Ok(tauri::plugin::PermissionState::Granted) => Ok(NotificationResult::Shown),
        Ok(tauri::plugin::PermissionState::Denied) => Ok(NotificationResult::denied(
            "Notification permission denied by the user or OS policy",
        )),
        Ok(_prompt) => {
            // Prompt / PromptWithRationale: treat as denied until the
            // user explicitly accepts. Frontend surfaces the in-app
            // banner so the user can open System Settings.
            Ok(NotificationResult::denied(
                "Notification permission not yet granted",
            ))
        }
        Err(err) => {
            log::warn!(
                "[notifications] request_permission failed, surfacing as unsupported: {err}"
            );
            Ok(NotificationResult::unsupported(err.to_string()))
        }
    }
}

/// Fire a single OS toast. Never throws; every failure is folded into
/// a `NotificationResult` variant so the frontend can display the
/// in-app fallback without a try/catch.
#[tauri::command]
pub async fn show_notification<R: Runtime>(
    app: AppHandle<R>,
    payload: NotificationPayload,
) -> Result<NotificationResult, String> {
    log::info!(
        "[notifications] show kind={} title={:?}",
        payload.kind.as_log_label(),
        payload.title
    );

    let builder = app
        .notification()
        .builder()
        .title(payload.title)
        .body(payload.body);

    match builder.show() {
        Ok(()) => Ok(NotificationResult::Shown),
        Err(err) => {
            // The plugin lumps "permission denied" and "os rejected"
            // into the same error path. Best-effort classification:
            // message containing "permission" or "denied" → denied;
            // everything else → unsupported. Frontend treats both as
            // "fall back to in-app banner" so the split is diagnostic.
            let msg = err.to_string();
            let lower = msg.to_lowercase();
            if lower.contains("permission") || lower.contains("denied") {
                log::info!("[notifications] show denied by OS: {msg}");
                Ok(NotificationResult::denied(msg))
            } else {
                log::warn!("[notifications] show failed: {msg}");
                Ok(NotificationResult::unsupported(msg))
            }
        }
    }
}
