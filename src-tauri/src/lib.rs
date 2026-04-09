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
    menu::{Menu, MenuItem, PredefinedMenuItem},
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
    pub mod room_map;
    pub mod runtime_quality;
    pub mod runtime_telemetry;
}

mod models {
    pub mod room_map;
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
    simulate_hue_fault, start_hue_stream, stop_hue_stream, HueRuntimeStateStore,
};
use commands::lighting_mode::{
    get_lighting_mode_status, set_lighting_mode, stop_lighting, LightingRuntimeState,
};
use commands::room_map::{copy_background_image, load_room_map, save_room_map, update_hue_channel_positions};
use commands::runtime_telemetry::{get_runtime_telemetry, RuntimeTelemetryState};

const TRAY_ICON_ID: &str = "main-tray";

struct TrayState<R: Runtime> {
    open_settings: MenuItem<R>,
    lights_off: MenuItem<R>,
    resume_last_mode: MenuItem<R>,
    solid_color: MenuItem<R>,
    quit: MenuItem<R>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct TrayLabels {
    open_settings: String,
    lights_off: String,
    resume_last_mode: String,
    solid_color: String,
    quit: String,
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
fn update_tray_labels(
    tray_state: State<'_, TrayState<tauri::Wry>>,
    labels: TrayLabels,
) -> Result<(), String> {
    tray_state.open_settings.set_text(&labels.open_settings).map_err(|e| e.to_string())?;
    tray_state.lights_off.set_text(&labels.lights_off).map_err(|e| e.to_string())?;
    tray_state.resume_last_mode.set_text(&labels.resume_last_mode).map_err(|e| e.to_string())?;
    tray_state.solid_color.set_text(&labels.solid_color).map_err(|e| e.to_string())?;
    tray_state.quit.set_text(&labels.quit).map_err(|e| e.to_string())?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Build tray menu
// ---------------------------------------------------------------------------
fn build_tray_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<(Menu<R>, TrayState<R>)> {
    let open = MenuItem::with_id(app, "open-settings", "Open Settings", true, None::<&str>)?;
    let separator1 = PredefinedMenuItem::separator(app)?;
    let status = MenuItem::with_id(app, "status-indicator", "● Idle", false, None::<&str>)?;
    let separator2 = PredefinedMenuItem::separator(app)?;
    let lights_off = MenuItem::with_id(app, "tray-lights-off", "Lights Off", true, None::<&str>)?;
    let resume_last = MenuItem::with_id(app, "tray-resume-last-mode", "Resume Last Mode", true, None::<&str>)?;
    let solid_color = MenuItem::with_id(app, "tray-solid-color", "Solid Color", true, None::<&str>)?;
    let separator3 = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "Quit LumaSync", true, None::<&str>)?;

    let menu = Menu::with_items(
        app,
        &[
            &open,
            &separator1,
            &status,
            &separator2,
            &lights_off,
            &resume_last,
            &solid_color,
            &separator3,
            &quit,
        ],
    )?;

    let tray_state = TrayState {
        open_settings: open,
        lights_off,
        resume_last_mode: resume_last,
        solid_color,
        quit,
    };

    Ok((menu, tray_state))
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

    // 6a. Dialog (file picker for room map background)
    builder = builder.plugin(tauri_plugin_dialog::init());

    // 6b. Fs (file copy for room map background)
    builder = builder.plugin(tauri_plugin_fs::init());

    // 6. Updater (auto-update from GitHub Releases)
    builder = builder.plugin(tauri_plugin_updater::Builder::new().build());

    // 7. Logging
    #[cfg(debug_assertions)]
    {
        builder = builder.plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Warn)
                .level_for("lumasync_lib", log::LevelFilter::Debug)
                .level_for("reqwest", log::LevelFilter::Warn)
                .level_for("hyper", log::LevelFilter::Warn)
                .level_for("hyper_util", log::LevelFilter::Warn)
                .level_for("openssl", log::LevelFilter::Warn)
                .level_for("rustls", log::LevelFilter::Warn)
                .target(tauri_plugin_log::Target::new(
                    tauri_plugin_log::TargetKind::Stdout,
                ))
                .target(tauri_plugin_log::Target::new(
                    tauri_plugin_log::TargetKind::LogDir {
                        file_name: Some("lumasync-dev".to_string()),
                    },
                ))
                .build(),
        );
    }
    #[cfg(not(debug_assertions))]
    {
        builder = builder.plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                .level_for("reqwest", log::LevelFilter::Warn)
                .level_for("hyper", log::LevelFilter::Warn)
                .level_for("hyper_util", log::LevelFilter::Warn)
                .level_for("openssl", log::LevelFilter::Warn)
                .level_for("rustls", log::LevelFilter::Warn)
                .target(tauri_plugin_log::Target::new(
                    tauri_plugin_log::TargetKind::Stdout,
                ))
                .target(tauri_plugin_log::Target::new(
                    tauri_plugin_log::TargetKind::LogDir {
                        file_name: Some("lumasync".to_string()),
                    },
                ))
                .build(),
        );
    }

    builder
        .setup(|app| {
            // Build tray menu
            let (menu, tray_state) = build_tray_menu(app.handle())?;
            let app_handle = app.handle().clone();

            app.manage(tray_state);
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
                    "tray-lights-off" => { let _ = app.emit("tray:lights-off", ()); }
                    "tray-resume-last-mode" => { let _ = app.emit("tray:resume-last-mode", ()); }
                    "tray-solid-color" => { let _ = app.emit("tray:solid-color", ()); }
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
            update_tray_labels,
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
            update_display_overlay_preview,
            save_room_map,
            load_room_map,
            copy_background_image,
            update_hue_channel_positions,
            simulate_hue_fault, // debug: real fault injection, release: returns error stub
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
