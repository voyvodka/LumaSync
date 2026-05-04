// LumaSync — Phase 1: Tray-first runtime shell
//
// Lifecycle order:
//   1. single-instance plugin (must be first — captures second-launch focus)
//   2. autostart plugin
//   3. store plugin
//   4. window-state plugin
//   5. tray icon + menu construction
//   6. close-to-tray interception via on_window_event
//
// Shutdown flow (macOS, all OSes — see kick_off_shutdown_and_die for rationale):
//   - red-X / Cmd+W → WindowEvent::CloseRequested → prevent_close + hide_to_tray
//     (window stays alive in the tray; process keeps running).
//   - Tray Quit menu item → kick_off_shutdown_and_die directly.
//   - Cmd+Q on macOS → NSApp.terminate flow runs independently of our
//     window event hook (tao 0.35 does NOT register applicationShouldTerminate:
//     so there is no way to intercept it in user code). NSApp eventually fires
//     applicationWillTerminate → tao emits LoopDestroyed → tauri-runtime-wry
//     surfaces RunEvent::Exit. We catch RunEvent::Exit in the .run callback
//     and run the same cleanup path. The watchdog inside
//     kick_off_shutdown_and_die guarantees process death within 4s, so a
//     stuck SCStream/DTLS Drop never produces a `?E` zombie.
//   - Ctrl+C in the dev terminal → SIGINT → tokio::signal::ctrl_c task →
//     kick_off_shutdown_and_die.

use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, RunEvent, Runtime, State,
};

mod commands {
    pub mod ambilight_capture;
    pub mod calibration;
    pub mod device_connection;
    pub mod device_handshake;
    pub mod hue;
    pub mod hue_http;
    pub mod hue_intensity;
    pub mod hue_onboarding;
    pub mod hue_stream_lifecycle;
    pub mod led_calibration;
    pub mod led_output;
    pub mod led_sink;
    pub mod lighting_mode;
    pub mod notifications;
    pub mod platform;
    pub mod room_map;
    pub mod runtime_quality;
    pub mod runtime_telemetry;
    pub mod wled_discovery;
    pub mod wled_sink;
}

#[cfg(target_os = "macos")]
mod macos_window;

mod models {
    pub mod room_map;
}

// v1.5 W2-A3 — shared LAN-discovery primitives (mDNS responder registry).
mod network;

use commands::calibration::{
    close_display_overlay, list_displays, open_display_overlay, start_calibration_test_pattern,
    stop_calibration_test_pattern, update_display_overlay_preview, OverlayState,
};
use commands::device_connection::{
    connect_serial_port, get_serial_connection_status, list_serial_ports, run_serial_health_check,
    ActiveSinkRegistry, SerialConnectionState,
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
use commands::notifications::{request_notification_permission, show_notification};
use commands::platform::open_log_dir;
use commands::room_map::hue_zone::{
    assign_channel_to_hue_zone, create_hue_zone, delete_hue_zone, update_hue_zone,
};
use commands::room_map::save_load::{
    copy_background_image, load_room_map, save_room_map, update_hue_channel_positions,
};
use commands::runtime_telemetry::{get_runtime_telemetry, RuntimeTelemetryState};
use commands::wled_discovery::{connect_wled_sink, discover_wled_devices, test_wled_bridge};

const TRAY_ICON_ID: &str = "main-tray";

/// Hard-exit deadline for shutdown. The cleanup path joins worker threads,
/// drops SCStream, deactivates DTLS — each of which can theoretically hang
/// (objc cleanup, network timeout, mutex contention). The watchdog ensures
/// the process always dies within this window, even when something hangs.
const SHUTDOWN_WATCHDOG: std::time::Duration = std::time::Duration::from_secs(4);

/// Set to `true` once a shutdown sequence has been kicked off so we don't
/// spawn redundant cleanup threads on RunEvent::ExitRequested + RunEvent::Exit
/// arriving back-to-back.
static SHUTDOWN_FIRED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

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
// Helper: cleanup_blocking — actually stops all background workers.
//
// Runs on a dedicated std::thread (NEVER the macOS main thread). Joins
// the ambilight worker (drops SCStream from a non-main thread, see
// LightingWorkerRuntime::stop), waits up to 3s for the Hue DTLS sender
// to ack shutdown, and releases the active serial sink.
// ---------------------------------------------------------------------------
fn cleanup_blocking<R: Runtime>(app: AppHandle<R>) {
    log::info!("[shutdown] cleanup thread started");

    // 1. Ambilight / serial capture worker.
    let t1 = std::time::Instant::now();
    if let Err(e) = stop_lighting(app.state::<LightingRuntimeState>()) {
        log::warn!("[shutdown] stop_lighting reported: {e}");
    }
    log::info!("[shutdown] step 1 (stop_lighting) took {:?}", t1.elapsed());

    // 2. Hue entertainment stream — bounded to 1.5s on shutdown.
    //
    // stop_hue_stream's worst case is HTTP deactivate (5s reqwest timeout)
    // + sender shutdown wait (3s Condvar) = up to 8s when the bridge is
    // slow or unreachable. That blew through our 4s watchdog and caused the
    // "cleanup hung — forcing exit" path. Bridge state restore is
    // best-effort (the bridge times out the entertainment session
    // server-side anyway), so detach the call and abandon after 1.5s if it
    // hasn't returned. process::exit(0) below will tear down the orphan
    // worker thread regardless.
    let t2 = std::time::Instant::now();
    let app_for_hue = app.clone();
    let (tx, rx) = std::sync::mpsc::channel::<Result<(), String>>();
    std::thread::Builder::new()
        .name("lumasync-shutdown-hue".into())
        .spawn(move || {
            let result = stop_hue_stream(None, app_for_hue.state::<HueRuntimeStateStore>())
                .map(|_| ())
                .map_err(|e| format!("{e:?}"));
            let _ = tx.send(result);
        })
        .ok();
    match rx.recv_timeout(std::time::Duration::from_millis(1500)) {
        Ok(Ok(())) => {
            log::info!(
                "[shutdown] step 2 (stop_hue_stream) took {:?}",
                t2.elapsed()
            )
        }
        Ok(Err(e)) => log::warn!("[shutdown] stop_hue_stream reported: {e}"),
        Err(_) => log::warn!(
            "[shutdown] step 2 (stop_hue_stream) abandoned after {:?}",
            t2.elapsed()
        ),
    }

    // 3. Active LED sink (serial port session).
    let t3 = std::time::Instant::now();
    app.state::<ActiveSinkRegistry>().clear();
    log::info!("[shutdown] step 3 (sink clear) took {:?}", t3.elapsed());

    log::info!("[shutdown] cleanup complete, exiting");
    cleanup_orphan_socket();
    std::process::exit(0);
}

// ---------------------------------------------------------------------------
// Helper: kick_off_shutdown_and_die — entry point for ALL shutdown triggers.
//
// Spawns cleanup_blocking on a worker thread (so the macOS main thread is
// never held — that was the deadlock culprit in v1.5.1+ when safe_quit ran
// inline inside the tray menu callback or the WindowEvent::CloseRequested
// handler). Arms a watchdog thread that calls process::exit(0) after
// SHUTDOWN_WATCHDOG no matter what. Idempotent via SHUTDOWN_FIRED.
//
// This is what guarantees no `?E` zombies: the process dies in <= 4s
// regardless of whether SCStream Drop, DTLS deactivate, or any other
// cleanup step hangs.
// ---------------------------------------------------------------------------
fn kick_off_shutdown_and_die<R: Runtime>(app: &AppHandle<R>) {
    if SHUTDOWN_FIRED.swap(true, std::sync::atomic::Ordering::SeqCst) {
        // Already in progress — don't re-arm.
        return;
    }
    log::info!("[shutdown] kicked off (watchdog={SHUTDOWN_WATCHDOG:?})");

    // Worker thread: do the graceful cleanup, then exit(0).
    let app_for_cleanup = app.clone();
    std::thread::Builder::new()
        .name("lumasync-shutdown".into())
        .spawn(move || cleanup_blocking(app_for_cleanup))
        .expect("failed to spawn shutdown cleanup thread");

    // Watchdog thread: guaranteed exit after SHUTDOWN_WATCHDOG.
    std::thread::Builder::new()
        .name("lumasync-shutdown-watchdog".into())
        .spawn(|| {
            std::thread::sleep(SHUTDOWN_WATCHDOG);
            log::warn!("[shutdown] watchdog fired — forcing exit (cleanup hung)");
            cleanup_orphan_socket();
            std::process::exit(0);
        })
        .expect("failed to spawn shutdown watchdog thread");
}

// Hard-exit (`std::process::exit`) bypasses Tauri plugin destroy() callbacks,
// so the single-instance plugin's Unix socket at
// /tmp/com_<identifier>_si.sock is leaked whenever the watchdog fires. The
// next launch's plugin connect() succeeds against the stale inode and the
// new instance silently exit(0)s. Remove the socket explicitly before the
// hard exit so the next launch starts cleanly.
fn cleanup_orphan_socket() {
    let path = "/tmp/com_lumasync_app_si.sock";
    match std::fs::remove_file(path) {
        Ok(()) => log::info!("[shutdown] removed orphan socket {path}"),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => log::warn!("[shutdown] could not remove {path}: {e}"),
    }
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
    tray_state
        .open_settings
        .set_text(&labels.open_settings)
        .map_err(|e| e.to_string())?;
    tray_state
        .lights_off
        .set_text(&labels.lights_off)
        .map_err(|e| e.to_string())?;
    tray_state
        .resume_last_mode
        .set_text(&labels.resume_last_mode)
        .map_err(|e| e.to_string())?;
    tray_state
        .solid_color
        .set_text(&labels.solid_color)
        .map_err(|e| e.to_string())?;
    tray_state
        .quit
        .set_text(&labels.quit)
        .map_err(|e| e.to_string())?;
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
    let resume_last = MenuItem::with_id(
        app,
        "tray-resume-last-mode",
        "Resume Last Mode",
        true,
        None::<&str>,
    )?;
    let solid_color =
        MenuItem::with_id(app, "tray-solid-color", "Solid Color", true, None::<&str>)?;
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

    // 1. Single-instance must be registered first.
    //
    // The macOS impl uses a Unix domain socket at `/tmp/<identifier>_si.sock`,
    // NOT NSWorkspace zombie detection (verified against
    // tauri-plugin-single-instance 2.4.1 source). The earlier "silent
    // exit within 50ms" launch failure traced to leftover sockets from
    // `?E` zombies whose RunEvent::Exit hook never fired (so the plugin's
    // socket cleanup at `destroy()` never ran). With the new
    // kick_off_shutdown_and_die guaranteeing process death + RunEvent::Exit
    // delivery, the plugin's socket is now reliably cleaned, so we keep
    // it enabled in BOTH debug and release builds.
    // Debug builds skip single-instance: hard-exit (process::exit) bypasses
    // the plugin's destroy() socket cleanup, so dev iterations leak
    // /tmp/com_lumasync_app_si.sock and the next launch silently exits when
    // the plugin connects to the stale socket. Release builds keep it on
    // because tray-first UX needs single-instance contract; the explicit
    // socket cleanup above guards against the hard-exit path on release too.
    #[cfg(not(debug_assertions))]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // Second launch: focus existing main window
            show_and_focus_settings(app);
        }));
    }

    // 2. Autostart
    builder = builder.plugin(tauri_plugin_autostart::init(
        tauri_plugin_autostart::MacosLauncher::LaunchAgent,
        Some(vec!["--tray"]), // args passed on autostart launch
    ));

    // 3. Store (settings persistence)
    builder = builder.plugin(tauri_plugin_store::Builder::default().build());

    // 4. Window-state (geometry persistence)
    //
    // Default flags (`StateFlags::all()`) would auto-restore SIZE and
    // VISIBLE on launch, which fights our "always start in compact, hidden
    // until React is ready" rule and causes a visible big→compact flash.
    // `skip_initial_state("main")` keeps the save-on-close behavior but
    // disables the automatic restore so the JS bootstrap owns everything.
    builder = builder.plugin(
        tauri_plugin_window_state::Builder::default()
            .skip_initial_state("main")
            .build(),
    );

    // 5. Opener (for external links)
    builder = builder.plugin(tauri_plugin_opener::init());

    // 6a. Dialog (file picker for room map background)
    builder = builder.plugin(tauri_plugin_dialog::init());

    // 6b. Fs (file copy for room map background)
    builder = builder.plugin(tauri_plugin_fs::init());

    // 6. Updater (auto-update from GitHub Releases)
    builder = builder.plugin(tauri_plugin_updater::Builder::new().build());

    // 6c. Notification (OS toast surface — macOS User Notifications,
    //      Windows Toast, Linux libnotify). Permission prompt is
    //      triggered just-in-time from commands::notifications.
    builder = builder.plugin(tauri_plugin_notification::init());

    // 6d. Process (app relaunch surface for GlobalErrorBoundary's
    //      Restart button; also available from React via
    //      @tauri-apps/plugin-process `relaunch()`).
    builder = builder.plugin(tauri_plugin_process::init());

    // 7. Logging
    //
    // Rotation strategy is split per build profile:
    //   - debug: KeepAll so developers retain the full history across
    //     long reproduction sessions without the sink silently
    //     discarding context.
    //   - release: KeepOne (current + one rotated) so a busy
    //     ambilight run cannot balloon the log directory on disk.
    // Both profiles share the same 5 MB per-file cap.
    const LOG_MAX_FILE_SIZE: u128 = 5 * 1024 * 1024;
    #[cfg(debug_assertions)]
    {
        builder = builder.plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Warn)
                .level_for("lumasync_lib", log::LevelFilter::Debug)
                // `webview` is the target name used by tauri-plugin-log's
                // attachConsole() JS bridge — keeping it at Info preserves
                // frontend `console.info`/`console.log` lines in the file
                // sink so external observers (e.g. the lumasync-debug
                // skill) can correlate frontend + backend timelines from a
                // single log file. Without this, only console.warn / error
                // would survive the global Warn filter.
                .level_for("webview", log::LevelFilter::Info)
                .level_for("reqwest", log::LevelFilter::Warn)
                .level_for("hyper", log::LevelFilter::Warn)
                .level_for("hyper_util", log::LevelFilter::Warn)
                .level_for("openssl", log::LevelFilter::Warn)
                .level_for("rustls", log::LevelFilter::Warn)
                .timezone_strategy(tauri_plugin_log::TimezoneStrategy::UseLocal)
                .max_file_size(LOG_MAX_FILE_SIZE)
                .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepAll)
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
                .timezone_strategy(tauri_plugin_log::TimezoneStrategy::UseLocal)
                .max_file_size(LOG_MAX_FILE_SIZE)
                .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepOne)
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

    let app = builder
        .setup(|app| {
            // Build tray menu
            let (menu, tray_state) = build_tray_menu(app.handle())?;
            let app_handle = app.handle().clone();

            // On non-macOS platforms, disable native window decorations so the
            // custom React <TitleBar /> can render icon+name+window controls
            // consistently. macOS keeps native traffic lights via the
            // `titleBarStyle: "Overlay"` + `hiddenTitle: true` combo set in
            // tauri.conf.json (content extends under the traffic lights).
            #[cfg(not(target_os = "macos"))]
            if let Some(main_window) = app.get_webview_window("main") {
                let _ = main_window.set_decorations(false);
            }

            // On macOS, forbid native fullscreen so the system's auto-hiding
            // fullscreen title bar can never collide with our custom one.
            #[cfg(target_os = "macos")]
            if let Some(main_window) = app.get_webview_window("main") {
                macos_window::forbid_native_fullscreen(&main_window);
            }

            // Debug builds: auto-open WebView devtools in a detached window so
            // frontend `console.log` is visible without manually toggling it
            // from the WebView context menu each launch.
            #[cfg(debug_assertions)]
            if let Some(main_window) = app.get_webview_window("main") {
                main_window.open_devtools();
            }

            app.manage(tray_state);
            app.manage(SerialConnectionState::default());
            app.manage(ActiveSinkRegistry::default());
            app.manage(OverlayState::default());
            app.manage(LightingRuntimeState::default());
            app.manage(HueRuntimeStateStore::default());
            app.manage(RuntimeTelemetryState::default());

            // Build tray icon.
            //
            // macOS sizing, spacing & silhouette: NSStatusItem expects a
            // ~22pt template image. The default window icon is the
            // bundle's full-colour rounded-square (opaque dark background
            // + yellow slash); under template-image masking only its
            // alpha channel matters, so it would render as a solid white
            // square in the menu bar. We instead embed a dedicated
            // pre-built monochrome silhouette of the slash glyph at 44x44
            // (Retina-friendly; AppKit downscales to 22pt on non-Retina)
            // and set `icon_as_template(true)` so AppKit treats the
            // alpha as a mask and auto-tints for light/dark menu bar.
            //
            // The asset is `include_bytes!`'d at compile time so the
            // tray works whether or not the running binary can resolve
            // its bundle resources directory at runtime.
            //
            // Linux & Windows are intentionally untouched: both expect a
            // full-colour tray icon and the template flag is macOS-only.
            let tray_builder = {
                let base = TrayIconBuilder::with_id(TRAY_ICON_ID)
                    .icon(app.default_window_icon().unwrap().clone())
                    .menu(&menu)
                    .tooltip("LumaSync");

                #[cfg(target_os = "macos")]
                {
                    // Pre-decoded RGBA bytes for `tray-icon@2x.png` (44x44).
                    // The companion PNG lives at `icons/tray-icon@2x.png`; the
                    // raw RGBA copy is generated from it via:
                    //   magick tray-icon@2x.png -depth 8 RGBA:tray-icon@2x.rgba
                    // We embed the raw form so we can hand it directly to
                    // `Image::new` without dragging in a PNG decoder at runtime.
                    const TRAY_ICON_RGBA: &[u8] =
                        include_bytes!("../icons/tray-icon@2x.rgba");
                    const TRAY_ICON_DIM: u32 = 44;
                    base.icon(tauri::image::Image::new(
                        TRAY_ICON_RGBA,
                        TRAY_ICON_DIM,
                        TRAY_ICON_DIM,
                    ))
                    .icon_as_template(true)
                }

                #[cfg(not(target_os = "macos"))]
                base
            };
            tray_builder
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
                    "tray-lights-off" => {
                        let _ = app.emit("tray:lights-off", ());
                    }
                    "tray-resume-last-mode" => {
                        let _ = app.emit("tray:resume-last-mode", ());
                    }
                    "tray-solid-color" => {
                        let _ = app.emit("tray:solid-color", ());
                    }
                    "quit" => kick_off_shutdown_and_die(app),
                    _ => {}
                })
                .build(&app_handle)?;

            // Dev-only: catch SIGINT (Ctrl+C in the terminal that ran
            // `pnpm tauri dev`) and run the same orderly shutdown path
            // so the dev terminal returns promptly instead of waiting on
            // cargo to send SIGTERM after a 10s grace.
            //
            // Tauri's async runtime is the multi-threaded tokio runtime; the
            // `signal` feature on the tokio dep is the only requirement.
            #[cfg(all(unix, debug_assertions))]
            {
                let app_for_signal = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    if let Ok(()) = tokio::signal::ctrl_c().await {
                        log::info!("[shutdown] SIGINT received");
                        kick_off_shutdown_and_die(&app_for_signal);
                    }
                });
            }

            Ok(())
        })
        // Close-to-tray interception (main window only — overlay windows must close freely).
        //
        // This handles red-X and Cmd+W cleanly. Cmd+Q on macOS ALSO routes
        // through here (NSApp's terminate broadcast hits each window's
        // windowShouldClose:), but the NSApp terminate flow proceeds
        // independently of our prevent_close — applicationWillTerminate
        // fires next regardless, surfaced as RunEvent::Exit below. So for
        // Cmd+Q the user sees the window vanish (hide_to_tray) and then
        // the process dies via the .run() callback's RunEvent::Exit branch.
        .on_window_event(|window, event| {
            if window.label() != "main" {
                return;
            }
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
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
            show_notification,
            request_notification_permission,
            open_log_dir,
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
            create_hue_zone,
            update_hue_zone,
            delete_hue_zone,
            assign_channel_to_hue_zone,
            simulate_hue_fault, // debug: real fault injection, release: returns error stub
            discover_wled_devices,
            connect_wled_sink,
            test_wled_bridge,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    // .run() with a callback is the only place that sees RunEvent::Exit on
    // macOS Cmd+Q (tao 0.35 surfaces applicationWillTerminate as
    // LoopDestroyed → tauri-runtime-wry → RunEvent::Exit). Without this
    // hook, Cmd+Q tears the process down WITHOUT ever running our cleanup,
    // which is what produced the `?E` zombies in earlier sessions.
    //
    // RunEvent::ExitRequested fires on app.exit() / app.restart() — currently
    // unused but covered for completeness in case future code paths add a
    // programmatic exit.
    app.run(|app_handle, event| match event {
        RunEvent::ExitRequested { api, .. } => {
            // We do our own orderly shutdown; let Tauri proceed with its
            // exit flow but make sure cleanup is kicked off so the process
            // dies before any plugin cleanup hangs.
            log::info!("[shutdown] RunEvent::ExitRequested received");
            kick_off_shutdown_and_die(app_handle);
            // Don't prevent — let Tauri also try its graceful path; whichever
            // races to exit(0) first wins, watchdog backstop is armed.
            let _ = api;
        }
        RunEvent::Exit => {
            log::info!("[shutdown] RunEvent::Exit received");
            kick_off_shutdown_and_die(app_handle);
            // We do NOT return from this callback into Tauri's normal teardown
            // because that path runs in the macOS main thread context post-
            // applicationWillTerminate, where SCStream Drop has been observed
            // to deadlock. The watchdog inside kick_off guarantees _exit(0)
            // within SHUTDOWN_WATCHDOG.
        }
        _ => {}
    });
}
