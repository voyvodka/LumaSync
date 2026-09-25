// LumaSync — tray-first runtime shell. Plugin registration order
// matters (single-instance first). Shutdown triggers all converge on
// `shutdown::begin` — see docs/architecture/ui-and-shell.md.

use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, EventTarget, Manager, RunEvent, Runtime, State,
};

mod commands {
    pub mod ambilight_capture;
    pub mod ambilight_scene;
    pub mod calibration;
    pub mod device_connection;
    pub mod device_handshake;
    pub mod hue;
    pub mod hue_http;
    pub mod hue_intensity;
    pub mod hue_onboarding;
    pub mod launch;
    pub mod led_calibration;
    pub mod led_output;
    pub mod led_preview;
    pub mod led_sink;
    pub mod lighting_mode;
    pub mod notifications;
    pub mod platform;
    pub mod room_affinity;
    pub mod room_map;
    pub mod runtime_quality;
    pub mod runtime_telemetry;
    pub mod screen_capture_permission;
    pub mod shell_state;
    pub mod status;
    pub mod test_pattern;
    pub mod updater;
    pub mod window_visibility;
    pub mod wled_discovery;
    pub mod wled_sink;
}

#[cfg(target_os = "macos")]
mod macos_window;

// Single source for every Tauri event name — see its module doc.
mod events;
mod panic_log;
mod shutdown;

// Evidence-gathering hooks for the CI platform bench; never in a release bin.
#[cfg(debug_assertions)]
mod smoke_bench;
#[cfg(debug_assertions)]
mod smoke_overlay;

mod models {
    pub mod room_map;
}

// Shared LAN-discovery primitives (mDNS responder registry).
mod network;

// Lives in-crate rather than under `tests/` because `mod commands` is private.
#[cfg(test)]
mod ipc_tests;

use commands::calibration::{
    close_display_overlay, list_displays, open_display_overlay, update_display_overlay_preview,
    OverlayState,
};
use commands::device_connection::{
    connect_serial_port, get_serial_connection_status, list_serial_ports, run_serial_health_check,
    ActiveSinkRegistry, SerialConnectionState, SerialPortAccess,
};
use commands::hue::commands::{
    get_hue_area_channels, get_hue_stream_status, restart_hue_stream, set_hue_solid_color,
    simulate_hue_fault, start_hue_stream,
};
use commands::hue::health::{get_hue_health, retry_hue_health, watch_hue_health};
use commands::hue::state_store::HueRuntimeStateStore;
use commands::hue_onboarding::{
    check_hue_stream_readiness, discover_hue_bridges, list_hue_entertainment_areas,
    migrate_hue_credentials, pair_hue_bridge, validate_hue_credentials, verify_hue_bridge_ip,
};
use commands::launch::{get_launch_context, AUTOSTART_TRAY_ARG};
use commands::led_preview::{
    close_led_twin_overlay, hide_led_control_popup, open_led_control_popup, open_led_twin_overlay,
    show_led_control_popup, LedTwinState,
};
use commands::lighting_mode::outputs::{
    apply_outputs, get_lighting_runtime, release_hue_output, run_tray_lighting, TrayLighting,
};
use commands::lighting_mode::tuning::retune_lighting;
use commands::lighting_mode::{
    get_led_preview_status, start_led_test_pattern, stop_led_test_pattern, LightingRuntimeState,
};
use commands::notifications::{request_notification_permission, show_notification};
use commands::platform::open_log_dir;
use commands::room_map::hue_zone::{
    assign_channel_to_hue_zone, create_hue_zone, delete_hue_zone, update_hue_zone,
};
use commands::room_map::save_load::{copy_background_image, update_hue_channel_positions};
use commands::runtime_telemetry::{
    get_runtime_telemetry, register_runtime_health_sink, RuntimeHealth, RuntimeTelemetryState,
    RUNTIME_HEALTH_CHANGED_EVENT,
};
use commands::screen_capture_permission::{
    get_screen_capture_permission, open_screen_capture_settings,
};
use commands::shell_state::{
    get_shell_state, patch_shell_state, replace_shell_state, ShellStateStore,
};
use commands::updater::{check_for_update, download_and_install_update, PendingUpdate};
use commands::window_visibility::{get_main_window_visibility, MainWindowVisibilityState};
use commands::wled_discovery::{
    connect_wled_sink, discover_wled_devices, get_wled_sink_status, test_wled_bridge,
};
use events::{SHELL_CLOSE_TO_TRAY_EVENT, TRAY_SHOW_LED_PREVIEW_EVENT};

/// Label of the primary settings webview window. Defined in
/// `tauri.conf.json` (`app.windows[].label = "main"`). Hot-path Rust→JS
/// events use `Emitter::emit_to(EventTarget::webview_window(MAIN_WINDOW_LABEL), ...)`
/// to avoid waking calibration-overlay webviews on every frame.
pub const MAIN_WINDOW_LABEL: &str = "main";

const TRAY_ICON_ID: &str = "main-tray";

struct TrayState<R: Runtime> {
    open_settings: MenuItem<R>,
    status: MenuItem<R>,
    lights_off: MenuItem<R>,
    resume_last_mode: MenuItem<R>,
    solid_color: MenuItem<R>,
    show_led_preview: MenuItem<R>,
    close_overlays: MenuItem<R>,
    quit: MenuItem<R>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct TrayLabels {
    open_settings: String,
    /// The disabled line under "Open LumaSync": the running mode and outputs,
    /// localized by the frontend, which is where the mode is known.
    status: String,
    lights_off: String,
    resume_last_mode: String,
    solid_color: String,
    show_led_preview: String,
    close_overlays: String,
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
        commands::window_visibility::refresh(app);
    }
}

// ---------------------------------------------------------------------------
// Helper: tray rescue — tear every overlay down and put the shell back
// ---------------------------------------------------------------------------

/// The overlays are `closable(false)`, `skip_taskbar(true)` and undecorated, so
/// an overlay that captures input instead of passing it through takes the whole
/// desktop with it: nothing underneath is clickable, and there is no title bar
/// and no taskbar button to close it with. The tray belongs to the shell and
/// cannot be covered, which makes it the one surface still reachable.
///
/// Deliberately backend-only. Every other tray item emits to the webview and
/// lets the frontend act, but a wedge is the worst moment to depend on a round
/// trip through it — so this closes the windows directly and shows the main
/// window unconditionally, rather than through `restore_main_after_preview`,
/// which only acts when the preview is what hid it.
pub(crate) fn close_all_overlays<R: Runtime>(app: &AppHandle<R>) {
    if let Some(twin_state) = app.try_state::<commands::led_preview::LedTwinState>() {
        if let Err(error) = commands::led_preview::close_led_twin_overlay(
            app.clone(),
            twin_state,
            commands::led_preview::CloseLedTwinOverlayPayload { display_id: None },
        ) {
            log::warn!("[tray] closing the twin overlays failed: {error}");
        }
    }

    if let Some(overlay_state) = app.try_state::<commands::calibration::OverlayState>() {
        if let Err(error) = commands::calibration::close_any_display_overlay(app, &overlay_state) {
            log::warn!("[tray] closing the calibration overlay failed: {error}");
        }
    }

    if let Some(twin_state) = app.try_state::<commands::led_preview::LedTwinState>() {
        if let Err(error) = commands::led_preview::hide_led_control_popup(app.clone(), twin_state) {
            log::warn!("[tray] hiding the control popup failed: {error}");
        }
    }

    show_and_focus_settings(app);
}

/// Main window only: the stall notice and the link-budget note live there.
fn register_runtime_health_emitter<R: Runtime>(app: &AppHandle<R>) {
    let app = app.clone();
    register_runtime_health_sink(std::sync::Arc::new(move |health: &RuntimeHealth| {
        if let Err(error) = app.emit_to(
            EventTarget::webview_window(MAIN_WINDOW_LABEL),
            RUNTIME_HEALTH_CHANGED_EVENT,
            health,
        ) {
            log::warn!("[runtime-health] emit failed: {error}");
        }
    }));
}

fn hide_to_tray<R: Runtime>(window: &tauri::Window<R>) {
    let _ = window.hide();
    commands::window_visibility::refresh(window.app_handle());
    // Target the main shell webview only — overlay windows must not receive
    // tray/shell lifecycle events. The `Window` here is already the main
    // window (filtered in the on_window_event handler) so a window-scoped
    // emit would already be safe; we still go through `emit_to` for
    // symmetry with the tray menu emits below.
    let _ = window.emit_to(
        EventTarget::webview_window(MAIN_WINDOW_LABEL),
        SHELL_CLOSE_TO_TRAY_EVENT,
        (),
    );
}

#[tauri::command]
fn update_tray_labels(
    tray_state: State<'_, TrayState<tauri::Wry>>,
    labels: TrayLabels,
) -> Result<(), String> {
    apply_tray_labels(&tray_state, &labels)
}

fn apply_tray_labels<R: Runtime>(
    tray_state: &TrayState<R>,
    labels: &TrayLabels,
) -> Result<(), String> {
    tray_state
        .open_settings
        .set_text(&labels.open_settings)
        .map_err(|e| e.to_string())?;
    tray_state
        .status
        .set_text(&labels.status)
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
        .show_led_preview
        .set_text(&labels.show_led_preview)
        .map_err(|e| e.to_string())?;
    tray_state
        .close_overlays
        .set_text(&labels.close_overlays)
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
    let open = MenuItem::with_id(app, "open-settings", "Open LumaSync", true, None::<&str>)?;
    let separator1 = PredefinedMenuItem::separator(app)?;
    // Neutral until the frontend pushes the real, localized line.
    let status = MenuItem::with_id(app, "status-indicator", "LumaSync", false, None::<&str>)?;
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
    let show_led_preview = MenuItem::with_id(
        app,
        "tray-show-led-preview",
        "LED Preview",
        true,
        None::<&str>,
    )?;
    let close_overlays = MenuItem::with_id(
        app,
        "tray-close-overlays",
        "Close Overlays",
        true,
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
            &lights_off,
            &resume_last,
            &solid_color,
            &show_led_preview,
            &close_overlays,
            &separator3,
            &quit,
        ],
    )?;

    let tray_state = TrayState {
        open_settings: open,
        status,
        lights_off,
        resume_last_mode: resume_last,
        solid_color,
        show_led_preview,
        close_overlays,
        quit,
    };

    Ok((menu, tray_state))
}

/// Wraps `generate_context!` in a function because the macro embeds
/// `_EMBED_INFO_PLIST` and a second expansion is a duplicate-symbol link error.
/// `ipc_tests` builds its mock apps from this same context.
fn app_context<R: Runtime>() -> tauri::Context<R> {
    tauri::generate_context!()
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();

    // 1. Single-instance must be registered first. Release-only — debug's
    // hard-exit hot-reload cycle would otherwise leak the socket on every
    // iteration. See docs/architecture/ui-and-shell.md.
    #[cfg(not(debug_assertions))]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            // Second launch: focus existing main window — unless it is the
            // autostart entry firing at login over an instance already running.
            if !commands::launch::launched_to_tray(&args) {
                show_and_focus_settings(app);
            }
        }));
    }

    // 1b. E2E WebDriver server. The env gate matters: the plugin binds 4445 the
    // moment it is registered, and `cargo test --all-features` turns the feature on.
    #[cfg(feature = "e2e")]
    if std::env::var(tauri_plugin_wdio_webdriver::PORT_ENV_VAR).is_ok() {
        builder = builder.plugin(tauri_plugin_wdio_webdriver::init());
    }

    // 2. Autostart
    builder = builder.plugin(tauri_plugin_autostart::init(
        tauri_plugin_autostart::MacosLauncher::LaunchAgent,
        Some(vec![AUTOSTART_TRAY_ARG]),
    ));

    // 4. Window-state (geometry persistence)
    //
    // Default flags (`StateFlags::all()`) would auto-restore SIZE and
    // VISIBLE on launch, which fights our "start hidden until React is ready,
    // then restore the saved UI mode" rule and causes a visible resize flash.
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
                // Frontend records arrive as `webview::<location>`. Before
                // plugin-log 2.9.2 the separator was a single `:`, which fern's
                // `::` level inheritance never matched; the global Info floor
                // covers both. Suppress noisy dependency targets below.
                .level(log::LevelFilter::Info)
                .level_for("lumasync_lib", log::LevelFilter::Debug)
                .level_for("reqwest", log::LevelFilter::Warn)
                .level_for("hyper", log::LevelFilter::Warn)
                .level_for("hyper_util", log::LevelFilter::Warn)
                .level_for("openssl", log::LevelFilter::Warn)
                .level_for("rustls", log::LevelFilter::Warn)
                .timezone_strategy(tauri_plugin_log::TimezoneStrategy::UseLocal)
                .max_file_size(LOG_MAX_FILE_SIZE)
                .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepAll)
                // `targets`, not `target`: the builder starts with a default
                // Stdout + LogDir pair and `target` appends to it — see
                // docs/architecture/build-and-release.md, "Log lines twice".
                .targets([
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir {
                        file_name: Some("lumasync-dev".to_string()),
                    }),
                ])
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
                .targets([
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir {
                        file_name: Some("lumasync".to_string()),
                    }),
                ])
                .build(),
        );
    }

    let app = builder
        .setup(|app| {
            // First thing after the log plugin has installed the logger.
            panic_log::install();

            // Before the banner below, which reads the update channel from it.
            app.manage(ShellStateStore::for_app(app.handle()));

            // Stable and beta are one install writing the same file in turn, so
            // no line says which build wrote it. Per-launch: a mid-session
            // rotation can still leave a file with no banner.
            log::info!(
                "[startup] LumaSync v{} ({}) channel={}",
                env!("CARGO_PKG_VERSION"),
                if cfg!(debug_assertions) {
                    "debug"
                } else {
                    "release"
                },
                commands::updater::read_update_channel(app.handle()),
            );

            // A dev binary is ad-hoc signed, so macOS asks for the login
            // keychain password once per secret per relink and no amount of
            // re-signing stops it — docs/architecture/build-and-release.md.
            // Debug builds keep their Hue credentials in a file instead.
            #[cfg(debug_assertions)]
            match app.path().app_data_dir() {
                Ok(dir) => commands::hue::credential_store::init_store_for_debug(dir),
                Err(error) => log::warn!(
                    "[hue-cred] no app data dir — debug build falls back to the OS keychain: {error}"
                ),
            }

            // Bridge certificate pins are a file, not keychain items, in every
            // build — docs/architecture/hue.md. Before any Hue command runs.
            match app.path().app_data_dir() {
                Ok(dir) => commands::hue::pin_store::init_pin_store(dir),
                Err(error) => log::warn!(
                    "[hue-tls] no app data dir — certificate pins last for this session only: {error}"
                ),
            }

            // Off the setup path: it touches the disk and nothing waits on it.
            match app.path().app_data_dir() {
                Ok(dir) => {
                    let handle = app.handle().clone();
                    std::thread::spawn(move || {
                        let state = commands::shell_state::persisted(&handle);
                        commands::room_map::background::prune_unreferenced_backgrounds(
                            &dir,
                            state.as_ref(),
                        )
                    });
                }
                Err(error) => {
                    log::warn!("[room-map] no app data dir — background prune skipped: {error}")
                }
            }

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
            // `LUMASYNC_NO_DEVTOOLS` takes it back out: opening devtools here is
            // the leading suspect for #181's debug-build navigation failure.
            #[cfg(debug_assertions)]
            if std::env::var_os("LUMASYNC_NO_DEVTOOLS").is_none() {
                if let Some(main_window) = app.get_webview_window("main") {
                    main_window.open_devtools();
                }
            }

            app.manage(tray_state);
            app.manage(SerialConnectionState::default());
            app.manage(SerialPortAccess::default());
            app.manage(ActiveSinkRegistry::default());
            app.manage(OverlayState::default());
            app.manage(LightingRuntimeState::default());
            app.manage(LedTwinState::default());
            app.manage(HueRuntimeStateStore::default());
            app.manage(RuntimeTelemetryState::default());
            app.manage(PendingUpdate::default());
            app.manage(MainWindowVisibilityState::default());
            register_runtime_health_emitter(app.handle());
            // After the shell state and the Hue runtime: its first pass reads both.
            commands::hue::health::install(app.handle());

            // After the `manage` calls, not next to `LUMASYNC_NO_DEVTOOLS`: the
            // hook resolves `OverlayState` when it fires.
            #[cfg(debug_assertions)]
            smoke_overlay::spawn_trigger_watcher(app.handle());

            // Both no-op unless their env var is `1` — see smoke_bench.rs.
            #[cfg(debug_assertions)]
            smoke_bench::spawn_credential_roundtrip();
            #[cfg(debug_assertions)]
            smoke_bench::spawn_capture_probe();

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
                    const TRAY_ICON_RGBA: &[u8] = include_bytes!("../icons/tray-icon@2x.rgba");
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
                    "tray-lights-off" => run_tray_lighting(app, TrayLighting::Off),
                    "tray-resume-last-mode" => {
                        run_tray_lighting(app, TrayLighting::ResumeLastMode)
                    }
                    "tray-solid-color" => run_tray_lighting(app, TrayLighting::SolidColor),
                    "tray-show-led-preview" => {
                        let _ = app.emit_to(
                            EventTarget::webview_window(MAIN_WINDOW_LABEL),
                            TRAY_SHOW_LED_PREVIEW_EVENT,
                            (),
                        );
                    }
                    "tray-close-overlays" => close_all_overlays(app),
                    "quit" => shutdown::begin(app, shutdown::ShutdownTrigger::TrayQuit, false),
                    _ => {}
                })
                .build(&app_handle)?;

            // Dev-only: catch SIGINT (Ctrl+C in the terminal that ran
            // `bun run tauri dev`) and run the same orderly shutdown path
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
                        shutdown::begin(
                            &app_for_signal,
                            shutdown::ShutdownTrigger::Sigint,
                            false,
                        );
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
            let label = window.label();
            // Main shell: red-X / Cmd+W hides to tray instead of quitting.
            if label == "main" {
                match event {
                    tauri::WindowEvent::CloseRequested { api, .. } => {
                        api.prevent_close();
                        hide_to_tray(window);
                    }
                    // Nothing reports show, hide or minimise as such; a
                    // minimise or restore resizes (Windows) and a window
                    // coming or going moves focus, so either re-reads it.
                    tauri::WindowEvent::Resized(_) | tauri::WindowEvent::Focused(_) => {
                        commands::window_visibility::refresh(window.app_handle());
                    }
                    _ => {}
                }
                return;
            }
            // LED control popup: mirror the main-window pattern — hide, never
            // destroy, so a re-show is cheap (v1.6 LED Preview).
            if label == commands::led_preview::LED_CONTROL_POPUP_LABEL {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window.hide();
                    if let Some(state) = window.try_state::<commands::led_preview::LedTwinState>() {
                        state.mark_control_hidden();
                        // The red-X bypasses `hide_led_control_popup`, and this
                        // is the path that would otherwise leave the shell
                        // hidden with no window to bring it back.
                        commands::led_preview::restore_main_after_preview(
                            window.app_handle(),
                            &state,
                        );
                    }
                    commands::led_preview::emit_preview_state_changed(window.app_handle());
                }
                return;
            }
            // A twin destroyed outside `close_led_twin_overlay` (display
            // unplugged) would otherwise pin the 60 Hz enrichment on forever.
            if label.starts_with(commands::led_preview::LED_TWIN_OVERLAY_LABEL_PREFIX) {
                if let tauri::WindowEvent::Destroyed = event {
                    if let Some(state) = window.try_state::<commands::led_preview::LedTwinState>() {
                        state.forget_twin_label(label);
                    }
                    commands::led_preview::emit_preview_state_changed(window.app_handle());
                }
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
            migrate_hue_credentials,
            list_hue_entertainment_areas,
            check_hue_stream_readiness,
            start_hue_stream,
            restart_hue_stream,
            set_hue_solid_color,
            get_hue_stream_status,
            get_hue_area_channels,
            get_runtime_telemetry,
            show_notification,
            request_notification_permission,
            open_log_dir,
            get_screen_capture_permission,
            open_screen_capture_settings,
            list_displays,
            open_display_overlay,
            close_display_overlay,
            update_display_overlay_preview,
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
            get_wled_sink_status,
            start_led_test_pattern,
            stop_led_test_pattern,
            get_led_preview_status,
            open_led_twin_overlay,
            close_led_twin_overlay,
            open_led_control_popup,
            show_led_control_popup,
            hide_led_control_popup,
            check_for_update,
            download_and_install_update,
            get_launch_context,
            get_shell_state,
            patch_shell_state,
            replace_shell_state,
            apply_outputs,
            retune_lighting,
            release_hue_output,
            get_lighting_runtime,
            get_hue_health,
            watch_hue_health,
            retry_hue_health,
            get_main_window_visibility,
        ])
        .build(app_context())
        .expect("error while building tauri application");

    // .run() with a callback is the only place that sees RunEvent::Exit on
    // macOS Cmd+Q (tao 0.35 surfaces applicationWillTerminate as
    // LoopDestroyed → tauri-runtime-wry → RunEvent::Exit). Without this
    // hook, Cmd+Q tears the process down WITHOUT ever running our cleanup,
    // which is what produced the `?E` zombies in earlier sessions.
    //
    // RunEvent::ExitRequested fires on app.exit() / app.request_restart() —
    // the process plugin's relaunch (GlobalErrorBoundary) and the updater's
    // restart after an install.
    app.run(|app_handle, event| match event {
        RunEvent::ExitRequested { code, api, .. } => {
            log::info!("[shutdown] RunEvent::ExitRequested received (code={code:?})");
            let restart = shutdown::is_restart_code(code);
            // Our own cleanup ends the process. Tauri ignores this for a
            // restart, which then reaches RunEvent::Exit below and relaunches
            // from there once the single-instance plugin has let go.
            api.prevent_exit();
            let trigger = if restart {
                shutdown::ShutdownTrigger::RestartRequested
            } else {
                shutdown::ShutdownTrigger::ExitRequested
            };
            shutdown::begin(app_handle, trigger, restart);
        }
        RunEvent::Exit => {
            log::info!("[shutdown] RunEvent::Exit received");
            shutdown::begin(app_handle, shutdown::ShutdownTrigger::AppExit, false);
            // We do NOT return from this callback into Tauri's normal teardown
            // because that path runs in the macOS main thread context post-
            // applicationWillTerminate, where SCStream Drop has been observed
            // to deadlock. Returning also let AppKit exit() the process under
            // the cleanup thread, so this thread waits for it (bounded by the
            // watchdog) and ends the process itself.
            shutdown::hold_main_thread_until_exit(app_handle);
        }
        // Dock icon click with the window hidden to the tray.
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { .. } => show_and_focus_settings(app_handle),
        _ => {}
    });
}
