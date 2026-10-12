//! The title bar's drag. Off macOS it is Tauri's own; on macOS it starts from the pointer, since
//! tao's anchors on whatever event AppKit last saw (`macos_window::drag_from_mouse`).

use tauri::{Runtime, Window};

/// Drags the calling window. Never fails: a drag that does not start leaves the window where it
/// is, and the user presses again.
#[tauri::command]
pub fn start_window_drag<R: Runtime>(window: Window<R>) {
    #[cfg(target_os = "macos")]
    {
        // Only a real window has an NSWindow: `MockRuntime`'s handle is a dangling view, and
        // reading the window through it faults.
        if std::any::TypeId::of::<R>() != std::any::TypeId::of::<tauri::Wry>() {
            return;
        }
        // A sync command runs on the main thread; anything else waits for it, by which time the
        // button may be up and the drag declines.
        if objc2::MainThreadMarker::new().is_some() {
            crate::macos_window::drag_from_mouse(&window);
        } else {
            let target = window.clone();
            if let Err(error) =
                window.run_on_main_thread(move || crate::macos_window::drag_from_mouse(&target))
            {
                log::warn!("[window-drag] could not reach the main thread: {error}");
            }
        }
    }
    #[cfg(not(target_os = "macos"))]
    if let Err(error) = window.start_dragging() {
        log::warn!("[window-drag] {error}");
    }
}
