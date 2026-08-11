//! IPC integration tests over Tauri's `MockRuntime`.
//!
//! These drive real `#[tauri::command]` handlers through the real invoke
//! pipeline against a real `AppHandle` and real managed state. That is the gap
//! `pnpm verify:shell-contracts` cannot close: it proves names and shapes agree,
//! not that a given input yields the documented `status.code`.

mod device_commands;
mod hue_commands;
mod lighting_commands;
mod telemetry_commands;

use serde_json::Value;
use tauri::ipc::{CallbackFn, InvokeBody};
use tauri::test::{get_ipc_response, mock_builder, MockRuntime};
use tauri::webview::InvokeRequest;
use tauri::{App, Manager, WebviewWindow, WebviewWindowBuilder};

use crate::commands::device_connection::{ActiveSinkRegistry, SerialConnectionState};
use crate::commands::hue::state_store::HueRuntimeStateStore;
use crate::commands::led_preview::LedTwinState;
use crate::commands::lighting_mode::LightingRuntimeState;
use crate::commands::runtime_telemetry::RuntimeTelemetryState;

/// Builds a mock app carrying the same managed state `lib.rs` registers, with
/// `handler` supplying the command subset under test.
///
/// Callers pass `tauri::generate_handler![..]` rather than the production list:
/// `generate_handler!` is a macro over literal paths, so it cannot be shared,
/// and a narrow list keeps a failure attributable to one command.
pub fn mock_app<F>(handler: F) -> App<MockRuntime>
where
    F: Fn(tauri::ipc::Invoke<MockRuntime>) -> bool + Send + Sync + 'static,
{
    let app = mock_builder()
        .invoke_handler(handler)
        // Not `mock_context`: its ACL authority is empty, so every invoke comes
        // back "not allowed. Plugin not found". This runs the real capabilities.
        .build(crate::app_context())
        .expect("mock app should build");

    app.manage(SerialConnectionState::default());
    app.manage(ActiveSinkRegistry::default());
    app.manage(LightingRuntimeState::default());
    app.manage(LedTwinState::default());
    app.manage(HueRuntimeStateStore::default());
    app.manage(RuntimeTelemetryState::default());
    app
}

/// The webview every invoke is routed through. Labelled `main` to match
/// `MAIN_WINDOW_LABEL`, since commands that call `emit_to` target it by name.
pub fn main_webview(app: &App<MockRuntime>) -> WebviewWindow<MockRuntime> {
    WebviewWindowBuilder::new(app, crate::MAIN_WINDOW_LABEL, Default::default())
        .build()
        .expect("mock webview should build")
}

/// The custom-protocol origin Tauri treats as local. A request from anywhere
/// else is a remote origin and gets ACL-rejected before it reaches the handler.
fn local_origin() -> tauri::Url {
    if cfg!(windows) {
        "http://tauri.localhost"
    } else {
        "tauri://localhost"
    }
    .parse()
    .expect("local origin is a valid URL")
}

/// Invokes `cmd` and returns the resolved payload, or the rejection value.
///
/// The `Err` arm is what the frontend would see as a thrown exception. Several
/// LumaSync contracts (Hue especially) require that arm to stay unreachable.
pub fn invoke(
    webview: &WebviewWindow<MockRuntime>,
    cmd: &str,
    args: Value,
) -> Result<Value, Value> {
    get_ipc_response(
        webview,
        InvokeRequest {
            cmd: cmd.into(),
            callback: CallbackFn(0),
            error: CallbackFn(1),
            url: local_origin(),
            body: InvokeBody::Json(args),
            headers: Default::default(),
            invoke_key: tauri::test::INVOKE_KEY.to_string(),
        },
    )
    .map(|body| body.deserialize::<Value>().expect("response is JSON"))
}

/// Reads `status.code` off a command result, failing loudly on the shapes that
/// would otherwise surface as a confusing `None`.
pub fn status_code(value: &Value) -> &str {
    value
        .get("status")
        .unwrap_or_else(|| panic!("response has no `status` object: {value}"))
        .get("code")
        .and_then(Value::as_str)
        .unwrap_or_else(|| panic!("`status.code` missing or not a string: {value}"))
}

/// Asserts a value is a JSON object whose keys are all camelCase.
///
/// Guards the `#[serde(rename_all = "camelCase")]` attribute on payload structs:
/// dropping it still compiles and still round-trips in Rust, but silently breaks
/// every frontend field read.
pub fn assert_camel_case_keys(value: &Value) {
    let object = value
        .as_object()
        .unwrap_or_else(|| panic!("expected a JSON object, got: {value}"));
    for key in object.keys() {
        assert!(
            !key.contains('_'),
            "key `{key}` is snake_case — the camelCase serde rename is missing"
        );
    }
}
