//! Whether the main window is on screen, as the native window reports it.
//! WebView2 can keep `document.visibilityState` at "visible" while the window
//! sits hidden in the tray, so a frontend poll that trusts only the document
//! keeps running for nobody. See docs/architecture/ui-and-shell.md,
//! "Background polls are visibility-aware".

use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, EventTarget, Manager, Runtime};

/// `SHELL_EVENTS.MAIN_WINDOW_VISIBILITY` in `src/shared/contracts/shell.ts`.
/// Defined in `crate::events`; re-exported here since this is the emit site.
pub use crate::events::MAIN_WINDOW_VISIBILITY_EVENT;

/// `MainWindowVisibility` in `shell.ts`: the `get_main_window_visibility`
/// response and the `shell://main-window-visibility` payload.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MainWindowVisibility {
    pub visible: bool,
}

/// The last value published, so a burst of window events emits once per change.
#[derive(Default)]
pub struct MainWindowVisibilityState {
    last: Mutex<Option<bool>>,
}

impl MainWindowVisibilityState {
    /// Records `visible` and answers whether it differs from the last one seen.
    fn observe(&self, visible: bool) -> bool {
        let previous = self
            .last
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .replace(visible);
        previous != Some(visible)
    }
}

/// Minimised counts as hidden. A failed read answers visible: the frontend
/// still honours `document.visibilityState`, so erring that way is the
/// behaviour before this signal existed, never a poll stopped for good.
fn read_main_visible<R: Runtime>(app: &AppHandle<R>) -> bool {
    let Some(window) = app.get_webview_window(crate::MAIN_WINDOW_LABEL) else {
        return true;
    };
    let shown = window.is_visible().unwrap_or(true);
    let minimized = window.is_minimized().unwrap_or(false);
    shown && !minimized
}

/// Re-reads the main window and tells it when the answer changed. Call after
/// anything that shows, hides, minimises or restores it.
pub(crate) fn refresh<R: Runtime>(app: &AppHandle<R>) -> MainWindowVisibility {
    let visibility = MainWindowVisibility {
        visible: read_main_visible(app),
    };
    let changed = app
        .try_state::<MainWindowVisibilityState>()
        .is_none_or(|state| state.observe(visibility.visible));
    if changed {
        if let Err(error) = app.emit_to(
            EventTarget::webview_window(crate::MAIN_WINDOW_LABEL),
            MAIN_WINDOW_VISIBILITY_EVENT,
            visibility,
        ) {
            log::warn!("[window-visibility] emit failed: {error}");
        }
    }
    visibility
}

/// A live read, not the cached value: the frontend asks again whenever the
/// document regains visibility or focus, which also covers a `show()` the
/// frontend made itself (the boot show in `windowLifecycle.ts`).
#[tauri::command]
pub fn get_main_window_visibility<R: Runtime>(app: AppHandle<R>) -> MainWindowVisibility {
    refresh(&app)
}

#[cfg(test)]
mod tests {
    use super::MainWindowVisibilityState;

    #[test]
    fn the_first_read_is_always_a_change() {
        let state = MainWindowVisibilityState::default();
        assert!(state.observe(true));
    }

    #[test]
    fn only_a_different_value_is_a_change() {
        let state = MainWindowVisibilityState::default();
        state.observe(true);
        assert!(!state.observe(true));
        assert!(state.observe(false));
        assert!(!state.observe(false));
        assert!(state.observe(true));
    }
}
