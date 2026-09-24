//! What the callers moved onto the transaction rely on: the LED control popup,
//! the tray, the settings refresh that replaced the per-panel re-dispatches,
//! and the coded refusals for a request or a config nothing should run.

use std::time::{Duration, Instant};

use serde_json::json;
use tauri::async_runtime::block_on;

use super::outputs::{
    apply_outputs_with, note_settings_saved, refresh_running_with, tray_request,
    ApplyOutputsRequest, ApplyOutputsResult, LightingOrigin, TrayLighting,
    SETTINGS_REFRESH_DEBOUNCE,
};
use super::snapshot::OutputTarget::{self, Hue, Usb};
use super::test_support::{Rig, RigSetup};
use super::{AmbilightPayload, LightingModeConfig, LightingModeKind, SolidColorPayload};
use crate::commands::device_connection::SerialConnectionState;
use crate::commands::hue::state_store::HueRuntimeStateStore;
use crate::commands::led_preview::LedTwinState;
use crate::commands::runtime_telemetry::RuntimeTelemetryState;
use crate::commands::test_pattern::{TestPatternConfig, TestPatternKind, TestPatternSpeed};
use tauri::Manager;

fn kind_only(kind: LightingModeKind) -> LightingModeConfig {
    LightingModeConfig {
        kind,
        ..LightingModeConfig::default()
    }
}

fn request(
    origin: LightingOrigin,
    mode: Option<LightingModeConfig>,
    targets: Option<&[&str]>,
) -> ApplyOutputsRequest {
    ApplyOutputsRequest {
        mode,
        targets: targets.map(|names| names.iter().map(|n| n.to_string()).collect()),
        origin,
    }
}

fn apply(rig: &Rig, request: ApplyOutputsRequest) -> ApplyOutputsResult {
    block_on(apply_outputs_with(&rig.handle(), request)).expect("apply_outputs resolves")
}

fn running(rig: &Rig, mode: LightingModeConfig, targets: &[&str]) {
    let started = apply(
        rig,
        request(LightingOrigin::User, Some(mode), Some(targets)),
    );
    assert_eq!(started.status.code, "OUTPUTS_APPLIED", "setup: {started:?}");
    rig.log.clear();
}

fn solid(r: u8) -> LightingModeConfig {
    LightingModeConfig {
        kind: LightingModeKind::Solid,
        solid: Some(SolidColorPayload {
            r,
            g: 20,
            b: 30,
            brightness: 1.0,
        }),
        ..LightingModeConfig::default()
    }
}

fn ambilight() -> LightingModeConfig {
    LightingModeConfig {
        kind: LightingModeKind::Ambilight,
        ambilight: Some(AmbilightPayload {
            brightness: 1.0,
            ..AmbilightPayload::default()
        }),
        ..LightingModeConfig::default()
    }
}

fn has(rig: &Rig, event: &str) -> bool {
    rig.log.events().iter().any(|e| e == event)
}

fn mode_applies(rig: &Rig) -> usize {
    rig.log
        .events()
        .iter()
        .filter(|e| e.starts_with("mode:"))
        .count()
}

fn wait_until(what: &str, done: impl Fn() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while !done() {
        assert!(Instant::now() < deadline, "timed out: {what}");
        std::thread::sleep(Duration::from_millis(5));
    }
}

// ---------------------------------------------------------------------------
// The LED control popup — each of these was a bug while it called the mode
// commands directly
// ---------------------------------------------------------------------------

#[test]
fn popup_off_stops_the_hue_stream_as_well_as_the_strip() {
    let rig = Rig::new(RigSetup::default());
    running(&rig, solid(1), &["usb", "hue"]);

    let result = apply(
        &rig,
        request(
            LightingOrigin::Popup,
            Some(kind_only(LightingModeKind::Off)),
            None,
        ),
    );

    assert_eq!(result.status.code, "OUTPUTS_APPLIED");
    assert!(has(&rig, "hue:stop:mode_control"), "{:?}", rig.log.events());
    assert!(!rig.hue.streaming());
    assert!(result.snapshot.active_targets.is_empty());
}

#[test]
fn popup_solid_and_ambilight_bring_hue_up_from_the_saved_targets() {
    for kind in [LightingModeKind::Solid, LightingModeKind::Ambilight] {
        let rig = Rig::new(RigSetup {
            state: json!({ "lastOutputTargets": ["usb", "hue"] }),
            ..RigSetup::default()
        });

        let result = apply(
            &rig,
            request(LightingOrigin::Popup, Some(kind_only(kind)), None),
        );

        assert_eq!(
            result.status.code, "OUTPUTS_APPLIED",
            "{kind:?}: {result:?}"
        );
        assert_eq!(result.snapshot.active_targets, vec![Usb, Hue], "{kind:?}");
        let events = rig.log.events();
        let started = events.iter().position(|e| e == "hue:start");
        let applied = events.iter().position(|e| e.starts_with("mode:"));
        assert!(
            matches!((started, applied), (Some(s), Some(a)) if s < a),
            "{kind:?}: Hue must be up before the worker starts: {events:?}"
        );
    }
}

#[test]
fn a_popup_choice_is_saved_for_the_next_launch() {
    let rig = Rig::new(RigSetup::default());

    apply(&rig, request(LightingOrigin::Popup, Some(solid(42)), None));

    let saved = rig
        .saved("lightingMode")
        .expect("the popup's choice is saved");
    assert_eq!(saved["kind"], json!("solid"));
    assert_eq!(saved["solid"]["r"], json!(42));
}

#[test]
fn a_popup_choice_on_an_uncalibrated_strip_is_refused_before_anything_moves() {
    let rig = Rig::new(RigSetup {
        calibrated: false,
        ..RigSetup::default()
    });

    let result = apply(
        &rig,
        request(
            LightingOrigin::Popup,
            Some(kind_only(LightingModeKind::Ambilight)),
            None,
        ),
    );

    assert_eq!(result.status.code, "OUTPUTS_CALIBRATION_REQUIRED");
    assert!(rig.log.events().is_empty(), "{:?}", rig.log.events());
    assert_eq!(result.snapshot.mode.kind, LightingModeKind::Off);
}

#[test]
fn a_kind_only_choice_keeps_the_last_colour() {
    let rig = Rig::new(RigSetup::default());
    running(&rig, solid(99), &["usb"]);
    apply(
        &rig,
        request(
            LightingOrigin::User,
            Some(kind_only(LightingModeKind::Off)),
            None,
        ),
    );

    let result = apply(
        &rig,
        request(
            LightingOrigin::Popup,
            Some(kind_only(LightingModeKind::Solid)),
            None,
        ),
    );

    assert_eq!(result.snapshot.mode.solid.map(|s| s.r), Some(99));
}

// ---------------------------------------------------------------------------
// The tray
// ---------------------------------------------------------------------------

#[test]
fn the_tray_resumes_the_last_mode_that_ran() {
    let rig = Rig::new(RigSetup::default());
    assert!(
        tray_request(&rig.handle(), TrayLighting::ResumeLastMode).is_none(),
        "nothing has run and nothing non-Off is saved"
    );
    running(&rig, ambilight(), &["usb"]);
    apply(
        &rig,
        request(
            LightingOrigin::Tray,
            Some(kind_only(LightingModeKind::Off)),
            None,
        ),
    );

    let resume = tray_request(&rig.handle(), TrayLighting::ResumeLastMode).unwrap();
    assert_eq!(resume.origin, LightingOrigin::Tray);
    assert_eq!(
        resume.mode.as_ref().map(|m| m.kind),
        Some(LightingModeKind::Ambilight)
    );
    let result = apply(&rig, resume);
    assert_eq!(result.status.code, "OUTPUTS_APPLIED");
    assert_eq!(result.snapshot.mode.kind, LightingModeKind::Ambilight);
}

#[test]
fn the_tray_resumes_a_saved_mode_after_a_launch_that_did_not_run_it() {
    let rig = Rig::new(RigSetup {
        state: json!({ "lightingMode": { "kind": "solid" } }),
        ..RigSetup::default()
    });
    let resume = tray_request(&rig.handle(), TrayLighting::ResumeLastMode).unwrap();
    assert_eq!(resume.mode.map(|m| m.kind), Some(LightingModeKind::Solid));
}

#[test]
fn the_tray_off_and_solid_items_are_choices_without_a_payload() {
    let rig = Rig::new(RigSetup::default());
    for (item, kind) in [
        (TrayLighting::Off, LightingModeKind::Off),
        (TrayLighting::SolidColor, LightingModeKind::Solid),
    ] {
        let request = tray_request(&rig.handle(), item).unwrap();
        let mode = request.mode.unwrap();
        assert_eq!(mode.kind, kind);
        assert!(mode.solid.is_none() && mode.ambilight.is_none());
        assert!(request.targets.is_none());
    }
}

// ---------------------------------------------------------------------------
// The settings refresh
// ---------------------------------------------------------------------------

#[test]
fn a_saved_display_change_re_applies_the_running_mode_once_and_saves_nothing() {
    let rig = Rig::new(RigSetup::default());
    running(&rig, ambilight(), &["usb"]);
    let written_before = rig.written_keys().len();
    rig.seed(json!({ "selectedDisplayId": "DISPLAY2:1920:0" }));

    let result = block_on(refresh_running_with(&rig.handle()))
        .unwrap()
        .expect("a mode is running");

    assert_eq!(result.status.code, "OUTPUTS_APPLIED");
    assert_eq!(mode_applies(&rig), 1, "{:?}", rig.log.events());
    assert_eq!(rig.running().display_id.as_deref(), Some("DISPLAY2:1920:0"));
    assert_eq!(rig.written_keys().len(), written_before);
}

#[test]
fn a_refresh_with_nothing_running_does_nothing() {
    let rig = Rig::new(RigSetup::default());
    assert!(block_on(refresh_running_with(&rig.handle()))
        .unwrap()
        .is_none());
    assert!(rig.log.events().is_empty());
}

#[test]
fn a_burst_of_setting_saves_becomes_one_re_apply() {
    let rig = Rig::new(RigSetup::default());
    running(&rig, ambilight(), &["usb"]);

    for _ in 0..20 {
        note_settings_saved(&rig.handle(), ["roomMap"]);
    }
    note_settings_saved(&rig.handle(), ["ledPreviewPopupCenterX"]);

    wait_until("the refresh never ran", || mode_applies(&rig) >= 1);
    std::thread::sleep(SETTINGS_REFRESH_DEBOUNCE * 2);
    assert_eq!(mode_applies(&rig), 1, "{:?}", rig.log.events());
}

#[test]
fn a_save_the_mode_does_not_read_refreshes_nothing() {
    let rig = Rig::new(RigSetup::default());
    running(&rig, ambilight(), &["usb"]);

    note_settings_saved(&rig.handle(), ["lastSection", "ledPreviewPopupCenterX"]);

    std::thread::sleep(SETTINGS_REFRESH_DEBOUNCE * 2);
    assert_eq!(mode_applies(&rig), 0, "{:?}", rig.log.events());
}

/// Starts a gamut test the way `start_led_test_pattern` does, minus the display
/// lookup a mock runtime cannot answer.
fn start_test(rig: &Rig) {
    let handle = rig.handle();
    let mut mode = ambilight();
    mode.targets = Some(vec!["usb".to_string()]);
    let result = super::apply_and_broadcast(
        &handle,
        mode,
        rig.state().inner(),
        rig.app.state::<SerialConnectionState>().inner(),
        rig.app.state::<HueRuntimeStateStore>().inner(),
        rig.app.state::<RuntimeTelemetryState>().inner(),
        rig.app.state::<LedTwinState>().inner(),
        Some(TestPatternConfig {
            kind: TestPatternKind::Gamut,
            brightness: 0.5,
            speed: TestPatternSpeed::default(),
            display_aspect: 16.0 / 9.0,
        }),
        None,
    )
    .unwrap();
    assert_eq!(
        result.mode.kind,
        LightingModeKind::Ambilight,
        "{:?}",
        result.status.code
    );
}

#[test]
fn a_test_pattern_is_left_alone_by_a_refresh_and_never_shown_as_the_mode() {
    let rig = Rig::new(RigSetup::default());
    running(&rig, solid(5), &["usb"]);

    start_test(&rig);
    assert_eq!(
        rig.state().snapshot.read().mode.kind,
        LightingModeKind::Solid,
        "the mirror keeps the mode the test interrupted"
    );
    rig.log.clear();

    block_on(refresh_running_with(&rig.handle())).unwrap();
    assert_eq!(mode_applies(&rig), 0, "{:?}", rig.log.events());
    assert!(rig.worker_running(), "the refresh stopped the test");
}

// ---------------------------------------------------------------------------
// Coded refusals
// ---------------------------------------------------------------------------

#[test]
fn an_unknown_target_is_a_coded_refusal_and_nothing_is_recorded() {
    let rig = Rig::new(RigSetup::default());
    running(&rig, solid(1), &["usb"]);
    let written_before = rig.written_keys().len();

    let result = apply(
        &rig,
        request(
            LightingOrigin::User,
            Some(kind_only(LightingModeKind::Ambilight)),
            Some(&["usb", "hdmi"]),
        ),
    );

    assert_eq!(result.status.code, "OUTPUTS_INVALID_REQUEST");
    assert!(
        result
            .status
            .details
            .as_deref()
            .unwrap_or_default()
            .contains("hdmi"),
        "{:?}",
        result.status
    );
    assert!(rig.log.events().is_empty(), "{:?}", rig.log.events());
    assert_eq!(rig.written_keys().len(), written_before);
    assert_eq!(rig.running().kind, LightingModeKind::Solid);
    // The intent was not touched either: the next plain choice still runs on USB.
    let next = apply(
        &rig,
        request(
            LightingOrigin::User,
            Some(kind_only(LightingModeKind::Ambilight)),
            None,
        ),
    );
    assert_eq!(next.snapshot.active_targets, vec![OutputTarget::Usb]);
}

#[test]
fn a_saved_calibration_that_does_not_add_up_refuses_the_start_and_keeps_what_runs() {
    let rig = Rig::new(RigSetup::default());
    running(&rig, solid(1), &["usb"]);
    let mut broken = super::calibration_for_tests();
    broken["totalLeds"] = json!(60);
    rig.seed(json!({ "ledCalibration": broken }));

    let result = apply(
        &rig,
        request(
            LightingOrigin::User,
            Some(kind_only(LightingModeKind::Ambilight)),
            None,
        ),
    );

    assert_eq!(result.status.code, "OUTPUTS_REFUSED");
    assert_eq!(
        result
            .outcome
            .apply_status
            .as_ref()
            .map(|s| s.code.as_str()),
        Some("LIGHTING_MODE_INVALID_CONFIG")
    );
    assert_eq!(rig.running().kind, LightingModeKind::Solid);
    assert!(!rig.worker_running());
}
