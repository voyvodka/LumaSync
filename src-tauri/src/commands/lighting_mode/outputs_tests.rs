//! The lighting transaction, scenario by scenario. Each test drives the real
//! `apply_mode_change` over a still frame and a recording serial sender, a
//! fake Hue driver that publishes into a real `HueOutputLive`, and an
//! in-memory shell state, then reads what the hardware saw (one ordered event
//! log), what was published, and what was saved.
//!
//! Most scenarios port a case of the frontend orchestrator's suite
//! (`useLightingModeOrchestrator.test.ts`); the name says the behaviour, the
//! comment above it names the case it came from.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::json;
use tauri::async_runtime::{block_on, spawn, JoinHandle};
use tauri::Manager;

use super::hue_driver::HueAreaVerdict;
use super::outputs::{
    apply_outputs_with, listen_hue_health, note_hue_reachable, note_local_sink_connected,
    note_settings_saved, refresh_running_with, release_hue_with, wait_for_area_release,
    ApplyOutputsRequest, ApplyOutputsResult, CancelToken, LightingOrigin, ReleaseWait,
    BOOT_HUE_RETRY_POLL, BOOT_HUE_RETRY_WINDOW,
};
use super::snapshot::{BootHueRetryState, HueLeftOutReason, LightingPhase, OutputTarget};
use super::test_support::{Rig, RigSetup};
use super::transition::set_lighting_mode_blocking;
use super::tuning::{retune_lighting, LightingTuning};
use super::{
    stop_lighting_blocking, AmbilightPayload, LightingModeConfig, LightingModeKind,
    SolidColorPayload, ACTIVE_AMBILIGHT_WORKERS,
};
use crate::commands::device_connection::{ActiveSinkRegistry, SerialConnectionState};
use crate::commands::hue::light_restore::HueLightsAfterStop;
use crate::commands::hue::state_store::HueRuntimeTriggerSource;
use crate::commands::led_output::{
    encode_packet_for_output, ColorCorrectionConfig, EncoderPlan, FirmwareProfile, LedChipType,
};
use crate::commands::wled_sink::{WledProtocol, WledSinkConfig};
use crate::shutdown::{app_cleanup_steps, run_cleanup, CleanupBudget};

use OutputTarget::{Hue, Usb};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

fn ambilight(brightness: f32) -> LightingModeConfig {
    LightingModeConfig {
        kind: LightingModeKind::Ambilight,
        ambilight: Some(AmbilightPayload {
            brightness,
            ..AmbilightPayload::default()
        }),
        ..LightingModeConfig::default()
    }
}

fn off() -> LightingModeConfig {
    LightingModeConfig::default()
}

fn request(
    origin: LightingOrigin,
    mode: Option<LightingModeConfig>,
    targets: Option<&[OutputTarget]>,
) -> ApplyOutputsRequest {
    ApplyOutputsRequest {
        mode,
        targets: targets.map(|targets| targets.iter().map(|t| t.as_str().to_string()).collect()),
        origin,
    }
}

fn user(mode: Option<LightingModeConfig>, targets: Option<&[OutputTarget]>) -> ApplyOutputsRequest {
    request(LightingOrigin::User, mode, targets)
}

fn apply(rig: &Rig, request: ApplyOutputsRequest) -> ApplyOutputsResult {
    block_on(apply_outputs_with(&rig.handle(), request)).expect("apply_outputs resolves")
}

fn spawn_apply(
    rig: &Rig,
    request: ApplyOutputsRequest,
) -> JoinHandle<Result<ApplyOutputsResult, String>> {
    let handle = rig.handle();
    spawn(async move { apply_outputs_with(&handle, request).await })
}

fn release(rig: &Rig, trigger: HueRuntimeTriggerSource) -> ApplyOutputsResult {
    block_on(release_hue_with(&rig.handle(), trigger)).expect("release resolves")
}

fn retune(rig: &Rig, tuning: LightingTuning) -> String {
    block_on(retune_lighting(rig.handle(), tuning))
        .expect("retune resolves")
        .status
        .code
}

fn wait_until(what: &str, done: impl Fn() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while !done() {
        assert!(Instant::now() < deadline, "timed out: {what}");
        std::thread::sleep(Duration::from_millis(2));
    }
}

/// Brings a mode up as a user choice and forgets what that took.
fn running(rig: &Rig, mode: LightingModeConfig, targets: &[OutputTarget]) {
    let started = apply(rig, user(Some(mode), Some(targets)));
    assert_eq!(started.status.code, "OUTPUTS_APPLIED", "setup: {started:?}");
    rig.log.clear();
}

fn events(rig: &Rig) -> Vec<String> {
    rig.log.events()
}

fn has(rig: &Rig, event: &str) -> bool {
    events(rig).iter().any(|e| e == event)
}

fn order(rig: &Rig, first: &str, then: &str) -> bool {
    match (rig.log.seq_of(first), rig.log.seq_of(then)) {
        (Some(a), Some(b)) => a < b,
        _ => false,
    }
}

fn mode_events(rig: &Rig) -> Vec<String> {
    events(rig)
        .into_iter()
        .filter(|e| e.starts_with("mode:"))
        .collect()
}

fn poison<T: Send>(mutex: &Mutex<T>) {
    let _ = std::thread::scope(|scope| {
        scope
            .spawn(|| {
                let _guard = mutex.lock();
                panic!("poisoning the lock on purpose");
            })
            .join()
    });
}

// ---------------------------------------------------------------------------
// Starting point and target choices
// ---------------------------------------------------------------------------

/// "starts OFF on the default target set"
#[test]
fn a_fresh_runtime_reports_off_with_nothing_driven() {
    let rig = Rig::new(RigSetup::default());
    let snapshot = rig.state().snapshot.read();
    assert_eq!(snapshot.mode.kind, LightingModeKind::Off);
    assert!(!snapshot.active);
    assert!(snapshot.active_targets.is_empty());
    assert_eq!(snapshot.phase, LightingPhase::Idle);
}

/// "persists the target selection even while nothing is running (INV-17)"
#[test]
fn a_target_choice_is_saved_even_while_off_and_touches_nothing() {
    let rig = Rig::new(RigSetup::default());
    let result = apply(&rig, user(None, Some(&[Hue])));

    assert_eq!(result.status.code, "OUTPUTS_APPLIED");
    assert_eq!(rig.saved("lastOutputTargets"), Some(json!(["hue"])));
    assert_eq!(result.snapshot.selected_targets, vec![Hue]);
    assert!(events(&rig).is_empty(), "{:?}", events(&rig));
}

// ---------------------------------------------------------------------------
// Removing a target from a running mode
// ---------------------------------------------------------------------------

/// "retains a target whose stop rejected and raises the notice"
#[test]
fn a_hue_removal_whose_stop_does_not_confirm_keeps_hue_listed() {
    let rig = Rig::new(RigSetup::default());
    running(&rig, solid(1), &[Usb, Hue]);
    rig.hue.script_stops(&["HUE_STOP_TIMEOUT_PARTIAL"]);

    let result = apply(&rig, user(None, Some(&[Usb])));

    assert_eq!(result.status.code, "OUTPUTS_APPLIED_PARTIAL");
    assert_eq!(result.outcome.stop_failed, vec![Hue]);
    assert!(result.snapshot.active_targets.contains(&Hue));
    // The worker lets go of Hue before the stream stops.
    assert!(
        order(&rig, "mode:solid:usb", "hue:stop:system"),
        "{:?}",
        events(&rig)
    );
}

/// "drops USB by re-applying the mode on Hue, not by stopping the runtime"
#[test]
fn dropping_usb_re_applies_the_mode_on_hue() {
    let rig = Rig::new(RigSetup::default());
    running(&rig, solid(1), &[Usb, Hue]);

    let result = apply(&rig, user(None, Some(&[Hue])));

    assert_eq!(result.status.code, "OUTPUTS_APPLIED");
    assert_eq!(events(&rig), vec!["mode:solid:hue"]);
    assert_eq!(result.snapshot.active_targets, vec![Hue]);
    assert_eq!(result.snapshot.mode.targets, Some(vec!["hue".to_string()]));
}

/// "falls back to stopping the runtime when the re-apply is refused with the
/// old mode still running"
#[test]
fn a_refused_usb_removal_stops_the_strip_rather_than_leave_it_lit() {
    let rig = Rig::new(RigSetup::default());
    running(&rig, solid(1), &[Usb, Hue]);
    rig.hue.stream_drops();
    rig.hue.script_starts(&["CONFIG_NOT_READY_GATE_BLOCKED"]);

    let result = apply(&rig, user(None, Some(&[Hue])));

    assert_eq!(result.status.code, "OUTPUTS_REFUSED");
    assert!(result.outcome.mode_ended);
    assert!(has(&rig, "mode:off:"), "{:?}", events(&rig));
    assert_eq!(rig.running().kind, LightingModeKind::Off);
    assert!(!result.snapshot.active_targets.contains(&Usb));
}

/// "an unplug drops USB the same way without writing the saved targets"
#[test]
fn an_unplug_drops_usb_the_same_way_without_saving() {
    let rig = Rig::new(RigSetup::default());
    running(&rig, solid(1), &[Usb, Hue]);
    let written_before = rig.written_keys().len();

    let result = apply(&rig, request(LightingOrigin::UsbUnplug, None, Some(&[Hue])));

    assert_eq!(result.status.code, "OUTPUTS_APPLIED");
    assert_eq!(events(&rig), vec!["mode:solid:hue"]);
    assert_eq!(result.snapshot.selected_targets, vec![Hue]);
    assert_eq!(
        rig.written_keys().len(),
        written_before,
        "{:?}",
        rig.written_keys()
    );
    assert_eq!(rig.saved("lastOutputTargets"), Some(json!(["usb", "hue"])));
}

#[test]
fn unplugging_the_only_target_ends_the_mode_and_keeps_the_selection() {
    let rig = Rig::new(RigSetup::default());
    running(&rig, ambilight(1.0), &[Usb]);
    let written_before = rig.written_keys().len();

    let result = apply(&rig, request(LightingOrigin::UsbUnplug, None, Some(&[])));

    assert_eq!(result.status.code, "OUTPUTS_APPLIED");
    assert!(result.outcome.mode_ended);
    assert_eq!(result.snapshot.mode.kind, LightingModeKind::Off);
    assert_eq!(result.snapshot.selected_targets, vec![Usb]);
    assert!(!rig.worker_running());
    assert_eq!(rig.written_keys().len(), written_before);
}

// ---------------------------------------------------------------------------
// Off
// ---------------------------------------------------------------------------

/// "routes the OFF transition to stopLighting and clears active targets"
#[test]
fn off_stops_the_worker_and_clears_the_outputs() {
    let rig = Rig::new(RigSetup::default());
    running(&rig, solid(1), &[Usb]);

    let result = apply(&rig, user(Some(off()), None));

    assert_eq!(result.status.code, "OUTPUTS_APPLIED");
    assert!(has(&rig, "mode:off:"));
    assert_eq!(result.snapshot.mode.kind, LightingModeKind::Off);
    assert!(result.snapshot.active_targets.is_empty());
    assert_eq!(result.snapshot.phase, LightingPhase::Idle);
    assert_eq!(rig.saved("lightingMode").unwrap()["kind"], json!("off"));
}

/// The worker holds a handle on the Hue sender; the stream stops second.
#[test]
fn off_stops_the_worker_before_the_hue_stream() {
    let rig = Rig::new(RigSetup::default());
    running(&rig, ambilight(1.0), &[Usb, Hue]);

    apply(&rig, user(Some(off()), None));

    assert!(
        order(&rig, "mode:off:", "hue:stop:mode_control"),
        "{:?}",
        events(&rig)
    );
    assert!(!rig.hue.streaming());
}

/// "still asks the other target to stop" and "drops the target that stopped
/// and keeps the one that did not"
#[test]
fn off_still_stops_hue_when_the_strip_stop_fails() {
    let rig = Rig::new(RigSetup::default());
    running(&rig, solid(1), &[Usb, Hue]);
    poison(&rig.state().runtime);

    let result = apply(&rig, user(Some(off()), None));

    assert!(has(&rig, "hue:stop:mode_control"), "{:?}", events(&rig));
    assert_eq!(result.status.code, "OUTPUTS_APPLIED_PARTIAL");
    assert_eq!(result.outcome.stop_failed, vec![Usb]);
    assert_eq!(result.snapshot.active_targets, vec![Usb]);
    assert_eq!(result.snapshot.phase, LightingPhase::Idle);
}

// ---------------------------------------------------------------------------
// Off turns the lights off — a user's Off only
// ---------------------------------------------------------------------------

/// What a blank of the rig's 59-LED strip puts on the wire.
fn black_frame() -> Vec<u8> {
    encode_packet_for_output(
        FirmwareProfile::default(),
        LedChipType::default(),
        1.0,
        &[[0, 0, 0]; 59],
        &EncoderPlan::new(&ColorCorrectionConfig::default()),
    )
}

/// Strip packets sent after `event`.
fn packets_after(rig: &Rig, event: &str) -> Vec<Vec<u8>> {
    let at = rig.log.seq_of(event).expect("the event happened");
    rig.log
        .packets()
        .into_iter()
        .filter(|(seq, _)| *seq > at)
        .map(|(_, packet)| packet)
        .collect()
}

fn hue_stops(rig: &Rig) -> Vec<HueLightsAfterStop> {
    rig.hue.stop_lights()
}

/// A strip holds the last frame it was sent, so stopping the worker alone
/// left Ambilight's last colours up.
#[test]
fn off_paints_the_strip_black_once_the_worker_has_stopped() {
    let rig = Rig::new(RigSetup::default());
    running(&rig, ambilight(1.0), &[Usb]);
    wait_until("the worker never drove the strip", || {
        !rig.log.packets().is_empty()
    });

    apply(&rig, user(Some(off()), None));

    assert_eq!(packets_after(&rig, "mode:off:"), vec![black_frame()]);
    assert!(!rig.worker_running());
}

/// Solid writes once; nothing but Off's black frame ever replaced it.
#[test]
fn off_from_solid_paints_the_strip_black() {
    let rig = Rig::new(RigSetup::default());
    running(&rig, solid(200), &[Usb]);

    apply(&rig, user(Some(off()), None));

    assert_eq!(packets_after(&rig, "mode:off:"), vec![black_frame()]);
}

#[test]
fn off_switches_the_hue_lights_off_by_default() {
    let rig = Rig::new(RigSetup::default());
    running(&rig, ambilight(1.0), &[Usb, Hue]);

    apply(&rig, user(Some(off()), None));

    assert_eq!(hue_stops(&rig), vec![HueLightsAfterStop::TurnOff]);
    assert!(
        order(&rig, "mode:off:", "hue:stop:mode_control"),
        "{:?}",
        events(&rig)
    );
}

/// The choice is read when Off runs, so a change made after the mode started
/// — in any window — counts.
#[test]
fn off_reads_the_hue_choice_when_it_runs() {
    let rig = Rig::new(RigSetup {
        state: json!({ "hueOffBehavior": "turnOff" }),
        ..RigSetup::default()
    });
    running(&rig, solid(1), &[Usb, Hue]);
    rig.seed(json!({ "hueOffBehavior": "restore" }));

    apply(&rig, user(Some(off()), None));
    assert_eq!(hue_stops(&rig), vec![HueLightsAfterStop::Restore]);
    // The strip goes dark whatever Hue does.
    assert_eq!(packets_after(&rig, "mode:off:"), vec![black_frame()]);

    running(&rig, solid(1), &[Usb, Hue]);
    rig.seed(json!({ "hueOffBehavior": "turnOff" }));
    apply(&rig, user(Some(off()), None));
    assert_eq!(
        hue_stops(&rig),
        vec![HueLightsAfterStop::Restore, HueLightsAfterStop::TurnOff]
    );
}

#[test]
fn the_tray_and_the_popup_off_switch_the_lights_off_too() {
    for origin in [LightingOrigin::Tray, LightingOrigin::Popup] {
        let rig = Rig::new(RigSetup::default());
        running(&rig, solid(1), &[Usb, Hue]);

        apply(&rig, request(origin, Some(off()), None));

        assert_eq!(
            hue_stops(&rig),
            vec![HueLightsAfterStop::TurnOff],
            "{origin:?}"
        );
        assert_eq!(
            packets_after(&rig, "mode:off:"),
            vec![black_frame()],
            "{origin:?}"
        );
    }
}

/// Only pressing Off turns lights off. Taking Hue out of a running mode, the
/// Devices card's stop, and a mode that ends because its outputs went all
/// let the lights go back as they were — and leave the strip alone.
#[test]
fn every_other_way_hue_output_ends_puts_the_lights_back() {
    // One rig at a time: each holds the worker-test guard.
    let ended_by = |end: &dyn Fn(&Rig)| {
        let rig = Rig::new(RigSetup::default());
        running(&rig, solid(1), &[Usb, Hue]);
        end(&rig);
        let blanked = rig
            .log
            .seq_of("mode:off:")
            .is_some_and(|_| !packets_after(&rig, "mode:off:").is_empty());
        (hue_stops(&rig), blanked)
    };
    let restored = (vec![HueLightsAfterStop::Restore], false);

    assert_eq!(
        ended_by(&|rig| {
            apply(rig, user(None, Some(&[Usb])));
        }),
        restored,
        "Hue taken out of the running mode"
    );
    assert_eq!(
        ended_by(&|rig| {
            release(rig, HueRuntimeTriggerSource::DeviceSurface);
        }),
        restored,
        "the Devices card's stop"
    );
    assert_eq!(
        ended_by(&|rig| {
            apply(rig, user(None, Some(&[])));
        }),
        restored,
        "every output deselected is not pressing Off"
    );
    assert_eq!(
        ended_by(&|rig| {
            apply(rig, request(LightingOrigin::UsbUnplug, None, Some(&[])));
        }),
        restored,
        "a strip unplugged"
    );
}

/// A launch that finds Off saved has nothing running to switch off.
#[test]
fn a_launch_whose_saved_mode_is_off_touches_no_light() {
    let rig = Rig::new(RigSetup {
        state: json!({
            "lightingMode": { "kind": "off" },
            "lastOutputTargets": ["usb", "hue"]
        }),
        ..RigSetup::default()
    });

    let result = apply(&rig, request(LightingOrigin::Boot, None, None));

    assert_eq!(result.status.code, "OUTPUTS_APPLIED");
    assert!(hue_stops(&rig).is_empty(), "{:?}", events(&rig));
    assert!(rig.log.packets().is_empty());
}

/// Off with nothing running sends the strip nothing. Hue still gets its stop,
/// as it always did, which writes nothing without a session to end.
#[test]
fn off_while_nothing_runs_sends_the_strip_nothing() {
    let rig = Rig::new(RigSetup::default());

    let result = apply(&rig, user(Some(off()), None));

    assert_eq!(result.status.code, "OUTPUTS_APPLIED");
    assert!(rig.log.packets().is_empty());
    assert!(!events(&rig).iter().any(|e| e.starts_with("wled:")));
}

/// Ambilight chosen straight after Off waits for Off's stop and starts
/// afterwards: a switch-off can never land under the new stream.
#[test]
fn ambilight_right_after_off_starts_once_the_switch_off_is_done() {
    let rig = Rig::new(RigSetup::default());
    running(&rig, ambilight(1.0), &[Usb, Hue]);
    let stop_gate = rig.hue.hold_stops();

    let off = spawn_apply(&rig, user(Some(off()), None));
    wait_until("Off reached Hue", || rig.hue.stops_entered() == 1);
    let on = spawn_apply(&rig, user(Some(ambilight(1.0)), None));
    std::thread::sleep(Duration::from_millis(50));
    assert_eq!(rig.hue.starts_entered(), 1, "the start overtook the stop");
    stop_gate.add_permits(1);
    block_on(off).unwrap().unwrap();
    let on = block_on(on).unwrap().unwrap();

    assert_eq!(on.status.code, "OUTPUTS_APPLIED");
    assert_eq!(hue_stops(&rig), vec![HueLightsAfterStop::TurnOff]);
    assert!(
        order(&rig, "hue:stop:mode_control", "hue:start"),
        "{:?}",
        events(&rig)
    );
    assert!(rig.hue.streaming());
}

/// A WLED device leaves realtime mode ~2 s after the last frame and goes back
/// to its own effect, so black alone does not keep it dark.
#[test]
fn off_on_a_wled_strip_paints_it_black_and_switches_it_off() {
    let rig = Rig::new(RigSetup {
        serial_connected: false,
        ..RigSetup::default()
    });
    let receiver = std::net::UdpSocket::bind("127.0.0.1:0").unwrap();
    receiver
        .set_read_timeout(Some(Duration::from_millis(500)))
        .unwrap();
    let config = WledSinkConfig {
        ip: "127.0.0.1".parse().unwrap(),
        port: receiver.local_addr().unwrap().port(),
        led_count: 59,
        protocol: WledProtocol::Drgb,
    };
    rig.app
        .state::<ActiveSinkRegistry>()
        .replace_wled(Box::new(config.build()), config);
    running(&rig, solid(200), &[Usb]);
    let mut datagram = [0u8; 2048];
    let (len, _) = receiver.recv_from(&mut datagram).expect("the Solid frame");
    assert!(datagram[2..len].iter().any(|byte| *byte != 0));

    apply(&rig, user(Some(off()), None));

    let (len, _) = receiver.recv_from(&mut datagram).expect("a black frame");
    assert_eq!(datagram[0], 2, "DRGB");
    assert_eq!(len, 2 + 59 * 3);
    assert!(datagram[2..len].iter().all(|byte| *byte == 0));
    assert!(
        order(&rig, "mode:off:", "wled:off:127.0.0.1"),
        "{:?}",
        events(&rig)
    );
}

#[test]
fn a_wled_strip_is_not_switched_off_when_its_mode_ends_another_way() {
    let rig = Rig::new(RigSetup {
        serial_connected: false,
        ..RigSetup::default()
    });
    let receiver = std::net::UdpSocket::bind("127.0.0.1:0").unwrap();
    let config = WledSinkConfig {
        ip: "127.0.0.1".parse().unwrap(),
        port: receiver.local_addr().unwrap().port(),
        led_count: 59,
        protocol: WledProtocol::Drgb,
    };
    rig.app
        .state::<ActiveSinkRegistry>()
        .replace_wled(Box::new(config.build()), config);
    running(&rig, solid(200), &[Usb]);

    apply(&rig, user(None, Some(&[])));

    assert!(has(&rig, "mode:off:"), "{:?}", events(&rig));
    assert!(!events(&rig).iter().any(|e| e.starts_with("wled:")));
}

// ---------------------------------------------------------------------------
// Starts that fail, and starts that run
// ---------------------------------------------------------------------------

/// "classifies a screen-recording denial…", "distinguishes a missing display…",
/// "keeps an unknown reason visible…": the reason reaches the frontend as sent.
#[test]
fn a_capture_failure_reports_its_reason_verbatim() {
    for reason in [
        "AMBILIGHT_CAPTURE_PERMISSION_DENIED",
        "AMBILIGHT_CAPTURE_MONITOR_NOT_FOUND",
        "AMBILIGHT_CAPTURE_NOT_YET_INVENTED",
    ] {
        let rig = Rig::new(RigSetup::default());
        rig.fail_capture(Some(reason));

        let result = apply(&rig, user(Some(ambilight(1.0)), Some(&[Usb])));

        assert_eq!(result.status.code, "OUTPUTS_START_FAILED", "{reason}");
        assert_eq!(result.status.details.as_deref(), Some(reason));
        let applied = result.outcome.apply_status.expect("the apply answered");
        assert_eq!(applied.code, "AMBILIGHT_MODE_START_FAILED");
        assert_eq!(applied.details.as_deref(), Some(reason));
    }
}

/// "does not commit or persist a mode the backend refused to start"
#[test]
fn a_start_that_failed_is_neither_shown_nor_saved() {
    let rig = Rig::new(RigSetup::default());
    rig.fail_capture(Some("AMBILIGHT_CAPTURE_PERMISSION_DENIED"));

    let result = apply(&rig, user(Some(ambilight(1.0)), Some(&[Usb])));

    assert_eq!(result.snapshot.mode.kind, LightingModeKind::Off);
    assert!(!result.snapshot.active_targets.contains(&Usb));
    assert_eq!(result.snapshot.selected_targets, vec![Usb]);
    assert!(!rig.written_keys().contains(&"lightingMode".to_string()));
}

/// "does not commit when a gate refuses while another kind is still live"
#[test]
fn a_gate_refusal_keeps_the_mode_that_runs() {
    let rig = Rig::new(RigSetup::default());
    running(&rig, solid(1), &[Usb]);
    rig.set_serial_connected(false);
    let saved_before = rig.saved("lightingMode");

    let result = apply(&rig, user(Some(ambilight(1.0)), None));

    assert_eq!(result.status.code, "OUTPUTS_REFUSED");
    assert_eq!(
        result.status.details.as_deref(),
        Some("DEVICE_NOT_CONNECTED")
    );
    assert_eq!(result.snapshot.mode.kind, LightingModeKind::Solid);
    assert_eq!(rig.saved("lightingMode"), saved_before);
}

/// An older build copied the selection into `lightingMode`, where nothing read
/// it; the next save leaves it out.
#[test]
fn a_saved_mode_drops_the_targets_an_older_build_wrote() {
    let rig = Rig::new(RigSetup {
        state: json!({ "lightingMode": { "kind": "solid", "targets": ["hue"] } }),
        ..RigSetup::default()
    });

    apply(&rig, user(Some(ambilight(0.8)), Some(&[Usb])));

    let saved = rig.saved("lightingMode").expect("the mode was saved");
    assert_eq!(saved["kind"], json!("ambilight"));
    assert_eq!(saved.get("targets"), None);
}

/// "commits the mode when the backend accepts it" and "stays silent when the
/// start succeeds"
#[test]
fn an_accepted_start_is_shown_and_saved() {
    let rig = Rig::new(RigSetup::default());

    let result = apply(&rig, user(Some(ambilight(0.8)), Some(&[Usb])));

    assert_eq!(result.status.code, "OUTPUTS_APPLIED");
    assert_eq!(result.snapshot.mode.kind, LightingModeKind::Ambilight);
    assert_eq!(result.snapshot.active_targets, vec![Usb]);
    assert_eq!(
        result.outcome.apply_status.map(|s| s.code).as_deref(),
        Some("AMBILIGHT_MODE_STARTED")
    );
    let saved = rig.saved("lightingMode").expect("the mode was saved");
    assert_eq!(saved["kind"], json!("ambilight"));
    assert_eq!(saved.get("targets"), None);
    assert_eq!(rig.saved("lastOutputTargets"), Some(json!(["usb"])));
    wait_until("the strip never received a frame", || {
        !rig.log.packets().is_empty()
    });
}

/// "routes a USB target with no calibration to the editor instead of
/// dispatching (D-05)"
#[test]
fn a_usb_start_without_a_calibration_touches_nothing() {
    let rig = Rig::new(RigSetup {
        calibrated: false,
        ..RigSetup::default()
    });

    let result = apply(&rig, user(Some(ambilight(1.0)), Some(&[Usb])));

    assert_eq!(result.status.code, "OUTPUTS_CALIBRATION_REQUIRED");
    assert!(events(&rig).is_empty(), "{:?}", events(&rig));
    assert!(rig.log.packets().is_empty());
    assert_eq!(result.snapshot.phase, LightingPhase::Idle);
    assert_eq!(result.snapshot.mode.kind, LightingModeKind::Off);
}

/// "fills omitted payloads from the current mode and carries the selected targets"
#[test]
fn a_mode_choice_keeps_the_last_payloads_and_saves_the_selection() {
    let rig = Rig::new(RigSetup::default());
    let mut first = solid(10);
    first.ambilight = Some(AmbilightPayload {
        brightness: 0.7,
        ..AmbilightPayload::default()
    });
    running(&rig, first, &[Usb]);

    let bare = LightingModeConfig {
        kind: LightingModeKind::Solid,
        ..LightingModeConfig::default()
    };
    let result = apply(&rig, user(Some(bare), Some(&[Usb, Hue])));

    assert_eq!(result.status.code, "OUTPUTS_APPLIED");
    assert_eq!(result.snapshot.mode.solid.as_ref().map(|s| s.r), Some(10));
    let saved = rig.saved("lightingMode").unwrap();
    assert_eq!(saved["solid"]["r"], json!(10));
    assert_eq!(
        saved["ambilight"]["brightness"]
            .as_f64()
            .map(|b| (b * 10.0).round()),
        Some(7.0)
    );
    assert_eq!(saved.get("targets"), None);
    assert_eq!(rig.saved("lastOutputTargets"), Some(json!(["usb", "hue"])));
}

// ---------------------------------------------------------------------------
// The Hue stream after a refused apply
// ---------------------------------------------------------------------------

/// "releases a stream this apply opened when the mode never ran"
#[test]
fn a_stream_this_start_opened_is_released_when_the_mode_never_ran() {
    let rig = Rig::new(RigSetup::default());
    rig.fail_capture(Some("AMBILIGHT_CAPTURE_PERMISSION_DENIED"));

    let result = apply(&rig, user(Some(ambilight(1.0)), Some(&[Hue])));

    assert_eq!(result.status.code, "OUTPUTS_START_FAILED");
    assert!(
        order(&rig, "hue:start", "hue:stop:system"),
        "{:?}",
        events(&rig)
    );
    assert!(result.snapshot.active_targets.is_empty());
    assert_eq!(result.snapshot.mode.kind, LightingModeKind::Off);
}

/// "keeps the stream a still-running mode is using when a gate refuses" — the
/// device gate no longer refuses the whole choice: it runs on the Hue that is
/// there, on the stream it already had.
#[test]
fn a_choice_the_strip_cannot_take_keeps_the_stream_the_running_mode_uses() {
    let rig = Rig::new(RigSetup::default());
    running(&rig, solid(1), &[Hue]);
    rig.set_serial_connected(false);

    let result = apply(&rig, user(Some(ambilight(1.0)), Some(&[Usb, Hue])));

    assert_eq!(result.status.code, "OUTPUTS_APPLIED_PARTIAL");
    assert!(
        !events(&rig).iter().any(|e| e.starts_with("hue:stop")),
        "{:?}",
        events(&rig)
    );
    assert_eq!(result.snapshot.mode.kind, LightingModeKind::Ambilight);
    assert_eq!(result.snapshot.active_targets, vec![Hue]);
    assert_eq!(result.outcome.dropped_targets, vec![Usb]);
}

/// "releases the previous mode's stream once the backend has torn that mode down"
#[test]
fn the_previous_modes_stream_is_released_once_that_mode_is_torn_down() {
    let rig = Rig::new(RigSetup::default());
    running(&rig, solid(1), &[Hue]);
    rig.fail_capture(Some("AMBILIGHT_CAPTURE_PERMISSION_DENIED"));

    let result = apply(&rig, user(Some(ambilight(1.0)), None));

    assert_eq!(result.status.code, "OUTPUTS_START_FAILED");
    assert!(has(&rig, "hue:stop:system"), "{:?}", events(&rig));
    assert_eq!(result.snapshot.mode.kind, LightingModeKind::Off);
    assert!(result.outcome.mode_ended);
}

/// "leaves a stream it never held alone"
#[test]
fn a_stream_the_test_lease_opened_is_left_alone() {
    let rig = Rig::new(RigSetup::default());
    let leased = apply(&rig, request(LightingOrigin::LeaseHue, None, Some(&[Hue])));
    assert_eq!(leased.status.code, "OUTPUTS_APPLIED");
    rig.log.clear();
    rig.fail_capture(Some("AMBILIGHT_CAPTURE_PERMISSION_DENIED"));

    apply(&rig, user(Some(ambilight(1.0)), Some(&[Hue])));

    assert!(
        !events(&rig).iter().any(|e| e.starts_with("hue:")),
        "{:?}",
        events(&rig)
    );
    assert!(rig.hue.streaming());
}

/// "keeps hue listed and raises the stop notice when the release fails"
#[test]
fn a_release_that_does_not_confirm_keeps_hue_listed() {
    let rig = Rig::new(RigSetup::default());
    rig.fail_capture(Some("AMBILIGHT_CAPTURE_PERMISSION_DENIED"));
    rig.hue.script_stops(&["HUE_STOP_TIMEOUT_PARTIAL"]);

    let result = apply(&rig, user(Some(ambilight(1.0)), Some(&[Hue])));

    assert_eq!(result.snapshot.active_targets, vec![Hue]);
    assert_eq!(result.outcome.stop_failed, vec![Hue]);
}

/// "does not stop anything when the apply is accepted"
#[test]
fn an_accepted_hue_start_stops_nothing_and_the_worker_drives_hue() {
    let rig = Rig::new(RigSetup::default());

    let result = apply(&rig, user(Some(ambilight(1.0)), Some(&[Hue])));

    assert_eq!(result.status.code, "OUTPUTS_APPLIED");
    assert!(!events(&rig).iter().any(|e| e.starts_with("hue:stop")));
    assert_eq!(result.snapshot.active_targets, vec![Hue]);
    assert!(
        rig.hue.received_frame(Duration::from_secs(2)),
        "no frame reached Hue"
    );
}

// ---------------------------------------------------------------------------
// Hue left out of a [usb, hue] start
// ---------------------------------------------------------------------------

/// "re-dispatches once on USB alone and runs the mode" — Rust knows the start
/// failed, so the doomed [usb, hue] apply is never sent.
#[test]
fn a_gated_hue_start_runs_the_mode_on_usb_alone() {
    let rig = Rig::new(RigSetup::default());
    rig.hue.script_starts(&["CONFIG_NOT_READY_GATE_BLOCKED"]);

    let result = apply(&rig, user(Some(ambilight(1.0)), Some(&[Usb, Hue])));

    assert_eq!(result.status.code, "OUTPUTS_APPLIED_PARTIAL");
    assert_eq!(mode_events(&rig), vec!["mode:ambilight:usb"]);
    assert_eq!(result.snapshot.mode.targets, Some(vec!["usb".to_string()]));
    assert_eq!(result.snapshot.active_targets, vec![Usb]);
    assert_eq!(result.snapshot.selected_targets, vec![Usb]);
    assert_eq!(
        result.outcome.hue_left_out,
        Some(HueLeftOutReason::Unreachable)
    );
    assert_eq!(
        result.snapshot.hue_held_out_reason,
        Some(HueLeftOutReason::Unreachable)
    );
    assert!(
        !has(&rig, "hue:stop:system"),
        "an idle, gated start has nothing to cancel"
    );
}

/// "never persists the reduced target set"
#[test]
fn a_left_out_hue_is_never_saved_away() {
    let rig = Rig::new(RigSetup {
        state: json!({ "lastOutputTargets": ["usb", "hue"] }),
        ..RigSetup::default()
    });
    rig.hue.script_starts(&["CONFIG_NOT_READY_GATE_BLOCKED"]);

    apply(&rig, user(Some(ambilight(1.0)), None));

    assert!(!rig
        .written_keys()
        .contains(&"lastOutputTargets".to_string()));
    let saved = rig.saved("lightingMode").unwrap();
    assert_eq!(saved["kind"], json!("ambilight"));
    assert_eq!(saved.get("targets"), None);
    assert_eq!(rig.saved("lastOutputTargets"), Some(json!(["usb", "hue"])));
}

/// "cancels a start that left Hue retrying before running on USB"
#[test]
fn a_start_left_retrying_is_cancelled_before_the_mode_runs() {
    let rig = Rig::new(RigSetup::default());
    rig.hue.script_starts(&["TRANSIENT_RETRY_SCHEDULED"]);

    let result = apply(&rig, user(Some(ambilight(1.0)), Some(&[Usb, Hue])));

    assert!(
        order(&rig, "hue:stop:system", "mode:ambilight:usb"),
        "{:?}",
        events(&rig)
    );
    assert_eq!(result.snapshot.active_targets, vec![Usb]);
    assert_eq!(
        result.outcome.hue_left_out,
        Some(HueLeftOutReason::Unreachable)
    );
}

/// "keeps hue listed and raises the stop notice when the cancel does not confirm"
#[test]
fn a_cancel_that_does_not_confirm_keeps_hue_listed() {
    let rig = Rig::new(RigSetup::default());
    rig.hue.script_starts(&["TRANSIENT_RETRY_SCHEDULED"]);
    rig.hue.script_stops(&["HUE_STOP_TIMEOUT_PARTIAL"]);

    let result = apply(&rig, user(Some(ambilight(1.0)), Some(&[Usb, Hue])));

    assert_eq!(result.snapshot.active_targets, vec![Usb, Hue]);
    assert_eq!(result.outcome.stop_failed, vec![Hue]);
}

/// "names a re-pair for an auth-invalid start"
#[test]
fn an_auth_refusal_is_named_as_a_re_pair() {
    let rig = Rig::new(RigSetup::default());
    rig.hue.script_starts(&["AUTH_INVALID_CREDENTIALS"]);

    let result = apply(&rig, user(Some(solid(1)), Some(&[Usb, Hue])));

    assert_eq!(result.snapshot.mode.kind, LightingModeKind::Solid);
    assert_eq!(result.outcome.hue_left_out, Some(HueLeftOutReason::Auth));
    assert!(!events(&rig).iter().any(|e| e.starts_with("hue:stop")));
}

/// "says Hue is not set up when there is no start config"
#[test]
fn no_bridge_on_record_is_named_as_not_set_up() {
    let rig = Rig::new(RigSetup {
        hue_paired: false,
        ..RigSetup::default()
    });

    let result = apply(&rig, user(Some(ambilight(1.0)), Some(&[Usb, Hue])));

    assert!(!has(&rig, "hue:start"));
    assert_eq!(result.outcome.hue_left_out, Some(HueLeftOutReason::Config));
}

/// "raises no notice and keeps the selection when the USB retry is refused too"
#[test]
fn a_usb_run_that_fails_too_raises_no_left_out_and_keeps_the_selection() {
    let rig = Rig::new(RigSetup::default());
    rig.hue.script_starts(&["CONFIG_NOT_READY_GATE_BLOCKED"]);
    rig.fail_capture(Some("AMBILIGHT_CAPTURE_PERMISSION_DENIED"));

    let result = apply(&rig, user(Some(ambilight(1.0)), Some(&[Usb, Hue])));

    assert_eq!(result.status.code, "OUTPUTS_START_FAILED");
    assert_eq!(result.outcome.hue_left_out, None);
    assert_eq!(result.snapshot.selected_targets, vec![Usb, Hue]);
    assert_eq!(result.snapshot.mode.kind, LightingModeKind::Off);
    assert_eq!(
        result.status.details.as_deref(),
        Some("AMBILIGHT_CAPTURE_PERMISSION_DENIED")
    );
}

/// "does not retry a Hue-only start the gate refuses"
#[test]
fn a_hue_only_start_the_gate_refuses_is_not_retried() {
    let rig = Rig::new(RigSetup::default());
    rig.hue.script_starts(&["CONFIG_NOT_READY_GATE_BLOCKED"]);

    let result = apply(&rig, user(Some(ambilight(1.0)), Some(&[Hue])));

    assert_eq!(result.status.code, "OUTPUTS_REFUSED");
    assert!(mode_events(&rig).is_empty(), "{:?}", events(&rig));
    assert_eq!(result.snapshot.mode.kind, LightingModeKind::Off);
    assert_eq!(result.outcome.hue_left_out, None);
}

// ---------------------------------------------------------------------------
// Hue added to a running USB mode
// ---------------------------------------------------------------------------

fn running_on_usb() -> Rig {
    let rig = Rig::new(RigSetup::default());
    running(&rig, ambilight(1.0), &[Usb]);
    rig
}

/// "keeps Hue out of the active set when the gate refuses the re-apply"
#[test]
fn adding_hue_the_gate_refuses_keeps_it_out_and_gives_the_stream_back() {
    let rig = running_on_usb();
    // Up by its own account, but no stream reached the slot before the apply.
    rig.hue.script_starts(&["HUE_STREAM_STARTING"]);

    let result = apply(&rig, user(None, Some(&[Usb, Hue])));

    assert_eq!(result.snapshot.active_targets, vec![Usb]);
    assert_eq!(result.snapshot.selected_targets, vec![Usb]);
    assert_eq!(
        result.outcome.hue_left_out,
        Some(HueLeftOutReason::Unreachable)
    );
    assert!(has(&rig, "hue:stop:system"), "{:?}", events(&rig));
    assert!(
        !has(&rig, "mode:off:"),
        "USB is neither stopped nor restarted"
    );
    assert_eq!(result.snapshot.mode.kind, LightingModeKind::Ambilight);
    assert_eq!(rig.saved("lastOutputTargets"), Some(json!(["usb", "hue"])));
}

/// "cancels a start that left Hue retrying and does not re-apply"
#[test]
fn adding_hue_left_retrying_cancels_it_without_a_re_apply() {
    let rig = running_on_usb();
    rig.hue.script_starts(&["TRANSIENT_RETRY_SCHEDULED"]);

    let result = apply(&rig, user(None, Some(&[Usb, Hue])));

    assert!(has(&rig, "hue:stop:system"));
    assert!(mode_events(&rig).is_empty(), "{:?}", events(&rig));
    assert_eq!(result.snapshot.active_targets, vec![Usb]);
    assert_eq!(
        result.outcome.hue_left_out,
        Some(HueLeftOutReason::Unreachable)
    );
}

/// "keeps hue listed and raises the stop notice when the cancel does not confirm"
#[test]
fn adding_hue_whose_cancel_does_not_confirm_keeps_it_listed() {
    let rig = running_on_usb();
    rig.hue.script_starts(&["TRANSIENT_RETRY_SCHEDULED"]);
    rig.hue.script_stops(&["HUE_STOP_TIMEOUT_PARTIAL"]);

    let result = apply(&rig, user(None, Some(&[Usb, Hue])));

    assert_eq!(result.snapshot.active_targets, vec![Usb, Hue]);
    assert_eq!(result.outcome.stop_failed, vec![Hue]);
}

/// "names a re-pair for an auth-invalid start"
#[test]
fn adding_hue_with_a_refused_key_names_a_re_pair() {
    let rig = running_on_usb();
    rig.hue.script_starts(&["AUTH_INVALID_CREDENTIALS"]);

    let result = apply(&rig, user(None, Some(&[Usb, Hue])));

    assert!(!events(&rig).iter().any(|e| e.starts_with("hue:stop")));
    assert_eq!(result.outcome.hue_left_out, Some(HueLeftOutReason::Auth));
    assert_eq!(result.snapshot.active_targets, vec![Usb]);
}

/// "says Hue is not set up when there is no start config"
#[test]
fn adding_hue_with_no_bridge_says_not_set_up() {
    let rig = Rig::new(RigSetup {
        hue_paired: false,
        ..RigSetup::default()
    });
    running(&rig, ambilight(1.0), &[Usb]);

    let result = apply(&rig, user(None, Some(&[Usb, Hue])));

    assert!(!has(&rig, "hue:start"));
    assert_eq!(result.outcome.hue_left_out, Some(HueLeftOutReason::Config));
    assert_eq!(result.snapshot.selected_targets, vec![Usb]);
}

/// "shows Off, not USB, when the re-apply tore the running mode down"
#[test]
fn adding_hue_whose_re_apply_tears_the_mode_down_shows_off() {
    let rig = running_on_usb();
    rig.fail_capture(Some("AMBILIGHT_CAPTURE_PERMISSION_DENIED"));

    let result = apply(&rig, user(None, Some(&[Usb, Hue])));

    assert_eq!(result.status.code, "OUTPUTS_START_FAILED");
    assert!(result.snapshot.active_targets.is_empty());
    assert_eq!(result.snapshot.mode.kind, LightingModeKind::Off);
    assert_eq!(result.outcome.hue_left_out, None);
    assert!(has(&rig, "hue:stop:system"), "{:?}", events(&rig));
}

/// "adds Hue when the backend runs it"
#[test]
fn adding_hue_the_backend_runs_joins_the_mode() {
    let rig = running_on_usb();

    let result = apply(&rig, user(None, Some(&[Usb, Hue])));

    assert_eq!(result.status.code, "OUTPUTS_APPLIED");
    assert_eq!(mode_events(&rig), vec!["mode:ambilight:usb,hue"]);
    assert_eq!(result.snapshot.active_targets, vec![Usb, Hue]);
    assert_eq!(result.snapshot.selected_targets, vec![Usb, Hue]);
    assert!(!events(&rig).iter().any(|e| e.starts_with("hue:stop")));
}

// ---------------------------------------------------------------------------
// USB added to a running Hue mode
// ---------------------------------------------------------------------------

fn running_on_hue() -> Rig {
    let rig = Rig::new(RigSetup::default());
    running(&rig, ambilight(1.0), &[Hue]);
    rig
}

/// "keeps USB out of the active set when the device gate refuses the re-apply"
#[test]
fn adding_usb_the_device_gate_refuses_leaves_hue_running_untouched() {
    let rig = running_on_hue();
    rig.set_serial_connected(false);

    let result = apply(&rig, user(None, Some(&[Usb, Hue])));

    assert_eq!(result.status.code, "OUTPUTS_APPLIED_PARTIAL");
    assert_eq!(result.outcome.dropped_targets, vec![Usb]);
    assert_eq!(
        result.outcome.apply_status.map(|s| s.code).as_deref(),
        Some("DEVICE_NOT_CONNECTED")
    );
    assert_eq!(result.snapshot.active_targets, vec![Hue]);
    assert_eq!(result.snapshot.selected_targets, vec![Hue]);
    assert!(!events(&rig)
        .iter()
        .any(|e| e.starts_with("hue:stop") || e == "mode:off:"));
    assert_eq!(rig.saved("lastOutputTargets"), Some(json!(["usb", "hue"])));
}

/// "drops USB from the selection when the dispatch throws" — a throw is a
/// broken runtime here, not a device verdict: Hue keeps running, and the
/// refusal carries the reason.
#[test]
fn adding_usb_when_the_apply_errors_keeps_hue_running() {
    let rig = running_on_hue();
    poison(&rig.app.state::<SerialConnectionState>().last_status);

    let result = apply(&rig, user(None, Some(&[Usb, Hue])));

    assert_eq!(result.status.code, "OUTPUTS_REFUSED");
    assert!(result
        .status
        .details
        .as_deref()
        .is_some_and(|d| d.starts_with("LIGHTING_CONNECTION_STATE_LOCK_FAILED")));
    assert_eq!(result.snapshot.mode.kind, LightingModeKind::Ambilight);
    assert_eq!(result.snapshot.active_targets, vec![Hue]);
    assert!(!events(&rig).iter().any(|e| e.starts_with("hue:stop")));
}

/// "shows Off and releases Hue when the re-apply tore the running mode down"
#[test]
fn adding_usb_whose_re_apply_tears_the_mode_down_releases_hue() {
    let rig = running_on_hue();
    rig.fail_capture(Some("LED_OUTPUT_PORT_OPEN_FAILED"));

    let result = apply(&rig, user(None, Some(&[Usb, Hue])));

    assert_eq!(result.status.code, "OUTPUTS_START_FAILED");
    assert_eq!(
        result.status.details.as_deref(),
        Some("LED_OUTPUT_PORT_OPEN_FAILED")
    );
    assert!(result.snapshot.active_targets.is_empty());
    assert_eq!(result.snapshot.mode.kind, LightingModeKind::Off);
    assert!(has(&rig, "hue:stop:system"), "{:?}", events(&rig));
    assert!(result.outcome.stop_failed.is_empty());
}

/// "keeps hue listed when the release after a teardown does not confirm"
#[test]
fn a_teardown_release_that_does_not_confirm_keeps_hue_listed() {
    let rig = running_on_hue();
    rig.fail_capture(Some("LED_OUTPUT_PORT_OPEN_FAILED"));
    rig.hue.script_stops(&["HUE_STOP_TIMEOUT_PARTIAL"]);

    let result = apply(&rig, user(None, Some(&[Usb, Hue])));

    assert_eq!(result.snapshot.active_targets, vec![Hue]);
    assert_eq!(result.outcome.stop_failed, vec![Hue]);
    assert_eq!(result.snapshot.mode.kind, LightingModeKind::Off);
}

/// "adds USB when the backend runs it"
#[test]
fn adding_usb_the_backend_runs_joins_the_mode() {
    let rig = running_on_hue();

    let result = apply(&rig, user(None, Some(&[Usb, Hue])));

    assert_eq!(result.status.code, "OUTPUTS_APPLIED");
    assert_eq!(mode_events(&rig), vec!["mode:ambilight:usb,hue"]);
    assert_eq!(result.snapshot.active_targets, vec![Usb, Hue]);
    assert_eq!(result.snapshot.selected_targets, vec![Usb, Hue]);
    assert!(!events(&rig).iter().any(|e| e.starts_with("hue:stop")));
}

// ---------------------------------------------------------------------------
// Releasing Hue from outside the mode controls
// ---------------------------------------------------------------------------

#[test]
fn releasing_hue_with_the_mode_off_is_a_plain_stop() {
    let rig = Rig::new(RigSetup::default());
    rig.hue.stream_up();

    let result = release(&rig, HueRuntimeTriggerSource::DeviceSurface);

    assert_eq!(result.status.code, "OUTPUTS_APPLIED");
    assert_eq!(events(&rig), vec!["hue:stop:device_surface"]);
}

#[test]
fn releasing_hue_from_usb_and_hue_re_applies_on_usb_first() {
    let rig = Rig::new(RigSetup::default());
    running(&rig, ambilight(1.0), &[Usb, Hue]);
    let written_before = rig.written_keys().len();

    let result = release(&rig, HueRuntimeTriggerSource::DeviceSurface);

    assert!(
        order(&rig, "mode:ambilight:usb", "hue:stop:device_surface"),
        "{:?}",
        events(&rig)
    );
    assert_eq!(result.snapshot.selected_targets, vec![Usb]);
    assert_eq!(result.snapshot.active_targets, vec![Usb]);
    assert_eq!(rig.written_keys().len(), written_before);
}

#[test]
fn releasing_the_only_target_ends_the_mode_and_keeps_the_selection() {
    let rig = Rig::new(RigSetup::default());
    running(&rig, ambilight(1.0), &[Hue]);

    let result = release(&rig, HueRuntimeTriggerSource::DeviceSurface);

    assert!(
        order(&rig, "mode:off:", "hue:stop:device_surface"),
        "{:?}",
        events(&rig)
    );
    assert!(result.outcome.mode_ended);
    assert_eq!(result.snapshot.mode.kind, LightingModeKind::Off);
    assert_eq!(result.snapshot.selected_targets, vec![Hue]);
}

// ---------------------------------------------------------------------------
// The test lease
// ---------------------------------------------------------------------------

#[test]
fn the_lease_gives_back_only_what_it_opened() {
    let rig = Rig::new(RigSetup::default());
    apply(&rig, request(LightingOrigin::LeaseHue, None, Some(&[Hue])));
    apply(&rig, request(LightingOrigin::LeaseHue, None, Some(&[])));
    assert_eq!(events(&rig), vec!["hue:start", "hue:stop:mode_control"]);

    // Already streaming: someone else's, so neither opened nor stopped.
    rig.log.clear();
    rig.hue.stream_up();
    apply(&rig, request(LightingOrigin::LeaseHue, None, Some(&[Hue])));
    apply(&rig, request(LightingOrigin::LeaseHue, None, Some(&[])));
    assert!(events(&rig).is_empty(), "{:?}", events(&rig));
}

#[test]
fn a_mode_started_during_a_lease_adopts_its_stream() {
    let rig = Rig::new(RigSetup::default());
    apply(&rig, request(LightingOrigin::LeaseHue, None, Some(&[Hue])));
    running(&rig, ambilight(1.0), &[Hue]);

    apply(&rig, request(LightingOrigin::LeaseHue, None, Some(&[])));

    assert!(!has(&rig, "hue:stop:mode_control"), "{:?}", events(&rig));
    assert!(rig.hue.streaming());
}

#[test]
fn a_lease_never_supersedes_a_mode_change() {
    let rig = Rig::new(RigSetup::default());
    let gate = rig.hue.hold_starts();
    let start = spawn_apply(&rig, user(Some(ambilight(1.0)), Some(&[Usb, Hue])));
    wait_until("the start reached Hue", || rig.hue.starts_entered() == 1);
    let lease = spawn_apply(&rig, request(LightingOrigin::LeaseHue, None, Some(&[Hue])));
    gate.add_permits(2);

    assert_eq!(
        block_on(start).unwrap().unwrap().status.code,
        "OUTPUTS_APPLIED"
    );
    block_on(lease).unwrap().unwrap();
}

// ---------------------------------------------------------------------------
// Tickets: the newest request wins
// ---------------------------------------------------------------------------

#[test]
fn a_queued_off_supersedes_a_start_in_flight() {
    let rig = Rig::new(RigSetup::default());
    let gate = rig.hue.hold_starts();
    let start = spawn_apply(&rig, user(Some(ambilight(1.0)), Some(&[Usb, Hue])));
    wait_until("the start reached Hue", || rig.hue.starts_entered() == 1);
    let stop = spawn_apply(&rig, user(Some(off()), None));
    // The Off is queued behind the start's turn; the start has not resumed.
    std::thread::sleep(Duration::from_millis(50));
    gate.add_permits(1);

    let start = block_on(start).unwrap().unwrap();
    let stop = block_on(stop).unwrap().unwrap();

    assert_eq!(start.status.code, "OUTPUTS_SUPERSEDED");
    assert_eq!(stop.status.code, "OUTPUTS_APPLIED");
    assert!(stop.request_id > start.request_id);
    assert!(
        mode_events(&rig)
            .iter()
            .all(|e| !e.starts_with("mode:ambilight")),
        "{:?}",
        events(&rig)
    );
    assert!(
        has(&rig, "hue:stop:mode_control"),
        "the stream the start opened is given back"
    );
    assert_eq!(rig.running().kind, LightingModeKind::Off);
    assert!(rig.log.packets().is_empty());
    assert_eq!(rig.saved("lightingMode").unwrap()["kind"], json!("off"));
}

#[test]
fn an_unplug_behind_a_queued_start_still_drops_usb() {
    let rig = Rig::new(RigSetup::default());
    let gate = rig.hue.hold_starts();
    let first = spawn_apply(&rig, user(Some(ambilight(1.0)), Some(&[Usb, Hue])));
    wait_until("the start reached Hue", || rig.hue.starts_entered() == 1);
    let second = spawn_apply(&rig, user(Some(solid(9)), None));
    std::thread::sleep(Duration::from_millis(20));
    let unplug = spawn_apply(&rig, request(LightingOrigin::UsbUnplug, None, Some(&[Hue])));
    std::thread::sleep(Duration::from_millis(20));
    gate.add_permits(1);

    let first = block_on(first).unwrap().unwrap();
    let second = block_on(second).unwrap().unwrap();
    let unplug = block_on(unplug).unwrap().unwrap();

    assert_eq!(first.status.code, "OUTPUTS_SUPERSEDED");
    assert_eq!(second.status.code, "OUTPUTS_SUPERSEDED");
    assert_eq!(unplug.status.code, "OUTPUTS_APPLIED");
    assert_eq!(mode_events(&rig), vec!["mode:solid:hue"]);
    assert!(
        rig.log.packets().is_empty(),
        "the strip was written after it went away"
    );
    assert_eq!(unplug.snapshot.active_targets, vec![Hue]);
    // The choice the unplug overtook still ran, so it is saved — with the
    // targets the user chose, not the ones the cable left.
    let saved = rig.saved("lightingMode").unwrap();
    assert_eq!(saved["kind"], json!("solid"));
    assert_eq!(saved.get("targets"), None);
    assert_eq!(rig.saved("lastOutputTargets"), Some(json!(["usb", "hue"])));
}

// ---------------------------------------------------------------------------
// Retunes
// ---------------------------------------------------------------------------

fn ambilight_tuning(brightness: f32) -> LightingTuning {
    LightingTuning {
        solid: None,
        ambilight: Some(AmbilightPayload {
            brightness,
            ..AmbilightPayload::default()
        }),
    }
}

fn solid_tuning(r: u8) -> LightingTuning {
    LightingTuning {
        solid: Some(SolidColorPayload {
            r,
            g: 0,
            b: 0,
            brightness: 1.0,
        }),
        ambilight: None,
    }
}

#[test]
fn a_retune_never_waits_for_a_transition_or_the_runtime_lock() {
    let rig = Rig::new(RigSetup::default());
    running(&rig, ambilight(1.0), &[Usb]);
    let state = rig.state();
    let _turn = state.hold_transition_for_tests();

    let (locked_tx, locked_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel::<()>();
    let holder = &state;
    std::thread::scope(|scope| {
        scope.spawn(move || {
            let _runtime = holder.runtime.lock().unwrap();
            locked_tx.send(()).unwrap();
            let _ = release_rx.recv();
        });
        locked_rx.recv().unwrap();

        let (done_tx, done_rx) = mpsc::channel();
        let handle = rig.handle();
        std::thread::spawn(move || {
            let started = Instant::now();
            let code = block_on(retune_lighting(handle, ambilight_tuning(0.4)))
                .unwrap()
                .status
                .code;
            let _ = done_tx.send((code, started.elapsed()));
        });
        let answered = done_rx.recv_timeout(Duration::from_secs(1));
        release_tx.send(()).unwrap();

        let (code, elapsed) = answered.expect("the retune waited on a lock it must never take");
        assert_eq!(code, "RETUNE_APPLIED");
        assert!(elapsed < Duration::from_millis(100), "{elapsed:?}");
    });
    assert_eq!(state.tuning.accepting_brightness(), Some(0.4));
}

#[test]
fn a_drag_during_a_start_lands() {
    let rig = Rig::new(RigSetup::default());
    let gate = rig.hue.hold_starts();
    let start = spawn_apply(&rig, user(Some(ambilight(1.0)), Some(&[Usb, Hue])));
    wait_until("the start reached Hue", || rig.hue.starts_entered() == 1);

    assert_eq!(retune(&rig, ambilight_tuning(0.25)), "RETUNE_DEFERRED");
    gate.add_permits(1);
    assert_eq!(
        block_on(start).unwrap().unwrap().status.code,
        "OUTPUTS_APPLIED"
    );

    assert_eq!(rig.state().tuning.accepting_brightness(), Some(0.25));
}

/// A drag between the apply and the commit is replayed by the commit.
#[test]
fn a_drag_while_the_transaction_stops_hue_lands_on_the_new_worker() {
    let rig = Rig::new(RigSetup::default());
    running(&rig, ambilight(1.0), &[Usb, Hue]);
    let gate = rig.hue.hold_stops();
    let removal = spawn_apply(&rig, user(None, Some(&[Usb])));
    wait_until("the removal reached the Hue stop", || {
        rig.hue.stops_entered() == 1
    });

    assert_eq!(retune(&rig, ambilight_tuning(0.3)), "RETUNE_DEFERRED");
    gate.add_permits(1);
    block_on(removal).unwrap().unwrap();

    assert_eq!(rig.state().tuning.accepting_brightness(), Some(0.3));
}

#[test]
fn no_solid_packet_is_sent_after_off_begins() {
    let rig = Rig::new(RigSetup::default());
    running(&rig, solid(1), &[Usb]);
    let stop = Arc::new(AtomicBool::new(false));
    let late_answers = Arc::new(Mutex::new(Vec::new()));
    let off_returned = Arc::new(AtomicBool::new(false));

    let hammer = {
        let handle = rig.handle();
        let stop = Arc::clone(&stop);
        let late_answers = Arc::clone(&late_answers);
        let off_returned = Arc::clone(&off_returned);
        std::thread::spawn(move || {
            let mut step = 0u8;
            while !stop.load(Ordering::SeqCst) {
                step = step.wrapping_add(1);
                let after_off = off_returned.load(Ordering::SeqCst);
                let code = block_on(retune_lighting(handle.clone(), solid_tuning(step)))
                    .unwrap()
                    .status
                    .code;
                if after_off {
                    late_answers.lock().unwrap().push(code);
                }
            }
        })
    };
    wait_until("no retune reached the strip", || {
        rig.log.packets().len() >= 5
    });
    apply(&rig, user(Some(off()), None));
    off_returned.store(true, Ordering::SeqCst);
    std::thread::sleep(Duration::from_millis(60));
    stop.store(true, Ordering::SeqCst);
    hammer.join().unwrap();

    let late = packets_after(&rig, "mode:off:");
    // The strip gets the one black frame Off sends, and no colour after it.
    assert_eq!(
        late,
        vec![black_frame()],
        "{} packets after Off",
        late.len()
    );
    let answers = late_answers.lock().unwrap();
    assert!(!answers.is_empty());
    assert!(
        answers.iter().all(|code| code == "RETUNE_NOT_RUNNING"),
        "{answers:?}"
    );
}

#[test]
fn a_settled_retune_is_published_and_saved() {
    let rig = Rig::new(RigSetup::default());
    running(&rig, solid(1), &[Usb]);

    assert_eq!(retune(&rig, solid_tuning(77)), "RETUNE_APPLIED");

    assert_eq!(
        rig.state().snapshot.read().mode.solid.map(|s| s.r),
        Some(77)
    );
    wait_until("the retune was never saved", || {
        rig.saved("lightingMode")
            .is_some_and(|mode| mode["solid"]["r"] == json!(77))
    });
    assert_eq!(rig.saved("lightingMode").unwrap().get("targets"), None);
    assert_eq!(rig.saved("lastOutputTargets"), Some(json!(["usb"])));
}

#[test]
fn a_retune_of_the_wrong_kind_reaches_nothing() {
    let rig = Rig::new(RigSetup::default());
    running(&rig, ambilight(1.0), &[Usb]);
    assert_eq!(retune(&rig, solid_tuning(3)), "RETUNE_NOT_RUNNING");
    assert_eq!(
        retune(&rig, LightingTuning::default()),
        "RETUNE_NOT_RUNNING"
    );
}

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

#[test]
fn a_transaction_publishes_each_phase_with_increasing_revisions() {
    let rig = Rig::new(RigSetup::default());

    let result = apply(&rig, user(Some(ambilight(1.0)), Some(&[Usb, Hue])));

    let published = rig.published();
    let revisions: Vec<u64> = published
        .iter()
        .map(|s| s["revision"].as_u64().unwrap())
        .collect();
    assert!(revisions.windows(2).all(|w| w[0] < w[1]), "{revisions:?}");
    let phases: Vec<&str> = published
        .iter()
        .filter_map(|s| s["phase"].as_str())
        .collect();
    for phase in ["applying", "startingHue", "idle"] {
        assert!(
            phases.contains(&phase),
            "{phase} never published: {phases:?}"
        );
    }
    let last = published.last().unwrap();
    assert_eq!(last["phase"], json!("idle"));
    assert_eq!(last["requestId"], json!(result.request_id));
    assert_eq!(last["revision"].as_u64(), Some(result.snapshot.revision));
    assert_eq!(
        rig.state().snapshot.read().revision,
        result.snapshot.revision
    );
}

#[test]
fn the_old_mode_commands_publish_the_snapshot_too() {
    let rig = Rig::new(RigSetup::default());
    let handle = rig.handle();

    let result = set_lighting_mode_blocking(&handle, {
        let mut mode = solid(4);
        mode.targets = Some(vec!["usb".to_string()]);
        mode
    })
    .unwrap();
    assert_eq!(result.status.code, "SOLID_MODE_APPLIED");
    assert_eq!(
        rig.state().snapshot.read().mode.kind,
        LightingModeKind::Solid
    );

    stop_lighting_blocking(&handle).unwrap();
    assert_eq!(rig.state().snapshot.read().mode.kind, LightingModeKind::Off);
    assert!(rig.published().len() >= 2);
}

// ---------------------------------------------------------------------------
// Quit
// ---------------------------------------------------------------------------

#[test]
fn a_start_is_refused_under_the_runtime_lock_once_closing() {
    let rig = Rig::new(RigSetup::default());
    let handle = rig.handle();
    rig.state().mark_closing();

    let mut mode = solid(4);
    mode.targets = Some(vec!["usb".to_string()]);
    let refused = set_lighting_mode_blocking(&handle, mode).unwrap();

    assert_eq!(refused.status.code, "LIGHTING_MODE_SHUTTING_DOWN");
    assert_eq!(refused.mode.kind, LightingModeKind::Off);
    assert!(rig.log.packets().is_empty());
    let stopped = stop_lighting_blocking(&handle).unwrap();
    assert_eq!(
        stopped.status.code, "LIGHTING_MODE_STOPPED",
        "Off still runs"
    );
}

#[test]
fn quit_completes_while_a_start_waits_on_hue_and_nothing_starts_after() {
    let rig = Rig::new(RigSetup::default());
    let gate = rig.hue.hold_starts();
    let start = spawn_apply(&rig, user(Some(ambilight(1.0)), Some(&[Usb, Hue])));
    wait_until("the start reached Hue", || rig.hue.starts_entered() == 1);

    let began = Instant::now();
    run_cleanup(
        app_cleanup_steps(rig.app.handle()),
        &CleanupBudget {
            lighting: Duration::from_millis(1_500),
            hue_deadline: Duration::from_millis(3_300),
            hue_grace: Duration::from_millis(100),
        },
    );
    assert!(
        began.elapsed() < Duration::from_secs(2),
        "{:?}",
        began.elapsed()
    );

    gate.add_permits(1);
    let result = block_on(start).unwrap().unwrap();

    assert_eq!(result.status.code, "OUTPUTS_SHUTTING_DOWN");
    std::thread::sleep(Duration::from_millis(50));
    assert!(!rig.worker_running());
    assert_eq!(ACTIVE_AMBILIGHT_WORKERS.load(Ordering::SeqCst), 0);
    assert_eq!(rig.running().kind, LightingModeKind::Off);
    assert!(rig.log.packets().is_empty());
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

#[test]
fn a_boot_restore_counts_a_wled_sink_as_the_usb_output() {
    let rig = Rig::new(RigSetup {
        serial_connected: false,
        state: json!({
            "lightingMode": { "kind": "solid", "solid": { "r": 5, "g": 6, "b": 7, "brightness": 1 }, "targets": ["usb"] },
            "lastOutputTargets": ["usb"]
        }),
        ..RigSetup::default()
    });
    let receiver = std::net::UdpSocket::bind("127.0.0.1:0").unwrap();
    let config = WledSinkConfig {
        ip: "127.0.0.1".parse().unwrap(),
        port: receiver.local_addr().unwrap().port(),
        led_count: 59,
        protocol: WledProtocol::Drgb,
    };
    rig.app
        .state::<ActiveSinkRegistry>()
        .replace_wled(Box::new(config.build()), config);

    let result = apply(&rig, request(LightingOrigin::Boot, None, None));

    assert_eq!(result.status.code, "OUTPUTS_APPLIED");
    assert_eq!(result.snapshot.mode.kind, LightingModeKind::Solid);
    assert_eq!(result.snapshot.active_targets, vec![Usb]);
    assert!(rig.written_keys().is_empty(), "a restore saves nothing");
}

#[test]
fn a_boot_restore_without_a_strip_runs_on_hue_and_keeps_the_selection() {
    let rig = Rig::new(RigSetup {
        serial_connected: false,
        state: json!({
            "lightingMode": { "kind": "ambilight", "ambilight": { "brightness": 0.6 } },
            "lastOutputTargets": ["usb", "hue"]
        }),
        ..RigSetup::default()
    });

    let result = apply(&rig, request(LightingOrigin::Boot, None, None));

    assert_eq!(result.status.code, "OUTPUTS_APPLIED");
    assert_eq!(result.snapshot.active_targets, vec![Hue]);
    assert_eq!(result.snapshot.selected_targets, vec![Usb, Hue]);
    assert!(rig.written_keys().is_empty());
}

fn paused_runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_current_thread()
        .enable_time()
        .start_paused(true)
        .build()
        .unwrap()
}

#[test]
fn a_boot_restore_waits_out_a_held_area_and_resumes_once() {
    let rig = Rig::new(RigSetup {
        state: json!({
            "lightingMode": { "kind": "ambilight", "ambilight": { "brightness": 1 } },
            "lastOutputTargets": ["hue"]
        }),
        ..RigSetup::default()
    });
    rig.hue.script_starts(&["CONFIG_NOT_READY_GATE_BLOCKED"]);
    rig.hue.script_probes(&[
        HueAreaVerdict::Busy,
        HueAreaVerdict::Busy,
        HueAreaVerdict::Free,
    ]);
    let handle = rig.handle();

    paused_runtime().block_on(async {
        let restore = apply_outputs_with(&handle, request(LightingOrigin::Boot, None, None))
            .await
            .unwrap();
        assert_eq!(restore.status.code, "OUTPUTS_REFUSED");
        assert_eq!(restore.snapshot.mode.kind, LightingModeKind::Off);

        let deadline = Instant::now() + Duration::from_secs(10);
        while rig.running().kind != LightingModeKind::Ambilight {
            assert!(
                Instant::now() < deadline,
                "the restore never resumed: {:?}",
                events(&rig)
            );
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    });

    assert_eq!(rig.hue.probes_made(), 3);
    let waiting = rig
        .published()
        .iter()
        .any(|s| s["bootHueRetry"] == json!("waiting"));
    assert!(waiting, "the wait was never announced");
    assert_eq!(rig.state().snapshot.read().boot_hue_retry, None);
    assert_eq!(events(&rig).iter().filter(|e| *e == "hue:start").count(), 2);
}

#[test]
fn a_boot_restore_left_on_usb_adds_hue_back_once_the_area_frees() {
    let rig = Rig::new(RigSetup {
        state: json!({
            "lightingMode": { "kind": "ambilight", "ambilight": { "brightness": 1 } },
            "lastOutputTargets": ["usb", "hue"]
        }),
        ..RigSetup::default()
    });
    rig.hue.script_starts(&["CONFIG_NOT_READY_GATE_BLOCKED"]);
    rig.hue
        .script_probes(&[HueAreaVerdict::Busy, HueAreaVerdict::Free]);
    let handle = rig.handle();

    paused_runtime().block_on(async {
        let restore = apply_outputs_with(&handle, request(LightingOrigin::Boot, None, None))
            .await
            .unwrap();
        assert_eq!(restore.snapshot.active_targets, vec![Usb]);
        // The first probe decides the notice: by the gate code alone a held
        // area would read as an unreachable bridge.
        assert_ne!(
            restore.snapshot.hue_held_out_reason,
            Some(HueLeftOutReason::Unreachable)
        );

        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let snapshot = rig.state().snapshot.read();
            if snapshot.active_targets.contains(&Hue) && snapshot.phase == LightingPhase::Idle {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "Hue never joined: {:?}",
                events(&rig)
            );
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    });

    let busy_seen = rig
        .published()
        .iter()
        .any(|s| s["hueHeldOutReason"] == json!("busy"));
    assert!(busy_seen);
    let snapshot = rig.state().snapshot.read();
    assert_eq!(snapshot.hue_held_out_reason, None);
    assert_eq!(snapshot.selected_targets, vec![Usb, Hue]);
    assert!(rig.written_keys().is_empty(), "the rejoin is session-only");
}

/// A paused clock auto-advances whenever the runtime has nothing but timers to
/// run — including while a transaction awaits `spawn_blocking` on Tauri's own
/// runtime — so an unheld wait can burn its whole window in virtual time before
/// the choice below arrives. The probe is held at the door instead: a held
/// probe is not a timer, so the wait is still pending when the choice lands.
#[test]
fn a_user_choice_cancels_the_boot_wait() {
    let rig = Rig::new(RigSetup {
        state: json!({
            "lightingMode": { "kind": "ambilight", "ambilight": { "brightness": 1 } },
            "lastOutputTargets": ["hue"]
        }),
        ..RigSetup::default()
    });
    rig.hue.script_starts(&["CONFIG_NOT_READY_GATE_BLOCKED"]);
    rig.hue.script_probes(&[HueAreaVerdict::Busy; 20]);
    let probe_gate = rig.hue.hold_probes();
    let handle = rig.handle();

    paused_runtime().block_on(async {
        apply_outputs_with(&handle, request(LightingOrigin::Boot, None, None))
            .await
            .unwrap();
        while rig.hue.probes_made() == 0 {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        apply_outputs_with(&handle, user(Some(off()), None))
            .await
            .unwrap();
        // The held probe now answers busy; the wait must see the cancel.
        probe_gate.add_permits(20);
        tokio::time::sleep(BOOT_HUE_RETRY_WINDOW).await;
        assert_eq!(rig.hue.probes_made(), 1, "the wait kept polling");
    });
    assert_eq!(rig.state().snapshot.read().boot_hue_retry, None);
    assert!(
        !rig.published()
            .iter()
            .any(|s| s["bootHueRetry"] == json!("waiting")),
        "a cancelled wait still announced itself"
    );
    assert_eq!(rig.running().kind, LightingModeKind::Off);
}

/// The lag the paused clock produced on CI, forced: the wait gives up first,
/// and the user's choice still takes its notice down.
#[test]
fn a_user_choice_after_the_wait_gave_up_takes_its_notice_down() {
    let rig = Rig::new(RigSetup {
        state: json!({
            "lightingMode": { "kind": "ambilight", "ambilight": { "brightness": 1 } },
            "lastOutputTargets": ["hue"]
        }),
        ..RigSetup::default()
    });
    rig.hue.script_starts(&["CONFIG_NOT_READY_GATE_BLOCKED"]);
    rig.hue.script_probes(&[HueAreaVerdict::Busy; 20]);
    let handle = rig.handle();

    paused_runtime().block_on(async {
        apply_outputs_with(&handle, request(LightingOrigin::Boot, None, None))
            .await
            .unwrap();
        tokio::time::sleep(BOOT_HUE_RETRY_WINDOW + BOOT_HUE_RETRY_POLL).await;
        let deadline = Instant::now() + Duration::from_secs(10);
        while rig.state().snapshot.read().boot_hue_retry != Some(BootHueRetryState::GaveUp) {
            assert!(Instant::now() < deadline, "the wait never gave up");
            tokio::time::sleep(Duration::from_millis(500)).await;
        }

        apply_outputs_with(&handle, user(Some(off()), None))
            .await
            .unwrap();
    });
    assert_eq!(rig.state().snapshot.read().boot_hue_retry, None);
}

#[test]
fn a_boot_wait_that_times_out_says_so() {
    let rig = Rig::new(RigSetup {
        state: json!({
            "lightingMode": { "kind": "ambilight", "ambilight": { "brightness": 1 } },
            "lastOutputTargets": ["hue"]
        }),
        ..RigSetup::default()
    });
    rig.hue.script_starts(&["CONFIG_NOT_READY_GATE_BLOCKED"]);
    rig.hue.script_probes(&[HueAreaVerdict::Busy; 20]);
    let handle = rig.handle();

    paused_runtime().block_on(async {
        apply_outputs_with(&handle, request(LightingOrigin::Boot, None, None))
            .await
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        while rig.state().snapshot.read().boot_hue_retry != Some(BootHueRetryState::GaveUp) {
            assert!(Instant::now() < deadline, "the wait never gave up");
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
    });
    assert_eq!(rig.running().kind, LightingModeKind::Off);
}

// ---------------------------------------------------------------------------
// The area wait itself, on a paused clock
// ---------------------------------------------------------------------------

fn scripted(verdicts: &[HueAreaVerdict]) -> Mutex<VecDeque<HueAreaVerdict>> {
    Mutex::new(verdicts.iter().copied().collect())
}

#[tokio::test(start_paused = true)]
async fn the_area_wait_polls_until_the_area_frees() {
    use HueAreaVerdict::{Busy, Free};
    let token = CancelToken::default();
    let script = scripted(&[Busy, Busy, Busy, Free]);
    let busy = AtomicUsize::new(0);
    let started = tokio::time::Instant::now();

    let outcome = wait_for_area_release(
        || {
            let verdict = script.lock().unwrap().pop_front().unwrap();
            async move { verdict }
        },
        &token,
        || {
            busy.fetch_add(1, Ordering::SeqCst);
        },
        BOOT_HUE_RETRY_POLL,
        BOOT_HUE_RETRY_WINDOW,
    )
    .await;

    assert_eq!(outcome, ReleaseWait::Free);
    assert_eq!(busy.load(Ordering::SeqCst), 1, "the busy notice fires once");
    assert_eq!(started.elapsed(), BOOT_HUE_RETRY_POLL * 3);
}

#[tokio::test(start_paused = true)]
async fn the_area_wait_gives_up_inside_its_window() {
    let token = CancelToken::default();
    let probes = AtomicUsize::new(0);
    let started = tokio::time::Instant::now();

    let outcome = wait_for_area_release(
        || {
            probes.fetch_add(1, Ordering::SeqCst);
            async { HueAreaVerdict::Busy }
        },
        &token,
        || {},
        BOOT_HUE_RETRY_POLL,
        BOOT_HUE_RETRY_WINDOW,
    )
    .await;

    assert_eq!(outcome, ReleaseWait::Timeout);
    assert_eq!(probes.load(Ordering::SeqCst), 9);
    assert!(started.elapsed() <= BOOT_HUE_RETRY_WINDOW);
}

#[tokio::test(start_paused = true)]
async fn the_area_wait_stops_at_an_answer_waiting_cannot_clear() {
    let token = CancelToken::default();
    let busy = AtomicUsize::new(0);

    let outcome = wait_for_area_release(
        || async { HueAreaVerdict::Other },
        &token,
        || {
            busy.fetch_add(1, Ordering::SeqCst);
        },
        BOOT_HUE_RETRY_POLL,
        BOOT_HUE_RETRY_WINDOW,
    )
    .await;

    assert_eq!(outcome, ReleaseWait::NotBusy);
    assert_eq!(busy.load(Ordering::SeqCst), 0);

    let silent = wait_for_area_release(
        || async { HueAreaVerdict::Unreachable },
        &token,
        || {},
        BOOT_HUE_RETRY_POLL,
        BOOT_HUE_RETRY_WINDOW,
    )
    .await;
    assert_eq!(
        silent,
        ReleaseWait::Unreachable,
        "a silent bridge is not polled"
    );
}

#[tokio::test(start_paused = true)]
async fn a_cancelled_area_wait_stops_mid_sleep() {
    let token = Arc::new(CancelToken::default());
    let canceller = Arc::clone(&token);
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_secs(4)).await;
        canceller.cancel();
    });
    let started = tokio::time::Instant::now();

    let outcome = wait_for_area_release(
        || async { HueAreaVerdict::Busy },
        &token,
        || {},
        BOOT_HUE_RETRY_POLL,
        BOOT_HUE_RETRY_WINDOW,
    )
    .await;

    assert_eq!(outcome, ReleaseWait::Cancelled);
    assert_eq!(started.elapsed(), Duration::from_secs(4));
}

// ---------------------------------------------------------------------------
// The launch's wait for a strip
// ---------------------------------------------------------------------------

fn restoring(targets: serde_json::Value) -> Rig {
    Rig::new(RigSetup {
        serial_connected: false,
        state: json!({
            "lightingMode": { "kind": "solid", "solid": { "r": 5, "g": 6, "b": 7, "brightness": 1 } },
            "lastOutputTargets": targets
        }),
        ..RigSetup::default()
    })
}

fn strip_connects(rig: &Rig) {
    rig.set_serial_connected(true);
    note_local_sink_connected(&rig.handle());
}

/// Auto-reconnect is still settling the strip when the restore runs; the
/// restore used to end Off and stay there.
#[test]
fn a_restore_that_found_no_strip_resumes_on_it_once_it_connects() {
    let rig = restoring(json!(["usb"]));

    let restore = apply(&rig, request(LightingOrigin::Boot, None, None));
    assert_eq!(restore.snapshot.mode.kind, LightingModeKind::Off);

    strip_connects(&rig);

    wait_until("the restore never resumed on the strip", || {
        rig.state().snapshot.read().mode.kind == LightingModeKind::Solid
    });
    assert_eq!(rig.state().snapshot.read().active_targets, vec![Usb]);
    assert!(rig.written_keys().is_empty(), "a resume saves nothing");
}

#[test]
fn a_restore_running_on_hue_adds_the_strip_once_it_connects() {
    let rig = restoring(json!(["usb", "hue"]));

    let restore = apply(&rig, request(LightingOrigin::Boot, None, None));
    assert_eq!(restore.snapshot.active_targets, vec![Hue]);

    strip_connects(&rig);

    wait_until("the strip never joined", || {
        let snapshot = rig.state().snapshot.read();
        snapshot.active_targets == vec![Usb, Hue] && snapshot.phase == LightingPhase::Idle
    });
    assert_eq!(
        events(&rig).iter().filter(|e| *e == "hue:start").count(),
        1,
        "the stream is kept, not restarted: {:?}",
        events(&rig)
    );
}

#[test]
fn a_choice_made_before_the_strip_connects_ends_the_wait() {
    let rig = restoring(json!(["usb"]));
    apply(&rig, request(LightingOrigin::Boot, None, None));
    apply(&rig, user(None, Some(&[Usb])));

    strip_connects(&rig);

    std::thread::sleep(Duration::from_millis(200));
    assert!(mode_events(&rig).is_empty(), "{:?}", events(&rig));
    assert_eq!(rig.running().kind, LightingModeKind::Off);
}

#[test]
fn a_strip_that_connects_after_the_wait_starts_nothing() {
    let rig = restoring(json!(["usb"]));
    apply(&rig, request(LightingOrigin::Boot, None, None));
    rig.state().outputs.lapse_boot_sink_wait();

    strip_connects(&rig);

    std::thread::sleep(Duration::from_millis(200));
    assert!(mode_events(&rig).is_empty(), "{:?}", events(&rig));
}

// ---------------------------------------------------------------------------
// The saved Hue area moves the stream
// ---------------------------------------------------------------------------

#[test]
fn a_new_saved_area_moves_the_running_stream_to_it() {
    let rig = Rig::new(RigSetup::default());
    running(&rig, ambilight(1.0), &[Hue]);
    rig.seed(json!({ "lastHueAreaId": "area-2" }));

    let result = block_on(refresh_running_with(&rig.handle()))
        .unwrap()
        .expect("a mode runs");

    assert_eq!(result.status.code, "OUTPUTS_APPLIED");
    assert!(
        order(&rig, "hue:stop:system", "hue:start"),
        "{:?}",
        events(&rig)
    );
    assert_eq!(rig.hue.start_areas(), vec!["area-1", "area-2"]);
    assert_eq!(rig.hue.live_area().as_deref(), Some("area-2"));
    assert_eq!(result.snapshot.active_targets, vec![Hue]);
    assert_eq!(rig.running().kind, LightingModeKind::Ambilight);
}

#[test]
fn a_mode_choice_runs_on_the_saved_area_not_the_live_one() {
    let rig = Rig::new(RigSetup::default());
    running(&rig, solid(1), &[Hue]);
    rig.seed(json!({ "lastHueAreaId": "area-2" }));

    let result = apply(&rig, user(Some(ambilight(1.0)), None));

    assert_eq!(result.status.code, "OUTPUTS_APPLIED");
    assert_eq!(rig.hue.live_area().as_deref(), Some("area-2"));
    assert_eq!(result.snapshot.active_targets, vec![Hue]);
}

#[test]
fn a_move_the_new_area_refuses_leaves_the_mode_on_the_strip() {
    let rig = Rig::new(RigSetup::default());
    running(&rig, ambilight(1.0), &[Usb, Hue]);
    rig.seed(json!({ "lastHueAreaId": "area-2" }));
    rig.hue.script_start_with_details(
        "CONFIG_NOT_READY_GATE_BLOCKED",
        "Missing prerequisites: ready; readiness: HUE_STREAM_NOT_READY, HUE_STREAM_NOT_READY_ACTIVE_STREAMER",
    );

    let result = block_on(refresh_running_with(&rig.handle()))
        .unwrap()
        .expect("a mode runs");

    assert_eq!(result.status.code, "OUTPUTS_APPLIED_PARTIAL");
    assert_eq!(result.outcome.hue_left_out, Some(HueLeftOutReason::InUse));
    assert_eq!(result.snapshot.active_targets, vec![Usb]);
    assert!(!rig.hue.streaming());
}

// ---------------------------------------------------------------------------
// A refused choice says why
// ---------------------------------------------------------------------------

#[test]
fn a_choice_with_the_strip_missing_runs_on_hue_and_drops_the_strip() {
    let rig = Rig::new(RigSetup {
        serial_connected: false,
        ..RigSetup::default()
    });

    let result = apply(&rig, user(Some(ambilight(1.0)), Some(&[Usb, Hue])));

    assert_eq!(result.status.code, "OUTPUTS_APPLIED_PARTIAL");
    assert_eq!(result.snapshot.active_targets, vec![Hue]);
    assert_eq!(result.outcome.dropped_targets, vec![Usb]);
    assert_eq!(result.snapshot.selected_targets, vec![Hue]);
    let saved = rig.saved("lightingMode").expect("the mode was saved");
    assert_eq!(saved.get("targets"), None);
    assert_eq!(
        rig.saved("lastOutputTargets"),
        Some(json!(["usb", "hue"])),
        "only the session drops it"
    );
}

fn hue_only_refusal(code: &'static str, details: &'static str) -> ApplyOutputsResult {
    let rig = Rig::new(RigSetup::default());
    rig.hue.script_start_with_details(code, details);
    apply(&rig, user(Some(ambilight(1.0)), Some(&[Hue])))
}

#[test]
fn a_hue_only_choice_hue_refused_names_the_reason() {
    let cases = [
        (
            "CONFIG_NOT_READY_GATE_BLOCKED",
            "Missing prerequisites: ready; readiness: HUE_STREAM_NOT_READY, HUE_STREAM_NOT_READY_ACTIVE_STREAMER",
            HueLeftOutReason::InUse,
        ),
        (
            "CONFIG_NOT_READY_GATE_BLOCKED",
            "Missing prerequisites: readiness; readiness: HUE_STREAM_READINESS_FAILED",
            HueLeftOutReason::Unreachable,
        ),
        (
            "CONFIG_NOT_READY_GATE_BLOCKED",
            "Missing prerequisites: ready; readiness: HUE_STREAM_NOT_READY",
            HueLeftOutReason::NoLights,
        ),
        (
            "AUTH_INVALID_CREDENTIALS",
            "Bridge returned explicit auth-invalid evidence.",
            HueLeftOutReason::Auth,
        ),
    ];
    for (code, details, reason) in cases {
        let result = hue_only_refusal(code, details);
        assert_eq!(result.status.code, "OUTPUTS_REFUSED", "{code} {details}");
        assert_eq!(result.outcome.hue_not_started, Some(reason), "{details}");
        assert_eq!(result.outcome.hue_left_out, None);
    }
}

#[test]
fn a_hue_only_choice_without_a_bridge_says_not_set_up() {
    let rig = Rig::new(RigSetup {
        hue_paired: false,
        ..RigSetup::default()
    });

    let result = apply(&rig, user(Some(ambilight(1.0)), Some(&[Hue])));

    assert_eq!(
        result.outcome.hue_not_started,
        Some(HueLeftOutReason::Config)
    );
}

#[test]
fn an_area_another_app_holds_is_named_when_hue_is_left_out() {
    let rig = Rig::new(RigSetup::default());
    rig.hue.script_start_with_details(
        "CONFIG_NOT_READY_GATE_BLOCKED",
        "Missing prerequisites: ready; readiness: HUE_STREAM_NOT_READY, HUE_STREAM_NOT_READY_ACTIVE_STREAMER",
    );

    let result = apply(&rig, user(Some(ambilight(1.0)), Some(&[Usb, Hue])));

    assert_eq!(result.snapshot.active_targets, vec![Usb]);
    assert_eq!(result.outcome.hue_left_out, Some(HueLeftOutReason::InUse));
    assert_eq!(result.outcome.hue_not_started, None);
}

// ---------------------------------------------------------------------------
// The launch's wait for the bridge — autostart before Wi-Fi is up
// ---------------------------------------------------------------------------

/// What the start gate answers when readiness could not reach the bridge.
const BRIDGE_SILENT: &str =
    "Missing prerequisites: readiness; readiness: HUE_STREAM_READINESS_FAILED";

fn restoring_on(targets: serde_json::Value, serial_connected: bool) -> Rig {
    Rig::new(RigSetup {
        serial_connected,
        state: json!({
            "lightingMode": { "kind": "ambilight", "ambilight": { "brightness": 1 } },
            "lastOutputTargets": targets
        }),
        ..RigSetup::default()
    })
}

fn hue_starts(rig: &Rig) -> usize {
    events(rig).iter().filter(|e| *e == "hue:start").count()
}

/// The start gate refused and the area wait's first probe found the bridge
/// silent. The wait used to read that as "not busy" and give up for good, so
/// a Hue-only setup stayed Off until the user chose again.
#[test]
fn a_hue_only_restore_resumes_once_the_bridge_answers() {
    let rig = restoring_on(json!(["hue"]), true);
    rig.hue
        .script_start_with_details("CONFIG_NOT_READY_GATE_BLOCKED", BRIDGE_SILENT);
    rig.hue.script_probes(&[HueAreaVerdict::Unreachable]);
    let handle = rig.handle();

    paused_runtime().block_on(async {
        let restore = apply_outputs_with(&handle, request(LightingOrigin::Boot, None, None))
            .await
            .unwrap();
        assert_eq!(restore.snapshot.mode.kind, LightingModeKind::Off);
        while rig.hue.probes_made() == 0 {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        // The park polls nothing: the wait ended at the silent probe.
        tokio::time::sleep(BOOT_HUE_RETRY_WINDOW * 2).await;
    });
    assert_eq!(rig.hue.probes_made(), 1);
    assert_eq!(rig.running().kind, LightingModeKind::Off);

    note_hue_reachable(&handle, false);
    note_hue_reachable(&handle, true);

    wait_until("the restore never resumed on Hue", || {
        let snapshot = rig.state().snapshot.read();
        snapshot.mode.kind == LightingModeKind::Ambilight && snapshot.phase == LightingPhase::Idle
    });
    assert_eq!(rig.state().snapshot.read().active_targets, vec![Hue]);
    assert!(rig.written_keys().is_empty(), "a resume saves nothing");

    // Once per launch: the next reachable edge finds nothing parked.
    apply(&rig, user(Some(off()), None));
    note_hue_reachable(&handle, false);
    note_hue_reachable(&handle, true);
    std::thread::sleep(Duration::from_millis(100));
    assert_eq!(hue_starts(&rig), 2, "{:?}", events(&rig));
}

/// A start that failed outright for a silent bridge parks without the area
/// wait; `[usb, hue]` has run on USB alone since, and Hue joins it.
#[test]
fn a_restore_left_on_usb_rejoins_hue_once_the_bridge_answers() {
    let rig = restoring_on(json!(["usb", "hue"]), true);
    rig.hue.script_starts(&["TRANSIENT_RETRY_SCHEDULED"]);

    let restore = apply(&rig, request(LightingOrigin::Boot, None, None));
    assert_eq!(restore.snapshot.active_targets, vec![Usb]);
    assert_eq!(
        restore.snapshot.hue_held_out_reason,
        Some(HueLeftOutReason::Unreachable)
    );

    // A probe still in flight carries the old verdict; nothing fires on it.
    note_hue_reachable(&rig.handle(), false);
    std::thread::sleep(Duration::from_millis(50));
    assert_eq!(hue_starts(&rig), 1);

    note_hue_reachable(&rig.handle(), true);

    wait_until("Hue never joined", || {
        let snapshot = rig.state().snapshot.read();
        snapshot.active_targets == vec![Usb, Hue] && snapshot.phase == LightingPhase::Idle
    });
    let snapshot = rig.state().snapshot.read();
    assert_eq!(snapshot.hue_held_out_reason, None);
    assert_eq!(snapshot.selected_targets, vec![Usb, Hue]);
    assert!(rig.written_keys().is_empty());
}

#[test]
fn a_user_choice_takes_the_parked_resume_back() {
    let rig = restoring_on(json!(["hue"]), true);
    rig.hue.script_starts(&["TRANSIENT_RETRY_SCHEDULED"]);
    apply(&rig, request(LightingOrigin::Boot, None, None));

    // The user chose Off while the bridge was away; its answer must not light
    // the room back up.
    apply(&rig, user(Some(off()), None));
    rig.log.clear();
    note_hue_reachable(&rig.handle(), true);

    std::thread::sleep(Duration::from_millis(150));
    assert!(events(&rig).is_empty(), "{:?}", events(&rig));
    assert_eq!(rig.running().kind, LightingModeKind::Off);
}

#[test]
fn a_forgotten_bridge_or_a_quit_takes_the_parked_resume_back() {
    use crate::commands::shell_state::ShellStateStore;

    let forgotten = restoring_on(json!(["hue"]), true);
    forgotten.hue.script_starts(&["TRANSIENT_RETRY_SCHEDULED"]);
    apply(&forgotten, request(LightingOrigin::Boot, None, None));
    forgotten
        .app
        .state::<ShellStateStore>()
        .patch(
            serde_json::Map::new(),
            vec!["lastHueBridge".to_string()],
            None,
            |_| {},
        )
        .unwrap();
    note_settings_saved(&forgotten.handle(), ["lastHueBridge"]);
    std::thread::sleep(Duration::from_millis(100));
    note_hue_reachable(&forgotten.handle(), true);
    std::thread::sleep(Duration::from_millis(150));
    assert_eq!(hue_starts(&forgotten), 1, "{:?}", events(&forgotten));
    // One rig at a time: each holds the process-wide worker guard.
    drop(forgotten);

    let quitting = restoring_on(json!(["hue"]), true);
    quitting.hue.script_starts(&["TRANSIENT_RETRY_SCHEDULED"]);
    apply(&quitting, request(LightingOrigin::Boot, None, None));
    quitting.state().mark_closing();
    note_hue_reachable(&quitting.handle(), true);
    std::thread::sleep(Duration::from_millis(150));
    assert_eq!(hue_starts(&quitting), 1, "{:?}", events(&quitting));
}

/// Both late at login: the strip still settling and the bridge not on the
/// network yet. The strip's resume leaves Hue to the bridge's, which adds it
/// beside the strip; neither wait knows about the other's order.
#[test]
fn a_restore_with_both_outputs_late_gets_both_back_in_either_order() {
    // The strip first.
    let rig = restoring_on(json!(["usb", "hue"]), false);
    rig.hue.script_starts(&["TRANSIENT_RETRY_SCHEDULED"]);
    let restore = apply(&rig, request(LightingOrigin::Boot, None, None));
    assert_eq!(restore.snapshot.mode.kind, LightingModeKind::Off);

    rig.set_serial_connected(true);
    note_local_sink_connected(&rig.handle());
    wait_until("the strip never resumed", || {
        let snapshot = rig.state().snapshot.read();
        snapshot.active_targets == vec![Usb] && snapshot.phase == LightingPhase::Idle
    });
    assert_eq!(hue_starts(&rig), 1, "the strip's resume left Hue alone");

    note_hue_reachable(&rig.handle(), true);
    wait_until("Hue never joined the strip", || {
        let snapshot = rig.state().snapshot.read();
        snapshot.active_targets == vec![Usb, Hue] && snapshot.phase == LightingPhase::Idle
    });
    assert_eq!(rig.running().kind, LightingModeKind::Ambilight);
    // One rig at a time: each holds the process-wide worker guard.
    drop(rig);

    // The bridge first.
    let rig = restoring_on(json!(["usb", "hue"]), false);
    rig.hue.script_starts(&["TRANSIENT_RETRY_SCHEDULED"]);
    apply(&rig, request(LightingOrigin::Boot, None, None));

    note_hue_reachable(&rig.handle(), true);
    wait_until("the restore never resumed on Hue", || {
        let snapshot = rig.state().snapshot.read();
        snapshot.active_targets == vec![Hue] && snapshot.phase == LightingPhase::Idle
    });

    rig.set_serial_connected(true);
    note_local_sink_connected(&rig.handle());
    wait_until("the strip never joined Hue", || {
        let snapshot = rig.state().snapshot.read();
        snapshot.active_targets == vec![Usb, Hue] && snapshot.phase == LightingPhase::Idle
    });
    assert_eq!(hue_starts(&rig), 2, "{:?}", events(&rig));
}

/// The monitor's own event is what answers the park: a probe in flight is
/// not an answer, the probe's answer is.
#[test]
fn the_health_event_answers_the_parked_resume() {
    use crate::events::HUE_HEALTH_CHANGED_EVENT;
    use tauri::Emitter;

    let rig = restoring_on(json!(["hue"]), true);
    rig.hue.script_starts(&["TRANSIENT_RETRY_SCHEDULED"]);
    listen_hue_health(&rig.handle());
    apply(&rig, request(LightingOrigin::Boot, None, None));
    let health = |verdict: &str, probing: bool| {
        json!({
            "revision": 1,
            "configured": true,
            "bridge": { "verdict": verdict, "probing": probing, "gaveUp": false },
            "area": null,
            "stream": { "active": false, "status": {} }
        })
    };

    rig.app
        .emit(HUE_HEALTH_CHANGED_EVENT, health("unreachable", false))
        .unwrap();
    rig.app
        .emit(HUE_HEALTH_CHANGED_EVENT, health("reachable", true))
        .unwrap();
    std::thread::sleep(Duration::from_millis(100));
    assert_eq!(hue_starts(&rig), 1);

    rig.app
        .emit(HUE_HEALTH_CHANGED_EVENT, health("reachable", false))
        .unwrap();
    wait_until("the event never resumed the restore", || {
        rig.state().snapshot.read().active_targets == vec![Hue]
    });
}

#[test]
fn forgetting_the_bridge_takes_the_parked_resume_back() {
    use crate::commands::hue::credential_store::NoopStore;
    use crate::commands::hue::forget::forget_hue_bridge_with;

    let rig = restoring_on(json!(["hue"]), true);
    rig.hue.script_starts(&["TRANSIENT_RETRY_SCHEDULED"]);
    apply(&rig, request(LightingOrigin::Boot, None, None));

    let status = block_on(forget_hue_bridge_with(
        &rig.handle(),
        "abc",
        &NoopStore::new(),
    ));
    assert!(status.code.starts_with("HUE_FORGET_"), "{status:?}");
    rig.log.clear();

    note_hue_reachable(&rig.handle(), true);

    std::thread::sleep(Duration::from_millis(150));
    assert!(events(&rig).is_empty(), "{:?}", events(&rig));
    assert_eq!(rig.running().kind, LightingModeKind::Off);
}

// ---------------------------------------------------------------------------
// The launch's wait for the bridge, against the real health monitor
// ---------------------------------------------------------------------------

mod bridge_wait {
    use std::collections::VecDeque;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    use serde_json::json;
    use tauri::Manager;

    use super::super::outputs::{apply_outputs_with, listen_hue_health, note_hue_reachable};
    use super::super::snapshot::{BootHueRetryState, LightingPhase, OutputTarget::Hue};
    use super::super::test_support::Rig;
    use super::{hue_starts, off, paused_runtime, request, restoring_on, user, wait_until};
    use super::{LightingModeKind, LightingOrigin};
    use crate::commands::hue::health::{
        HealthBackend, HealthFuture, HueHealthMonitor, HueHealthTarget, HueStreamHealth, StreamRead,
    };
    use crate::commands::hue::state_store::HueRuntimeOwner;
    use crate::commands::hue_onboarding::{
        HueStreamReadiness, HueStreamReadinessResponse, HueValidateCredentialsResponse,
    };
    use crate::commands::status::CommandStatus;

    const SILENT: &str = "HUE_CREDENTIAL_CHECK_FAILED";
    const ANSWERS: &str = "HUE_CREDENTIAL_VALID";

    /// A bridge that answers each probe from a script, then `ANSWERS`.
    struct Bridge {
        probes: AtomicUsize,
        script: Mutex<VecDeque<&'static str>>,
    }

    impl Bridge {
        fn new(script: &[&'static str]) -> Arc<Self> {
            Arc::new(Self {
                probes: AtomicUsize::new(0),
                script: Mutex::new(script.iter().copied().collect()),
            })
        }

        fn probes(&self) -> usize {
            self.probes.load(Ordering::SeqCst)
        }
    }

    impl HealthBackend for Bridge {
        fn target(&self) -> Option<HueHealthTarget> {
            Some(HueHealthTarget {
                bridge_ip: "192.168.1.50".to_string(),
                username: String::new(),
                area_id: "area-1".to_string(),
            })
        }
        fn stream(&self, _bridge_check: bool) -> HealthFuture<'_, StreamRead> {
            Box::pin(async {
                StreamRead {
                    health: HueStreamHealth {
                        active: false,
                        status: HueRuntimeOwner::default().last_status,
                    },
                    stream_area: None,
                    readiness: None,
                }
            })
        }
        fn validate(
            &self,
            _target: HueHealthTarget,
        ) -> HealthFuture<'_, HueValidateCredentialsResponse> {
            Box::pin(async {
                self.probes.fetch_add(1, Ordering::SeqCst);
                let code = self.script.lock().unwrap().pop_front().unwrap_or(ANSWERS);
                HueValidateCredentialsResponse {
                    status: CommandStatus::new(code, "probe", None),
                    valid: code == ANSWERS,
                }
            })
        }
        fn readiness(
            &self,
            _target: HueHealthTarget,
        ) -> HealthFuture<'_, HueStreamReadinessResponse> {
            Box::pin(async {
                HueStreamReadinessResponse {
                    status: CommandStatus::new("HUE_STREAM_READY", "ready", None),
                    readiness: HueStreamReadiness {
                        ready: true,
                        reasons: Vec::new(),
                    },
                }
            })
        }
        fn wall_clock_ms(&self) -> u64 {
            0
        }
    }

    /// A Hue-only restore at login, with the monitor managed the way `lib.rs`
    /// manages it and publishing into the app. No window ever watches.
    fn tray_launch(script: &[&'static str]) -> (Rig, Arc<Bridge>, HueHealthMonitor) {
        let rig = restoring_on(json!(["hue"]), true);
        rig.hue.script_starts(&["TRANSIENT_RETRY_SCHEDULED"]);
        listen_hue_health(&rig.handle());
        let bridge = Bridge::new(script);
        let monitor = HueHealthMonitor::new(bridge.clone(), Arc::new(rig.handle()));
        rig.app.manage(monitor.clone());
        (rig, bridge, monitor)
    }

    fn resumed_on_hue(rig: &Rig) -> bool {
        let snapshot = rig.state().snapshot.read();
        snapshot.active_targets == vec![Hue] && snapshot.phase == LightingPhase::Idle
    }

    /// Passes of the monitor over `span` of paused time, one `step` apart.
    async fn run_for(monitor: &HueHealthMonitor, span: Duration, step: Duration) {
        let mut elapsed = Duration::ZERO;
        while elapsed < span {
            monitor.run_once().await;
            tokio::time::advance(step).await;
            elapsed += step;
        }
    }

    /// Autostart before Wi-Fi is up: the launch probe finds the bridge silent
    /// and no window ever shows. The park's own bounded probing asks until the
    /// bridge answers, the restore resumes once, and hidden traffic is zero again.
    #[test]
    fn a_silent_launch_probe_is_followed_by_hidden_probes_until_the_bridge_answers() {
        let (rig, bridge, monitor) = tray_launch(&[SILENT, SILENT, SILENT]);
        let handle = rig.handle();

        paused_runtime().block_on(async {
            monitor.run_once().await;
            assert_eq!(bridge.probes(), 1, "the launch probe");
            apply_outputs_with(&handle, request(LightingOrigin::Boot, None, None))
                .await
                .unwrap();

            let mut passes = 0;
            while !resumed_on_hue(&rig) {
                assert!(passes < 40, "the restore never resumed");
                monitor.run_once().await;
                tokio::time::advance(Duration::from_secs(5)).await;
                std::thread::sleep(Duration::from_millis(20));
                passes += 1;
            }
            // Two more silent probes, then the one that answered.
            assert_eq!(bridge.probes(), 4);

            // The resume clears the park off the publishing thread.
            std::thread::sleep(Duration::from_millis(100));
            run_for(&monitor, Duration::from_secs(600), Duration::from_secs(15)).await;
        });
        assert_eq!(bridge.probes(), 4, "hidden probing outlived the resume");
        assert_eq!(hue_starts(&rig), 2);
    }

    /// The reverse race: the launch probe already said the bridge answers
    /// when the restore parks. No edge will come, so the park fires at once.
    #[test]
    fn a_bridge_that_already_answers_resumes_the_park_at_once() {
        let (rig, bridge, monitor) = tray_launch(&[]);
        tauri::async_runtime::block_on(monitor.run_once());
        assert_eq!(bridge.probes(), 1);

        let restore = tauri::async_runtime::block_on(apply_outputs_with(
            &rig.handle(),
            request(LightingOrigin::Boot, None, None),
        ))
        .unwrap();
        assert_eq!(restore.snapshot.mode.kind, LightingModeKind::Off);

        wait_until("the park never fired", || resumed_on_hue(&rig));
        assert_eq!(bridge.probes(), 1, "no probe was needed");
        note_hue_reachable(&rig.handle(), false);
        note_hue_reachable(&rig.handle(), true);
        std::thread::sleep(Duration::from_millis(100));
        assert_eq!(hue_starts(&rig), 2, "once per launch");
    }

    #[test]
    fn a_choice_during_the_wait_stops_the_hidden_probing() {
        let (rig, bridge, monitor) = tray_launch(&[SILENT; 40]);
        let handle = rig.handle();

        paused_runtime().block_on(async {
            monitor.run_once().await;
            apply_outputs_with(&handle, request(LightingOrigin::Boot, None, None))
                .await
                .unwrap();
            run_for(&monitor, Duration::from_secs(10), Duration::from_secs(5)).await;
            let before = bridge.probes();
            assert!(before > 1, "the park probed nothing");

            apply_outputs_with(&handle, user(Some(off()), None))
                .await
                .unwrap();
            run_for(&monitor, Duration::from_secs(600), Duration::from_secs(5)).await;
            assert_eq!(bridge.probes(), before, "probing outlived the cancel");
        });
    }

    /// The bridge never answers: the park gives up, says so the way the area
    /// wait does, and the probing stops with it.
    #[test]
    fn a_park_whose_bridge_never_answers_gives_up_and_stops_probing() {
        let (rig, bridge, monitor) = tray_launch(&[SILENT; 400]);
        rig.state()
            .outputs
            .set_boot_hue_park_window(Duration::from_millis(200));
        let handle = rig.handle();

        paused_runtime().block_on(async {
            monitor.run_once().await;
            apply_outputs_with(&handle, request(LightingOrigin::Boot, None, None))
                .await
                .unwrap();
            wait_until("the park never gave up", || {
                rig.state().snapshot.read().boot_hue_retry == Some(BootHueRetryState::GaveUp)
            });
            let before = bridge.probes();
            run_for(&monitor, Duration::from_secs(600), Duration::from_secs(5)).await;
            assert_eq!(bridge.probes(), before, "probing outlived the give-up");
        });
        assert_eq!(hue_starts(&rig), 1);
    }

    /// A test pattern borrows Hue. Against a bridge the monitor already found
    /// silent the start is skipped rather than sat out, so the pattern and its
    /// Stop do not wait on the bridge's timeouts; a bridge that answers still
    /// gets its start.
    #[test]
    fn a_test_lease_skips_a_bridge_the_monitor_found_silent() {
        for (script, starts, left_out) in [
            (SILENT, 0, Some(super::HueLeftOutReason::Unreachable)),
            (ANSWERS, 1, None),
        ] {
            let rig = Rig::new(super::RigSetup::default());
            let bridge = Bridge::new(&[script]);
            let monitor = HueHealthMonitor::new(bridge.clone(), Arc::new(rig.handle()));
            rig.app.manage(monitor.clone());
            let handle = rig.handle();

            let result = paused_runtime().block_on(async {
                monitor.run_once().await;
                apply_outputs_with(
                    &handle,
                    request(LightingOrigin::LeaseHue, None, Some(&[Hue])),
                )
                .await
                .unwrap()
            });

            assert_eq!(hue_starts(&rig), starts, "{script}");
            assert_eq!(result.outcome.hue_left_out, left_out, "{script}");
        }
    }
}
