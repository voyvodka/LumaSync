// LumaSync — Phase 1: Tray-first runtime shell
//
// Lifecycle order:
//   1. single-instance plugin (must be first — captures second-launch focus)
//   2. autostart plugin
//   3. store plugin
//   4. window-state plugin
//   5. tray icon + menu construction
//   6. close-to-tray interception via on_window_event

use std::{thread, time::Duration};
use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, Runtime, State,
};

mod commands {
    pub mod ambilight_capture;
    pub mod calibration;
    pub mod device_connection;
    pub mod hue_onboarding;
    pub mod hue_stream_lifecycle;
    pub mod led_output;
    pub mod lighting_mode;
    pub mod runtime_quality;
    pub mod runtime_telemetry;
}

use commands::calibration::{
    close_display_overlay, list_displays, open_display_overlay, start_calibration_test_pattern,
    stop_calibration_test_pattern, update_display_overlay_preview, OverlayState,
};
use commands::device_connection::{
    connect_serial_port, get_serial_connection_status, list_serial_ports, run_serial_health_check,
    SerialConnectionState,
};
use commands::hue_onboarding::{
    check_hue_stream_readiness, discover_hue_bridges, list_hue_entertainment_areas,
    pair_hue_bridge, validate_hue_credentials, verify_hue_bridge_ip,
};
use commands::hue_stream_lifecycle::{
    get_hue_area_channels, get_hue_stream_status, restart_hue_stream, set_hue_solid_color,
    start_hue_stream, stop_hue_stream, HueRuntimeStateStore,
};
use commands::lighting_mode::{
    get_lighting_mode_status, set_lighting_mode, stop_lighting, LightingRuntimeState,
};
use commands::runtime_telemetry::{get_runtime_telemetry, RuntimeTelemetryState};

const TRAY_ICON_ID: &str = "main-tray";

struct TrayState<R: Runtime> {
    startup_toggle: CheckMenuItem<R>,
}

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

fn hide_to_tray<R: Runtime>(window: &tauri::Window<R>) {
    let _ = window.hide();
    let _ = window.emit("shell:close-to-tray", ());
}

#[tauri::command]
fn set_tray_startup_checked(
    tray_state: State<'_, TrayState<tauri::Wry>>,
    checked: bool,
) -> Result<(), String> {
    tray_state
        .startup_toggle
        .set_checked(checked)
        .map_err(|error| format!("Failed to set startup tray check state: {error}"))
}

// ---------------------------------------------------------------------------
// Build tray menu
// ---------------------------------------------------------------------------
fn build_tray_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<(Menu<R>, CheckMenuItem<R>)> {
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

    let menu = Menu::with_items(
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
    )?;

    Ok((menu, startup))
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

    // 6. Updater (auto-update from GitHub Releases)
    builder = builder.plugin(tauri_plugin_updater::Builder::new().build());

    builder
        .setup(|app| {
            // Build tray menu
            let (menu, startup_toggle) = build_tray_menu(app.handle())?;
            let app_handle = app.handle().clone();

            app.manage(TrayState { startup_toggle });
            app.manage(SerialConnectionState::default());
            app.manage(OverlayState::default());
            app.manage(LightingRuntimeState::default());
            app.manage(HueRuntimeStateStore::default());
            app.manage(RuntimeTelemetryState::default());

            // Build tray icon
            TrayIconBuilder::with_id(TRAY_ICON_ID)
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

                if cfg!(target_os = "macos") && window.is_fullscreen().unwrap_or(false) {
                    let _ = window.set_fullscreen(false);
                    let app_handle = window.app_handle().clone();
                    let window_label = window.label().to_string();

                    thread::spawn(move || {
                        thread::sleep(Duration::from_millis(120));
                        if let Some(main_window) = app_handle.get_webview_window(&window_label) {
                            let _ = main_window.hide();
                            let _ = main_window.emit("shell:close-to-tray", ());
                        }
                    });

                    return;
                }

                hide_to_tray(window);
            }
        })
        .invoke_handler(tauri::generate_handler![
            set_tray_startup_checked,
            list_serial_ports,
            connect_serial_port,
            get_serial_connection_status,
            run_serial_health_check,
            discover_hue_bridges,
            verify_hue_bridge_ip,
            pair_hue_bridge,
            validate_hue_credentials,
            list_hue_entertainment_areas,
            check_hue_stream_readiness,
            start_hue_stream,
            stop_hue_stream,
            restart_hue_stream,
            set_hue_solid_color,
            get_hue_stream_status,
            get_hue_area_channels,
            set_lighting_mode,
            stop_lighting,
            get_lighting_mode_status,
            get_runtime_telemetry,
            start_calibration_test_pattern,
            stop_calibration_test_pattern,
            list_displays,
            open_display_overlay,
            close_display_overlay,
            update_display_overlay_preview
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
