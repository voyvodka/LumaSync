//! A preview scene borrows the lights: Ambilight on the user's settings while
//! it plays, the interrupted mode back after, and a user's own choice ending it
//! for good.

use serde_json::json;
use tauri::async_runtime::block_on;

use super::outputs::{
    apply_outputs_with, refresh_running_with, ApplyOutputsRequest, LightingOrigin,
};
use super::preview_scene::{
    set_scene_brightness, start_scene_lighting, stop_scene_lighting, SceneLighting, SceneRestore,
};
use super::test_support::{Rig, RigSetup};
use super::{LightingModeConfig, LightingModeKind, SolidColorPayload};
use crate::commands::preview::SceneKind;

fn solid(r: u8) -> LightingModeConfig {
    LightingModeConfig {
        kind: LightingModeKind::Solid,
        solid: Some(SolidColorPayload {
            r,
            g: 20,
            b: 30,
            brightness: 1.0,
            kelvin: None,
        }),
        ..LightingModeConfig::default()
    }
}

fn running(rig: &Rig, mode: LightingModeConfig) {
    let started = block_on(apply_outputs_with(
        &rig.handle(),
        ApplyOutputsRequest {
            mode: Some(mode),
            targets: Some(vec!["usb".to_string()]),
            origin: LightingOrigin::User,
        },
    ))
    .expect("apply_outputs resolves");
    assert_eq!(started.status.code, "OUTPUTS_APPLIED", "setup: {started:?}");
    rig.log.clear();
}

fn start(rig: &Rig, kind: SceneKind) -> f32 {
    match start_scene_lighting(&rig.handle(), kind).expect("the start answers") {
        SceneLighting::Running { brightness } => brightness,
        _ => panic!("the scene did not start"),
    }
}

fn scene(rig: &Rig) -> Option<SceneKind> {
    rig.state().runtime.lock().unwrap().preview.scene
}

fn prior_kind(rig: &Rig) -> Option<LightingModeKind> {
    rig.state()
        .runtime
        .lock()
        .unwrap()
        .preview
        .session_prior
        .as_ref()
        .map(|prior| prior.kind)
}

#[test]
fn a_scene_runs_ambilight_and_the_mirror_keeps_the_mode_it_interrupted() {
    let rig = Rig::new(RigSetup::default());
    running(&rig, solid(5));

    start(&rig, SceneKind::Spiral);

    assert_eq!(rig.running().kind, LightingModeKind::Ambilight);
    assert_eq!(rig.running().targets, Some(vec!["usb".to_string()]));
    assert_eq!(scene(&rig), Some(SceneKind::Spiral));
    assert_eq!(prior_kind(&rig), Some(LightingModeKind::Solid));
    assert_eq!(
        rig.state().snapshot.read().mode.kind,
        LightingModeKind::Solid,
        "the scene is not the user's mode"
    );
}

#[test]
fn stopping_the_scene_brings_back_the_mode_it_interrupted() {
    let rig = Rig::new(RigSetup::default());
    running(&rig, solid(5));
    start(&rig, SceneKind::Spiral);

    let restored = stop_scene_lighting(&rig.handle()).unwrap();

    assert!(matches!(restored, SceneRestore::Restored));
    assert_eq!(rig.running().kind, LightingModeKind::Solid);
    assert_eq!(rig.running().solid.map(|s| s.r), Some(5));
    assert_eq!(scene(&rig), None);
    assert_eq!(prior_kind(&rig), None);
}

/// Switching scenes moves the running one in place: the mode to come back to
/// is still the user's, not the first scene's Ambilight.
#[test]
fn a_second_scene_keeps_the_mode_the_first_one_interrupted() {
    let rig = Rig::new(RigSetup::default());
    running(&rig, solid(5));
    start(&rig, SceneKind::Spiral);

    start(&rig, SceneKind::Sunset);

    assert_eq!(scene(&rig), Some(SceneKind::Sunset));
    assert_eq!(prior_kind(&rig), Some(LightingModeKind::Solid));
}

/// A mode chosen anywhere during a scene ends it in the critical section of
/// the change, so the scene's stop cannot put the old mode back over it.
#[test]
fn a_mode_change_ends_the_scene_and_is_not_undone() {
    let rig = Rig::new(RigSetup::default());
    running(&rig, solid(5));
    start(&rig, SceneKind::EdgeTour);

    running(&rig, solid(7));
    assert_eq!(scene(&rig), None);
    assert_eq!(prior_kind(&rig), None);

    let late_stop = stop_scene_lighting(&rig.handle()).unwrap();
    assert!(matches!(late_stop, SceneRestore::NotRunning));
    assert_eq!(rig.running().solid.map(|s| s.r), Some(7));
}

/// A user's Ambilight during a scene is a plain one: its worker is not the
/// scene's, so it keeps its place in the runtime history.
#[test]
fn ambilight_chosen_during_a_scene_starts_a_worker_of_its_own() {
    let rig = Rig::new(RigSetup::default());
    running(&rig, solid(5));
    start(&rig, SceneKind::EdgeTour);
    assert!(rig.state().runtime.lock().unwrap().preview.scene_worker);

    running(
        &rig,
        LightingModeConfig {
            kind: LightingModeKind::Ambilight,
            ..LightingModeConfig::default()
        },
    );

    assert_eq!(rig.running().kind, LightingModeKind::Ambilight);
    assert!(!rig.state().runtime.lock().unwrap().preview.scene_worker);
}

/// The brightness the user gave one scene carries to the next.
#[test]
fn a_second_scene_keeps_the_brightness_the_first_was_given() {
    let rig = Rig::new(RigSetup::default());
    running(&rig, solid(5));
    start(&rig, SceneKind::Spiral);
    assert!(set_scene_brightness(&rig.state(), 0.3));

    assert_eq!(start(&rig, SceneKind::Sunset), 0.3);
    assert_eq!(rig.running().ambilight.map(|a| a.brightness), Some(0.3));
}

#[test]
fn a_scene_that_cannot_capture_gives_the_lights_back() {
    let rig = Rig::new(RigSetup::default());
    running(&rig, solid(5));
    rig.fail_capture(Some("AMBILIGHT_CAPTURE_PERMISSION_DENIED"));

    let outcome = start_scene_lighting(&rig.handle(), SceneKind::Spiral).unwrap();

    let SceneLighting::Failed(status) = outcome else {
        panic!("a failed capture must fail the scene");
    };
    assert_eq!(status.code, "AMBILIGHT_MODE_START_FAILED");
    assert_eq!(rig.running().kind, LightingModeKind::Solid);
    assert_eq!(scene(&rig), None);
}

#[test]
fn with_nothing_to_light_no_scene_starts() {
    let rig = Rig::new(RigSetup {
        serial_connected: false,
        hue_paired: false,
        ..RigSetup::default()
    });

    let outcome = start_scene_lighting(&rig.handle(), SceneKind::Spiral).unwrap();

    assert!(matches!(outcome, SceneLighting::NoOutput));
    assert_eq!(scene(&rig), None);
}

#[test]
fn a_settings_refresh_leaves_a_scene_alone() {
    let rig = Rig::new(RigSetup::default());
    running(&rig, solid(5));
    start(&rig, SceneKind::Spiral);
    rig.seed(json!({ "selectedDisplayId": "DISPLAY2:1920:0" }));
    rig.log.clear();

    block_on(refresh_running_with(&rig.handle())).unwrap();

    assert!(
        !rig.log.events().iter().any(|e| e.starts_with("mode:")),
        "{:?}",
        rig.log.events()
    );
    assert_eq!(scene(&rig), Some(SceneKind::Spiral));
}

/// The scene's brightness is live and never saved: the user's Ambilight
/// brightness is theirs.
#[test]
fn the_scene_brightness_reaches_the_worker_and_is_never_saved() {
    let rig = Rig::new(RigSetup::default());
    running(&rig, solid(5));
    start(&rig, SceneKind::Spiral);
    let writes_before = rig.written_keys().len();

    assert!(set_scene_brightness(&rig.state(), 0.25));
    super::outputs::persist_running_choice(&rig.handle());

    assert_eq!(rig.running().ambilight.map(|a| a.brightness), Some(0.25));
    assert_eq!(
        rig.written_keys().len(),
        writes_before,
        "{:?}",
        rig.written_keys()
    );
}

#[test]
fn without_a_scene_its_brightness_changes_nothing() {
    let rig = Rig::new(RigSetup::default());
    running(&rig, solid(5));

    assert!(!set_scene_brightness(&rig.state(), 0.25));
    assert_eq!(rig.running().kind, LightingModeKind::Solid);
}

/// The latency scene measures on a worker of its own, with nothing between
/// the flip and the output; a switch back hands the worker its settings back.
#[test]
fn the_latency_scene_measures_on_an_unsmoothed_worker_of_its_own() {
    let rig = Rig::new(RigSetup::default());
    // A saved preset wins over an alpha in the worker's live settings.
    rig.seed(json!({
        "lightingMode": {
            "kind": "ambilight",
            "ambilight": { "brightness": 0.8, "lightingSmoothingPreset": "subtle" }
        }
    }));
    running(&rig, solid(5));
    start(&rig, SceneKind::Spiral);

    start(&rig, SceneKind::Latency);
    let state = rig.state();
    {
        let owner = state.runtime.lock().unwrap();
        assert!(owner.preview.latency_sink.is_some());
        assert!(
            owner.preview.latency_worker,
            "the switch rebuilt the worker"
        );
        let live = owner.ambilight_live.as_ref().expect("a running worker");
        assert_eq!(live.read_smoothing_alpha(), 1.0, "what the worker reads");
        assert!(!live.read_black_border_detection());
    }

    start(&rig, SceneKind::Sunset);
    let owner = state.runtime.lock().unwrap();
    assert!(owner.preview.latency_sink.is_none());
    assert!(!owner.preview.latency_worker);
}
