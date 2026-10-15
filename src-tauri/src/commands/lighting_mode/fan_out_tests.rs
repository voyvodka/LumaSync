//! An Ambilight run driving every strip of its set: what each strip is sent, which ports the run
//! holds, what an Off or a Solid blanks, and when a retune keeps the run.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use serde_json::json;

use super::runtime::LightingRuntimeOwner;
use super::strip_set::resolve_strips;
use super::transition::{apply_mode_change, stop_previous};
use super::usb_output::{ActiveStrip, SolidUsbOutput, UsbOutputPlan};
use super::{
    AmbilightPayload, LightingModeConfig, LightingModeKind, SolidColorPayload, WORKER_TEST_GUARD,
};
use crate::commands::ambilight_capture::{
    AmbilightCaptureError, AmbilightFrameSource, CapturedFrame,
};
use crate::commands::led_calibration::{LedCalibrationConfig, LedSegmentCounts};
use crate::commands::led_output::{
    LedColorOrder, LedOutputBridge, LedOutputError, LedPacketSender,
};
use crate::commands::local_outputs::DrivenLocal;
use crate::commands::runtime_telemetry::SharedRuntimeTelemetry;
use crate::models::led_strips::{LedStrip, StripHardware, StripTransport};

#[derive(Default)]
struct Recorder {
    writes: Mutex<Vec<(String, Vec<u8>)>>,
    disconnected: Mutex<Vec<String>>,
    /// A port whose every write fails.
    failing: Mutex<Option<String>>,
}

impl Recorder {
    fn to(&self, port: &str) -> Vec<Vec<u8>> {
        let writes = self.writes.lock().unwrap();
        writes
            .iter()
            .filter(|(p, _)| p == port)
            .map(|(_, packet)| packet.clone())
            .collect()
    }
    fn clear(&self) {
        self.writes.lock().unwrap().clear();
    }
}

impl LedPacketSender for Recorder {
    fn send(&self, port_name: &str, packet: &[u8]) -> Result<(), LedOutputError> {
        if self.failing.lock().unwrap().as_deref() == Some(port_name) {
            return Err(LedOutputError {
                code: "LED_OUTPUT_WRITE_FAILED",
                details: None,
            });
        }
        self.writes
            .lock()
            .unwrap()
            .push((port_name.to_string(), packet.to_vec()));
        Ok(())
    }
    fn disconnect_session(&self, port_name: &str) {
        self.disconnected
            .lock()
            .unwrap()
            .push(port_name.to_string());
    }
}

struct StillFrame;

impl AmbilightFrameSource for StillFrame {
    fn capture_frame(&mut self) -> Result<Arc<CapturedFrame>, AmbilightCaptureError> {
        Ok(Arc::new(CapturedFrame::new(
            4,
            4,
            (0..16)
                .map(|i| [(i * 16) as u8, ((i * 7) % 256) as u8, 200])
                .collect(),
        )))
    }
}

fn calibration(total: u16) -> LedCalibrationConfig {
    let top = total / 2;
    let right = (total - top) / 2;
    let bottom = (total - top - right) / 2;
    LedCalibrationConfig {
        template_id: None,
        counts: LedSegmentCounts {
            top,
            right,
            bottom,
            left: total - top - right - bottom,
        },
        bottom_missing: 0,
        corner_ownership: "horizontal".to_string(),
        visual_preset: "subtle".to_string(),
        start_anchor: "top-start".to_string(),
        start_local_index: None,
        direction: "cw".to_string(),
        total_leds: total,
    }
}

fn ambilight(total: u16) -> LightingModeConfig {
    LightingModeConfig {
        effect: None,
        kind: LightingModeKind::Ambilight,
        solid: None,
        ambilight: Some(AmbilightPayload {
            brightness: 1.0,
            ..Default::default()
        }),
        targets: Some(vec!["usb".to_string()]),
        display_id: None,
        led_calibration: Some(calibration(total)),
        color_correction: None,
        firmware_profile: None,
        chip_type: None,
        color_order: None,
        room_geometry: None,
    }
}

fn saved_strip(id: &str, port: &str, total: u16, order: Option<&str>) -> LedStrip {
    LedStrip {
        id: id.to_string(),
        name: None,
        enabled: true,
        transport: Some(StripTransport::Serial {
            port_name: port.to_string(),
        }),
        hardware: StripHardware {
            firmware_profile: None,
            chip_type: None,
            color_order: order.map(|o| json!(o)),
        },
        layout: Some(serde_json::to_value(calibration(total)).unwrap()),
        color_correction: None,
    }
}

/// An owner with two saved strips connected — A on COM-A (30 LEDs, the saved primary) and B on
/// COM-B (20 LEDs) — and a counter of the capture sources it opened.
fn two_strips() -> (LightingRuntimeOwner, Arc<Recorder>, Arc<AtomicUsize>) {
    let recorder = Arc::new(Recorder::default());
    let captures = Arc::new(AtomicUsize::new(0));
    let opened = Arc::clone(&captures);
    let owner = LightingRuntimeOwner {
        output_bridge: LedOutputBridge::from_sender(recorder.clone()),
        frame_source_factory: Arc::new(move |_req| {
            opened.fetch_add(1, Ordering::SeqCst);
            Ok(Box::new(StillFrame))
        }),
        strips: resolve_strips(
            &[
                saved_strip("a", "COM-A", 30, None),
                saved_strip("b", "COM-B", 20, Some("rgb")),
            ],
            vec![
                DrivenLocal::Serial("COM-A".into()),
                DrivenLocal::Serial("COM-B".into()),
            ],
        ),
        ..Default::default()
    };
    (owner, recorder, captures)
}

fn apply(owner: &mut LightingRuntimeOwner, mode: LightingModeConfig) -> String {
    apply_mode_change(
        owner,
        mode,
        true,
        Some("COM-A"),
        None,
        None,
        Some(SharedRuntimeTelemetry::default()),
        None,
        None,
    )
    .status
    .code
}

fn stop(owner: &mut LightingRuntimeOwner) {
    let mut trace = None;
    stop_previous(owner, &mut trace);
}

/// The v1 frame for `leds` pixels: a 5-byte header, 3 bytes a pixel and the XOR byte.
const fn frame_len(leds: usize) -> usize {
    5 + 3 * leds + 1
}

#[test]
fn one_capture_feeds_both_strips_each_at_its_own_length() {
    let _guard = WORKER_TEST_GUARD.lock().unwrap_or_else(|e| e.into_inner());
    let (mut owner, recorder, captures) = two_strips();
    assert_eq!(apply(&mut owner, ambilight(30)), "AMBILIGHT_MODE_STARTED");
    thread::sleep(Duration::from_millis(80));
    assert_eq!(captures.load(Ordering::SeqCst), 1);
    assert!(
        recorder
            .to("COM-A")
            .iter()
            .all(|p| p.len() == frame_len(30))
            && !recorder.to("COM-A").is_empty()
    );
    assert!(
        recorder
            .to("COM-B")
            .iter()
            .all(|p| p.len() == frame_len(20))
            && !recorder.to("COM-B").is_empty()
    );
    assert_eq!(
        owner.active_ports,
        vec!["COM-A".to_string(), "COM-B".to_string()]
    );
    assert_eq!(owner.active_strips.len(), 2);
    assert_eq!(owner.active_strips[1].color_order, LedColorOrder::Rgb);
    stop(&mut owner);
}

#[test]
fn an_effect_lights_the_mode_s_strip_alone() {
    let _guard = WORKER_TEST_GUARD.lock().unwrap_or_else(|e| e.into_inner());
    let (mut owner, recorder, _) = two_strips();
    let effect = LightingModeConfig {
        kind: LightingModeKind::Effect,
        effect: Some(super::config::DEFAULT_EFFECT.clone()),
        ..ambilight(30)
    };
    let code = apply(&mut owner, effect);
    assert_eq!(code, "EFFECT_MODE_STARTED");
    thread::sleep(Duration::from_millis(60));
    assert!(recorder.to("COM-B").is_empty());
    assert_eq!(owner.active_ports, vec!["COM-A".to_string()]);
    stop(&mut owner);
}

#[test]
fn a_strip_beside_the_mode_s_that_cannot_take_a_frame_is_left_out_and_the_run_goes_on() {
    let _guard = WORKER_TEST_GUARD.lock().unwrap_or_else(|e| e.into_inner());
    let (mut owner, recorder, _) = two_strips();
    *recorder.failing.lock().unwrap() = Some("COM-B".into());
    assert_eq!(apply(&mut owner, ambilight(30)), "AMBILIGHT_MODE_STARTED");
    assert_eq!(owner.active_ports, vec!["COM-A".to_string()]);
    assert_eq!(owner.active_strips.len(), 1);
    // Asked for, though it did not start: a retune with the same set keeps this run.
    assert_eq!(owner.requested_extras.len(), 1);
    stop(&mut owner);

    // The mode's own strip failing still fails the run, as it always has.
    let (mut owner, recorder, _) = two_strips();
    *recorder.failing.lock().unwrap() = Some("COM-A".into());
    assert_eq!(
        apply(&mut owner, ambilight(30)),
        "AMBILIGHT_MODE_START_FAILED"
    );
}

#[test]
fn a_retune_keeps_the_run_and_a_changed_strip_beside_it_restarts_it() {
    let _guard = WORKER_TEST_GUARD.lock().unwrap_or_else(|e| e.into_inner());
    let (mut owner, _recorder, captures) = two_strips();
    assert_eq!(apply(&mut owner, ambilight(30)), "AMBILIGHT_MODE_STARTED");
    let mut brighter = ambilight(30);
    brighter.ambilight = Some(AmbilightPayload {
        brightness: 0.5,
        ..Default::default()
    });
    assert_eq!(
        apply(&mut owner, brighter.clone()),
        "AMBILIGHT_MODE_UPDATED"
    );
    assert_eq!(captures.load(Ordering::SeqCst), 1);

    owner.strips = resolve_strips(
        &[
            saved_strip("a", "COM-A", 30, None),
            saved_strip("b", "COM-B", 24, Some("rgb")),
        ],
        vec![
            DrivenLocal::Serial("COM-A".into()),
            DrivenLocal::Serial("COM-B".into()),
        ],
    );
    assert_eq!(apply(&mut owner, brighter), "AMBILIGHT_MODE_STARTED");
    assert_eq!(captures.load(Ordering::SeqCst), 2);
    stop(&mut owner);
}

#[test]
fn a_solid_after_two_strips_blanks_and_lets_go_of_the_one_beside_it() {
    let _guard = WORKER_TEST_GUARD.lock().unwrap_or_else(|e| e.into_inner());
    let (mut owner, recorder, _) = two_strips();
    assert_eq!(apply(&mut owner, ambilight(30)), "AMBILIGHT_MODE_STARTED");
    thread::sleep(Duration::from_millis(40));
    let solid = LightingModeConfig {
        kind: LightingModeKind::Solid,
        solid: Some(SolidColorPayload {
            r: 255,
            g: 0,
            b: 0,
            brightness: 1.0,
            kelvin: None,
        }),
        ..ambilight(30)
    };
    assert_eq!(apply(&mut owner, solid.clone()), "SOLID_MODE_APPLIED");
    let last_b = recorder.to("COM-B").pop().expect("B written");
    assert_eq!(last_b.len(), frame_len(20));
    assert!(
        last_b[5..last_b.len() - 1].iter().all(|&byte| byte == 0),
        "B's last frame is black"
    );
    assert_eq!(
        *recorder.disconnected.lock().unwrap(),
        vec!["COM-B".to_string()]
    );
    assert_eq!(owner.active_ports, vec!["COM-A".to_string()]);

    // An Off after it remembers the Solid's one strip, not the two before.
    recorder.clear();
    assert_eq!(
        apply(&mut owner, LightingModeConfig::default()),
        "LIGHTING_MODE_STOPPED"
    );
    assert_eq!(
        owner
            .ended_run
            .iter()
            .map(|s| s.plan.clone())
            .collect::<Vec<_>>(),
        vec![UsbOutputPlan::Serial("COM-A".into())]
    );
    let _ = solid;
}

#[test]
fn an_off_after_two_strips_remembers_each_with_its_own_length() {
    let _guard = WORKER_TEST_GUARD.lock().unwrap_or_else(|e| e.into_inner());
    let (mut owner, _recorder, _) = two_strips();
    assert_eq!(apply(&mut owner, ambilight(30)), "AMBILIGHT_MODE_STARTED");
    assert_eq!(
        apply(&mut owner, LightingModeConfig::default()),
        "LIGHTING_MODE_STOPPED"
    );
    let lengths: Vec<(UsbOutputPlan, usize)> = owner
        .ended_run
        .iter()
        .map(|s| (s.plan.clone(), s.led_count))
        .collect();
    assert_eq!(
        lengths,
        vec![
            (UsbOutputPlan::Serial("COM-A".into()), 30),
            (UsbOutputPlan::Serial("COM-B".into()), 20)
        ]
    );
    // An Off after the Off keeps the record of the run that drove something.
    assert_eq!(
        apply(&mut owner, LightingModeConfig::default()),
        "LIGHTING_MODE_STOPPED"
    );
    assert_eq!(owner.ended_run.len(), 2);
}

#[test]
fn a_strip_blanked_from_its_record_is_painted_as_the_mode_would_paint_it() {
    let recorder = Arc::new(Recorder::default());
    let bridge = LedOutputBridge::from_sender(recorder.clone());
    let mode = ambilight(30);
    let plan = UsbOutputPlan::Serial("COM-A".into());
    SolidUsbOutput::for_mode(&bridge, plan.clone(), &mode)
        .blank()
        .unwrap();
    SolidUsbOutput::for_strip(&bridge, &ActiveStrip::of_mode(plan, &mode))
        .blank()
        .unwrap();
    let frames = recorder.to("COM-A");
    assert_eq!(frames.len(), 2);
    assert_eq!(frames[0], frames[1]);
}

#[test]
fn the_runtime_drives_and_holds_the_strip_beside_the_mode_s() {
    let _guard = WORKER_TEST_GUARD.lock().unwrap_or_else(|e| e.into_inner());
    let (mut owner, _recorder, _) = two_strips();
    assert_eq!(apply(&mut owner, ambilight(30)), "AMBILIGHT_MODE_STARTED");
    let drives = |port: &str| {
        owner
            .active_strips
            .iter()
            .any(|s| s.plan == UsbOutputPlan::Serial(port.into()))
    };
    assert!(drives("COM-B") && drives("COM-A") && !drives("COM-C"));
    assert!(owner.active_ports.contains(&"COM-B".to_string()));
    stop(&mut owner);
}

fn red_test_pattern() -> crate::commands::test_pattern::TestPatternConfig {
    crate::commands::test_pattern::TestPatternConfig {
        kind: crate::commands::test_pattern::TestPatternKind::Solid { r: 255, g: 0, b: 0 },
        brightness: 1.0,
        speed: Default::default(),
        display_aspect: 1.78,
    }
}

#[test]
fn an_off_after_a_run_that_drove_nothing_blanks_no_earlier_strip() {
    let _guard = WORKER_TEST_GUARD.lock().unwrap_or_else(|e| e.into_inner());
    let (mut owner, _recorder, _) = two_strips();
    assert_eq!(apply(&mut owner, ambilight(30)), "AMBILIGHT_MODE_STARTED");
    // A preview-only test with no device drives no strip.
    owner.preview.pending_test_pattern = Some(red_test_pattern());
    let mut preview_only = ambilight(30);
    preview_only.targets = Some(Vec::new());
    let code = apply_mode_change(
        &mut owner,
        preview_only,
        false,
        None,
        None,
        None,
        Some(SharedRuntimeTelemetry::default()),
        None,
        None,
    )
    .status
    .code;
    assert_eq!(code, "AMBILIGHT_MODE_STARTED");
    assert_eq!(
        apply(&mut owner, LightingModeConfig::default()),
        "LIGHTING_MODE_STOPPED"
    );
    assert!(
        owner.ended_run.is_empty(),
        "the Off must not paint the ports the run before held"
    );
}

#[test]
fn a_test_pattern_on_the_mode_s_strip_keeps_the_strip_beside_it_warm() {
    let _guard = WORKER_TEST_GUARD.lock().unwrap_or_else(|e| e.into_inner());
    let (mut owner, recorder, _) = two_strips();
    assert_eq!(apply(&mut owner, ambilight(30)), "AMBILIGHT_MODE_STARTED");
    thread::sleep(Duration::from_millis(40));
    owner.preview.pending_test_pattern = Some(red_test_pattern());
    assert_eq!(apply(&mut owner, ambilight(30)), "AMBILIGHT_MODE_STARTED");
    // B was painted black and its session kept, so the Ambilight after finds it without a reopen.
    let last_b = recorder.to("COM-B").pop().expect("B written");
    assert!(last_b[5..last_b.len() - 1].iter().all(|&byte| byte == 0));
    assert!(recorder.disconnected.lock().unwrap().is_empty());
    assert_eq!(
        owner.active_ports,
        vec!["COM-A".to_string(), "COM-B".to_string()]
    );
    stop(&mut owner);
}
