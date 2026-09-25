//! The mode state machine end to end: the target gates, Hue sampling and its
//! live stream, room geometry, the ambilight fast path, Solid's full-strip
//! frame, output-stamp hydration and the edge-signal feed.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use super::config::normalize_mode_config;
use super::runtime::LightingRuntimeOwner;
use super::transition::apply_mode_change;
use super::{AmbilightPayload, LightingModeConfig, LightingModeKind, SolidColorPayload};
use crate::commands::ambilight_capture::{
    AmbilightCaptureError, AmbilightFrameSource, CapturedFrame,
};
use crate::commands::hue::commands::stop_hue_runtime;
use crate::commands::hue::frame::{HueAreaChannel, HueColorSender, HueScreenRegion};
use crate::commands::hue::light_restore::HueLightsAfterStop;
use crate::commands::hue::reconnect::store_active_stream_context;
use crate::commands::hue::retry::start_with_evidence;
use crate::commands::hue::sender::{
    is_shutdown_signaled, spawn_hue_http_sender, DeactivateToken, HueLightMetadata, ShutdownSignal,
    SpawnedHueSender,
};
use crate::commands::hue::state_store::test_helpers::strict_gate_ready;
use crate::commands::hue::state_store::{
    acquire_hue_runtime, HueActiveOutputContext, HueOutputLive, HueRuntimeStateStore,
    HueRuntimeTriggerSource, StartHueStreamRequest,
};
use crate::commands::led_output::{
    ColorCorrectionConfig, FirmwareProfile, LedChipType, LedColorOrder, LedOutputBridge,
    LedOutputError, LedPacketSender,
};
use crate::commands::runtime_telemetry::RuntimeTelemetrySnapshot;
use crate::commands::test_pattern::{TestPatternConfig, TestPatternKind, TestPatternSpeed};
use crate::models::room_map::{RoomDimensions, RoomGeometry, TvAnchorPlacement};

#[derive(Default)]
struct FakeLedSender {
    writes: Mutex<Vec<(String, Vec<u8>)>>,
}

impl LedPacketSender for FakeLedSender {
    fn send(&self, port_name: &str, packet: &[u8]) -> Result<(), LedOutputError> {
        self.writes
            .lock()
            .expect("writes lock poisoned")
            .push((port_name.to_string(), packet.to_vec()));
        Ok(())
    }

    fn disconnect_session(&self, _port_name: &str) {}
}

struct FakeFrameSource {
    frame: CapturedFrame,
}

impl AmbilightFrameSource for FakeFrameSource {
    fn capture_frame(&mut self) -> Result<Arc<CapturedFrame>, AmbilightCaptureError> {
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
        hue_gate_waived: false,
        frame_source_factory: Arc::new(|_req: super::runtime::AmbilightCaptureRequest| {
            Ok(Box::new(FakeFrameSource {
                frame: CapturedFrame::new(
                    2,
                    2,
                    vec![[10, 20, 30], [40, 50, 60], [70, 80, 90], [100, 110, 120]],
                ),
            }))
        }),
    }
}

fn shared_telemetry() -> Arc<Mutex<RuntimeTelemetrySnapshot>> {
    Arc::new(Mutex::new(RuntimeTelemetrySnapshot::default()))
}

/// Warms up once, then fails forever — the display-unplugged-mid-stream
/// shape. The first frame must succeed or `start_ambilight_worker` never
/// gets past its warm-up retry loop and no worker exists to observe.
struct FailsAfterFirstFrameSource {
    frame: CapturedFrame,
    served: std::sync::atomic::AtomicBool,
}

impl AmbilightFrameSource for FailsAfterFirstFrameSource {
    fn capture_frame(&mut self) -> Result<Arc<CapturedFrame>, AmbilightCaptureError> {
        if self.served.swap(true, std::sync::atomic::Ordering::SeqCst) {
            return Err(AmbilightCaptureError::InvalidFrame(
                "AMBILIGHT_CAPTURE_MONITOR_NOT_FOUND",
            ));
        }
        Ok(Arc::new(self.frame.clone()))
    }
}

fn owner_that_fails_after_first_frame() -> LightingRuntimeOwner {
    LightingRuntimeOwner {
        active_mode: LightingModeConfig::default(),
        active_port: None,
        worker: None,
        ambilight_live: None,
        room_geometry_live: None,
        output_bridge: LedOutputBridge::from_sender(Arc::new(FakeLedSender::default())),
        preview: Default::default(),
        closing: Default::default(),
        hue_gate_waived: false,
        frame_source_factory: Arc::new(|_req: super::runtime::AmbilightCaptureRequest| {
            Ok(Box::new(FailsAfterFirstFrameSource {
                frame: CapturedFrame::new(
                    2,
                    2,
                    vec![[10, 20, 30], [40, 50, 60], [70, 80, 90], [100, 110, 120]],
                ),
                served: std::sync::atomic::AtomicBool::new(false),
            }))
        }),
    }
}

/// Serialise a worker-touching test against the process-global
/// `ACTIVE_AMBILIGHT_WORKERS` counter, sharing the SAME lock as the sibling
/// `transition_tests` module. Hold the returned guard for the whole test body.
fn acquire_worker_test_guard() -> std::sync::MutexGuard<'static, ()> {
    super::WORKER_TEST_GUARD
        .lock()
        .unwrap_or_else(|e| e.into_inner())
}

/// Spin until the process-global active-worker count drains to zero (or a
/// short timeout elapses) so the guarded test releases its lock only after
/// its spawned workers have exited. Mirrors `transition_tests::wait_for_worker_count`
/// but is local to this module, which does not import the counter directly.
fn wait_for_workers_drained() {
    for _ in 0..20 {
        if super::ACTIVE_AMBILIGHT_WORKERS.load(std::sync::atomic::Ordering::SeqCst) == 0 {
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
}

fn ambilight_with_targets(targets: Option<Vec<String>>) -> LightingModeConfig {
    LightingModeConfig {
        kind: LightingModeKind::Ambilight,
        solid: None,
        ambilight: Some(AmbilightPayload {
            brightness: 1.0,
            ..Default::default()
        }),
        targets,
        display_id: None,
        led_calibration: None,
        color_correction: None,
        firmware_profile: None,
        chip_type: None,
        color_order: None,
        room_geometry: None,
    }
}

fn solid_with_targets(targets: Option<Vec<String>>) -> LightingModeConfig {
    LightingModeConfig {
        kind: LightingModeKind::Solid,
        solid: Some(SolidColorPayload {
            r: 255,
            g: 0,
            b: 0,
            brightness: 1.0,
        }),
        ambilight: None,
        targets,
        display_id: None,
        led_calibration: None,
        color_correction: None,
        firmware_profile: None,
        chip_type: None,
        color_order: None,
        room_geometry: None,
    }
}

#[test]
fn hue_only_target_bypasses_usb_gate() {
    // targets=["hue"], device_connected=false, hue_output=None
    // USB gate should be bypassed; Hue gate should fire (HUE_NOT_READY)
    // Either way: result must NOT be DEVICE_NOT_CONNECTED.
    let mut owner = owner_with_fake_sender();
    let result = apply_mode_change(
        &mut owner,
        solid_with_targets(Some(vec!["hue".to_string()])),
        false,
        // device not connected
        None,
        None,
        // no serial port
        None,
        // hue_output=None triggers HUE_NOT_READY gate
        None,
        None,
        None,
    );

    assert_ne!(
        result.status.code, "DEVICE_NOT_CONNECTED",
        "Hue-only target should bypass USB gate; got: {}",
        result.status.code
    );
    // Hue gate fires because hue_output is None
    assert_eq!(result.status.code, "HUE_NOT_READY");
}

#[test]
fn usb_target_requires_device_connected() {
    // targets=["usb"], device_connected=false -> DEVICE_NOT_CONNECTED
    let mut owner = owner_with_fake_sender();
    let result = apply_mode_change(
        &mut owner,
        solid_with_targets(Some(vec!["usb".to_string()])),
        false,
        // device not connected
        None,
        None,
        None,
        None,
        None,
        None,
    );

    assert_eq!(result.status.code, "DEVICE_NOT_CONNECTED");
}

/// A port name recorded while `connected` is false was never admitted by
/// `connect_serial_port`, so it must not become a serial plan.
#[test]
fn a_recorded_port_without_a_connection_does_not_arm_serial_output() {
    let mut owner = owner_with_fake_sender();
    let result = apply_mode_change(
        &mut owner,
        solid_with_targets(Some(vec!["usb".to_string()])),
        false,
        Some("/dev/cu.Bluetooth-Incoming-Port"),
        None,
        None,
        None,
        None,
        None,
    );

    assert_eq!(result.status.code, "DEVICE_NOT_CONNECTED");
    assert_eq!(owner.active_port, None);
}

#[test]
fn none_targets_preserves_legacy_usb_gate() {
    // targets=None, device_connected=false -> DEVICE_NOT_CONNECTED (backward compat)
    let mut owner = owner_with_fake_sender();
    let result = apply_mode_change(
        &mut owner,
        solid_with_targets(None),
        false,
        // device not connected
        None,
        None,
        None,
        None,
        None,
        None,
    );

    assert_eq!(result.status.code, "DEVICE_NOT_CONNECTED");
}

#[test]
fn hue_only_target_returns_hue_not_ready_when_no_hue_output() {
    // targets=["hue"], hue_output=None -> HUE_NOT_READY
    let mut owner = owner_with_fake_sender();
    let result = apply_mode_change(
        &mut owner,
        ambilight_with_targets(Some(vec!["hue".to_string()])),
        false, // device not connected (irrelevant for hue-only)
        None,
        None, // wled_sink
        None, // no hue output -> HUE_NOT_READY
        Some(shared_telemetry()),
        None,
        None,
    );

    assert_eq!(result.status.code, "HUE_NOT_READY");
}

fn solid_hue_only() -> LightingModeConfig {
    LightingModeConfig {
        kind: LightingModeKind::Solid,
        solid: Some(SolidColorPayload {
            r: 200,
            g: 10,
            b: 40,
            brightness: 1.0,
        }),
        ambilight: None,
        targets: Some(vec!["hue".to_string()]),
        display_id: None,
        led_calibration: None,
        color_correction: None,
        firmware_profile: None,
        chip_type: None,
        color_order: None,
        room_geometry: None,
    }
}

fn hue_context_with_channels(channel_count: usize) -> HueActiveOutputContext {
    HueActiveOutputContext {
        channels: (0..channel_count)
            .map(|i| HueAreaChannel {
                channel_id: i as u8,
                light_ids: vec![format!("light-{i}")],
                screen_region: HueScreenRegion::Center,
                position_x: 0.0,
                position_y: 0.0,
                position_z: None,
            })
            .collect(),
        color_sender: HueColorSender::with_mailbox(channel_count.max(1)).0,
    }
}

/// The runtime's slot as a mode change is handed it, already holding `context`.
fn live(context: HueActiveOutputContext) -> Option<Arc<HueOutputLive>> {
    Some(HueOutputLive::holding(context))
}

#[test]
fn a_channel_height_does_not_reach_the_scene_stage() {
    let at_height = |position_z: Option<f32>| {
        vec![
            HueAreaChannel {
                channel_id: 0,
                light_ids: vec!["light-0".to_string()],
                screen_region: HueScreenRegion::Left,
                position_x: -0.7,
                position_y: 0.4,
                position_z,
            },
            HueAreaChannel {
                channel_id: 3,
                light_ids: vec!["light-3".to_string()],
                screen_region: HueScreenRegion::Bottom,
                position_x: 0.1,
                position_y: -0.9,
                position_z: position_z.map(|z| -z),
            },
        ]
    };
    let points = |topology: crate::commands::ambilight_scene::LightTopology| match topology {
        crate::commands::ambilight_scene::LightTopology::Points(points) => points,
        other => panic!("expected points, got {other:?}"),
    };

    let (flat_topology, flat_affinity) =
        super::sampling::hue_topology_and_affinity(&at_height(None));
    for z in [Some(0.0), Some(1.0), Some(-1.0)] {
        let (topology, affinity) = super::sampling::hue_topology_and_affinity(&at_height(z));
        assert_eq!(points(topology), points(flat_topology.clone()));
        assert_eq!(affinity, flat_affinity);
        // What the worker actually calls: without geometry it is the legacy
        // table, sampling at the bridge's (x, y) whatever the height.
        let table = super::sampling::hue_sample_table(&at_height(z), None);
        assert_eq!(points(table.topology), points(flat_topology.clone()));
        assert_eq!(table.affinity, flat_affinity);
        assert_eq!(table.sample_points, vec![(-0.7, 0.4), (0.1, -0.9)]);
    }
    assert_eq!(points(flat_topology), vec![(-0.7, 0.4), (0.1, -0.9)]);
}

/// 4 × 5 × 2.5 m room, 1.2 m TV centred on the TV wall, default mount (1.0 m).
fn room_geometry(
    placements: Vec<crate::commands::hue::state_store::HueChannelPlacementOverride>,
) -> RoomGeometry {
    RoomGeometry {
        dimensions: RoomDimensions {
            width_meters: 4.0,
            depth_meters: 5.0,
            height_meters: 2.5,
        },
        tv: TvAnchorPlacement {
            x: 1.4,
            y: 0.0,
            width: 1.2,
            height: 0.1,
            locked: None,
            mount_height_meters: None,
        },
        hue_placements: placements,
    }
}

fn placement(
    channel_id: u8,
    x: f32,
    y: f32,
    z: Option<f32>,
) -> crate::commands::hue::state_store::HueChannelPlacementOverride {
    crate::commands::hue::state_store::HueChannelPlacementOverride {
        channel_id,
        position_x: x,
        position_y: y,
        position_z: z,
    }
}

fn channel(channel_id: u8, x: f32, y: f32, z: Option<f32>) -> HueAreaChannel {
    HueAreaChannel {
        channel_id,
        light_ids: vec![format!("light-{channel_id}")],
        screen_region: HueScreenRegion::Center,
        position_x: x,
        position_y: y,
        position_z: z,
    }
}

#[test]
fn a_channel_height_reaches_the_scene_stage_with_room_geometry() {
    let geometry = room_geometry(Vec::new());
    let at_height = |z: Option<f32>| {
        super::sampling::hue_sample_table(&[channel(0, 0.0, 1.0, z)], Some(&geometry))
    };
    let floor = at_height(Some(-1.0));
    let ceiling = at_height(Some(1.0));
    let unknown = at_height(None);
    assert!((floor.sample_points[0].1 + 1.0).abs() < 1e-5);
    assert!((ceiling.sample_points[0].1 - 1.0).abs() < 1e-5);
    assert_eq!(
        unknown.sample_points[0].1, 0.0,
        "unknown height samples at mount"
    );
    assert_ne!(floor.affinity, ceiling.affinity);
    assert!(
        (unknown.affinity[0] - 1.0).abs() < 1e-5,
        "at the screen centre"
    );

    // Depth no longer drives vertical: the legacy table put a TV-wall light
    // at the top row whatever its height.
    let legacy = super::sampling::hue_sample_table(&[channel(0, 0.0, 1.0, Some(-1.0))], None);
    assert_eq!(legacy.sample_points[0], (0.0, 1.0));
}

#[test]
fn room_geometry_placements_overlay_the_stream_channels_by_channel_id() {
    // Ordinal 1 is channel 3: matching by position in the list would move
    // the wrong light.
    let channels = [channel(0, -0.5, 1.0, None), channel(3, 0.0, 1.0, None)];
    let unmoved = super::sampling::hue_sample_table(&channels, Some(&room_geometry(Vec::new())));
    let moved = super::sampling::hue_sample_table(
        &channels,
        Some(&room_geometry(vec![
            placement(3, 0.3, 1.0, Some(1.0)),
            placement(9, 0.9, 0.0, None),
        ])),
    );
    assert_eq!(moved.sample_points[0], unmoved.sample_points[0]);
    assert!((moved.sample_points[1].0 - 1.0).abs() < 1e-5);
    assert!((moved.sample_points[1].1 - 1.0).abs() < 1e-5);
    assert_eq!(
        moved.sample_points.len(),
        2,
        "an unknown channel_id is skipped"
    );
}

#[test]
fn invalid_room_geometry_falls_back_to_the_legacy_table() {
    let channels = [channel(0, -0.7, 0.4, Some(1.0))];
    let mut broken = room_geometry(vec![placement(0, 0.5, 0.5, None)]);
    broken.dimensions.width_meters = 0.0;
    let table = super::sampling::hue_sample_table(&channels, Some(&broken));
    let legacy = super::sampling::hue_sample_table(&channels, None);
    assert_eq!(table.sample_points, legacy.sample_points);
    assert_eq!(table.affinity, legacy.affinity);
}

#[test]
fn normalize_mode_config_carries_room_geometry_only_for_ambilight() {
    let geometry = room_geometry(vec![placement(0, 0.1, 0.2, Some(0.3))]);
    let with_geometry = |kind: LightingModeKind| LightingModeConfig {
        kind,
        room_geometry: Some(geometry.clone()),
        ..LightingModeConfig::default()
    };
    assert_eq!(
        normalize_mode_config(with_geometry(LightingModeKind::Ambilight)).room_geometry,
        Some(geometry.clone())
    );
    assert_eq!(
        normalize_mode_config(with_geometry(LightingModeKind::Solid)).room_geometry,
        None
    );
    assert_eq!(
        normalize_mode_config(with_geometry(LightingModeKind::Off)).room_geometry,
        None
    );
}

#[test]
fn absent_room_geometry_serializes_without_the_key() {
    let without = serde_json::to_value(ambilight_with_payload(AmbilightPayload {
        brightness: 1.0,
        ..Default::default()
    }))
    .expect("serialize");
    assert!(without.get("roomGeometry").is_none(), "{without}");

    let wire = serde_json::json!({
        "kind": "ambilight",
        "ambilight": { "brightness": 1.0 },
        "roomGeometry": {
            "dimensions": { "widthMeters": 4.0, "depthMeters": 5.0, "heightMeters": 2.5 },
            "tv": { "x": 1.4, "y": 0.0, "width": 1.2, "height": 0.1 },
            "huePlacements": [{ "channelId": 3, "positionX": 0.25, "positionY": 1.0 }]
        }
    });
    let parsed: LightingModeConfig = serde_json::from_value(wire.clone()).expect("parse");
    assert_eq!(
        parsed.room_geometry,
        Some(room_geometry(vec![placement(3, 0.25, 1.0, None)]))
    );
    let echoed = serde_json::to_value(&parsed).expect("serialize");
    assert_eq!(
        echoed["roomGeometry"], wire["roomGeometry"],
        "echo is byte-identical"
    );
}

#[test]
fn a_room_geometry_change_retunes_the_running_worker_in_place() {
    let _guard = acquire_worker_test_guard();
    let mut owner = owner_with_fake_sender();
    let base = ambilight_with_payload(AmbilightPayload {
        brightness: 0.8,
        ..Default::default()
    });
    let apply = |owner: &mut LightingRuntimeOwner, mode: LightingModeConfig| {
        apply_mode_change(
            owner,
            mode,
            true,
            Some("COM-RG"),
            None,
            None,
            Some(shared_telemetry()),
            None,
            None,
        )
    };

    assert_eq!(
        apply(&mut owner, base.clone()).status.code,
        "AMBILIGHT_MODE_STARTED"
    );
    let cell = Arc::clone(owner.room_geometry_live.as_ref().expect("cell after start"));
    let live = Arc::clone(owner.ambilight_live.as_ref().expect("live after start"));
    assert_eq!(cell.generation(), 0);

    let geometry = room_geometry(vec![placement(0, 0.2, 0.9, Some(0.5))]);
    let placed = LightingModeConfig {
        room_geometry: Some(geometry.clone()),
        ..base.clone()
    };
    let result = apply(&mut owner, placed.clone());
    assert_eq!(
        result.status.code, "AMBILIGHT_MODE_UPDATED",
        "a room-map drag must not restart the worker"
    );
    assert!(Arc::ptr_eq(
        &cell,
        owner.room_geometry_live.as_ref().unwrap()
    ));
    assert!(Arc::ptr_eq(&live, owner.ambilight_live.as_ref().unwrap()));
    assert_eq!(cell.generation(), 1);
    assert_eq!(cell.snapshot(), (1, Some(geometry.clone())));
    assert_eq!(result.mode.room_geometry, Some(geometry));

    assert_eq!(
        apply(&mut owner, placed).status.code,
        "AMBILIGHT_MODE_UPDATED"
    );
    assert_eq!(cell.generation(), 1, "an unchanged geometry does not bump");

    assert_eq!(
        apply(&mut owner, base).status.code,
        "AMBILIGHT_MODE_UPDATED"
    );
    assert_eq!(
        cell.snapshot(),
        (2, None),
        "removing the TV anchor clears the cell"
    );

    let mut cleanup_trace = None;
    super::transition::stop_previous(&mut owner, &mut cleanup_trace);
    assert!(owner.room_geometry_live.is_none());
    wait_for_workers_drained();
}

/// Top half red, bottom half blue — which half a Hue channel samples is
/// visible in the colour it sends.
fn split_frame_owner() -> LightingRuntimeOwner {
    let mut owner = owner_with_fake_sender();
    owner.frame_source_factory = Arc::new(|_req: super::runtime::AmbilightCaptureRequest| {
        let (w, h) = (64u32, 64u32);
        let pixels_rgb = (0..h)
            .flat_map(|row| {
                let px = if row < h / 2 {
                    [220, 0, 0]
                } else {
                    [0, 0, 220]
                };
                std::iter::repeat_n(px, w as usize)
            })
            .collect();
        Ok(Box::new(FakeFrameSource {
            frame: CapturedFrame::new(w, h, pixels_rgb),
        }))
    });
    owner
}

/// A new colour every capture, so every Hue frame is a light PUT the
/// fallback sender has to make.
struct CyclingFrameSource {
    tick: u8,
}

impl AmbilightFrameSource for CyclingFrameSource {
    fn capture_frame(&mut self) -> Result<Arc<CapturedFrame>, AmbilightCaptureError> {
        self.tick = self.tick.wrapping_add(47);
        Ok(Arc::new(CapturedFrame::new(
            2,
            2,
            vec![[self.tick, 255 - self.tick, 90]; 4],
        )))
    }
}

fn hue_mode(targets: &[&str]) -> LightingModeConfig {
    LightingModeConfig {
        kind: LightingModeKind::Ambilight,
        ambilight: Some(AmbilightPayload {
            brightness: 1.0,
            smoothing_alpha: Some(1.0),
            ..Default::default()
        }),
        targets: Some(targets.iter().map(|t| t.to_string()).collect()),
        ..LightingModeConfig::default()
    }
}

fn hue_request(bridge_ip: &str, area_id: &str) -> StartHueStreamRequest {
    StartHueStreamRequest {
        bridge_ip: bridge_ip.to_string(),
        username: "app-key".to_string(),
        client_key: String::new(),
        area_id: area_id.to_string(),
        trigger_source: Some(HueRuntimeTriggerSource::ModeControl),
        channel_placements: None,
    }
}

fn wait_until(what: &str, done: impl Fn() -> bool) {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    while !done() {
        assert!(std::time::Instant::now() < deadline, "{what}");
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
}

/// A running Hue runtime whose stream is the HTTP fallback sender against
/// `bridge`, stored the way a start stores it — which also fills the slot
/// a mode change hands the worker.
fn running_http_fallback(
    bridge: &crate::commands::hue::test_bridge::TestBridge,
) -> (HueRuntimeStateStore, ShutdownSignal) {
    let channels = vec![channel(0, 0.0, 1.0, None)];
    let (color_sender, sender_exited) = spawn_hue_http_sender(
        crate::commands::hue::transport::blocking_client_for_key("app-key").expect("client"),
        bridge.authority.clone(),
        "app-key".to_string(),
        channels.clone(),
    );
    let store = HueRuntimeStateStore::default();
    {
        let mut owner = acquire_hue_runtime(&store.runtime);
        let _ = start_with_evidence(
            &mut owner,
            &strict_gate_ready(),
            HueRuntimeTriggerSource::ModeControl,
        );
        store_active_stream_context(
            &mut owner,
            &hue_request(&bridge.authority, "area"),
            channels,
            SpawnedHueSender {
                color_sender,
                uses_dtls: false,
                shutdown_signal: Arc::clone(&sender_exited),
                cipher_name: None,
                deactivate_token: DeactivateToken::new(),
            },
        );
    }
    (store, sender_exited)
}

/// Removing Hue from a running `[usb, hue]` mode: the frontend re-applies
/// the mode on USB, then `stop_hue_stream` stops the stream and waits for
/// the sender thread to exit before it restores the lights. The re-applied
/// worker must not keep the sender alive, or it paints the lights after
/// the restore.
#[test]
fn a_mode_re_applied_without_hue_lets_the_hue_sender_exit() {
    use crate::commands::hue::test_bridge::{Reply, TestBridge};

    let _guard = acquire_worker_test_guard();
    let bridge = TestBridge::start(|_, _, _| Reply::ok());
    let light_puts = || bridge.puts_to("/clip/v2/resource/light/").len();
    let (store, sender_exited) = running_http_fallback(&bridge);

    let mut owner = owner_with_fake_sender();
    owner.frame_source_factory = Arc::new(|_req: super::runtime::AmbilightCaptureRequest| {
        Ok(Box::new(CyclingFrameSource { tick: 0 }))
    });
    let mut apply = |targets: &[&str]| {
        apply_mode_change(
            &mut owner,
            hue_mode(targets),
            true,
            Some("COM-HUE"),
            None,
            Some(store.output_live()),
            Some(shared_telemetry()),
            None,
            None,
        )
        .status
        .code
    };

    assert_eq!(apply(&["usb", "hue"]), "AMBILIGHT_MODE_STARTED");
    wait_until("the worker never drove the Hue sender", || {
        light_puts() >= 2
    });

    assert_eq!(apply(&["usb"]), "AMBILIGHT_MODE_STARTED");
    let stopped = stop_hue_runtime(
        &store.runtime_arc(),
        HueRuntimeTriggerSource::ModeControl,
        None,
        HueLightsAfterStop::Restore,
    );

    assert_eq!(stopped.status.code, "HUE_STREAM_STOPPED");
    assert!(is_shutdown_signaled(&sender_exited));
    // The restore would start here; nothing may reach a light after it.
    let at_restore = light_puts();
    std::thread::sleep(Duration::from_millis(400));
    assert_eq!(light_puts(), at_restore);
    assert!(owner.worker.is_some(), "USB keeps running");

    let mut cleanup_trace = None;
    super::transition::stop_previous(&mut owner, &mut cleanup_trace);
    wait_for_workers_drained();
}

/// `stop_hue_stream` under a worker whose targets still name Hue — Off from
/// a Hue-only mode, or a Hue stop the frontend sent before the re-apply. The
/// worker follows the runtime's slot, so it lets go of the sender within a
/// frame: the stop sees the sender exit instead of timing out as
/// `HUE_STOP_TIMEOUT_PARTIAL`, nothing reaches a light after it, and the
/// worker goes on driving the strip.
fn assert_a_hue_stop_under_a_live_worker_lets_the_sender_exit(targets: &[&str]) {
    use crate::commands::hue::test_bridge::{Reply, TestBridge};

    let _guard = acquire_worker_test_guard();
    let bridge = TestBridge::start(|_, _, _| Reply::ok());
    let light_puts = || bridge.puts_to("/clip/v2/resource/light/").len();
    let (store, sender_exited) = running_http_fallback(&bridge);

    let usb = Arc::new(FakeLedSender::default());
    let usb_writes = || usb.writes.lock().expect("writes lock").len();
    let mut owner = owner_with_fake_sender();
    owner.output_bridge = LedOutputBridge::from_sender(usb.clone());
    owner.frame_source_factory = Arc::new(|_req: super::runtime::AmbilightCaptureRequest| {
        Ok(Box::new(CyclingFrameSource { tick: 0 }))
    });
    let started = apply_mode_change(
        &mut owner,
        hue_mode(targets),
        true,
        Some("COM-HUE"),
        None,
        Some(store.output_live()),
        Some(shared_telemetry()),
        None,
        None,
    );
    assert_eq!(started.status.code, "AMBILIGHT_MODE_STARTED");
    wait_until("the worker never drove the Hue sender", || {
        light_puts() >= 2
    });

    let stopped = stop_hue_runtime(
        &store.runtime_arc(),
        HueRuntimeTriggerSource::ModeControl,
        None,
        HueLightsAfterStop::Restore,
    );

    assert_eq!(stopped.status.code, "HUE_STREAM_STOPPED");
    assert!(is_shutdown_signaled(&sender_exited));
    let at_restore = light_puts();
    std::thread::sleep(Duration::from_millis(400));
    assert_eq!(
        light_puts(),
        at_restore,
        "a light was painted after the stop"
    );
    assert!(owner.worker.is_some(), "the mode itself is not stopped");
    if targets.contains(&"usb") {
        let before = usb_writes();
        wait_until("the strip stopped with the Hue stream", || {
            usb_writes() > before
        });
    }

    let mut cleanup_trace = None;
    super::transition::stop_previous(&mut owner, &mut cleanup_trace);
    wait_for_workers_drained();
}

#[test]
fn a_hue_stop_under_a_hue_only_worker_lets_the_sender_exit() {
    assert_a_hue_stop_under_a_live_worker_lets_the_sender_exit(&["hue"]);
}

#[test]
fn a_hue_stop_under_a_usb_and_hue_worker_lets_the_sender_exit() {
    assert_a_hue_stop_under_a_live_worker_lets_the_sender_exit(&["usb", "hue"]);
}

/// The slot is handed to every mode change, whatever its targets. A worker
/// whose targets leave Hue out must never sample or send Hue from it.
#[test]
fn a_worker_without_a_hue_target_never_uses_a_live_hue_stream() {
    let _guard = acquire_worker_test_guard();
    let (color_sender, frames) = HueColorSender::recording(1);
    let hue = live(HueActiveOutputContext {
        channels: vec![channel(0, 0.0, 1.0, None)],
        color_sender,
    });
    let mut owner = owner_with_fake_sender();
    owner.frame_source_factory = Arc::new(|_req: super::runtime::AmbilightCaptureRequest| {
        Ok(Box::new(CyclingFrameSource { tick: 0 }))
    });

    let started = apply_mode_change(
        &mut owner,
        hue_mode(&["usb"]),
        true,
        Some("COM-HUE"),
        None,
        hue,
        Some(shared_telemetry()),
        None,
        None,
    );
    assert_eq!(started.status.code, "AMBILIGHT_MODE_STARTED");
    std::thread::sleep(Duration::from_millis(300));
    assert!(
        frames.try_recv().is_err(),
        "a USB-only worker sent a Hue frame"
    );

    let mut cleanup_trace = None;
    super::transition::stop_previous(&mut owner, &mut cleanup_trace);
    wait_for_workers_drained();
}

/// Stands in for one DTLS session: the real send loop, writing into a
/// counter instead of a socket.
#[cfg(debug_assertions)]
#[derive(Default)]
struct DtlsSession {
    frames: std::sync::atomic::AtomicUsize,
    exited: std::sync::atomic::AtomicBool,
}

#[cfg(debug_assertions)]
struct CountingSocket(Arc<DtlsSession>);

#[cfg(debug_assertions)]
impl std::io::Write for CountingSocket {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0
            .frames
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

/// Item 7: a reconnect replaced the stream and its sender, and the worker
/// went on writing to the one it was handed at start, so the status read
/// Running while the lamps froze. `simulate_hue_fault` fires the stream's
/// shutdown signal; the reconnect monitor then rebuilds the stream, and the
/// worker must follow it there. The stand-in sessions keep-alive only once
/// a minute, so every frame they count came from the worker.
#[cfg(debug_assertions)]
#[test]
fn a_reconnect_hands_the_running_worker_the_new_sender() {
    let _watchdog = super::Watchdog::arm(
        "a_reconnect_hands_the_running_worker_the_new_sender",
        Duration::from_secs(90),
    );
    use std::sync::atomic::Ordering as AtomicOrdering;
    use tauri::Manager;

    use crate::commands::hue::commands::simulate_hue_fault;
    use crate::commands::hue::reconnect::{
        spawn_reconnect_monitor_with, HueSenderBuild, ReconnectDeps,
    };
    use crate::commands::hue::sender::{
        new_shutdown_signal, signal_shutdown_complete, DtlsSendLoop, HUE_SENDER_MIN_INTERVAL_MS,
    };
    use crate::commands::hue::state_store::HueRuntimeState;
    use crate::commands::hue::test_bridge::{light_json, FakeHue, Reply};

    let _guard = acquire_worker_test_guard();
    let hue = FakeHue::start(
        &[("living-room", &["light-1"])],
        &[("light-1", light_json(true, 100.0, None, (0.6, 0.3)))],
        |_| Reply::ok(),
    );
    let request = hue_request(&hue.bridge.authority, "living-room");

    let sessions: Arc<Mutex<Vec<Arc<DtlsSession>>>> = Arc::default();
    let build: HueSenderBuild = {
        let sessions = Arc::clone(&sessions);
        Arc::new(
            move |request: &StartHueStreamRequest,
                  channels: Vec<HueAreaChannel>,
                  light_metadata: Arc<std::collections::HashMap<String, HueLightMetadata>>,
                  packet_counter: Arc<std::sync::atomic::AtomicU32>| {
                let session = Arc::new(DtlsSession::default());
                sessions
                    .lock()
                    .expect("sessions")
                    .push(Arc::clone(&session));
                let (color_sender, rx) = HueColorSender::with_mailbox(channels.len());
                let shutdown = new_shutdown_signal();
                let signal = Arc::clone(&shutdown);
                let deactivate_token = DeactivateToken::new();
                let token = Arc::clone(&deactivate_token);
                let area_id = request.area_id.clone();
                std::thread::spawn(move || {
                    DtlsSendLoop {
                        area_id: &area_id,
                        channels: &channels,
                        light_metadata: &light_metadata,
                        packet_counter: &packet_counter,
                        deactivate_token: &token,
                        min_interval: Duration::from_millis(HUE_SENDER_MIN_INTERVAL_MS),
                        keepalive: Duration::from_secs(60),
                    }
                    .run(&mut CountingSocket(Arc::clone(&session)), &rx);
                    session.exited.store(true, AtomicOrdering::SeqCst);
                    signal_shutdown_complete(&signal);
                });
                SpawnedHueSender {
                    color_sender,
                    uses_dtls: true,
                    shutdown_signal: shutdown,
                    cipher_name: Some("PSK-AES128-GCM-SHA256".to_string()),
                    deactivate_token,
                }
            },
        )
    };
    let session = |n: usize| Arc::clone(&sessions.lock().expect("sessions")[n]);

    // Dropping a runtime waits for its blocking tasks, and the reconnect
    // monitor's wait is one; a failed assertion must fail, not hang.
    struct Abandoned(Option<tokio::runtime::Runtime>);
    impl Drop for Abandoned {
        fn drop(&mut self) {
            if let Some(rt) = self.0.take() {
                rt.shutdown_background();
            }
        }
    }
    let rt = Abandoned(Some(
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .expect("tokio runtime"),
    ));
    let app = tauri::test::mock_app();
    app.manage(HueRuntimeStateStore::default());
    let store = app.state::<HueRuntimeStateStore>();
    let runtime = store.runtime_arc();
    {
        let mut owner = acquire_hue_runtime(&runtime);
        let _ = start_with_evidence(
            &mut owner,
            &strict_gate_ready(),
            HueRuntimeTriggerSource::ModeControl,
        );
        let channels = vec![channel(0, 0.0, 1.0, None)];
        let spawned = build(
            &request,
            channels.clone(),
            Arc::default(),
            Arc::clone(&owner.packet_send_count),
        );
        let signal = Arc::clone(&spawned.shutdown_signal);
        store_active_stream_context(&mut owner, &request, channels, spawned);
        let _enter = rt.0.as_ref().expect("runtime").enter();
        spawn_reconnect_monitor_with(
            signal,
            Arc::clone(&runtime),
            request.clone(),
            ReconnectDeps::assume_ready(Arc::clone(&build)),
        );
    }

    let mut owner = owner_with_fake_sender();
    owner.frame_source_factory = Arc::new(|_req: super::runtime::AmbilightCaptureRequest| {
        Ok(Box::new(CyclingFrameSource { tick: 0 }))
    });
    let started = apply_mode_change(
        &mut owner,
        hue_mode(&["hue"]),
        false,
        None,
        None,
        Some(store.output_live()),
        Some(shared_telemetry()),
        None,
        None,
    );
    assert_eq!(started.status.code, "AMBILIGHT_MODE_STARTED");
    let first = session(0);
    wait_until("the worker never reached the first sender", || {
        first.frames.load(AtomicOrdering::SeqCst) >= 3
    });

    assert_eq!(
        simulate_hue_fault(app.state::<HueRuntimeStateStore>()).code,
        "HUE_FAULT_SIMULATED"
    );
    wait_until("the reconnect never built a second sender", || {
        sessions.lock().expect("sessions").len() == 2
    });
    let second = session(1);
    wait_until("the worker never reached the reconnected sender", || {
        second.frames.load(AtomicOrdering::SeqCst) >= 3
    });
    wait_until("a handle kept the first sender alive", || {
        first.exited.load(AtomicOrdering::SeqCst)
    });
    let packets = || {
        acquire_hue_runtime(&runtime)
            .packet_send_count
            .load(AtomicOrdering::SeqCst)
    };
    let before = packets();
    wait_until("the telemetry frame counter stopped", || packets() > before);
    assert_eq!(
        acquire_hue_runtime(&runtime).state,
        HueRuntimeState::Running
    );

    let mut cleanup_trace = None;
    super::transition::stop_previous(&mut owner, &mut cleanup_trace);
    let stopped = stop_hue_runtime(
        &runtime,
        HueRuntimeTriggerSource::ModeControl,
        None,
        HueLightsAfterStop::Restore,
    );
    assert_eq!(stopped.status.code, "HUE_STREAM_STOPPED");
    wait_for_workers_drained();
    drop(rt);
}

#[test]
fn a_live_room_geometry_update_reaches_hue_sampling() {
    let _guard = acquire_worker_test_guard();
    let mut owner = split_frame_owner();
    let (color_sender, rx) = HueColorSender::with_mailbox(1);
    let hue = live(HueActiveOutputContext {
        channels: vec![channel(0, 0.0, 1.0, None)],
        color_sender,
    });
    let mode_at = |z: f32| LightingModeConfig {
        kind: LightingModeKind::Ambilight,
        ambilight: Some(AmbilightPayload {
            brightness: 1.0,
            smoothing_alpha: Some(1.0),
            ..Default::default()
        }),
        targets: Some(vec!["hue".to_string()]),
        room_geometry: Some(room_geometry(vec![placement(0, 0.0, 1.0, Some(z))])),
        ..LightingModeConfig::default()
    };
    let apply = |owner: &mut LightingRuntimeOwner, mode: LightingModeConfig| {
        apply_mode_change(
            owner,
            mode,
            false,
            None,
            None,
            hue.clone(),
            Some(shared_telemetry()),
            None,
            None,
        )
    };
    // Blue-dominant vs red-dominant: the scene stage mixes in some ambience,
    // so the test asserts which half wins, not an exact colour.
    let wait_for = |want_red: bool| {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while std::time::Instant::now() < deadline {
            if let Ok(update) = rx.recv_timeout(std::time::Duration::from_millis(100)) {
                let [r, _, b] = update.channel_colors[0];
                if (r > b) == want_red && r != b {
                    return true;
                }
            }
        }
        false
    };

    assert_eq!(
        apply(&mut owner, mode_at(-1.0)).status.code,
        "AMBILIGHT_MODE_STARTED"
    );
    assert!(
        wait_for(false),
        "a floor-level light must sample the bottom (blue) half"
    );

    assert_eq!(
        apply(&mut owner, mode_at(1.0)).status.code,
        "AMBILIGHT_MODE_UPDATED"
    );
    assert!(
        wait_for(true),
        "the live update must move it to the top (red) half"
    );

    let mut cleanup_trace = None;
    super::transition::stop_previous(&mut owner, &mut cleanup_trace);
    wait_for_workers_drained();
}

#[test]
fn solid_hue_only_reports_applied_when_the_color_reaches_the_sender() {
    let mut owner = owner_with_fake_sender();
    let result = apply_mode_change(
        &mut owner,
        solid_hue_only(),
        false,
        None,
        None,
        live(hue_context_with_channels(2)),
        Some(shared_telemetry()),
        None,
        None,
    );

    assert_eq!(result.status.code, "SOLID_MODE_APPLIED");
}

/// Regression: an empty-channel Hue context made `apply_hue_color_with_context`
/// return `HUE_COLOR_APPLY_SKIPPED_NO_LIGHTS`, which was discarded with
/// `let _ =` while the command still reported `SOLID_MODE_APPLIED` — a
/// success status for a mode where no packet reached any sink.
#[test]
fn solid_hue_only_reports_skipped_when_no_lights_resolve() {
    let mut owner = owner_with_fake_sender();
    let result = apply_mode_change(
        &mut owner,
        solid_hue_only(),
        false,
        None,
        None,
        live(hue_context_with_channels(0)),
        Some(shared_telemetry()),
        None,
        None,
    );

    assert_eq!(result.status.code, "SOLID_MODE_HUE_OUTPUT_SKIPPED");
    assert_eq!(
        result.status.details.as_deref(),
        Some("HUE_COLOR_APPLY_SKIPPED_NO_LIGHTS")
    );
}

// ---------------------------------------------------------------------------
// Fast-path None preservation — saturation / smoothing_alpha must NOT
// collapse to defaults when an incoming payload omits them.
//
// Repro for the v1.5 manual-test regression "ambilight saturation /
// smoothing reset on every brightness slider tweak": frontend pushed
// brightness-only payloads with `saturation: None` and `smoothing_alpha:
// None`, and the fast path's old `unwrap_or(1.0)` / `unwrap_or(0.35)`
// silently clobbered the user's tuned values. The new behaviour reads
// the live atomic on None so the running worker keeps its current state.
// ---------------------------------------------------------------------------

fn ambilight_with_payload(payload: AmbilightPayload) -> LightingModeConfig {
    LightingModeConfig {
        kind: LightingModeKind::Ambilight,
        solid: None,
        ambilight: Some(payload),
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

#[test]
fn a_worker_failing_mid_stream_reaches_telemetry() {
    // The start already returned AMBILIGHT_MODE_STARTED, so a status code
    // can never carry this — and the only other flush lives on the success
    // branch, which a failing worker never takes.
    let _guard = acquire_worker_test_guard();
    let mut owner = owner_that_fails_after_first_frame();
    let telemetry = shared_telemetry();

    let started = apply_mode_change(
        &mut owner,
        ambilight_with_payload(AmbilightPayload {
            brightness: 1.0,
            ..Default::default()
        }),
        true,
        Some("COM-MIDFAIL"),
        None,
        None,
        Some(Arc::clone(&telemetry)),
        None,
        None,
    );
    assert_eq!(started.status.code, "AMBILIGHT_MODE_STARTED");

    // One TELEMETRY_WINDOW must elapse before the failure path flushes, and
    // the first flushed window still counts the warm-up frame — the frozen
    // capture_fps only falls to zero on the window after that.
    let mut observed = None;
    for _ in 0..60 {
        std::thread::sleep(std::time::Duration::from_millis(50));
        let snapshot = telemetry.lock().expect("telemetry lock").clone();
        if snapshot.last_capture_error_code.is_some() && snapshot.capture_fps == 0.0 {
            observed = Some(snapshot);
            break;
        }
    }

    let mut cleanup_trace = None;
    super::transition::stop_previous(&mut owner, &mut cleanup_trace);
    wait_for_workers_drained();

    let snapshot = observed.expect("a mid-stream capture failure must reach telemetry");
    assert_eq!(
        snapshot.last_capture_error_code.as_deref(),
        Some("AMBILIGHT_CAPTURE_MONITOR_NOT_FOUND")
    );
    assert_eq!(snapshot.last_capture_error_at_secs, Some(0));
}

fn test_config(kind: TestPatternKind, speed: TestPatternSpeed, aspect: f32) -> TestPatternConfig {
    TestPatternConfig {
        kind,
        brightness: 0.5,
        speed,
        display_aspect: aspect,
    }
}

fn red_chase() -> TestPatternKind {
    TestPatternKind::Chase { r: 255, g: 0, b: 0 }
}

/// R15: a colour or speed change during a running test used to tear the
/// worker down and build a new one, which is why the frontend had to throttle
/// a continuous drag to 4 Hz.
#[test]
fn a_running_test_retunes_in_place_instead_of_rebuilding() {
    let _guard = acquire_worker_test_guard();
    let mut owner = owner_with_fake_sender();

    owner.preview.pending_test_pattern =
        Some(test_config(red_chase(), TestPatternSpeed::Slow, 1.78));
    let started = apply_mode_change(
        &mut owner,
        ambilight_with_payload(AmbilightPayload {
            brightness: 0.5,
            ..Default::default()
        }),
        true,
        Some("COM-R15"),
        None,
        None,
        Some(shared_telemetry()),
        None,
        None,
    );
    assert_eq!(started.status.code, "AMBILIGHT_MODE_STARTED");
    let slot = owner
        .preview
        .pattern_live
        .clone()
        .expect("a synthetic worker must publish its live cell");

    owner.preview.pending_test_pattern = Some(test_config(
        TestPatternKind::Spiral,
        TestPatternSpeed::Fast,
        1.78,
    ));
    let retuned = apply_mode_change(
        &mut owner,
        ambilight_with_payload(AmbilightPayload {
            brightness: 0.5,
            ..Default::default()
        }),
        true,
        Some("COM-R15"),
        None,
        None,
        Some(shared_telemetry()),
        None,
        None,
    );
    assert_eq!(
        retuned.status.code, "AMBILIGHT_MODE_UPDATED",
        "a pattern tweak on a running test must not rebuild the worker",
    );

    let cell = slot.lock().expect("live cell");
    assert_eq!(cell.kind, TestPatternKind::Spiral);
    assert_eq!(cell.speed, TestPatternSpeed::Fast);
    drop(cell);
    assert_eq!(
        owner.preview.active_test_pattern.as_ref().map(|c| &c.kind),
        Some(&TestPatternKind::Spiral),
        "the retune must also move the reported active pattern",
    );

    let mut cleanup_trace = None;
    super::transition::stop_previous(&mut owner, &mut cleanup_trace);
    wait_for_workers_drained();
}

/// The frame size is baked into the source, so a display swap is the one
/// test-to-test change the cell cannot carry.
#[test]
fn a_display_aspect_change_still_rebuilds_the_source() {
    let _guard = acquire_worker_test_guard();
    let mut owner = owner_with_fake_sender();

    owner.preview.pending_test_pattern =
        Some(test_config(red_chase(), TestPatternSpeed::Slow, 1.78));
    let payload = ambilight_with_payload(AmbilightPayload {
        brightness: 0.5,
        ..Default::default()
    });
    let started = apply_mode_change(
        &mut owner,
        payload.clone(),
        true,
        Some("COM-R15B"),
        None,
        None,
        Some(shared_telemetry()),
        None,
        None,
    );
    assert_eq!(started.status.code, "AMBILIGHT_MODE_STARTED");

    owner.preview.pending_test_pattern =
        Some(test_config(red_chase(), TestPatternSpeed::Slow, 1.6));
    let after = apply_mode_change(
        &mut owner,
        payload,
        true,
        Some("COM-R15B"),
        None,
        None,
        Some(shared_telemetry()),
        None,
        None,
    );
    assert_eq!(after.status.code, "AMBILIGHT_MODE_STARTED");

    let mut cleanup_trace = None;
    super::transition::stop_previous(&mut owner, &mut cleanup_trace);
    wait_for_workers_drained();
}

/// Live→test needs a synthetic source built, so it can never be a retune
/// however similar the rest of the config looks.
#[test]
fn starting_a_test_over_live_ambilight_rebuilds() {
    let _guard = acquire_worker_test_guard();
    let mut owner = owner_with_fake_sender();

    let payload = ambilight_with_payload(AmbilightPayload {
        brightness: 0.5,
        ..Default::default()
    });
    let live = apply_mode_change(
        &mut owner,
        payload.clone(),
        true,
        Some("COM-R15C"),
        None,
        None,
        Some(shared_telemetry()),
        None,
        None,
    );
    assert_eq!(live.status.code, "AMBILIGHT_MODE_STARTED");
    assert!(owner.preview.pattern_live.is_none());

    owner.preview.pending_test_pattern =
        Some(test_config(red_chase(), TestPatternSpeed::Slow, 1.78));
    let to_test = apply_mode_change(
        &mut owner,
        payload,
        true,
        Some("COM-R15C"),
        None,
        None,
        Some(shared_telemetry()),
        None,
        None,
    );
    assert_eq!(to_test.status.code, "AMBILIGHT_MODE_STARTED");
    assert!(owner.preview.pattern_live.is_some());

    let mut cleanup_trace = None;
    super::transition::stop_previous(&mut owner, &mut cleanup_trace);
    wait_for_workers_drained();
}

/// The chip type decides the wire format — SK6812 RGBW emits four bytes per
/// pixel where WS2812B emits three — and it is read only when the encoder is
/// built. Left out of the fast-path guard, a chip change took the in-place
/// retune and the strip kept being driven with the previous format.
#[test]
fn fast_path_guard_restarts_the_worker_on_a_chip_type_change() {
    let _guard = acquire_worker_test_guard();
    let mut owner = owner_with_fake_sender();

    let mut start = ambilight_with_payload(AmbilightPayload {
        brightness: 0.8,
        ..Default::default()
    });
    start.chip_type = Some(LedChipType::Ws2812bGrb);
    let brought_up = apply_mode_change(
        &mut owner,
        start.clone(),
        true,
        Some("COM-CHIP"),
        None,
        None,
        Some(shared_telemetry()),
        None,
        None,
    );
    assert_eq!(brought_up.status.code, "AMBILIGHT_MODE_STARTED");

    let mut swapped = start.clone();
    swapped.chip_type = Some(LedChipType::Sk6812Rgbw);
    let after = apply_mode_change(
        &mut owner,
        swapped,
        true,
        Some("COM-CHIP"),
        None,
        None,
        Some(shared_telemetry()),
        None,
        None,
    );
    assert_eq!(
        after.status.code, "AMBILIGHT_MODE_STARTED",
        "a chip-type change must rebuild the encoder, not retune atomics",
    );

    // …while an unchanged chip still takes the cheap path.
    let retune = apply_mode_change(
        &mut owner,
        {
            let mut same = start.clone();
            same.chip_type = Some(LedChipType::Sk6812Rgbw);
            same.ambilight = Some(AmbilightPayload {
                brightness: 0.3,
                ..Default::default()
            });
            same
        },
        true,
        Some("COM-CHIP"),
        None,
        None,
        Some(shared_telemetry()),
        None,
        None,
    );
    assert_eq!(retune.status.code, "AMBILIGHT_MODE_UPDATED");

    let mut cleanup_trace = None;
    super::transition::stop_previous(&mut owner, &mut cleanup_trace);
    wait_for_workers_drained();
}

#[test]
fn fast_path_preserves_saturation_when_payload_omits_it() {
    let _guard = acquire_worker_test_guard();
    let mut owner = owner_with_fake_sender();

    // First call: bring up ambilight with explicit saturation = 1.5
    let bring_up = apply_mode_change(
        &mut owner,
        ambilight_with_payload(AmbilightPayload {
            brightness: 0.8,
            saturation: Some(1.5),
            ..Default::default()
        }),
        true,
        Some("COM-FP1"),
        None,
        None,
        Some(shared_telemetry()),
        None,
        None,
    );
    assert_eq!(bring_up.status.code, "AMBILIGHT_MODE_STARTED");
    let live_after_start = owner
        .ambilight_live
        .as_ref()
        .expect("ambilight_live must be present after start")
        .clone();
    assert!((live_after_start.read_saturation() - 1.5).abs() < 1e-5);

    // Second call: brightness-only tweak with saturation = None.
    // Must hit the fast path and KEEP the running 1.5 saturation.
    let tweak = apply_mode_change(
        &mut owner,
        ambilight_with_payload(AmbilightPayload {
            brightness: 0.42,
            saturation: None,
            ..Default::default()
        }),
        true,
        Some("COM-FP1"),
        None,
        None,
        Some(shared_telemetry()),
        None,
        None,
    );
    assert_eq!(
        tweak.status.code, "AMBILIGHT_MODE_UPDATED",
        "brightness-only retune must take the in-place fast path",
    );
    let live = owner.ambilight_live.as_ref().expect("live present");
    assert!(
        (live.read_saturation() - 1.5).abs() < 1e-5,
        "fast path must preserve saturation when payload omits it; got {}",
        live.read_saturation()
    );
    assert!(
        (live.read_brightness() - 0.42).abs() < 1e-5,
        "fast path must apply the new brightness",
    );

    let mut cleanup_trace = None;
    super::transition::stop_previous(&mut owner, &mut cleanup_trace);
    wait_for_workers_drained();
}

#[test]
fn fast_path_preserves_smoothing_alpha_when_payload_omits_it() {
    let _guard = acquire_worker_test_guard();
    let mut owner = owner_with_fake_sender();

    let bring_up = apply_mode_change(
        &mut owner,
        ambilight_with_payload(AmbilightPayload {
            brightness: 1.0,
            smoothing_alpha: Some(0.20),
            ..Default::default()
        }),
        true,
        Some("COM-FP2"),
        None,
        None,
        Some(shared_telemetry()),
        None,
        None,
    );
    assert_eq!(bring_up.status.code, "AMBILIGHT_MODE_STARTED");

    let tweak = apply_mode_change(
        &mut owner,
        ambilight_with_payload(AmbilightPayload {
            brightness: 0.5,
            smoothing_alpha: None,
            ..Default::default()
        }),
        true,
        Some("COM-FP2"),
        None,
        None,
        Some(shared_telemetry()),
        None,
        None,
    );
    assert_eq!(tweak.status.code, "AMBILIGHT_MODE_UPDATED");
    let live = owner.ambilight_live.as_ref().expect("live present");
    assert!(
        (live.read_smoothing_alpha() - 0.20).abs() < 1e-5,
        "fast path must preserve smoothing_alpha when payload omits it; got {}",
        live.read_smoothing_alpha()
    );

    let mut cleanup_trace = None;
    super::transition::stop_previous(&mut owner, &mut cleanup_trace);
    wait_for_workers_drained();
}

#[test]
fn fast_path_explicit_saturation_overrides_running_atomic() {
    // Sanity check: an explicit Some(value) STILL overrides the live atomic.
    // This guards against an over-eager None-preservation that would also
    // ignore explicit values.
    let _guard = acquire_worker_test_guard();
    let mut owner = owner_with_fake_sender();

    let _ = apply_mode_change(
        &mut owner,
        ambilight_with_payload(AmbilightPayload {
            brightness: 1.0,
            saturation: Some(1.0),
            ..Default::default()
        }),
        true,
        Some("COM-FP3"),
        None,
        None,
        Some(shared_telemetry()),
        None,
        None,
    );

    let tweak = apply_mode_change(
        &mut owner,
        ambilight_with_payload(AmbilightPayload {
            brightness: 1.0,
            saturation: Some(1.8),
            ..Default::default()
        }),
        true,
        Some("COM-FP3"),
        None,
        None,
        Some(shared_telemetry()),
        None,
        None,
    );
    assert_eq!(tweak.status.code, "AMBILIGHT_MODE_UPDATED");
    let live = owner.ambilight_live.as_ref().expect("live present");
    assert!(
        (live.read_saturation() - 1.8).abs() < 1e-5,
        "explicit Some(value) must override the running atomic; got {}",
        live.read_saturation()
    );

    let mut cleanup_trace = None;
    super::transition::stop_previous(&mut owner, &mut cleanup_trace);
    wait_for_workers_drained();
}

// -----------------------------------------------------------------------
// Solid mode — full-strip USB encoding (v1.5 hardware repro)
//
// Latent bug (HEAD): the Solid arm encoded `&[[r, g, b]]` (a 1-element
// slice), so the firmware received a 9-byte frame with count=1 and only
// LED #0 was painted. These tests exercise the full-strip path against
// an in-memory `FakeLedSender` that records every packet it receives.
// -----------------------------------------------------------------------

/// Variant of `owner_with_fake_sender` that returns a clone of the fake
/// sender so the test can read the recorded writes back. Returning the
/// `Arc<FakeLedSender>` is sufficient because the sender is always wrapped
/// in `Arc<dyn LedPacketSender>` inside the bridge.
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
        hue_gate_waived: false,
        frame_source_factory: Arc::new(|_req: super::runtime::AmbilightCaptureRequest| {
            Ok(Box::new(FakeFrameSource {
                frame: CapturedFrame::new(
                    2,
                    2,
                    vec![[10, 20, 30], [40, 50, 60], [70, 80, 90], [100, 110, 120]],
                ),
            }))
        }),
    };
    (owner, recorder)
}

fn calibration_with_total_leds(
    total: u16,
) -> crate::commands::led_calibration::LedCalibrationConfig {
    use crate::commands::led_calibration::LedSegmentCounts;
    // Distribute the requested total across the four edges so
    // `build_led_sequence` produces a non-degenerate sequence. The exact
    // distribution does not matter for the byte-count assertions below;
    // what matters is that `total_leds` matches the segment sum.
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

fn solid_with_calibration(total_leds: u16) -> LightingModeConfig {
    LightingModeConfig {
        kind: LightingModeKind::Solid,
        solid: Some(SolidColorPayload {
            r: 255,
            g: 0,
            b: 0,
            brightness: 1.0,
        }),
        ambilight: None,
        targets: Some(vec!["usb".to_string()]),
        display_id: None,
        led_calibration: Some(calibration_with_total_leds(total_leds)),
        color_correction: None,
        firmware_profile: None,
        chip_type: None,
        color_order: None,
        room_geometry: None,
    }
}

#[test]
fn solid_mode_with_59_led_calibration_emits_full_strip_packet() {
    // 59 LEDs × 3 bytes/LED + 5-byte header (magic + brightness + count_le)
    // + 1-byte XOR checksum = 183 bytes. This matches the byte-for-byte
    // layout produced by the firmware-test loopback script and proves the
    // "1 LED demo" regression (9-byte frame) is gone.
    let (mut owner, recorder) = owner_with_recording_sender();
    let result = apply_mode_change(
        &mut owner,
        solid_with_calibration(59),
        true,
        Some("COM-FULL"),
        None,
        None,
        None,
        None,
        None,
    );

    assert_eq!(result.status.code, "SOLID_MODE_APPLIED");

    let writes = recorder.writes.lock().expect("writes lock poisoned");
    assert!(
        !writes.is_empty(),
        "Solid mode must dispatch at least one packet"
    );
    let (port, packet) = &writes[0];
    assert_eq!(port, "COM-FULL");
    assert_eq!(
        packet.len(),
        5 + 3 * 59 + 1,
        "59-LED Solid frame must be 183 bytes (was {} bytes)",
        packet.len()
    );

    // Header sanity: AA 55 brightness count_lo count_hi
    assert_eq!(
        &packet[0..2],
        &[0xAA, 0x55],
        "magic header must precede brightness"
    );
    assert_eq!(
        packet[2], 255,
        "brightness byte must reflect input 1.0 -> 255"
    );
    let count = u16::from_le_bytes([packet[3], packet[4]]);
    assert_eq!(count, 59, "count must match total_leds=59");

    // RGB payload sanity: red input must produce non-zero R bytes (the
    // gamma LUT shrinks values but 255 in -> 255 out per the LUT's
    // inverse-square-root anchor). Avoids the "encoded all zeros" Bug B.
    let payload = &packet[5..5 + 3 * 59];
    assert_eq!(payload.len() % 3, 0);
    for chunk in payload.as_chunks::<3>().0 {
        assert!(
            chunk[0] > 0,
            "every LED's red channel must be > 0 (input red 255 must not collapse to zero)"
        );
        assert_eq!(chunk[1], 0, "green channel must be zero for pure red input");
        assert_eq!(chunk[2], 0, "blue channel must be zero for pure red input");
    }
}

#[test]
fn solid_mode_without_calibration_falls_back_to_single_led_legacy_frame() {
    // When no calibration is present (legacy/uncalibrated devices) the
    // arm must still emit a valid frame instead of panicking. A 1-LED
    // packet is the correct legacy behaviour because the v1.3 firmware
    // shipped without per-LED sampling.
    let (mut owner, recorder) = owner_with_recording_sender();
    let result = apply_mode_change(
        &mut owner,
        solid_with_targets(Some(vec!["usb".to_string()])),
        true,
        Some("COM-LEGACY"),
        None,
        None,
        None,
        None,
        None,
    );

    assert_eq!(result.status.code, "SOLID_MODE_APPLIED");
    let writes = recorder.writes.lock().expect("writes lock poisoned");
    let (_, packet) = &writes[0];
    assert_eq!(
        packet.len(),
        5 + 3 + 1,
        "uncalibrated Solid frame must remain 9 bytes for v1.3 backward compat"
    );
}

#[test]
fn solid_mode_with_30_led_calibration_emits_96_byte_packet() {
    // Sanity: parametric byte-count assertion. 30 LEDs × 3 + 5 + 1 = 96.
    let (mut owner, recorder) = owner_with_recording_sender();
    let result = apply_mode_change(
        &mut owner,
        solid_with_calibration(30),
        true,
        Some("COM-30"),
        None,
        None,
        None,
        None,
        None,
    );
    assert_eq!(result.status.code, "SOLID_MODE_APPLIED");

    let writes = recorder.writes.lock().expect("writes lock poisoned");
    let (_, packet) = &writes[0];
    assert_eq!(packet.len(), 5 + 3 * 30 + 1);
    let count = u16::from_le_bytes([packet[3], packet[4]]);
    assert_eq!(count, 30);
}

#[test]
fn solid_mode_packet_xor_checksum_is_valid() {
    // The firmware drops frames whose terminal XOR byte does not match
    // the running checksum of all preceding bytes. A subtle off-by-one
    // in the encoder would render every Solid frame invalid and the
    // strip would freeze on its previous frame — the exact symptom
    // reported as "Bug B: LED #0 doesn't light at all in Solid mode".
    let (mut owner, recorder) = owner_with_recording_sender();
    let _ = apply_mode_change(
        &mut owner,
        solid_with_calibration(59),
        true,
        Some("COM-XOR"),
        None,
        None,
        None,
        None,
        None,
    );

    let writes = recorder.writes.lock().expect("writes lock poisoned");
    let (_, packet) = &writes[0];
    let (body, checksum) = packet.split_at(packet.len() - 1);
    let computed = body.iter().fold(0_u8, |acc, b| acc ^ b);
    assert_eq!(
        computed, checksum[0],
        "encoder XOR must match the firmware-side parser; otherwise frames are silently dropped"
    );
}

// -----------------------------------------------------------------------
// v1.6 LED Preview — output-stamp hydration + enrichment gating
// -----------------------------------------------------------------------

const SK6812_SHELL_STATE: &str = r#"{"shell-state":{"selectedChipType":"sk6812-rgbw"}}"#;

/// A shell-state file body as the store would load it.
fn persisted(raw: &str) -> Option<crate::commands::shell_state::PersistedShellState> {
    crate::commands::shell_state::PersistedShellState::from_file_json(raw)
}

/// A payload as the LED control popup sends it — kind + settings, no
/// output stamps — run through the same hydration chain `set_lighting_mode`
/// uses, with the persisted shell state injected in place of the store.
fn hydrated_like_set_lighting_mode(
    mut payload: LightingModeConfig,
    shell_state: &'static str,
) -> LightingModeConfig {
    super::hydrate::hydrate_mode_payload(&mut payload, &|| persisted(shell_state));
    payload
}

/// The popup's Ambilight click carried no chip type, so the fast-path chip
/// comparison failed against a running SK6812 worker and the restart fell
/// back to `LedChipType::default()` — the WS2812B encoder, three bytes per
/// pixel on a four-byte strip.
#[test]
fn unstamped_ambilight_click_keeps_a_running_sk6812_worker_on_rgbw() {
    let _guard = acquire_worker_test_guard();
    let mut owner = owner_with_fake_sender();

    let mut running = ambilight_with_payload(AmbilightPayload {
        brightness: 0.8,
        ..Default::default()
    });
    running.chip_type = Some(LedChipType::Sk6812Rgbw);
    let up = apply_mode_change(
        &mut owner,
        running.clone(),
        true,
        Some("COM-RGBW"),
        None,
        None,
        Some(shared_telemetry()),
        None,
        None,
    );
    assert_eq!(up.status.code, "AMBILIGHT_MODE_STARTED");

    let mut popup_click = running.clone();
    popup_click.chip_type = None;
    popup_click.firmware_profile = None;
    popup_click.color_correction = None;
    let hydrated = hydrated_like_set_lighting_mode(popup_click, SK6812_SHELL_STATE);
    let after = apply_mode_change(
        &mut owner,
        hydrated,
        true,
        Some("COM-RGBW"),
        None,
        None,
        Some(shared_telemetry()),
        None,
        None,
    );

    assert_eq!(
        after.status.code, "AMBILIGHT_MODE_UPDATED",
        "an unstamped click must retune the running worker, not rebuild it",
    );
    assert_eq!(owner.active_mode.chip_type, Some(LedChipType::Sk6812Rgbw));

    let mut cleanup_trace = None;
    super::transition::stop_previous(&mut owner, &mut cleanup_trace);
    wait_for_workers_drained();
}

/// Solid built its packet from the firmware profile alone, so an SK6812
/// strip got three-byte pixels from every window, stamped or not.
#[test]
fn solid_on_sk6812_writes_four_byte_rgbw_pixels() {
    let (mut owner, recorder) = owner_with_recording_sender();
    let mut solid = solid_with_calibration(10);
    solid.solid = Some(SolidColorPayload {
        r: 255,
        g: 255,
        b: 255,
        brightness: 1.0,
    });
    let hydrated = hydrated_like_set_lighting_mode(solid, SK6812_SHELL_STATE);

    let result = apply_mode_change(
        &mut owner,
        hydrated,
        true,
        Some("COM-RGBW"),
        None,
        None,
        None,
        None,
        None,
    );
    assert_eq!(result.status.code, "SOLID_MODE_APPLIED");

    let writes = recorder.writes.lock().expect("writes lock poisoned");
    let (_, packet) = &writes[0];
    assert_eq!(packet.len(), 5 + 4 * 10 + 1, "SK6812 Solid frame is RGBW");
    assert_eq!(u16::from_le_bytes([packet[3], packet[4]]), 10);
    // White drives the dedicated W emitter, not the three colour dies.
    assert_eq!(&packet[5..9], &[0, 0, 0, 255]);
    let checksum = packet[..packet.len() - 1]
        .iter()
        .fold(0_u8, |acc, byte| acc ^ byte);
    assert_eq!(packet[packet.len() - 1], checksum);
}

/// Streaming hands packets to the serial writer and learns of a failure one
/// send later. Solid is a single write, so it must wait for its own.
#[test]
fn solid_reports_its_own_serial_write_failure() {
    struct RefusingPort;
    impl std::io::Write for RefusingPort {
        fn write(&mut self, _buf: &[u8]) -> std::io::Result<usize> {
            Err(std::io::ErrorKind::BrokenPipe.into())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    let (mut owner, _) = owner_with_recording_sender();
    owner.output_bridge =
        LedOutputBridge::with_serial_writer_for_tests(|_| Ok(Box::new(RefusingPort)));

    let result = apply_mode_change(
        &mut owner,
        solid_with_calibration(10),
        true,
        Some("COM-REFUSING"),
        None,
        None,
        None,
        None,
        None,
    );

    assert_eq!(result.status.code, "SOLID_MODE_APPLY_FAILED");
    let details = result.status.details.expect("the reason rides details");
    assert!(
        details.starts_with("LED_OUTPUT_WRITE_FAILED"),
        "got: {details}"
    );
}

/// The default setup (LumaSync v1 + WS2812B) used to ignore the gamma
/// sliders on Solid too, because it shared the hardcoded-2.2 encoder.
#[test]
fn solid_on_the_default_setup_applies_the_user_gamma() {
    let solid_grey = |gamma: f32| {
        let (mut owner, recorder) = owner_with_recording_sender();
        let mut solid = solid_with_calibration(3);
        solid.solid = Some(SolidColorPayload {
            r: 128,
            g: 128,
            b: 128,
            brightness: 1.0,
        });
        solid.color_correction = Some(ColorCorrectionConfig {
            gamma_r: gamma,
            gamma_g: gamma,
            gamma_b: gamma,
            ..ColorCorrectionConfig::default()
        });
        let result = apply_mode_change(
            &mut owner,
            solid,
            true,
            Some("COM-GAMMA"),
            None,
            None,
            None,
            None,
            None,
        );
        assert_eq!(result.status.code, "SOLID_MODE_APPLIED");
        let writes = recorder.writes.lock().expect("writes lock poisoned");
        writes[0].1.clone()
    };

    let linear = solid_grey(1.0);
    let default = solid_grey(2.2);
    assert_eq!(&linear[0..2], &[0xAA, 0x55], "still the LumaSync v1 frame");
    assert_eq!(&linear[5..14], &[128; 9], "gamma 1.0 leaves mid-grey alone");
    assert_eq!(&default[5..14], &[56; 9], "gamma 2.2 maps 128 to 56");
}

/// Adalight has no four-byte pixel, so SK6812 under it must still write the
/// three-byte Adalight frame — the same fallback the ambilight sink takes.
#[test]
fn solid_on_sk6812_under_adalight_keeps_the_adalight_frame() {
    let (mut owner, recorder) = owner_with_recording_sender();
    let mut solid = solid_with_calibration(10);
    solid.chip_type = Some(LedChipType::Sk6812Rgbw);
    solid.firmware_profile = Some(FirmwareProfile::Adalight);

    let result = apply_mode_change(
        &mut owner,
        solid,
        true,
        Some("COM-ADA"),
        None,
        None,
        None,
        None,
        None,
    );
    assert_eq!(result.status.code, "SOLID_MODE_APPLIED");

    let writes = recorder.writes.lock().expect("writes lock poisoned");
    let (_, packet) = &writes[0];
    assert_eq!(&packet[0..3], b"Ada");
    assert_eq!(packet.len(), 6 + 3 * 10);
}

/// Caller-wins: a stamp the payload already carries is never replaced.
#[test]
fn hydration_never_overrides_a_stamped_chip_type() {
    let mut stamped = solid_with_calibration(10);
    stamped.chip_type = Some(LedChipType::Ws2812bGrb);
    let hydrated = hydrated_like_set_lighting_mode(stamped, SK6812_SHELL_STATE);
    assert_eq!(hydrated.chip_type, Some(LedChipType::Ws2812bGrb));
}

/// `stop_led_test_pattern`'s restore, run through the real chain: the
/// snapshot helper, the hydration `apply_and_broadcast` performs, then
/// `apply_mode_change`, with the persisted shell state injected.
fn restored_after_test(prior: LightingModeConfig, shell_state: String) -> LightingModeConfig {
    let load = || persisted(&shell_state);
    let mut restore = super::led_test_pattern::restore_mode_after_test(Some(prior), &load);
    super::hydrate::hydrate_mode_payload(&mut restore, &load);
    restore
}

/// The snapshot is taken at test start; a chip switch made while the test
/// ran must survive the stop instead of reverting to the old encoder.
#[test]
fn stopping_a_test_restores_the_chip_type_saved_during_it() {
    let (mut owner, recorder) = owner_with_recording_sender();
    let mut prior = solid_with_calibration(10);
    prior.chip_type = Some(LedChipType::Ws2812bGrb);
    prior.firmware_profile = Some(FirmwareProfile::LumaSyncV1);

    let restored = restored_after_test(prior, SK6812_SHELL_STATE.to_string());
    assert_eq!(restored.chip_type, Some(LedChipType::Sk6812Rgbw));

    let result = apply_mode_change(
        &mut owner,
        restored,
        true,
        Some("COM-RGBW"),
        None,
        None,
        None,
        None,
        None,
    );
    assert_eq!(result.status.code, "SOLID_MODE_APPLIED");
    assert_eq!(owner.active_mode.chip_type, Some(LedChipType::Sk6812Rgbw));
    let writes = recorder.writes.lock().expect("writes lock poisoned");
    let (_, packet) = &writes[0];
    assert_eq!(packet.len(), 5 + 4 * 10 + 1, "restored Solid frame is RGBW");
}

/// The calibration editor saves, then stops its test. The stale layout on
/// the snapshot has more than one LED, so caller-wins hydration would keep
/// it over the layout just written to disk.
#[test]
fn stopping_a_test_restores_the_calibration_saved_during_it() {
    let (mut owner, recorder) = owner_with_recording_sender();
    let prior = solid_with_calibration(10);
    let shell_state = serde_json::json!({
        "shell-state": { "ledCalibration": calibration_with_total_leds(20) }
    })
    .to_string();

    let restored = restored_after_test(prior, shell_state);
    let result = apply_mode_change(
        &mut owner,
        restored,
        true,
        Some("COM-CAL"),
        None,
        None,
        None,
        None,
        None,
    );
    assert_eq!(result.status.code, "SOLID_MODE_APPLIED");
    let writes = recorder.writes.lock().expect("writes lock poisoned");
    let (_, packet) = &writes[0];
    assert_eq!(u16::from_le_bytes([packet[3], packet[4]]), 20);
}

/// With no usable layout on disk the snapshot's is still better than the
/// legacy 1-LED frame clearing it would fall to.
#[test]
fn stopping_a_test_keeps_the_snapshot_calibration_when_disk_has_none() {
    let restored = restored_after_test(
        solid_with_calibration(10),
        r#"{"shell-state":{}}"#.to_string(),
    );
    assert_eq!(restored.led_calibration.map(|cal| cal.total_leds), Some(10));
}

// -----------------------------------------------------------------------
// Colour order — contract, persistence, hydration, test patterns
// -----------------------------------------------------------------------

const BGR_SHELL_STATE: &str = r#"{"shell-state":{"ledColorOrder":"bgr"}}"#;

/// A payload with every other stamp still has to read the order off disk —
/// the all-present early return must count it.
#[test]
fn hydration_fills_the_color_order_even_when_every_other_stamp_is_set() {
    let mut stamped = solid_with_calibration(10);
    stamped.color_correction = Some(ColorCorrectionConfig::default());
    stamped.firmware_profile = Some(FirmwareProfile::LumaSyncV1);
    stamped.chip_type = Some(LedChipType::Ws2812bGrb);
    let hydrated = hydrated_like_set_lighting_mode(stamped, BGR_SHELL_STATE);
    assert_eq!(hydrated.color_order, Some(LedColorOrder::Bgr));
}

#[test]
fn hydration_never_overrides_a_stamped_color_order() {
    let mut stamped = solid_with_calibration(10);
    stamped.color_order = Some(LedColorOrder::Rgb);
    let hydrated = hydrated_like_set_lighting_mode(stamped, BGR_SHELL_STATE);
    assert_eq!(hydrated.color_order, Some(LedColorOrder::Rgb));
}

/// The probe asks "which colour is slot N?", which a saved order would
/// answer for the user. Every other pattern keeps the saved order.
#[test]
fn a_channel_probe_pins_the_identity_order_over_the_saved_one() {
    let hydrate_test = |kind: TestPatternKind| {
        let mut config = solid_with_calibration(10);
        config.color_order = super::led_test_pattern::test_pattern_color_order(&kind);
        hydrated_like_set_lighting_mode(config, BGR_SHELL_STATE).color_order
    };
    assert_eq!(
        hydrate_test(TestPatternKind::ChannelProbe { slot: 1 }),
        Some(LedColorOrder::Rgb)
    );
    assert_eq!(
        hydrate_test(TestPatternKind::Chase { r: 255, g: 0, b: 0 }),
        Some(LedColorOrder::Bgr)
    );
}

#[test]
fn stopping_a_test_re_reads_the_color_order() {
    let mut prior = solid_with_calibration(10);
    prior.color_order = Some(LedColorOrder::Grb);

    let restored = restored_after_test(prior.clone(), BGR_SHELL_STATE.to_string());
    assert_eq!(restored.color_order, Some(LedColorOrder::Bgr));

    let restored = restored_after_test(prior, r#"{"shell-state":{}}"#.to_string());
    assert_eq!(
        restored.color_order, None,
        "an order cleared on disk mid-test is not revived from the snapshot"
    );
}

// -----------------------------------------------------------------------
// Edge-signal — only the twin overlay listens
// -----------------------------------------------------------------------

/// Drives the real worker, twin gate and emitter. With no twin open the
/// worker must not hand the emitter anything — the payload is only ever
/// built as its argument — and no window may receive the event. Once a twin
/// opens, that twin alone receives frames carrying the strip buffer and the
/// Hue channel colours; the main window never does.
#[test]
fn the_edge_signal_is_built_and_sent_only_while_a_twin_is_open() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::{Duration, Instant};
    use tauri::{Listener, Manager, WebviewWindowBuilder};

    use crate::commands::led_preview::LedTwinState;

    let _guard = acquire_worker_test_guard();
    let app = tauri::test::mock_app();
    app.manage(LedTwinState::default());
    let main = WebviewWindowBuilder::new(&app, crate::MAIN_WINDOW_LABEL, Default::default())
        .build()
        .expect("main webview");
    let twin_label = "led-twin-overlay-test";
    let twin = WebviewWindowBuilder::new(&app, twin_label, Default::default())
        .build()
        .expect("twin webview");

    let main_events = Arc::new(AtomicUsize::new(0));
    let main_counter = Arc::clone(&main_events);
    main.listen(super::preview::EDGE_SIGNAL_EVENT, move |_| {
        main_counter.fetch_add(1, Ordering::SeqCst);
    });
    let twin_frames: Arc<Mutex<Vec<serde_json::Value>>> = Arc::default();
    let twin_sink = Arc::clone(&twin_frames);
    twin.listen(super::preview::EDGE_SIGNAL_EVENT, move |event| {
        let frame = serde_json::from_str(event.payload()).expect("payload is JSON");
        twin_sink.lock().expect("frames lock").push(frame);
    });

    let built = Arc::new(AtomicUsize::new(0));
    let built_counter = Arc::clone(&built);
    let real_emitter = super::preview::build_edge_emitter(app.handle());
    let emitter: super::preview::EdgeSignalEmitter = Arc::new(move |payload| {
        built_counter.fetch_add(1, Ordering::SeqCst);
        real_emitter(payload);
    });

    let twin_state = app.state::<LedTwinState>();
    let mut owner = owner_with_fake_sender();
    owner.preview.preview_gate = Some(twin_state.preview_active());
    let mode = LightingModeConfig {
        kind: LightingModeKind::Ambilight,
        ambilight: Some(AmbilightPayload {
            brightness: 1.0,
            ..Default::default()
        }),
        targets: Some(vec!["usb".to_string(), "hue".to_string()]),
        led_calibration: Some(calibration_with_total_leds(12)),
        ..LightingModeConfig::default()
    };
    let started = apply_mode_change(
        &mut owner,
        mode,
        true,
        Some("COM-TWIN"),
        None,
        live(hue_context_with_channels(2)),
        Some(shared_telemetry()),
        Some(emitter),
        None,
    );
    assert_eq!(started.status.code, "AMBILIGHT_MODE_STARTED");

    std::thread::sleep(Duration::from_millis(300));
    assert_eq!(
        built.load(Ordering::SeqCst),
        0,
        "no twin open: the worker must not build an edge-signal payload"
    );
    assert_eq!(main_events.load(Ordering::SeqCst), 0);
    assert!(twin_frames.lock().expect("frames lock").is_empty());

    twin_state.record_twin_for_test("display-1", twin_label);
    let deadline = Instant::now() + Duration::from_secs(5);
    let frame = loop {
        let with_hue = twin_frames
            .lock()
            .expect("frames lock")
            .iter()
            .rev()
            .find(|frame| frame.get("hueChannels").is_some())
            .cloned();
        if let Some(frame) = with_hue {
            break frame;
        }
        assert!(
            Instant::now() < deadline,
            "an open twin must receive frames carrying hueChannels"
        );
        std::thread::sleep(Duration::from_millis(10));
    };
    assert_eq!(frame["leds"].as_array().map(Vec::len), Some(12));
    assert_eq!(frame["ledCount"], 12);
    assert_eq!(frame["hueChannels"].as_array().map(Vec::len), Some(2));
    assert_eq!(frame["source"], "live");
    for dropped in ["top", "bottom", "left", "right"] {
        assert!(frame.get(dropped).is_none(), "`{dropped}` has no reader");
    }
    assert_eq!(
        main_events.load(Ordering::SeqCst),
        0,
        "the main window has no edge-signal listener and must receive nothing"
    );

    twin_state.forget_twin_label(twin_label);
    // One tick may already be past the gate when the twin closes.
    std::thread::sleep(Duration::from_millis(100));
    let after_close = built.load(Ordering::SeqCst);
    std::thread::sleep(Duration::from_millis(300));
    assert_eq!(
        built.load(Ordering::SeqCst),
        after_close,
        "closing the last twin must stop the feed"
    );

    let mut cleanup_trace = None;
    super::transition::stop_previous(&mut owner, &mut cleanup_trace);
    wait_for_workers_drained();
}
