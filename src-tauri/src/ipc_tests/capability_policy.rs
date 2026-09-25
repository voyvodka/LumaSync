//! The per-window permission policy — plugin, core and app commands — resolved
//! from the real capability files the way the running app resolves them.
//!
//! A permission a window needs but no capability grants compiles, builds and
//! passes every other test — it only fails as a rejected invoke in that window.
//! So each "allowed" row below is a call the frontend makes (see the Capabilities
//! entry in docs/architecture/ui-and-shell.md for the call sites), and each
//! "denied" row is a call no window makes — most of them grants that were removed.
//!
//! App commands are ACL-checked because `build.rs` declares an app manifest;
//! `APP_POLICY` must name every command in it.

use serde_json::json;
use tauri::ipc::Origin;
use tauri::test::{mock_builder, MockRuntime};
use tauri::{Manager, WebviewWindowBuilder};

use super::invoke;

const MAIN: &str = "main";
const POPUP: &str = "led-control-popup";
const TWIN: &str = "led-twin-overlay-0";
const CALIBRATION: &str = "calibration-overlay-00000000000000ff-0";

/// Columns are `[main, popup, twin, calibration]`.
const BUNDLE_WINDOWS: [bool; 4] = [true, true, true, false];
const MAIN_AND_POPUP: [bool; 4] = [true, true, false, false];
const MAIN_ONLY: [bool; 4] = [true, false, false, false];
const POPUP_ONLY: [bool; 4] = [false, true, false, false];
const NO_WINDOW: [bool; 4] = [false; 4];

const POLICY: &[(&str, [bool; 4])] = &[
    // Every window with the app bundle loaded
    ("plugin:event|listen", BUNDLE_WINDOWS),
    ("plugin:event|unlisten", BUNDLE_WINDOWS),
    ("plugin:log|log", BUNDLE_WINDOWS),
    // Main and the popup: geometry reads, drag regions, debug devtools shortcut
    ("plugin:window|scale_factor", MAIN_AND_POPUP),
    ("plugin:window|inner_size", MAIN_AND_POPUP),
    ("plugin:window|outer_position", MAIN_AND_POPUP),
    ("plugin:window|start_dragging", MAIN_AND_POPUP),
    ("plugin:window|internal_toggle_maximize", MAIN_AND_POPUP),
    ("plugin:webview|internal_toggle_devtools", MAIN_AND_POPUP),
    // Main only
    ("plugin:window|available_monitors", MAIN_ONLY),
    ("plugin:window|outer_size", MAIN_ONLY),
    ("plugin:window|is_maximized", MAIN_ONLY),
    ("plugin:window|center", MAIN_ONLY),
    ("plugin:window|set_position", MAIN_ONLY),
    ("plugin:window|set_size", MAIN_ONLY),
    ("plugin:window|set_min_size", MAIN_ONLY),
    ("plugin:window|show", MAIN_ONLY),
    ("plugin:window|unminimize", MAIN_ONLY),
    ("plugin:window|set_focus", MAIN_ONLY),
    ("plugin:window|minimize", MAIN_ONLY),
    ("plugin:window|toggle_maximize", MAIN_ONLY),
    ("plugin:window|close", MAIN_ONLY),
    ("plugin:autostart|enable", MAIN_ONLY),
    ("plugin:autostart|disable", MAIN_ONLY),
    ("plugin:autostart|is_enabled", MAIN_ONLY),
    ("plugin:dialog|open", MAIN_ONLY),
    ("plugin:fs|read_file", MAIN_ONLY),
    ("plugin:opener|open_url", MAIN_ONLY),
    ("plugin:notification|is_permission_granted", MAIN_ONLY),
    ("plugin:process|restart", MAIN_ONLY),
    // Denied everywhere: no window calls these, and most were granted before
    ("plugin:event|emit", NO_WINDOW),
    ("plugin:event|emit_to", NO_WINDOW),
    ("plugin:window|set_max_size", NO_WINDOW),
    ("plugin:window|set_size_constraints", NO_WINDOW),
    ("plugin:window|set_always_on_top", NO_WINDOW),
    ("plugin:window|set_ignore_cursor_events", NO_WINDOW),
    ("plugin:window|get_all_windows", NO_WINDOW),
    ("plugin:window|create", NO_WINDOW),
    ("plugin:webview|create_webview_window", NO_WINDOW),
    ("plugin:menu|new", NO_WINDOW),
    ("plugin:menu|set_as_app_menu", NO_WINDOW),
    ("plugin:tray|new", NO_WINDOW),
    ("plugin:tray|set_menu", NO_WINDOW),
    ("plugin:image|from_path", NO_WINDOW),
    ("plugin:app|version", NO_WINDOW),
    ("plugin:path|resolve_directory", NO_WINDOW),
    // The store plugin is gone: Rust owns shell-state.json.
    ("plugin:store|load", NO_WINDOW),
    ("plugin:store|get", NO_WINDOW),
    ("plugin:store|set", NO_WINDOW),
    ("plugin:store|clear", NO_WINDOW),
    ("plugin:store|delete", NO_WINDOW),
    ("plugin:store|save", NO_WINDOW),
    ("plugin:store|reset", NO_WINDOW),
    ("plugin:fs|write_file", NO_WINDOW),
    ("plugin:fs|copy_file", NO_WINDOW),
    ("plugin:fs|remove", NO_WINDOW),
    ("plugin:fs|read_dir", NO_WINDOW),
    ("plugin:opener|open_path", NO_WINDOW),
    ("plugin:opener|reveal_item_in_dir", NO_WINDOW),
    ("plugin:updater|check", NO_WINDOW),
    ("plugin:updater|download_and_install", NO_WINDOW),
    ("plugin:window-state|save_window_state", NO_WINDOW),
    ("plugin:window-state|restore_state", NO_WINDOW),
    ("plugin:notification|notify", NO_WINDOW),
    ("plugin:notification|request_permission", NO_WINDOW),
    ("plugin:process|exit", NO_WINDOW),
    ("plugin:dialog|save", NO_WINDOW),
    ("plugin:dialog|message", NO_WINDOW),
];

/// Every app command, with the windows whose frontend invokes it. Derived from
/// the `*Api.ts` bridges each window's entry mounts — the table in
/// docs/architecture/ui-and-shell.md says which caller justifies each row.
const APP_POLICY: &[(&str, [bool; 4])] = &[
    // Shell state: every bundle window reads it; the twin never writes it, and
    // only the main window runs the migration write-back.
    ("get_shell_state", BUNDLE_WINDOWS),
    ("patch_shell_state", MAIN_AND_POPUP),
    ("replace_shell_state", MAIN_ONLY),
    // The popup drives modes and test patterns through the lighting
    // transaction, which also holds the Hue test lease.
    ("apply_outputs", MAIN_AND_POPUP),
    ("retune_lighting", MAIN_AND_POPUP),
    ("get_lighting_runtime", MAIN_AND_POPUP),
    ("start_led_test_pattern", MAIN_AND_POPUP),
    ("stop_led_test_pattern", MAIN_AND_POPUP),
    ("show_notification", MAIN_AND_POPUP),
    // GlobalErrorBoundary's "Show logs", mounted in both.
    ("open_log_dir", MAIN_AND_POPUP),
    // Only the popup's own controls call these.
    ("get_led_preview_status", POPUP_ONLY),
    ("close_led_twin_overlay", POPUP_ONLY),
    ("hide_led_control_popup", POPUP_ONLY),
    // The main window only.
    ("update_tray_labels", MAIN_ONLY),
    ("get_launch_context", MAIN_ONLY),
    ("get_main_window_visibility", MAIN_ONLY),
    ("list_serial_ports", MAIN_ONLY),
    ("connect_serial_port", MAIN_ONLY),
    ("get_serial_connection_status", MAIN_ONLY),
    ("run_serial_health_check", MAIN_ONLY),
    ("discover_hue_bridges", MAIN_ONLY),
    ("verify_hue_bridge_ip", MAIN_ONLY),
    ("pair_hue_bridge", MAIN_ONLY),
    ("validate_hue_credentials", MAIN_ONLY),
    ("migrate_hue_credentials", MAIN_ONLY),
    ("list_hue_entertainment_areas", MAIN_ONLY),
    ("check_hue_stream_readiness", MAIN_ONLY),
    // The Devices card starts and restarts the stream beside a mode; its stop
    // goes through the transaction, which lets a running mode go of Hue first.
    ("start_hue_stream", MAIN_ONLY),
    ("restart_hue_stream", MAIN_ONLY),
    ("release_hue_output", MAIN_ONLY),
    // The one Hue health source; nothing else polls the bridge.
    ("get_hue_health", MAIN_ONLY),
    ("watch_hue_health", MAIN_ONLY),
    ("retry_hue_health", MAIN_ONLY),
    ("get_hue_area_channels", MAIN_ONLY),
    ("get_runtime_telemetry", MAIN_ONLY),
    ("get_screen_capture_permission", MAIN_ONLY),
    ("open_screen_capture_settings", MAIN_ONLY),
    ("list_displays", MAIN_ONLY),
    ("open_display_overlay", MAIN_ONLY),
    ("close_display_overlay", MAIN_ONLY),
    ("update_display_overlay_preview", MAIN_ONLY),
    ("copy_background_image", MAIN_ONLY),
    ("update_hue_channel_positions", MAIN_ONLY),
    ("create_hue_zone", MAIN_ONLY),
    ("update_hue_zone", MAIN_ONLY),
    ("delete_hue_zone", MAIN_ONLY),
    ("assign_channel_to_hue_zone", MAIN_ONLY),
    // The dev mock's panel passes it through to Rust from the main window.
    ("simulate_hue_fault", MAIN_ONLY),
    ("discover_wled_devices", MAIN_ONLY),
    ("connect_wled_sink", MAIN_ONLY),
    ("test_wled_bridge", MAIN_ONLY),
    ("get_wled_sink_status", MAIN_ONLY),
    ("open_led_twin_overlay", MAIN_ONLY),
    ("open_led_control_popup", MAIN_ONLY),
    ("show_led_control_popup", MAIN_ONLY),
    ("check_for_update", MAIN_ONLY),
    ("download_and_install_update", MAIN_ONLY),
    // Registered, but nothing in the frontend calls it.
    ("request_notification_permission", NO_WINDOW),
    // The last bare Hue command the lighting transaction replaced. Still
    // registered, and its tests grant it; a window calling it would skip the
    // transaction's ordering and saving.
    ("set_hue_solid_color", NO_WINDOW),
    // Read by the health monitor in Rust; its test grants it.
    ("get_hue_stream_status", NO_WINDOW),
];

/// The commands a compromised overlay or popup page must never reach, named so
/// the intent survives a table edit that would otherwise pass unnoticed.
const MAIN_WINDOW_PRIVILEGES: &[&str] = &[
    "pair_hue_bridge",
    "migrate_hue_credentials",
    "validate_hue_credentials",
    "download_and_install_update",
    "check_for_update",
    "replace_shell_state",
    "copy_background_image",
];

#[test]
fn each_window_is_granted_exactly_the_plugin_calls_it_makes() {
    assert_policy(POLICY);
}

#[test]
fn each_window_is_granted_exactly_the_app_commands_it_invokes() {
    assert_policy(APP_POLICY);
}

#[test]
fn overlays_and_the_popup_cannot_reach_main_window_privileges() {
    let mut context = crate::app_context::<MockRuntime>();
    let authority = context.runtime_authority_mut();
    for command in MAIN_WINDOW_PRIVILEGES {
        assert!(
            authority
                .resolve_access(command, MAIN, MAIN, &Origin::Local)
                .is_some(),
            "{command} must stay reachable from the main window"
        );
        for window in [POPUP, TWIN, CALIBRATION] {
            assert!(
                authority
                    .resolve_access(command, window, window, &Origin::Local)
                    .is_none(),
                "{command} is reachable from `{window}`"
            );
        }
    }
    // The twin reads settings and nothing else; the calibration overlay has no IPC.
    for window in [TWIN, CALIBRATION] {
        assert!(authority
            .resolve_access("patch_shell_state", window, window, &Origin::Local)
            .is_none());
    }
}

/// `APP_POLICY` must cover exactly the manifest in `build.rs`, which the
/// contracts verifier in turn holds equal to `generate_handler!`.
#[test]
fn the_app_policy_names_every_command_in_the_manifest() {
    let build_rs = include_str!("../../build.rs");
    let start = build_rs
        .find("const APP_COMMANDS")
        .expect("build.rs declares APP_COMMANDS");
    let end = start
        + build_rs[start..]
            .find("];")
            .expect("APP_COMMANDS is closed");
    let mut manifest: Vec<&str> = build_rs[start..end].split('"').skip(1).step_by(2).collect();
    let mut table: Vec<&str> = APP_POLICY.iter().map(|(command, _)| *command).collect();
    manifest.sort_unstable();
    table.sort_unstable();
    assert_eq!(
        table, manifest,
        "APP_POLICY and build.rs APP_COMMANDS differ"
    );
}

fn assert_policy(policy: &[(&str, [bool; 4])]) {
    let mut context = crate::app_context::<MockRuntime>();
    let authority = context.runtime_authority_mut();

    let mut mismatches = Vec::new();
    for (command, expected) in policy {
        for (window, want) in [MAIN, POPUP, TWIN, CALIBRATION].iter().zip(expected) {
            let got = authority
                .resolve_access(command, window, window, &Origin::Local)
                .is_some();
            if got != *want {
                mismatches.push(format!(
                    "{command} on `{window}`: expected {}, resolved {}",
                    verdict(*want),
                    verdict(got)
                ));
            }
        }
    }

    assert!(
        mismatches.is_empty(),
        "capability policy drifted:\n  {}",
        mismatches.join("\n  ")
    );
}

/// Every grant is local-only: a remote page loaded into any window must reach
/// none of them.
#[test]
fn no_call_is_reachable_from_a_remote_origin() {
    let mut context = crate::app_context::<MockRuntime>();
    let authority = context.runtime_authority_mut();
    let remote = Origin::Remote {
        url: "https://example.com".parse().expect("valid URL"),
    };

    for (command, _) in POLICY.iter().chain(APP_POLICY) {
        for window in [MAIN, POPUP, TWIN, CALIBRATION] {
            assert!(
                authority
                    .resolve_access(command, window, window, &remote)
                    .is_none(),
                "{command} resolved for a remote origin on `{window}`"
            );
        }
    }
}

/// `fs:allow-read-file` is scoped to the directory `copy_background_image`
/// writes into, so the room-map canvas can read a background back while the
/// store file beside it — and anything deeper — stays out of reach. Runs the
/// real fs plugin against paths that do not exist, so a scope that wrongly
/// admits one still reads nothing from the developer's machine.
#[test]
fn the_webview_reads_room_map_backgrounds_and_nothing_else_in_app_data() {
    let app = mock_builder()
        .plugin(tauri_plugin_fs::init())
        .build(crate::app_context())
        .expect("mock app should build");
    let main = WebviewWindowBuilder::new(&app, MAIN, Default::default())
        .build()
        .expect("mock webview should build");
    let app_data = app.path().app_data_dir().expect("app data dir resolves");
    let backgrounds = app_data.join("room-map-backgrounds");

    let read = |path: std::path::PathBuf| {
        let error = invoke(&main, "plugin:fs|read_file", json!({ "path": path }))
            .expect_err("no path read here exists, so every read must fail");
        error.to_string()
    };

    let in_scope = read(backgrounds.join("00000000-0000-0000-0000-000000000000.png"));
    assert!(
        !in_scope.contains("forbidden path"),
        "a background image path must pass the scope and fail only on I/O: {in_scope}"
    );

    for outside in [
        app_data.join("absent-shell-state.json"),
        backgrounds.join("nested").join("image.png"),
    ] {
        let error = read(outside.clone());
        assert!(
            error.contains("forbidden path"),
            "{} must be refused by the scope, got: {error}",
            outside.display()
        );
    }
}

fn verdict(allowed: bool) -> &'static str {
    if allowed {
        "allowed"
    } else {
        "denied"
    }
}
