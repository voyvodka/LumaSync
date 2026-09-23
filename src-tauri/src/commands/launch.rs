//! How this process was launched, for the parts of the shell that behave
//! differently at login.

use std::ffi::OsStr;

use serde::Serialize;
use tauri::{AppHandle, Manager, Runtime};

/// Passed by the autostart entry (`tauri_plugin_autostart::init` in `lib.rs`).
/// A login launch stays in the tray instead of opening a window over whatever
/// the user is doing.
pub const AUTOSTART_TRAY_ARG: &str = "--tray";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchContext {
    pub start_hidden: bool,
    /// Built with the `e2e` cargo feature (`bun run e2e:build`). Release bundles
    /// never enable it, so this is `false` for every user.
    pub e2e_build: bool,
}

/// `args` is a full argv, program name first.
pub fn launched_to_tray<I, S>(args: I) -> bool
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    args.into_iter()
        .skip(1)
        .any(|arg| arg.as_ref() == AUTOSTART_TRAY_ARG)
}

/// Read once by `initWindowLifecycle` before its one `show()`.
#[tauri::command]
pub fn get_launch_context<R: Runtime>(app: AppHandle<R>) -> LaunchContext {
    LaunchContext {
        start_hidden: launched_to_tray(&app.env().args_os),
        e2e_build: cfg!(feature = "e2e"),
    }
}

#[cfg(test)]
mod tests {
    use super::launched_to_tray;

    #[test]
    fn the_autostart_flag_starts_hidden() {
        assert!(launched_to_tray([
            "/Applications/LumaSync.app/Contents/MacOS/lumasync",
            "--tray"
        ]));
    }

    #[test]
    fn a_plain_launch_shows_the_window() {
        assert!(!launched_to_tray(["lumasync"]));
        assert!(!launched_to_tray(Vec::<String>::new()));
    }

    /// argv[0] is the program, never a flag — an install path ending in
    /// `--tray` must not hide the window.
    #[test]
    fn the_program_name_is_not_read_as_the_flag() {
        assert!(!launched_to_tray(["--tray"]));
    }

    #[test]
    fn only_the_exact_flag_counts() {
        assert!(!launched_to_tray(["lumasync", "--tray=false"]));
        assert!(!launched_to_tray(["lumasync", "--TRAY"]));
    }
}
