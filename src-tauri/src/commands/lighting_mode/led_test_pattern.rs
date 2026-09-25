//! The LED test pattern commands: a synthetic source run through the same
//! transition, and the restore of the mode it interrupted.

use std::sync::atomic::Ordering;

use log::warn;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime};

use super::config::{
    AmbilightPayload, LightingModeCommandResult, LightingModeConfig, LightingModeKind,
};
use super::hydrate::{
    hydrate_mode_payload, maybe_hydrate_led_calibration, read_persisted_shell_state,
};
use super::preview::build_edge_emitter;
use super::runtime::LightingRuntimeState;
use super::snapshot;
use super::transition::{
    apply_mode_change, command_status, note_applied_mode, run_mode_transition,
};
use crate::commands::calibration::list_displays;
use crate::commands::device_connection::{ActiveSinkRegistry, SerialConnectionState};
use crate::commands::hue::state_store::{snapshot_hue_output_context, HueRuntimeStateStore};
use crate::commands::led_calibration::LedCalibrationConfig;
use crate::commands::led_output::LedColorOrder;
use crate::commands::led_preview::{emit_preview_state_changed, LedTwinState};
use crate::commands::runtime_telemetry::RuntimeTelemetryState;
use crate::commands::shell_state::{self, PersistedShellState};
use crate::commands::status::CommandStatus;
use crate::commands::test_pattern::{
    TestPatternConfig, TestPatternKind, TestPatternSpeed, DEFAULT_DISPLAY_ASPECT,
};
use crate::commands::wled_sink::WledSinkConfig;

const LED_TEST_PATTERN_STARTED: &str = "LED_TEST_PATTERN_STARTED";
const LED_TEST_PATTERN_PREVIEW_ONLY: &str = "LED_TEST_PATTERN_PREVIEW_ONLY";
const LED_TEST_PATTERN_STOPPED: &str = "LED_TEST_PATTERN_STOPPED";
const LED_TEST_PATTERN_INVALID_PARAMS: &str = "LED_TEST_PATTERN_INVALID_PARAMS";
const LED_TEST_PATTERN_NO_CALIBRATION: &str = "LED_TEST_PATTERN_NO_CALIBRATION";
const LED_TEST_PATTERN_RUNTIME_ERROR: &str = "LED_TEST_PATTERN_RUNTIME_ERROR";

/// Aspect (width / height) of the display the strip surrounds, used to weight
/// the synthetic frame's perimeter. Prefers the user's selected display so it
/// matches the twin overlay, then the primary one; falls back to 16:9.
fn resolve_display_aspect<R: Runtime>(app: &AppHandle<R>) -> f32 {
    let Ok(displays) = list_displays(app.clone()) else {
        return DEFAULT_DISPLAY_ASPECT;
    };
    let selected = shell_state::persisted(app).and_then(|state| state.selected_display_id());

    let target = selected
        .and_then(|id| displays.iter().find(|d| d.id == id))
        .or_else(|| displays.iter().find(|d| d.is_primary))
        .or_else(|| displays.first());

    match target {
        Some(d) if d.height > 0 => d.width as f32 / d.height as f32,
        _ => DEFAULT_DISPLAY_ASPECT,
    }
}

/// Apply a mode transition and publish the runtime snapshot. Shared by the
/// synthetic-test start/stop commands; `apply_config_blocking` inlines the
/// equivalent flow with its own hydration logging.
#[allow(clippy::too_many_arguments)]
pub(super) fn apply_and_broadcast<R: Runtime>(
    app: &AppHandle<R>,
    mut payload: LightingModeConfig,
    runtime_state: &LightingRuntimeState,
    connection_state: &SerialConnectionState,
    hue_runtime_state: &HueRuntimeStateStore,
    telemetry_state: &RuntimeTelemetryState,
    twin_state: &LedTwinState,
    test_pattern: Option<TestPatternConfig>,
    // Without this snapshot the "usb" channel collapses to the serial one, so a
    // WLED-only session runs preview-only and its restore is gated on stop.
    wled_sink: Option<WledSinkConfig>,
) -> Result<LightingModeCommandResult, String> {
    runtime_state.tuning.close_blocking();
    hydrate_mode_payload(&mut payload, &|| read_persisted_shell_state(app));

    let connection_snapshot = connection_state
        .last_status
        .lock()
        .map(|status| status.clone())
        .map_err(|error| format!("LIGHTING_CONNECTION_STATE_LOCK_FAILED: {error}"))?;

    let edge_emitter = Some(build_edge_emitter(app));

    let starts_a_test = test_pattern.is_some();
    let result = {
        let mut owner = runtime_state
            .runtime
            .lock()
            .map_err(|error| format!("LIGHTING_RUNTIME_STATE_LOCK_FAILED: {error}"))?;
        let hue_output = Some(hue_runtime_state.output_live());
        owner.preview.pending_test_pattern = test_pattern;
        owner.preview.preview_gate = Some(twin_state.preview_active());
        apply_mode_change(
            &mut owner,
            payload,
            connection_snapshot.connected,
            connection_snapshot.port_name.as_deref(),
            wled_sink,
            hue_output,
            Some(telemetry_state.shared_snapshot()),
            edge_emitter,
            None,
        )
    };

    note_applied_mode(app, &result.mode);
    // A test pattern is a preview, not the user's mode: every window's mirror
    // keeps showing the mode it interrupted, which the test's stop restores
    // and publishes.
    if !starts_a_test {
        snapshot::publish_running(app, &result.mode);
    }

    Ok(result)
}

/// The ambilight settings a test pattern runs under, whatever the user's are.
pub(super) fn test_pattern_ambilight(brightness: f32) -> AmbilightPayload {
    AmbilightPayload {
        brightness,
        // A pattern is painted on black: the detector reads the unlit part of
        // the frame as bars and crops it, and every LED lands somewhere else.
        black_border_detection: false,
        // Unsmoothed, unsaturated: the default 0.35 EWMA smears the chase
        // band across neighbours, which is the ordering it exists to prove.
        smoothing_alpha: Some(1.0),
        saturation: Some(1.0),
        ..AmbilightPayload::default()
    }
}

/// Request payload for `start_led_test_pattern` — which synthetic pattern to
/// run, at what speed/brightness, and which output channels to drive.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartLedTestPatternPayload {
    pub pattern: TestPatternKind,
    pub brightness: f32,
    #[serde(default)]
    pub speed: Option<TestPatternSpeed>,
    #[serde(default)]
    pub targets: Option<Vec<String>>,
    /// Layout to size the frame with. LED Setup sends its unsaved editor
    /// state here; absent falls through to `maybe_hydrate_led_calibration`.
    #[serde(default)]
    pub led_calibration: Option<LedCalibrationConfig>,
}

/// Result of `start_led_test_pattern` / `stop_led_test_pattern` — whether the
/// pattern is running and whether it fell back to preview-only (no connected
/// output sink).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LedTestPatternResult {
    pub active: bool,
    pub preview_only: bool,
    pub status: CommandStatus,
}

/// Start a synthetic LED test pattern (spiral, chase, etc.) for the LED
/// Preview feature — resolves available output targets, requires a real
/// strip calibration to size the pattern, and captures the prior live mode
/// so `stop_led_test_pattern` can restore it.
#[tauri::command]
pub async fn start_led_test_pattern<R: Runtime>(
    app: AppHandle<R>,
    payload: StartLedTestPatternPayload,
) -> Result<LedTestPatternResult, String> {
    run_mode_transition(app, move |app| {
        start_led_test_pattern_blocking(app, payload)
    })
    .await
}

fn start_led_test_pattern_blocking<R: Runtime>(
    app: &AppHandle<R>,
    payload: StartLedTestPatternPayload,
) -> Result<LedTestPatternResult, String> {
    let runtime_state = app.state::<LightingRuntimeState>();
    let connection_state = app.state::<SerialConnectionState>();
    let hue_runtime_state = app.state::<HueRuntimeStateStore>();
    let telemetry_state = app.state::<RuntimeTelemetryState>();
    let led_twin_state = app.state::<LedTwinState>();
    let sink_registry = app.state::<ActiveSinkRegistry>();
    if !payload.brightness.is_finite() || !(0.0..=1.0).contains(&payload.brightness) {
        return Ok(LedTestPatternResult {
            active: false,
            preview_only: false,
            status: command_status(
                LED_TEST_PATTERN_INVALID_PARAMS,
                "Test pattern brightness must be within 0..1.",
                None,
            ),
        });
    }
    if let Some(Err(reason)) = payload.led_calibration.as_ref().map(|c| c.validate()) {
        return Ok(LedTestPatternResult {
            active: false,
            preview_only: false,
            status: command_status(
                LED_TEST_PATTERN_INVALID_PARAMS,
                "The LED layout for the test is not valid.",
                Some(reason),
            ),
        });
    }
    if matches!(payload.pattern, TestPatternKind::ChannelProbe { slot } if slot > 2) {
        return Ok(LedTestPatternResult {
            active: false,
            preview_only: false,
            status: command_status(
                LED_TEST_PATTERN_INVALID_PARAMS,
                "Channel probe slot must be 0, 1 or 2.",
                None,
            ),
        });
    }

    let test_config = TestPatternConfig {
        kind: payload.pattern.clone(),
        brightness: payload.brightness,
        speed: payload.speed.unwrap_or_default(),
        display_aspect: resolve_display_aspect(app),
    };

    // Resolve sink availability up front to choose targets + report
    // preview-only without re-deriving it from apply_mode_change.
    let device_connected = connection_state
        .last_status
        .lock()
        .map(|status| status.output_port().is_some())
        .map_err(|error| format!("LIGHTING_CONNECTION_STATE_LOCK_FAILED: {error}"))?;
    let wled_sink = sink_registry.active_wled_config();
    let hue_available = snapshot_hue_output_context(hue_runtime_state.inner())?
        .map(|ctx| !ctx.channels.is_empty())
        .unwrap_or(false);

    let requested = payload.targets.clone().unwrap_or_default();
    let want_usb = requested.is_empty() || requested.iter().any(|t| t == "usb");
    let want_hue = requested.iter().any(|t| t == "hue");
    // A registered WLED sink IS the "usb" channel — see `UsbOutputPlan`.
    let use_usb = (device_connected || wled_sink.is_some()) && want_usb;
    let use_hue = hue_available && want_hue;
    let preview_only = !use_usb && !use_hue;

    let mut targets: Vec<String> = Vec::new();
    if use_usb {
        targets.push("usb".to_string());
    }
    if use_hue {
        targets.push("hue".to_string());
    }

    let mut config = LightingModeConfig {
        kind: LightingModeKind::Ambilight,
        solid: None,
        ambilight: Some(test_pattern_ambilight(payload.brightness)),
        targets: Some(targets),
        display_id: None,
        led_calibration: payload.led_calibration.clone(),
        color_correction: None,
        firmware_profile: None,
        chip_type: None,
        color_order: test_pattern_color_order(&payload.pattern),
        room_geometry: None,
    };

    // A synthetic test needs a real strip layout to size its frame. Resolve
    // the effective calibration up front: with no usable calibration the
    // worker would silently degrade to a single-LED twin (one dot) while the
    // chase band is sized for FALLBACK_TOTAL_LEDS — a misleading single-dot
    // preview. Route the user to the calibration flow with a coded status
    // instead. (Never throws — coded status on the Ok result.)
    maybe_hydrate_led_calibration(&mut config, &|| read_persisted_shell_state(app));
    let effective_total_leds = config
        .led_calibration
        .as_ref()
        .map(|cal| cal.total_leds)
        .unwrap_or(0);
    if effective_total_leds <= 1 {
        return Ok(LedTestPatternResult {
            active: false,
            preview_only: false,
            status: command_status(
                LED_TEST_PATTERN_NO_CALIBRATION,
                "No LED calibration is available to size the test pattern.",
                None,
            ),
        });
    }

    // Capture the live mode to restore on stop — but never overwrite a real
    // prior mode with a test mode if we are already previewing.
    {
        let prior = {
            let owner = runtime_state
                .runtime
                .lock()
                .map_err(|error| format!("LIGHTING_RUNTIME_STATE_LOCK_FAILED: {error}"))?;
            if owner.preview.active_test_pattern.is_some() {
                None
            } else {
                // Fresh run — rewind the animation. A tweak to an already
                // running pattern keeps its phase instead.
                owner
                    .preview
                    .pattern_phase
                    .store(0f32.to_bits(), Ordering::Relaxed);
                Some(owner.active_mode.clone())
            }
        };
        if let Some(prior_mode) = prior {
            led_twin_state.set_prior_mode(prior_mode);
        }
    }

    let result = apply_and_broadcast(
        app,
        config,
        runtime_state.inner(),
        connection_state.inner(),
        hue_runtime_state.inner(),
        telemetry_state.inner(),
        led_twin_state.inner(),
        Some(test_config),
        wled_sink,
    )?;

    emit_preview_state_changed(app);

    let outcome = if is_ambilight_start_ok(&result.status.code) {
        let code = if preview_only {
            LED_TEST_PATTERN_PREVIEW_ONLY
        } else {
            LED_TEST_PATTERN_STARTED
        };
        LedTestPatternResult {
            active: true,
            preview_only,
            status: command_status(code, "LED test pattern started.", None),
        }
    } else {
        LedTestPatternResult {
            active: false,
            preview_only,
            status: command_status(
                LED_TEST_PATTERN_RUNTIME_ERROR,
                "LED test pattern could not start.",
                Some(format!("{}: {}", result.status.code, result.status.message)),
            ),
        }
    };
    Ok(outcome)
}

/// The colour order a test pattern pins, overriding the saved one (caller-wins
/// hydration keeps it). A channel probe lights one wire slot so the user can
/// say which colour appears, which only means something when nothing reorders
/// the slots. Every other pattern keeps the saved order, like any output.
pub(super) fn test_pattern_color_order(kind: &TestPatternKind) -> Option<LedColorOrder> {
    match kind {
        TestPatternKind::ChannelProbe { .. } => Some(LedColorOrder::Rgb),
        _ => None,
    }
}

/// A test pattern reaches the lights through either arm of `apply_mode_change`:
/// a fresh worker, or the in-place retune a running test takes. Accepting only
/// the former reported every change after the first as a failed start.
pub(super) fn is_ambilight_start_ok(code: &str) -> bool {
    code == "AMBILIGHT_MODE_STARTED" || code == "AMBILIGHT_MODE_UPDATED"
}

/// The pre-test mode with its output stamps and calibration re-read from disk.
/// The snapshot dates from test start and hydration is caller-wins, so stale
/// values would revert a chip / profile / correction change made mid-test and
/// the calibration editor's save-then-stop. The snapshot's layout survives only
/// when disk has none, instead of dropping to the legacy 1-LED frame.
pub(super) fn restore_mode_after_test(
    prior: Option<LightingModeConfig>,
    load: &dyn Fn() -> Option<PersistedShellState>,
) -> LightingModeConfig {
    let mut restore = prior.unwrap_or_default();
    restore.chip_type = None;
    restore.firmware_profile = None;
    restore.color_correction = None;
    restore.color_order = None;
    if let Some(snapshot_calibration) = restore.led_calibration.take() {
        maybe_hydrate_led_calibration(&mut restore, load);
        if restore.led_calibration.is_none() {
            restore.led_calibration = Some(snapshot_calibration);
        }
    }
    restore
}

/// Stop the running LED test pattern and restore the mode that was active
/// before it started (or force `Off` if that restore itself gets gated by a
/// disconnected sink, so the synthetic worker never gets stranded running).
#[tauri::command]
pub async fn stop_led_test_pattern<R: Runtime>(
    app: AppHandle<R>,
) -> Result<LedTestPatternResult, String> {
    run_mode_transition(app, |app| stop_led_test_pattern_blocking(app)).await
}

fn stop_led_test_pattern_blocking<R: Runtime>(
    app: &AppHandle<R>,
) -> Result<LedTestPatternResult, String> {
    let runtime_state = app.state::<LightingRuntimeState>();
    let connection_state = app.state::<SerialConnectionState>();
    let hue_runtime_state = app.state::<HueRuntimeStateStore>();
    let telemetry_state = app.state::<RuntimeTelemetryState>();
    let led_twin_state = app.state::<LedTwinState>();
    let sink_registry = app.state::<ActiveSinkRegistry>();
    let wled_sink = sink_registry.active_wled_config();
    let restore = restore_mode_after_test(led_twin_state.take_prior_mode(), &|| {
        read_persisted_shell_state(app)
    });
    let mut result = apply_and_broadcast(
        app,
        restore,
        runtime_state.inner(),
        connection_state.inner(),
        hue_runtime_state.inner(),
        telemetry_state.inner(),
        led_twin_state.inner(),
        None,
        wled_sink,
    )?;

    // A gated restore (DEVICE_NOT_CONNECTED / HUE_NOT_READY) returns before
    // `apply_mode_change` tears the previous worker down, so the synthetic
    // pattern would keep running with no way to stop it. Fall back to Off.
    if runtime_state.preview_snapshot().test_active {
        warn!(
            "[stop_led_test_pattern] restore gated ({}) — forcing Off so the synthetic worker stops",
            result.status.code
        );
        result = apply_and_broadcast(
            app,
            LightingModeConfig::default(),
            runtime_state.inner(),
            connection_state.inner(),
            hue_runtime_state.inner(),
            telemetry_state.inner(),
            led_twin_state.inner(),
            None,
            wled_sink,
        )?;
    }

    led_twin_state.recompute();
    emit_preview_state_changed(app);
    Ok(LedTestPatternResult {
        active: result.active,
        preview_only: false,
        status: command_status(LED_TEST_PATTERN_STOPPED, "LED test pattern stopped.", None),
    })
}
