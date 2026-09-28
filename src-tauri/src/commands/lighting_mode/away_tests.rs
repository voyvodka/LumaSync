//! Lights off while the user is away, and back when they return: the away Off
//! turns the lights off as the user's Off does, but saves nothing and answers
//! nobody, and the return puts back only the mode that was put out.

use serde_json::json;
use tauri::async_runtime::block_on;

use super::outputs::{
    apply_outputs_with, away_with, prepare_away, ApplyOutputsRequest, ApplyOutputsResult, AwayEdge,
    LightingOrigin,
};
use super::snapshot::OutputTarget;
use super::test_support::{Rig, RigSetup};
use super::{AmbilightPayload, LightingModeConfig, LightingModeKind, SolidColorPayload};
use crate::commands::hue::light_restore::HueLightsAfterStop;

use OutputTarget::{Hue, Usb};

fn ambilight() -> LightingModeConfig {
    LightingModeConfig {
        kind: LightingModeKind::Ambilight,
        ambilight: Some(AmbilightPayload::default()),
        ..LightingModeConfig::default()
    }
}

fn solid() -> LightingModeConfig {
    LightingModeConfig {
        kind: LightingModeKind::Solid,
        solid: Some(SolidColorPayload {
            r: 10,
            g: 20,
            b: 30,
            brightness: 1.0,
        }),
        ..LightingModeConfig::default()
    }
}

fn choose(
    rig: &Rig,
    mode: LightingModeConfig,
    targets: Option<&[OutputTarget]>,
) -> ApplyOutputsResult {
    let request = ApplyOutputsRequest {
        mode: Some(mode),
        targets: targets.map(|targets| targets.iter().map(|t| t.as_str().to_string()).collect()),
        origin: LightingOrigin::User,
    };
    let result = block_on(apply_outputs_with(&rig.handle(), request)).expect("apply resolves");
    assert_eq!(result.status.code, "OUTPUTS_APPLIED", "{result:?}");
    result
}

fn away(rig: &Rig, edge: AwayEdge) -> Option<ApplyOutputsResult> {
    block_on(away_with(&rig.handle(), edge)).expect("away resolves")
}

fn last_outcome(rig: &Rig) -> serde_json::Value {
    rig.published()
        .last()
        .map(|snapshot| snapshot["lastOutcome"].clone())
        .expect("something was published")
}

#[test]
fn going_away_turns_the_lights_off_as_off_does() {
    let rig = Rig::new(RigSetup::default());
    choose(&rig, ambilight(), Some(&[Usb, Hue]));
    rig.log.clear();

    assert!(away(&rig, AwayEdge::Leave).is_some());

    assert_eq!(rig.running().kind, LightingModeKind::Off);
    assert!(!rig.worker_running());
    // The strip holds its last frame unless it is sent black, and the Hue
    // lights follow the user's Off choice rather than going back as they were.
    assert!(
        rig.log.seq_of("mode:off:").is_some(),
        "{:?}",
        rig.log.events()
    );
    assert!(!rig.log.packets().is_empty(), "the strip was not blanked");
    assert_eq!(rig.hue.stop_lights(), vec![HueLightsAfterStop::TurnOff]);
}

/// A crash while away must resume the last real choice at launch, so the away
/// Off writes nothing; and nobody pressed anything, so nothing is answered.
#[test]
fn going_away_saves_nothing_and_raises_no_outcome() {
    let rig = Rig::new(RigSetup::default());
    choose(&rig, ambilight(), Some(&[Usb]));
    let written = rig.written_keys().len();
    let outcome = last_outcome(&rig);

    away(&rig, AwayEdge::Leave);

    assert_eq!(
        rig.saved("lightingMode").unwrap()["kind"],
        json!("ambilight")
    );
    assert_eq!(
        rig.written_keys().len(),
        written,
        "{:?}",
        rig.written_keys()
    );
    assert_eq!(last_outcome(&rig), outcome);
}

#[test]
fn coming_back_puts_back_what_ran() {
    let rig = Rig::new(RigSetup::default());
    choose(&rig, solid(), Some(&[Usb]));
    away(&rig, AwayEdge::Leave);
    let written = rig.written_keys().len();

    assert!(away(&rig, AwayEdge::Return).is_some());

    let running = rig.running();
    assert_eq!(running.kind, LightingModeKind::Solid);
    assert_eq!(
        running.solid.map(|solid| (solid.r, solid.g, solid.b)),
        Some((10, 20, 30))
    );
    assert_eq!(rig.written_keys().len(), written);
}

/// Whatever the user chose while away is what runs; coming back does not
/// overturn it with what ran before.
#[test]
fn a_choice_made_while_away_is_not_overturned_on_return() {
    let rig = Rig::new(RigSetup::default());
    choose(&rig, ambilight(), Some(&[Usb]));
    away(&rig, AwayEdge::Leave);
    choose(&rig, solid(), None);

    assert!(away(&rig, AwayEdge::Return).is_none());
    assert_eq!(rig.running().kind, LightingModeKind::Solid);
}

#[test]
fn lights_that_were_off_stay_off_both_ways() {
    let rig = Rig::new(RigSetup::default());

    assert!(away(&rig, AwayEdge::Leave).is_none());
    assert!(away(&rig, AwayEdge::Return).is_none());
    assert_eq!(rig.running().kind, LightingModeKind::Off);
}

#[test]
fn the_keep_setting_leaves_the_lights_on() {
    let rig = Rig::new(RigSetup {
        state: json!({ "awayLights": "keep" }),
        ..RigSetup::default()
    });
    choose(&rig, ambilight(), Some(&[Usb]));

    assert!(away(&rig, AwayEdge::Leave).is_none());
    assert!(rig.worker_running());
}

/// Lock, then display off, then sleep: one Off, and one return puts it back.
#[test]
fn going_away_twice_puts_out_once() {
    let rig = Rig::new(RigSetup::default());
    choose(&rig, ambilight(), Some(&[Usb]));

    assert!(away(&rig, AwayEdge::Leave).is_some());
    assert!(away(&rig, AwayEdge::Leave).is_none());
    assert!(away(&rig, AwayEdge::Return).is_some());
    assert_eq!(rig.running().kind, LightingModeKind::Ambilight);
}

/// A quick lock and unlock: the return's turn may run before the leave's, and
/// must still leave the lights on.
#[test]
fn a_return_that_runs_before_its_leave_still_leaves_the_lights_on() {
    let rig = Rig::new(RigSetup::default());
    choose(&rig, ambilight(), Some(&[Usb]));

    let leave = prepare_away(&rig.handle(), AwayEdge::Leave).expect("the lights were on");
    let back = prepare_away(&rig.handle(), AwayEdge::Return).expect("something was put out");
    block_on(back.run(&rig.handle())).expect("the return runs");
    block_on(leave.run(&rig.handle())).expect("the leave resolves");

    assert_eq!(rig.running().kind, LightingModeKind::Ambilight);
}

/// A reload while the screen is locked restores at launch; it must not light
/// the room, and the return still brings the mode back.
#[test]
fn a_launch_restore_while_away_keeps_the_lights_off_until_the_return() {
    let rig = Rig::new(RigSetup::default());
    choose(&rig, ambilight(), Some(&[Usb]));
    away(&rig, AwayEdge::Leave);

    let request = ApplyOutputsRequest {
        mode: None,
        targets: None,
        origin: LightingOrigin::Boot,
    };
    block_on(apply_outputs_with(&rig.handle(), request)).expect("the restore resolves");
    assert_eq!(rig.running().kind, LightingModeKind::Off);

    assert!(away(&rig, AwayEdge::Return).is_some());
    assert_eq!(rig.running().kind, LightingModeKind::Ambilight);
}

/// A choice still starting when the user leaves is saved then, since the away
/// Off takes its turn first; otherwise a crash while away would resume the
/// choice before it.
#[test]
fn a_choice_still_starting_when_the_user_leaves_is_saved() {
    let rig = Rig::new(RigSetup::default());
    let held = rig.hue.hold_starts();
    let request = ApplyOutputsRequest {
        mode: Some(ambilight()),
        targets: Some(vec!["usb".to_string(), "hue".to_string()]),
        origin: LightingOrigin::User,
    };
    let handle = rig.handle();
    let starting =
        tauri::async_runtime::spawn(async move { apply_outputs_with(&handle, request).await });
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while rig.hue.starts_entered() < 1 {
        assert!(
            std::time::Instant::now() < deadline,
            "the choice never reached Hue"
        );
        std::thread::sleep(std::time::Duration::from_millis(2));
    }
    assert_ne!(
        rig.saved("lightingMode").map(|mode| mode["kind"].clone()),
        Some(json!("ambilight"))
    );

    let leave = prepare_away(&rig.handle(), AwayEdge::Leave).expect("the lights were on");
    assert_eq!(
        rig.saved("lightingMode").unwrap()["kind"],
        json!("ambilight")
    );

    held.add_permits(8);
    let _ = block_on(starting);
    block_on(leave.run(&rig.handle())).expect("the leave resolves");
    assert_eq!(rig.running().kind, LightingModeKind::Off);
}
