//! Platform shell surface commands.
//!
//! Sibling of `commands::notifications`. Commands here expose OS shell
//! affordances the frontend needs but that are not device-specific:
//! today, just the ability to reveal the LumaSync logs in the
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

use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_opener::OpenerExt;

/// Reveal the LumaSync logs in the host's file browser.
///
/// Path resolution is delegated to `tauri::Manager::path().app_log_dir()`
/// which picks:
///   - macOS: `~/Library/Logs/com.lumasync.app/`
///   - Windows: `%LOCALAPPDATA%\com.lumasync.app\logs\`
///   - Linux (XDG): `~/.local/share/com.lumasync.app/logs/` or
///     `$XDG_DATA_HOME/com.lumasync.app/logs/`
///
/// The newest log file is revealed (selected in Finder / Explorer / the file
/// manager) rather than the directory opened: on macOS the directory's name
/// ends in `.app`, so `open` takes it for an application bundle and fails
/// with "executable is missing". With no log file yet, the directory itself
/// is revealed in its parent.
#[tauri::command]
pub async fn open_log_dir<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    let log_dir = app
        .path()
        .app_log_dir()
        .map_err(|e| format!("Failed to resolve app log directory: {e}"))?;

    let target = newest_log_file(&log_dir).unwrap_or_else(|| log_dir.clone());
    log::info!("[platform] open_log_dir revealing {}", target.display());

    app.opener()
        .reveal_item_in_dir(&target)
        .map_err(|e| format!("Failed to open log directory: {e}"))?;

    Ok(())
}

fn newest_log_file(dir: &Path) -> Option<PathBuf> {
    std::fs::read_dir(dir)
        .ok()?
        .filter_map(Result::ok)
        .filter(|entry| entry.path().extension().is_some_and(|ext| ext == "log"))
        .filter_map(|entry| {
            let meta = entry.metadata().ok()?;
            meta.is_file().then(|| (meta.modified().ok(), entry.path()))
        })
        .max_by(|a, b| a.0.cmp(&b.0))
        .map(|(_, path)| path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::{Duration, SystemTime};

    struct Scratch(PathBuf);

    impl Scratch {
        fn new() -> Self {
            let dir = std::env::temp_dir().join(format!(
                "lumasync-logdir-test-{}",
                uuid::Uuid::new_v4().simple()
            ));
            fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn the_newest_log_file_is_revealed_and_other_entries_are_ignored() {
        let dir = Scratch::new();
        let old = dir.0.join("lumasync_2026-09-24.log");
        let new = dir.0.join("lumasync.log");
        fs::write(&old, "old").unwrap();
        fs::write(&new, "new").unwrap();
        fs::write(dir.0.join("notes.txt"), "x").unwrap();
        fs::create_dir(dir.0.join("archive.log")).unwrap();
        let earlier = SystemTime::now() - Duration::from_secs(3600);
        fs::File::options()
            .write(true)
            .open(&old)
            .unwrap()
            .set_modified(earlier)
            .unwrap();

        assert_eq!(newest_log_file(&dir.0), Some(new));
    }

    #[test]
    fn a_directory_without_logs_or_a_missing_one_yields_none() {
        let dir = Scratch::new();
        assert_eq!(newest_log_file(&dir.0), None);
        assert_eq!(newest_log_file(&dir.0.join("missing")), None);
    }
}
