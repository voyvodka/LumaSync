// LumaSync — Phase 1: Tray-first runtime shell
//
// Lifecycle order:
//   1. single-instance plugin (must be first — captures second-launch focus)
//   2. autostart plugin
//   3. store plugin
//   4. window-state plugin
//   5. tray icon + menu construction
//   6. close-to-tray interception via on_window_event

use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, Runtime,
};

const TRAY_ICON_ID: &str = "main-tray";
const STARTUP_TOGGLE_ITEM_ID: &str = "startup-toggle";

// ---------------------------------------------------------------------------
// Helper: show-and-focus the main settings window
// ---------------------------------------------------------------------------
fn show_and_focus_settings<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

// ---------------------------------------------------------------------------
// Helper: safe quit — no deferred LED shutdown in Phase 1
// ---------------------------------------------------------------------------
fn safe_quit<R: Runtime>(app: &AppHandle<R>) {
    app.exit(0);
}

#[tauri::command]
fn set_tray_startup_checked<R: Runtime>(app: AppHandle<R>, checked: bool) -> Result<(), String> {
    let tray = app
        .tray_by_id(TRAY_ICON_ID)
        .ok_or_else(|| "Tray icon not found".to_string())?;

    let startup_item = tray
        .get_item(STARTUP_TOGGLE_ITEM_ID)
        .ok_or_else(|| "Startup tray item not found".to_string())?;

    let check_item = startup_item
        .as_check_menuitem()
        .ok_or_else(|| "Startup tray item is not checkable".to_string())?;

    check_item
        .set_checked(checked)
        .map_err(|error| format!("Failed to set startup tray check state: {error}"))
}

// ---------------------------------------------------------------------------
// Build tray menu
// ---------------------------------------------------------------------------
fn build_tray_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let open = MenuItem::with_id(app, "open-settings", "Open Settings", true, None::<&str>)?;
    let separator1 = PredefinedMenuItem::separator(app)?;
    // Status indicator — disabled label (Phase 1: always "Idle")
    let status = MenuItem::with_id(app, "status-indicator", "● Idle", false, None::<&str>)?;
    let separator2 = PredefinedMenuItem::separator(app)?;
    let startup = CheckMenuItem::with_id(
        app,
        "startup-toggle",
        "Start at Login",
        true,
        false,
        None::<&str>,
    )?;
    let separator3 = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "Quit LumaSync", true, None::<&str>)?;

    Menu::with_items(
        app,
        &[
            &open,
            &separator1,
            &status,
            &separator2,
            &startup,
            &separator3,
            &quit,
        ],
    )
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();

    // 1. Single-instance must be registered first
    builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
        // Second launch: focus existing main window
        show_and_focus_settings(app);
    }));

    // 2. Autostart
    builder = builder.plugin(tauri_plugin_autostart::init(
        tauri_plugin_autostart::MacosLauncher::LaunchAgent,
        Some(vec!["--tray"]), // args passed on autostart launch
    ));

    // 3. Store (settings persistence)
    builder = builder.plugin(tauri_plugin_store::Builder::default().build());

    // 4. Window-state (geometry persistence)
    builder = builder.plugin(tauri_plugin_window_state::Builder::default().build());

    // 5. Opener (for external links)
    builder = builder.plugin(tauri_plugin_opener::init());

    builder
        .setup(|app| {
            // Build tray menu
            let menu = build_tray_menu(app.handle())?;
            let app_handle = app.handle().clone();

            // Build tray icon
            TrayIconBuilder::new()
                .id(TRAY_ICON_ID)
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .tooltip("LumaSync")
                // Left-click on tray icon → open/focus settings
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_and_focus_settings(tray.app_handle());
                    }
                })
                // Menu item actions
                .on_menu_event(move |app, event| match event.id.as_ref() {
                    "open-settings" => show_and_focus_settings(app),
                    "startup-toggle" => {
                        // Toggle is handled by the frontend via plugin-autostart commands.
                        // Here we just forward the action so the frontend can sync state.
                        let _ = app.emit("tray:startup-toggle-clicked", ());
                    }
                    "quit" => safe_quit(app),
                    _ => {}
                })
                .build(&app_handle)?;

            Ok(())
        })
        // Close-to-tray interception
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                // Prevent default close (process exit) and hide to tray instead
                api.prevent_close();
                let _ = window.hide();

                // Emit event so frontend can show one-time tray hint if needed
                let _ = window.emit("shell:close-to-tray", ());
            }
        })
        .invoke_handler(tauri::generate_handler![set_tray_startup_checked])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
