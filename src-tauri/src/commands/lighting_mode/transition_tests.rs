//! `apply_mode_change` over a still frame and a recording serial sender: the
//! "usb" channel's sink selection, runtime exclusivity, per-LED encoding and
//! the colour order a running worker retunes in place.

use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use super::live::AmbilightLiveSettings;
use super::pacing::resolve_quality_config;
use super::runtime::LightingRuntimeOwner;
use super::transition::{apply_mode_change, set_active_port, stop_previous};
use super::usb_output::UsbOutputPlan;
use super::worker::start_ambilight_worker;
use super::{
    AmbilightPayload, LightingModeConfig, LightingModeKind, SolidColorPayload,
    ACTIVE_AMBILIGHT_WORKERS, AMBILIGHT_CAPTURE_ATTEMPTS, AMBILIGHT_FRAME_ATTEMPTS,
    SOLID_OUTPUT_ATTEMPTS,
};
use crate::commands::ambilight_capture::{
    AmbilightCaptureError, AmbilightFrameSource, CapturedFrame,
};
use crate::commands::led_output::{
    FirmwareProfile, LedChipType, LedColorOrder, LedOutputBridge, LedOutputError, LedPacketSender,
};
use crate::commands::runtime_quality::RuntimeQualityConfig;
use crate::commands::runtime_telemetry::RuntimeTelemetrySnapshot;
use crate::commands::wled_sink::{WledProtocol, WledSinkConfig};

#[derive(Default)]
struct FakeLedSender {
    writes: Mutex<Vec<(String, Vec<u8>)>>,
    disconnected: Mutex<Vec<String>>,
}

impl FakeLedSender {
    fn disconnected_ports(&self) -> Vec<String> {
        self.disconnected
            .lock()
            .expect("disconnected lock poisoned")
            .clone()
    }
}

impl LedPacketSender for FakeLedSender {
    fn send(&self, port_name: &str, packet: &[u8]) -> Result<(), LedOutputError> {
        self.writes
            .lock()
            .expect("writes lock poisoned")
            .push((port_name.to_string(), packet.to_vec()));
        Ok(())
    }

    fn disconnect_session(&self, port_name: &str) {
        self.disconnected
            .lock()
            .expect("disconnected lock poisoned")
            .push(port_name.to_string());
    }
}

struct FakeFrameSource {
    frame: CapturedFrame,
    fail_with_unavailable: bool,
}

impl AmbilightFrameSource for FakeFrameSource {
    fn capture_frame(&mut self) -> Result<Arc<CapturedFrame>, AmbilightCaptureError> {
        if self.fail_with_unavailable {
            return Err(AmbilightCaptureError::FrameUnavailable);
        }
        Ok(Arc::new(self.frame.clone()))
    }
}

fn owner_with_fake_sender() -> LightingRuntimeOwner {
    LightingRuntimeOwner {
        active_mode: LightingModeConfig::default(),
        active_port: None,
        worker: None,
        ambilight_live: None,
        room_geometry_live: None,
        output_bridge: LedOutputBridge::from_sender(Arc::new(FakeLedSender::default())),
        preview: Default::default(),
        closing: Default::default(),
        frame_source_factory: Arc::new(|_req: super::runtime::AmbilightCaptureRequest| {
            Ok(Box::new(FakeFrameSource {
                frame: CapturedFrame::new(
                    2,
                    2,
                    vec![[10, 20, 30], [40, 50, 60], [70, 80, 90], [100, 110, 120]],
                ),
                fail_with_unavailable: false,
            }))
        }),
    }
}

fn owner_with_unavailable_capture() -> LightingRuntimeOwner {
    LightingRuntimeOwner {
        active_mode: LightingModeConfig::default(),
        active_port: None,
        worker: None,
        ambilight_live: None,
        room_geometry_live: None,
        output_bridge: LedOutputBridge::from_sender(Arc::new(FakeLedSender::default())),
        preview: Default::default(),
        closing: Default::default(),
        frame_source_factory: Arc::new(|_req: super::runtime::AmbilightCaptureRequest| {
            Ok(Box::new(FakeFrameSource {
                frame: CapturedFrame::new(1, 1, vec![[0, 0, 0]]),
                fail_with_unavailable: true,
            }))
        }),
    }
}

fn ambilight_mode() -> LightingModeConfig {
    LightingModeConfig {
        kind: LightingModeKind::Ambilight,
        solid: None,
        ambilight: Some(AmbilightPayload {
            brightness: 0.8,
            ..Default::default()
        }),
        targets: None,
        display_id: None,
        led_calibration: None,
        color_correction: None,
        firmware_profile: None,
        chip_type: None,
        color_order: None,
        room_geometry: None,
    }
}

fn solid_mode() -> LightingModeConfig {
    LightingModeConfig {
        kind: LightingModeKind::Solid,
        solid: Some(SolidColorPayload {
            r: 32,
            g: 64,
            b: 128,
            brightness: 0.6,
        }),
        ambilight: None,
        targets: None,
        display_id: None,
        led_calibration: None,
        color_correction: None,
        firmware_profile: None,
        chip_type: None,
        color_order: None,
        room_geometry: None,
    }
}

fn wait_for_worker_count(target: usize) {
    for _ in 0..10 {
        if ACTIVE_AMBILIGHT_WORKERS.load(Ordering::SeqCst) == target {
            return;
        }
        thread::sleep(Duration::from_millis(5));
    }
}

/// Serialise a worker-touching test against the process-global
/// `ACTIVE_AMBILIGHT_WORKERS` counter. Hold the returned guard for the
/// whole test body so the next test only starts once this one has drained
/// its workers back to zero. Recovers from poisoning so a panic in one
/// guarded test does not cascade into spurious failures elsewhere.
fn acquire_worker_test_guard() -> std::sync::MutexGuard<'static, ()> {
    super::WORKER_TEST_GUARD
        .lock()
        .unwrap_or_else(|e| e.into_inner())
}

fn shared_runtime_telemetry() -> Arc<Mutex<RuntimeTelemetrySnapshot>> {
    Arc::new(Mutex::new(RuntimeTelemetrySnapshot::default()))
}

/// Mirrors `owner_with_fake_sender` but exposes the recorder `Arc` so a
/// test can inspect (or assert the absence of) serial writes.
fn owner_with_recording_sender() -> (LightingRuntimeOwner, Arc<FakeLedSender>) {
    let recorder: Arc<FakeLedSender> = Arc::new(FakeLedSender::default());
    let owner = LightingRuntimeOwner {
        active_mode: LightingModeConfig::default(),
        active_port: None,
        worker: None,
        ambilight_live: None,
        room_geometry_live: None,
        output_bridge: LedOutputBridge::from_sender(recorder.clone()),
        preview: Default::default(),
        closing: Default::default(),
        frame_source_factory: Arc::new(|_req: super::runtime::AmbilightCaptureRequest| {
            Ok(Box::new(FakeFrameSource {
                frame: CapturedFrame::new(
                    2,
                    2,
                    vec![[10, 20, 30], [40, 50, 60], [70, 80, 90], [100, 110, 120]],
                ),
                fail_with_unavailable: false,
            }))
        }),
    };
    (owner, recorder)
}

// -----------------------------------------------------------------------
// set_active_port — release the old port's cached session only on switch
// -----------------------------------------------------------------------

#[test]
fn set_active_port_preserves_same_port_but_releases_a_different_one() {
    let (mut owner, recorder) = owner_with_recording_sender();

    set_active_port(&mut owner, "COM_A".to_string());
    assert_eq!(owner.active_port.as_deref(), Some("COM_A"));
    assert!(
        recorder.disconnected_ports().is_empty(),
        "first-ever port assignment has nothing to release"
    );

    // Same port again — a mode restart on the port already in use. The
    // cached session must be left alone (DTR invariant).
    set_active_port(&mut owner, "COM_A".to_string());
    assert!(
        recorder.disconnected_ports().is_empty(),
        "re-assigning the SAME port must not release its cached session"
    );

    // A genuine switch — COM_A's cached session must be released so
    // another app (e.g. the Arduino IDE) can open it, and COM_B becomes
    // the new active port without being touched itself.
    set_active_port(&mut owner, "COM_B".to_string());
    assert_eq!(owner.active_port.as_deref(), Some("COM_B"));
    assert_eq!(
        recorder.disconnected_ports(),
        vec!["COM_A".to_string()],
        "switching ports must release exactly the abandoned one"
    );
}

/// Loopback would fail `connect_wled_sink`'s SSRF guard, but these tests
/// exercise dispatch logic downstream of it -- a real `send_to` against
/// loopback still succeeds with no listener.
fn wled_config_fixture(led_count: u16) -> WledSinkConfig {
    WledSinkConfig {
        ip: "127.0.0.1".parse().expect("valid IPv4"),
        port: 4048,
        led_count,
        protocol: WledProtocol::Ddp,
    }
}

// -----------------------------------------------------------------------
// resolve_quality_config — WLED-vs-serial budget divergence
// -----------------------------------------------------------------------

#[test]
fn resolve_quality_config_serial_link_gets_a_baud_budget() {
    let plan = Some(UsbOutputPlan::Serial("COM1".to_string()));
    let (_, budget) = resolve_quality_config(
        &plan,
        60,
        FirmwareProfile::LumaSyncV1,
        LedChipType::Ws2812bGrb,
    );
    assert!(budget.is_some(), "a serial link must report a baud budget");
}

#[test]
fn resolve_quality_config_wled_never_gets_a_serial_budget_even_when_led_count_is_large() {
    // 300 LEDs at GRB would be link_constrained on a real serial link;
    // WLED must stay unconstrained regardless of LED count.
    let plan = Some(UsbOutputPlan::Wled(wled_config_fixture(300)));
    let (config, budget) = resolve_quality_config(
        &plan,
        300,
        FirmwareProfile::LumaSyncV1,
        LedChipType::Ws2812bGrb,
    );
    assert!(
        budget.is_none(),
        "WLED must never report a serial send budget"
    );
    let defaults = RuntimeQualityConfig::default();
    assert_eq!(
        config.base_interval_ms, defaults.base_interval_ms,
        "WLED must use the capture-paced defaults, not the serial clamp"
    );
    assert_eq!(config.min_interval_ms, defaults.min_interval_ms);
    assert_eq!(config.max_interval_ms, defaults.max_interval_ms);
}

#[test]
fn resolve_quality_config_hue_only_reports_no_serial_budget() {
    let (config, budget) = resolve_quality_config(
        &None,
        0,
        FirmwareProfile::LumaSyncV1,
        LedChipType::Ws2812bGrb,
    );
    assert!(budget.is_none());
    assert_eq!(config.base_interval_ms, 40);
    assert_eq!(config.min_interval_ms, 30);
    assert_eq!(config.max_interval_ms, 100);
}

// -----------------------------------------------------------------------
// apply_mode_change — registry-selection: WLED vs serial vs neither
// -----------------------------------------------------------------------

#[test]
fn solid_mode_routes_to_wled_sink_and_never_touches_the_serial_bridge() {
    let (mut owner, recorder) = owner_with_recording_sender();
    let result = apply_mode_change(
        &mut owner,
        solid_mode(),
        true,
        Some("COM1"), // stale/irrelevant serial connection
        Some(wled_config_fixture(30)),
        None,
        None,
        None,
        None,
    );

    assert_eq!(result.status.code, "SOLID_MODE_APPLIED");
    // Proof the registered WLED sink was used, not serial, even though a
    // serial port was also nominally connected.
    let writes = recorder.writes.lock().expect("writes lock poisoned");
    assert!(
        writes.is_empty(),
        "the serial bridge must see zero writes when a WLED sink is registered"
    );
}

#[test]
fn solid_mode_usb_gate_passes_when_only_a_wled_sink_is_registered() {
    // No serial device connected this session; only WLED is registered.
    // Before the registry was wired in, this combination hit the
    // DEVICE_NOT_CONNECTED gate and silently blocked WLED-only setups.
    let mut owner = owner_with_fake_sender();
    let result = apply_mode_change(
        &mut owner,
        solid_mode(),
        false,
        None,
        Some(wled_config_fixture(10)),
        None,
        None,
        None,
        None,
    );

    assert_eq!(result.status.code, "SOLID_MODE_APPLIED");
    assert!(result.active);
}

#[test]
fn switching_ports_through_apply_mode_change_releases_the_old_port_only() {
    // The helper alone is not enough: every apply runs stop_previous first,
    // so this goes through the real path to prove the old port survives it.
    let (mut owner, recorder) = owner_with_recording_sender();
    let apply = |owner: &mut LightingRuntimeOwner, port: &str| {
        apply_mode_change(
            owner,
            solid_mode(),
            true,
            Some(port),
            None,
            None,
            None,
            None,
            None,
        )
    };

    assert_eq!(apply(&mut owner, "COM_A").status.code, "SOLID_MODE_APPLIED");
    assert_eq!(apply(&mut owner, "COM_A").status.code, "SOLID_MODE_APPLIED");
    assert!(
        recorder.disconnected_ports().is_empty(),
        "a restart on the same port must keep its cached session (DTR)"
    );

    assert_eq!(apply(&mut owner, "COM_B").status.code, "SOLID_MODE_APPLIED");
    assert_eq!(recorder.disconnected_ports(), vec!["COM_A".to_string()]);
    assert_eq!(owner.active_port.as_deref(), Some("COM_B"));
}

#[test]
fn solid_mode_falls_back_to_serial_when_no_wled_sink_is_registered() {
    // wled_sink=None must reproduce the pre-WLED-wiring behavior exactly.
    let mut owner = owner_with_fake_sender();
    let result = apply_mode_change(
        &mut owner,
        solid_mode(),
        true,
        Some("COM9"),
        None,
        None,
        None,
        None,
        None,
    );

    assert_eq!(result.status.code, "SOLID_MODE_APPLIED");
}

#[test]
fn ambilight_mode_wled_only_starts_and_sends_frames_with_no_serial_connection() {
    let _guard = acquire_worker_test_guard();
    AMBILIGHT_FRAME_ATTEMPTS.store(0, Ordering::SeqCst);
    AMBILIGHT_CAPTURE_ATTEMPTS.store(0, Ordering::SeqCst);

    let mut owner = owner_with_fake_sender();
    let result = apply_mode_change(
        &mut owner,
        ambilight_mode(),
        false,
        None,
        Some(wled_config_fixture(10)),
        None,
        Some(shared_runtime_telemetry()),
        None,
        None,
    );

    assert_eq!(result.status.code, "AMBILIGHT_MODE_STARTED");
    thread::sleep(Duration::from_millis(20));
    assert!(
        AMBILIGHT_FRAME_ATTEMPTS.load(Ordering::SeqCst) > 0,
        "wled-only ambilight must still attempt frame sends"
    );

    let mut cleanup_trace = None;
    stop_previous(&mut owner, &mut cleanup_trace);
    wait_for_worker_count(0);
}

/// With nothing available, `start_led_test_pattern` sends `targets: []`,
/// which the legacy rule reads as "USB required" — and a test skips the USB
/// gate. Only the plan keeps a recorded but unconnected port from the worker.
#[test]
fn a_preview_only_test_pattern_never_writes_to_an_unconnected_port() {
    let _guard = acquire_worker_test_guard();
    let (mut owner, recorder) = owner_with_recording_sender();
    owner.preview.pending_test_pattern = Some(crate::commands::test_pattern::TestPatternConfig {
        kind: crate::commands::test_pattern::TestPatternKind::Solid { r: 255, g: 0, b: 0 },
        brightness: 1.0,
        speed: Default::default(),
        display_aspect: 1.78,
    });
    let mut mode = ambilight_mode();
    mode.targets = Some(Vec::new());

    let result = apply_mode_change(
        &mut owner,
        mode,
        false,
        Some("/dev/cu.Bluetooth-Incoming-Port"),
        None,
        None,
        Some(shared_runtime_telemetry()),
        None,
        None,
    );

    assert_eq!(result.status.code, "AMBILIGHT_MODE_STARTED");
    thread::sleep(Duration::from_millis(200));
    let writes = recorder.writes.lock().expect("writes lock").len();
    let mut cleanup_trace = None;
    stop_previous(&mut owner, &mut cleanup_trace);
    wait_for_worker_count(0);

    assert_eq!(writes, 0, "a preview-only test must not open the port");
    assert_eq!(owner.active_port, None);
}

#[test]
fn set_ambilight_stops_previous_then_starts_new_runtime() {
    let _guard = acquire_worker_test_guard();
    let mut owner = owner_with_fake_sender();
    owner = LightingRuntimeOwner {
        active_mode: ambilight_mode(),
        active_port: Some("COM1".to_string()),
        worker: Some(
            start_ambilight_worker(
                owner.output_bridge.clone(),
                Some(UsbOutputPlan::Serial("COM1".to_string())),
                None,
                AmbilightLiveSettings::new(0.8, false, 0.35, 1.0),
                (owner.frame_source_factory)(super::runtime::AmbilightCaptureRequest {
                    display_id: None,
                    led_calibration: None,
                    test_pattern: None,
                    pattern_phase: None,
                    pattern_live: None,
                    frame_interval: Duration::from_millis(50),
                })
                .expect("frame source should be available"),
                shared_runtime_telemetry(),
                None,
                None,
                crate::commands::led_output::ColorCorrectionConfig::default(),
                crate::commands::led_output::FirmwareProfile::default(),
                crate::commands::led_output::LedChipType::default(),
                None,
                super::live::RoomGeometryLive::new(None),
                super::worker::WorkerPacing::live(Duration::from_millis(50)),
            )
            .expect("worker start should succeed"),
        ),
        ambilight_live: None,
        room_geometry_live: None,
        output_bridge: owner.output_bridge,
        frame_source_factory: owner.frame_source_factory,
        preview: Default::default(),
        closing: Default::default(),
    };
    let mut trace = Vec::new();

    let result = apply_mode_change(
        &mut owner,
        ambilight_mode(),
        true,
        Some("COM1"),
        None,
        None,
        Some(shared_runtime_telemetry()),
        None,
        Some(&mut trace),
    );

    assert_eq!(result.status.code, "AMBILIGHT_MODE_STARTED");
    assert_eq!(result.mode.kind, LightingModeKind::Ambilight);
    assert!(result.active);
    assert_eq!(trace, vec!["stop_previous", "start_ambilight"]);

    let mut cleanup_trace = None;
    stop_previous(&mut owner, &mut cleanup_trace);
    wait_for_worker_count(0);
}

#[test]
fn set_solid_applies_payload_and_marks_mode_active() {
    SOLID_OUTPUT_ATTEMPTS.store(0, Ordering::SeqCst);
    let mut owner = owner_with_fake_sender();
    let result = apply_mode_change(
        &mut owner,
        solid_mode(),
        true,
        Some("COM4"),
        None,
        None,
        None,
        None,
        None,
    );

    assert_eq!(result.status.code, "SOLID_MODE_APPLIED");
    assert_eq!(result.mode.kind, LightingModeKind::Solid);
    assert!(result.active);
    assert_eq!(result.mode.solid.expect("solid payload").brightness, 0.6);
    assert!(
        SOLID_OUTPUT_ATTEMPTS.load(Ordering::SeqCst) > 0,
        "solid mode should attempt physical output"
    );
}

#[test]
fn ambilight_mode_attempts_to_send_at_least_one_frame() {
    let _guard = acquire_worker_test_guard();
    AMBILIGHT_FRAME_ATTEMPTS.store(0, Ordering::SeqCst);
    AMBILIGHT_CAPTURE_ATTEMPTS.store(0, Ordering::SeqCst);

    let mut owner = owner_with_fake_sender();
    let result = apply_mode_change(
        &mut owner,
        ambilight_mode(),
        true,
        Some("COM7"),
        None,
        None,
        Some(shared_runtime_telemetry()),
        None,
        None,
    );

    assert_eq!(result.status.code, "AMBILIGHT_MODE_STARTED");
    thread::sleep(Duration::from_millis(20));
    assert!(
        AMBILIGHT_CAPTURE_ATTEMPTS.load(Ordering::SeqCst) > 0,
        "ambilight mode should attempt at least one frame capture"
    );
    assert!(
        AMBILIGHT_FRAME_ATTEMPTS.load(Ordering::SeqCst) > 0,
        "ambilight mode should attempt at least one frame send"
    );

    let mut cleanup_trace = None;
    stop_previous(&mut owner, &mut cleanup_trace);
    wait_for_worker_count(0);
}

#[test]
fn repeated_switches_keep_single_active_runtime() {
    let _guard = acquire_worker_test_guard();
    let mut owner = owner_with_fake_sender();

    let first = apply_mode_change(
        &mut owner,
        ambilight_mode(),
        true,
        Some("COM2"),
        None,
        None,
        Some(shared_runtime_telemetry()),
        None,
        None,
    );
    assert_eq!(first.mode.kind, LightingModeKind::Ambilight);
    wait_for_worker_count(1);
    assert_eq!(ACTIVE_AMBILIGHT_WORKERS.load(Ordering::SeqCst), 1);

    let second = apply_mode_change(
        &mut owner,
        ambilight_mode(),
        true,
        Some("COM2"),
        None,
        None,
        Some(shared_runtime_telemetry()),
        None,
        None,
    );
    assert_eq!(second.mode.kind, LightingModeKind::Ambilight);
    wait_for_worker_count(1);
    assert_eq!(ACTIVE_AMBILIGHT_WORKERS.load(Ordering::SeqCst), 1);

    let final_state = apply_mode_change(
        &mut owner,
        solid_mode(),
        true,
        Some("COM2"),
        None,
        None,
        None,
        None,
        None,
    );
    assert_eq!(final_state.mode.kind, LightingModeKind::Solid);
    wait_for_worker_count(0);
    assert_eq!(ACTIVE_AMBILIGHT_WORKERS.load(Ordering::SeqCst), 0);

    assert_eq!(final_state.status.code, "SOLID_MODE_APPLIED");
}

#[test]
fn solid_to_ambilight_to_solid_keeps_runtime_exclusive() {
    // Manual-test repro for v1.5 #44: user enters Solid mode, frontend
    // race fires a stale Ambilight push, then user pushes Solid again.
    // The runtime owner must end on Solid with zero active workers and
    // the LED bridge must NOT be holding a stale ambilight worker.
    let _guard = acquire_worker_test_guard();
    let mut owner = owner_with_fake_sender();

    // Solid #1
    let s1 = apply_mode_change(
        &mut owner,
        solid_mode(),
        true,
        Some("COM-EX"),
        None,
        None,
        None,
        None,
        None,
    );
    assert_eq!(s1.status.code, "SOLID_MODE_APPLIED");
    wait_for_worker_count(0);
    assert_eq!(ACTIVE_AMBILIGHT_WORKERS.load(Ordering::SeqCst), 0);

    // Stale Ambilight push (simulates the frontend race that the manual
    // tester reproduced — a brightness/preset effect re-sending Ambilight
    // immediately after the user picked Solid).
    let amb = apply_mode_change(
        &mut owner,
        ambilight_mode(),
        true,
        Some("COM-EX"),
        None,
        None,
        Some(shared_runtime_telemetry()),
        None,
        None,
    );
    assert_eq!(amb.status.code, "AMBILIGHT_MODE_STARTED");
    wait_for_worker_count(1);
    assert_eq!(ACTIVE_AMBILIGHT_WORKERS.load(Ordering::SeqCst), 1);

    // Solid #2 — final user intent. Must stop the ambilight worker
    // synchronously and leave zero active workers so the next packet
    // written to the LED bridge is the solid colour, not a stale frame.
    let s2 = apply_mode_change(
        &mut owner,
        solid_mode(),
        true,
        Some("COM-EX"),
        None,
        None,
        None,
        None,
        None,
    );
    assert_eq!(s2.status.code, "SOLID_MODE_APPLIED");
    assert_eq!(s2.mode.kind, LightingModeKind::Solid);
    wait_for_worker_count(0);
    assert_eq!(
        ACTIVE_AMBILIGHT_WORKERS.load(Ordering::SeqCst),
        0,
        "after final Solid, ambilight workers must be fully drained",
    );
    assert!(
        owner.worker.is_none(),
        "owner.worker must be None after Solid takes over",
    );
    assert!(
        owner.ambilight_live.is_none(),
        "owner.ambilight_live must be None after Solid takes over",
    );
}

#[test]
fn disconnected_mode_change_keeps_existing_runtime_state() {
    let mut owner = owner_with_fake_sender();
    let _ = apply_mode_change(
        &mut owner,
        solid_mode(),
        true,
        Some("COM3"),
        None,
        None,
        None,
        None,
        None,
    );

    let denied = apply_mode_change(
        &mut owner,
        ambilight_mode(),
        false,
        None,
        None,
        None,
        Some(shared_runtime_telemetry()),
        None,
        None,
    );

    assert_eq!(denied.status.code, "DEVICE_NOT_CONNECTED");
    assert_eq!(denied.mode.kind, LightingModeKind::Solid);
}

#[test]
fn ambilight_mode_reports_start_failure_when_capture_is_unavailable() {
    let mut owner = owner_with_unavailable_capture();

    let failed = apply_mode_change(
        &mut owner,
        ambilight_mode(),
        true,
        Some("COM1"),
        None,
        None,
        Some(shared_runtime_telemetry()),
        None,
        None,
    );

    assert_eq!(failed.status.code, "AMBILIGHT_MODE_START_FAILED");
    assert_eq!(
        failed.status.details,
        Some("AMBILIGHT_CAPTURE_FRAME_UNAVAILABLE".to_string())
    );
    assert_eq!(failed.mode.kind, LightingModeKind::Off);
}

// Originally guarded only against `target_os = "windows"`, but v1.4 added
// macOS SCDisplay capture and v1.5 added Linux X11 capture via xcap —
// so all three first-class targets now build a live source successfully.
// Restrict the contract assertion to the truly-unsupported platforms (BSDs
// / illumos) where the factory is still expected to surface the
// `AMBILIGHT_CAPTURE_UNSUPPORTED_PLATFORM` reason instead of silently
// falling back to a static source.
#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
#[test]
fn default_runtime_owner_uses_live_source_factory_contract() {
    let owner = LightingRuntimeOwner::default();

    let error = match (owner.frame_source_factory)(super::runtime::AmbilightCaptureRequest {
        display_id: None,
        led_calibration: None,
        test_pattern: None,
    }) {
        Ok(_) => panic!("default frame source must not fall back to static source"),
        Err(error) => error,
    };

    assert_eq!(
        error.as_reason(),
        "AMBILIGHT_CAPTURE_UNSUPPORTED_PLATFORM".to_string()
    );
}

// -----------------------------------------------------------------------
// Ambilight worker — per-LED USB encoding (v1.5 hardware repro)
//
// Latent symptom (HEAD): "ambilight only lights LED #0". Even though the
// worker pipeline samples one colour per LED via `sample_frame_for_sequence`
// and the `SerialSink` encodes the full slice, there was no test that
// observed the actual byte count reaching the wire. This test snapshots
// the recorded packet against the LumaSync v1 wire format so any future
// refactor that drops back to a 1-LED slice is caught immediately.
// -----------------------------------------------------------------------

fn ambilight_calibration_with_total_leds(
    total: u16,
) -> crate::commands::led_calibration::LedCalibrationConfig {
    use crate::commands::led_calibration::LedSegmentCounts;
    let top = total / 2;
    let right = (total - top) / 2;
    let bottom = (total - top - right) / 2;
    let left = total - top - right - bottom;
    crate::commands::led_calibration::LedCalibrationConfig {
        template_id: None,
        counts: LedSegmentCounts {
            top,
            right,
            bottom,
            left,
        },
        bottom_missing: 0,
        corner_ownership: "horizontal".to_string(),
        visual_preset: "subtle".to_string(),
        start_anchor: "top-start".to_string(),
        direction: "cw".to_string(),
        total_leds: total,
    }
}

fn ambilight_mode_with_calibration(total_leds: u16) -> LightingModeConfig {
    LightingModeConfig {
        kind: LightingModeKind::Ambilight,
        solid: None,
        ambilight: Some(AmbilightPayload {
            brightness: 1.0,
            ..Default::default()
        }),
        targets: Some(vec!["usb".to_string()]),
        display_id: None,
        led_calibration: Some(ambilight_calibration_with_total_leds(total_leds)),
        color_correction: None,
        firmware_profile: None,
        chip_type: None,
        color_order: None,
        room_geometry: None,
    }
}

/// Build an owner whose `LedPacketSender` is exposed as an `Arc` so the
/// test can read recorded packet bytes back. Mirrors `owner_with_fake_sender`
/// but returns the recorder Arc alongside the owner.
fn owner_with_recording_sender_for_ambilight() -> (LightingRuntimeOwner, Arc<FakeLedSender>) {
    let recorder: Arc<FakeLedSender> = Arc::new(FakeLedSender::default());
    let owner = LightingRuntimeOwner {
        active_mode: LightingModeConfig::default(),
        active_port: None,
        worker: None,
        ambilight_live: None,
        room_geometry_live: None,
        output_bridge: LedOutputBridge::from_sender(recorder.clone()),
        preview: Default::default(),
        closing: Default::default(),
        frame_source_factory: Arc::new(|_req: super::runtime::AmbilightCaptureRequest| {
            Ok(Box::new(FakeFrameSource {
                frame: CapturedFrame::new(
                    4,
                    4,
                    // 16 unique pixels so per-LED averaging in
                    // `sample_frame_for_sequence` produces non-zero output
                    // for every edge LED regardless of segment counts.
                    (0..16)
                        .map(|i| [(i * 16) as u8, ((i * 7) % 256) as u8, 200])
                        .collect(),
                ),
                fail_with_unavailable: false,
            }))
        }),
    };
    (owner, recorder)
}

#[test]
fn ambilight_mode_with_30_led_calibration_emits_per_led_usb_packet() {
    // 30 LEDs × 3 bytes/LED + 5-byte header + 1-byte XOR = 96 bytes.
    // Verifies the ambilight worker's USB sink is encoding the FULL
    // sampled sequence — not just a single-LED slice. Asserts on the
    // initial-frame send (line ~899 in lighting_mode.rs) which fires
    // synchronously inside `start_ambilight_worker` BEFORE the worker
    // thread spawns. That deterministic write avoids racing the worker
    // loop's first iteration.
    let _guard = acquire_worker_test_guard();
    AMBILIGHT_FRAME_ATTEMPTS.store(0, Ordering::SeqCst);
    AMBILIGHT_CAPTURE_ATTEMPTS.store(0, Ordering::SeqCst);

    let (mut owner, recorder) = owner_with_recording_sender_for_ambilight();
    let result = apply_mode_change(
        &mut owner,
        ambilight_mode_with_calibration(30),
        true,
        Some("COM-AMB-30"),
        None,
        None,
        Some(shared_runtime_telemetry()),
        None,
        None,
    );

    assert_eq!(result.status.code, "AMBILIGHT_MODE_STARTED");

    // The worker's initial-frame send is synchronous. Brief grace period
    // covers the worker thread's first loop iteration as a belt-and-braces
    // measure, but the assertion below requires only the synchronous send.
    thread::sleep(Duration::from_millis(50));

    let writes = recorder.writes.lock().expect("writes lock poisoned");
    assert!(
        !writes.is_empty(),
        "ambilight worker must dispatch at least one USB packet"
    );
    let (port, packet) = &writes[0];
    assert_eq!(port, "COM-AMB-30");
    assert_eq!(
        packet.len(),
        5 + 3 * 30 + 1,
        "30-LED ambilight frame must be 96 bytes (was {} bytes — likely a 1-LED slice regression)",
        packet.len()
    );
    assert_eq!(&packet[0..2], &[0xAA, 0x55]);
    let count = u16::from_le_bytes([packet[3], packet[4]]);
    assert_eq!(count, 30, "wire count must match calibration total_leds");

    // XOR checksum must validate so the firmware accepts the frame.
    let (body, checksum) = packet.split_at(packet.len() - 1);
    let computed = body.iter().fold(0_u8, |acc, b| acc ^ b);
    assert_eq!(
        computed, checksum[0],
        "ambilight frame XOR must match firmware-side parser"
    );

    drop(writes);
    let mut cleanup_trace = None;
    stop_previous(&mut owner, &mut cleanup_trace);
    wait_for_worker_count(0);
}

// -----------------------------------------------------------------------
// Colour order — read live by the worker, not by a restart
// -----------------------------------------------------------------------

fn owner_with_red_frame() -> (LightingRuntimeOwner, Arc<FakeLedSender>) {
    let recorder: Arc<FakeLedSender> = Arc::new(FakeLedSender::default());
    let owner = LightingRuntimeOwner {
        active_mode: LightingModeConfig::default(),
        active_port: None,
        worker: None,
        ambilight_live: None,
        room_geometry_live: None,
        output_bridge: LedOutputBridge::from_sender(recorder.clone()),
        preview: Default::default(),
        closing: Default::default(),
        frame_source_factory: Arc::new(|_req: super::runtime::AmbilightCaptureRequest| {
            Ok(Box::new(FakeFrameSource {
                frame: CapturedFrame::new(4, 4, vec![[255, 0, 0]; 16]),
                fail_with_unavailable: false,
            }))
        }),
    };
    (owner, recorder)
}

/// Red dominates wire slot 0 under the identity order and slot 2 under
/// BGR; the scene stage may blend, but it cannot swap which slot leads.
fn first_pixel(packet: &[u8]) -> [u8; 3] {
    [packet[5], packet[6], packet[7]]
}

fn apply_on(
    owner: &mut LightingRuntimeOwner,
    mode: LightingModeConfig,
) -> super::LightingModeCommandResult {
    apply_mode_change(
        owner,
        mode,
        true,
        Some("COM-ORDER"),
        None,
        None,
        Some(shared_runtime_telemetry()),
        None,
        None,
    )
}

#[test]
fn a_color_order_change_retunes_the_running_worker_in_place() {
    let _guard = acquire_worker_test_guard();
    let (mut owner, recorder) = owner_with_red_frame();
    let mode = ambilight_mode_with_calibration(8);

    assert_eq!(
        apply_on(&mut owner, mode.clone()).status.code,
        "AMBILIGHT_MODE_STARTED"
    );
    let live = Arc::clone(owner.ambilight_live.as_ref().expect("live after start"));
    let [r, _, b] = first_pixel(&recorder.writes.lock().unwrap()[0].1);
    assert!(r > b, "identity order leaves red in slot 0");

    let reordered = LightingModeConfig {
        color_order: Some(LedColorOrder::Bgr),
        ..mode.clone()
    };
    let result = apply_on(&mut owner, reordered);
    assert_eq!(
        result.status.code, "AMBILIGHT_MODE_UPDATED",
        "a colour-order change must not restart the worker"
    );
    assert!(Arc::ptr_eq(&live, owner.ambilight_live.as_ref().unwrap()));
    assert_eq!(live.read_color_order(), LedColorOrder::Bgr);
    assert_eq!(result.mode.color_order, Some(LedColorOrder::Bgr));

    let seen = recorder.writes.lock().unwrap().len();
    let deadline = Instant::now() + Duration::from_secs(3);
    let reached_the_wire = loop {
        let reordered_frame = recorder.writes.lock().unwrap()[seen..]
            .iter()
            .any(|(_, packet)| {
                let [r, _, b] = first_pixel(packet);
                b > r
            });
        if reordered_frame || Instant::now() > deadline {
            break reordered_frame;
        }
        thread::sleep(Duration::from_millis(20));
    };
    assert!(reached_the_wire, "the running worker sends red in slot 2");

    assert_eq!(
        apply_on(&mut owner, mode).status.code,
        "AMBILIGHT_MODE_UPDATED"
    );
    assert_eq!(
        live.read_color_order(),
        LedColorOrder::Rgb,
        "dropping the order returns to the identity"
    );

    let mut cleanup_trace = None;
    stop_previous(&mut owner, &mut cleanup_trace);
    wait_for_worker_count(0);
}

/// The first frame is sent before the loop starts; without its own
/// `set_color_order` it would go out in the identity order.
#[test]
fn the_first_frame_already_carries_the_color_order() {
    let _guard = acquire_worker_test_guard();
    let (mut owner, recorder) = owner_with_red_frame();
    let mode = LightingModeConfig {
        color_order: Some(LedColorOrder::Bgr),
        ..ambilight_mode_with_calibration(8)
    };

    assert_eq!(
        apply_on(&mut owner, mode).status.code,
        "AMBILIGHT_MODE_STARTED"
    );
    let [r, _, b] = first_pixel(&recorder.writes.lock().unwrap()[0].1);
    assert!(b > r, "the synchronous first send is already reordered");

    let mut cleanup_trace = None;
    stop_previous(&mut owner, &mut cleanup_trace);
    wait_for_worker_count(0);
}

#[test]
fn solid_writes_in_the_requested_color_order() {
    let (mut owner, recorder) = owner_with_red_frame();
    let mode = LightingModeConfig {
        kind: LightingModeKind::Solid,
        solid: Some(SolidColorPayload {
            r: 255,
            g: 0,
            b: 0,
            brightness: 1.0,
        }),
        targets: Some(vec!["usb".to_string()]),
        led_calibration: Some(ambilight_calibration_with_total_leds(4)),
        color_order: Some(LedColorOrder::Gbr),
        ..LightingModeConfig::default()
    };
    assert_eq!(apply_on(&mut owner, mode).status.code, "SOLID_MODE_APPLIED");
    let writes = recorder.writes.lock().unwrap();
    assert_eq!(first_pixel(&writes[0].1), [0, 0, 255]);
}

/// WLED has its own colour-order setting on the device; reordering here
/// too would apply the correction twice.
#[test]
fn a_wled_sink_ignores_the_color_order() {
    let receiver = std::net::UdpSocket::bind("127.0.0.1:0").expect("bind receiver");
    receiver
        .set_read_timeout(Some(Duration::from_secs(2)))
        .expect("read timeout");
    let config = WledSinkConfig {
        ip: "127.0.0.1".parse().expect("valid IPv4"),
        port: receiver.local_addr().expect("addr").port(),
        led_count: 2,
        protocol: WledProtocol::Ddp,
    };
    let mut sink = super::usb_output::ActiveUsbSink::Wled(
        crate::commands::wled_sink::CorrectedWledSink::new(config.build(), Default::default()),
    );
    sink.start().expect("start");

    let pixels = |sink: &mut super::usb_output::ActiveUsbSink| {
        sink.send_frame(&[[255, 0, 0], [0, 0, 255]]).expect("send");
        let mut buf = [0_u8; 64];
        let n = receiver.recv(&mut buf).expect("datagram");
        buf[10..n].to_vec()
    };
    assert_eq!(pixels(&mut sink), vec![255, 0, 0, 0, 0, 255]);
    sink.set_color_order(LedColorOrder::Bgr);
    assert_eq!(pixels(&mut sink), vec![255, 0, 0, 0, 0, 255]);
    sink.stop().expect("stop");
}
