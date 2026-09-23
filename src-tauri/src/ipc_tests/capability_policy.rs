//! The per-window plugin and core permission policy, resolved from the real
//! capability files the way the running app resolves them.
//!
//! A permission a window needs but no capability grants compiles, builds and
//! passes every other test — it only fails as a rejected invoke in that window.
//! So each "allowed" row below is a call the frontend makes (see the Capabilities
//! entry in docs/architecture/ui-and-shell.md for the call sites), and each
//! "denied" row is a call no window makes — most of them grants that were removed.
//!
//! App commands are not here: without an app ACL manifest Tauri admits every
//! `generate_handler!` command from any local window.

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
const NO_WINDOW: [bool; 4] = [false; 4];

const POLICY: &[(&str, [bool; 4])] = &[
    // Every window with the app bundle loaded
    ("plugin:event|listen", BUNDLE_WINDOWS),
    ("plugin:event|unlisten", BUNDLE_WINDOWS),
    ("plugin:store|load", BUNDLE_WINDOWS),
    ("plugin:store|get", BUNDLE_WINDOWS),
    ("plugin:store|set", BUNDLE_WINDOWS),
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

#[test]
fn each_window_is_granted_exactly_the_plugin_calls_it_makes() {
    let mut context = crate::app_context::<MockRuntime>();
    let authority = context.runtime_authority_mut();

    let mut mismatches = Vec::new();
    for (command, expected) in POLICY {
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
fn no_plugin_call_is_reachable_from_a_remote_origin() {
    let mut context = crate::app_context::<MockRuntime>();
    let authority = context.runtime_authority_mut();
    let remote = Origin::Remote {
        url: "https://example.com".parse().expect("valid URL"),
    };

    for (command, _) in POLICY {
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
