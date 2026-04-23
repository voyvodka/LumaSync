//! Platform shell surface commands (v1.4 W3-O).
//!
//! Sibling of `commands::notifications`. Commands here expose OS shell
//! affordances the frontend needs but that are not device-specific:
//! today, just the ability to reveal the LumaSync log directory in the
//! system file browser (Finder / Explorer / xdg-open) so users can
//! attach logs to a bug report straight from `GlobalErrorBoundary` or
//! the About section.
//!
//! Returns `Result<(), String>` rather than a coded status object
//! because there is no actionable branching the frontend needs — the
//! button either succeeded or it did not, and the error string is
//! already translated on the Rust side via `tauri::Error::to_string`.
//! If future platform commands grow per-OS failure modes they should
//! be refactored into a discriminated union like `NotificationResult`.

use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_opener::OpenerExt;

/// Reveal the LumaSync app log directory in the host's file browser.
///
/// Path resolution is delegated to `tauri::Manager::path().app_log_dir()`
/// which picks:
///   - macOS: `~/Library/Logs/com.lumasync.app/`
///   - Windows: `%LOCALAPPDATA%\com.lumasync.app\logs\`
///   - Linux (XDG): `~/.local/share/com.lumasync.app/logs/` or
///     `$XDG_DATA_HOME/com.lumasync.app/logs/`
///
/// Opening is handed off to `tauri-plugin-opener` which internally
/// invokes `open` on macOS, `explorer.exe` on Windows, and `xdg-open`
/// on Linux. We do not attempt to create the directory here — the
/// logging plugin creates it on first write, so on a fresh install
/// before the first log line is flushed the call will fail; this is
/// acceptable because the boundary only offers "Show logs" after an
/// error has already fired and been logged.
#[tauri::command]
pub async fn open_log_dir<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    let log_dir = app
        .path()
        .app_log_dir()
        .map_err(|e| format!("Failed to resolve app log directory: {e}"))?;

    log::info!("[platform] open_log_dir revealing {}", log_dir.display());

    app.opener()
        .open_path(log_dir.to_string_lossy().to_string(), None::<String>)
        .map_err(|e| format!("Failed to open log directory: {e}"))?;

    Ok(())
}
