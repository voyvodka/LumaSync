//! What a preview scene does to the lights: Ambilight on the user's own
//! settings while the scene plays, and the mode it interrupted back after.
//! The scene is not the user's mode, so like a test pattern it is never saved
//! and the runtime snapshot keeps showing the mode it interrupted.

use std::sync::Arc;

use log::warn;
use tauri::{AppHandle, Manager, Runtime};

use super::config::{LightingModeConfig, LightingModeKind};
use super::hydrate::hydrate_mode_payload;
use super::latency::{LatencyResult, LatencySink};
use super::led_test_pattern::{
    apply_and_broadcast, is_ambilight_start_ok, restore_mode_after_test,
};
use super::live::retune_ambilight_live;
use super::outputs::{ambilight_payload_for, power_off_left_wled_blocking};
use super::preview::build_twin_sink;
use super::runtime::LightingRuntimeState;
use super::snapshot::{OutputTarget, OutputTargets};
use super::transition::{
    apply_mode_change, blank_usb_after_off, note_applied_mode, run_mode_transition,
};
use crate::commands::hue::state_store::{snapshot_hue_output_context, HueRuntimeStateStore};
use crate::commands::local_outputs::{DrivenLocal, LocalOutputRegistry};
use crate::commands::preview::{PreviewSessionState, SceneKind};
use crate::commands::runtime_telemetry::RuntimeTelemetryState;
use crate::commands::shell_state;
use crate::commands::status::CommandStatus;

pub enum SceneLighting {
    /// Ambilight runs for the scene, at this brightness.
    Running { brightness: f32 },
    /// A test pattern owns the lights.
    TestPatternActive,
    /// Nothing to light: no strip or WLED panel, and no Hue stream up.
    NoOutput,
    /// Ambilight did not start; the interrupted mode is back. The apply's status.
    Failed(CommandStatus),
}

pub enum SceneRestore {
    NotRunning,
    Restored,
    /// The interrupted mode could not come back — its output went away — so the
    /// lights are off. The refused apply's status.
    Off(CommandStatus),
}

/// Each latency sample, to the popup.
fn latency_sink<R: Runtime>(app: &AppHandle<R>) -> LatencySink {
    let app = app.clone();
    Arc::new(move |result: &LatencyResult| {
        crate::commands::preview::scene::send_latency(&app, result);
    })
}

/// The outputs a scene lights: those the user chose that can be driven now, or
/// every one that can when nothing was chosen. Hue only with its stream already
/// up: starting it belongs to the lighting transaction, as for a test pattern.
fn scene_targets(chosen: &OutputTargets, usb: bool, hue: bool) -> Vec<OutputTarget> {
    let wants = |target: OutputTarget| chosen.is_empty() || chosen.contains(&target);
    let mut targets = Vec::new();
    if usb && wants(OutputTarget::Usb) {
        targets.push(OutputTarget::Usb);
    }
    if hue && wants(OutputTarget::Hue) {
        targets.push(OutputTarget::Hue);
    }
    targets
}

/// Starts Ambilight for `kind`, or moves a running scene to it in place.
pub fn start_scene_lighting<R: Runtime>(
    app: &AppHandle<R>,
    kind: SceneKind,
) -> Result<SceneLighting, String> {
    let runtime_state = app.state::<LightingRuntimeState>();
    if runtime_state.test_pattern_active() {
        return Ok(SceneLighting::TestPatternActive);
    }
    let driven = app.state::<LocalOutputRegistry>().driven_checked()?;
    let hue_runtime_state = app.state::<HueRuntimeStateStore>();
    let hue_up = snapshot_hue_output_context(hue_runtime_state.inner())?
        .is_some_and(|context| !context.channels.is_empty());
    let targets = scene_targets(
        &runtime_state.outputs.intent().targets,
        driven.is_some(),
        hue_up,
    );
    if targets.is_empty() {
        return Ok(SceneLighting::NoOutput);
    }

    // The user's Ambilight as a choice of it would run — preset, display and
    // room map included — with the layout and output stamps filled after.
    let mut config = ambilight_payload_for(
        &targets,
        &runtime_state.tuning.stored(),
        shell_state::persisted(app).as_ref(),
    );
    hydrate_mode_payload(&mut config, &|| shell_state::persisted(app));
    let measuring = kind == SceneKind::Latency;
    if measuring {
        // A flip must reach the output as it is: unsmoothed — a saved preset
        // would win over the alpha, so it goes too — and the frame uncropped.
        let ambilight = config.ambilight.get_or_insert_with(Default::default);
        ambilight.smoothing_alpha = Some(1.0);
        ambilight.lighting_smoothing_preset = None;
        ambilight.hue_intensity_preset = None;
        ambilight.black_border_detection = false;
    }
    let telemetry_state = app.state::<RuntimeTelemetryState>();
    let preview_session = app.state::<PreviewSessionState>();
    let (device_connected, connected_port, wled_sink) = DrivenLocal::plan_args(driven.as_ref());

    runtime_state.tuning.close_blocking();
    let (result, failed_prior) = {
        let mut owner = runtime_state.lock_owner()?;
        // A second scene keeps the first one's prior, which is the user's mode,
        // and the brightness the user gave the scene.
        if owner.preview.scene.is_none() {
            owner.preview.session_prior = Some(owner.active_mode.clone());
        } else if let Some(brightness) = owner.active_mode.ambilight.as_ref().map(|a| a.brightness)
        {
            config
                .ambilight
                .get_or_insert_with(Default::default)
                .brightness = brightness;
        }
        owner.preview.scene = Some(kind);
        owner.preview.latency_sink = measuring.then(|| latency_sink(app));
        owner.preview.pending_test_pattern = None;
        owner.preview.preview_gate = Some(preview_session.twin_open());
        let result = apply_mode_change(
            &mut owner,
            config,
            device_connected,
            connected_port,
            wled_sink,
            Some(hue_runtime_state.output_live()),
            Some(telemetry_state.shared_snapshot()),
            Some(build_twin_sink(app)),
            None,
        );
        if is_ambilight_start_ok(&result.status.code) {
            (result, None)
        } else {
            owner.preview.scene = None;
            owner.preview.latency_sink = None;
            let prior = owner.preview.session_prior.take();
            (result, Some(prior))
        }
    };
    note_applied_mode(app, &result.mode);
    match failed_prior {
        None => Ok(SceneLighting::Running {
            brightness: result
                .mode
                .ambilight
                .as_ref()
                .map_or(1.0, |ambilight| ambilight.brightness),
        }),
        Some(prior) => {
            restore_interrupted(app, prior)?;
            Ok(SceneLighting::Failed(result.status))
        }
    }
}

/// `start_scene_lighting` in the mode-change queue.
pub async fn start_scene_queued<R: Runtime>(
    app: AppHandle<R>,
    kind: SceneKind,
) -> Result<SceneLighting, String> {
    run_mode_transition(app, move |app| start_scene_lighting(app, kind)).await
}

/// `stop_scene_lighting` in the mode-change queue.
pub async fn stop_scene_queued<R: Runtime>(app: AppHandle<R>) -> Result<SceneRestore, String> {
    run_mode_transition(app, |app| stop_scene_lighting(app)).await
}

/// Ends the scene's Ambilight and brings back the mode it interrupted.
pub fn stop_scene_lighting<R: Runtime>(app: &AppHandle<R>) -> Result<SceneRestore, String> {
    let runtime_state = app.state::<LightingRuntimeState>();
    let prior = {
        let mut owner = runtime_state.lock_owner()?;
        if owner.preview.scene.take().is_none() {
            return Ok(SceneRestore::NotRunning);
        }
        owner.preview.latency_sink = None;
        owner.preview.session_prior.take()
    };
    restore_interrupted(app, prior)
}

/// The interrupted mode, with the settings as saved now. Back to Off, the strip
/// is painted black and a WLED panel switched off, as a user's Off does: the
/// scene's last frame would otherwise stay on it.
fn restore_interrupted<R: Runtime>(
    app: &AppHandle<R>,
    prior: Option<LightingModeConfig>,
) -> Result<SceneRestore, String> {
    let runtime_state = app.state::<LightingRuntimeState>();
    let hue_runtime_state = app.state::<HueRuntimeStateStore>();
    let telemetry_state = app.state::<RuntimeTelemetryState>();
    let preview_session = app.state::<PreviewSessionState>();
    let apply_with = |mode: LightingModeConfig, driven: Option<&DrivenLocal>| {
        apply_and_broadcast(
            app,
            mode,
            runtime_state.inner(),
            driven,
            hue_runtime_state.inner(),
            telemetry_state.inner(),
            preview_session.inner(),
            None,
        )
    };
    // The scene's marker and prior are already gone: a restore that cannot
    // run must still end the scene's worker, or it lights on with no owner.
    let give_up = |error: String| {
        warn!("[preview-scene] restore failed ({error}) — the lights go off");
        if let Err(off) = apply_with(LightingModeConfig::default(), None) {
            warn!("[preview-scene] the lights could not go off either: {off}");
        }
        error
    };
    let driven = app
        .state::<LocalOutputRegistry>()
        .driven_checked()
        .map_err(give_up)?;
    let scene_mode = runtime_state.lock_owner()?.active_mode.clone();
    let restore = restore_mode_after_test(prior, &|| shell_state::persisted(app));
    let apply = |mode: LightingModeConfig| apply_with(mode, driven.as_ref());
    let restored = apply(restore).map_err(give_up)?;
    // A gated restore (the strip unplugged mid-scene) returns before the
    // scene's worker is torn down, which would leave it running unowned.
    let scene_worker_left = runtime_state.lock_owner()?.preview.scene_worker;
    let outcome = if scene_worker_left {
        warn!(
            "[preview-scene] restore gated ({}) — the lights go off",
            restored.status.code
        );
        apply(LightingModeConfig::default())?;
        SceneRestore::Off(restored.status)
    } else {
        SceneRestore::Restored
    };
    let lights_off = runtime_state
        .runtime
        .lock()
        .is_ok_and(|owner| owner.active_mode.kind == LightingModeKind::Off);
    if lights_off {
        if let Some(off) = blank_usb_after_off(app, &scene_mode) {
            if let Some(wled) = off.wled {
                power_off_left_wled_blocking(app, wled.ip);
            }
        }
    }
    Ok(outcome)
}

/// The scene's brightness, live and never saved. `false` with no scene running.
pub fn set_scene_brightness(state: &LightingRuntimeState, brightness: f32) -> bool {
    let mut owner = state
        .runtime
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if owner.preview.scene.is_none() {
        return false;
    }
    let Some(live) = owner.ambilight_live.clone() else {
        return false;
    };
    let mut ambilight = owner.active_mode.ambilight.clone().unwrap_or_default();
    ambilight.brightness = brightness;
    retune_ambilight_live(&live, &ambilight);
    owner.active_mode.ambilight = Some(ambilight);
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_scene_lights_the_chosen_outputs_it_can_reach() {
        let usb_only: OutputTargets = [OutputTarget::Usb].into_iter().collect();
        assert_eq!(
            scene_targets(&usb_only, true, true),
            vec![OutputTarget::Usb]
        );
        assert!(scene_targets(&usb_only, false, true).is_empty());
        let none = OutputTargets::new();
        assert_eq!(
            scene_targets(&none, true, true),
            vec![OutputTarget::Usb, OutputTarget::Hue]
        );
        assert_eq!(scene_targets(&none, false, true), vec![OutputTarget::Hue]);
        assert!(scene_targets(&none, false, false).is_empty());
    }
}
