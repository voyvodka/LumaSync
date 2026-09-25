//! Fakes for the lighting transaction's tests. Nothing here reaches a bridge,
//! opens a serial port or captures the screen: Hue is a driver that publishes
//! into a real `HueOutputLive`, the strip is a recording packet sender, and
//! capture is a still frame.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::test::MockRuntime;
use tauri::{App, AppHandle, Listener, Manager};

use super::hue_driver::{HueAreaVerdict, HueDriver, HueDriverHandle, HueFuture};
use super::outputs::WledPowerOffHandle;
use super::runtime::LightingRuntimeOwner;
use super::{
    stop_lighting_blocking, LightingRuntimeState, ACTIVE_AMBILIGHT_WORKERS,
    LIGHTING_MODE_CHANGED_EVENT,
};
use crate::commands::ambilight_capture::{
    AmbilightCaptureError, AmbilightFrameSource, CapturedFrame,
};
use crate::commands::device_connection::{ActiveSinkRegistry, SerialConnectionState};
use crate::commands::hue::frame::{HueAreaChannel, HueColorSender, HueFrameRx, HueScreenRegion};
use crate::commands::hue::light_restore::HueLightsAfterStop;
use crate::commands::hue::state_store::{
    status_with, HueActiveOutputContext, HueOutputLive, HueRuntimeCommandResult, HueRuntimeState,
    HueRuntimeStateStore, HueRuntimeTriggerSource, StartHueStreamRequest,
};
use crate::commands::led_output::{LedOutputBridge, LedOutputError, LedPacketSender};
use crate::commands::led_preview::LedTwinState;
use crate::commands::runtime_telemetry::RuntimeTelemetryState;
use crate::commands::shell_state::{ShellStateStore, SHELL_STATE_CHANGED_EVENT};

use super::snapshot::LIGHTING_RUNTIME_CHANGED_EVENT;

pub(crate) const PORT: &str = "COM-TEST";

/// Aborts the test binary when the test holding it outlives `limit`. A worker
/// join, a sender wait or a drop that never returns otherwise holds `cargo
/// test` until the CI job times out — one such run sat for 13 hours. Declare
/// it first, so it is dropped last and covers the test's drops too.
pub(crate) struct Watchdog {
    done: Arc<(Mutex<bool>, std::sync::Condvar)>,
}

impl Watchdog {
    pub(crate) fn arm(test: &'static str, limit: Duration) -> Self {
        let done = Arc::new((Mutex::new(false), std::sync::Condvar::new()));
        let flag = Arc::clone(&done);
        std::thread::spawn(move || {
            let (lock, finished) = &*flag;
            let guard = lock.lock().unwrap_or_else(|err| err.into_inner());
            let (guard, _) = finished
                .wait_timeout_while(guard, limit, |done| !*done)
                .unwrap_or_else(|err| err.into_inner());
            if !*guard {
                // Not `eprintln!`: the harness captures that, and an abort
                // throws the captured output away.
                use std::io::Write;
                let _ = writeln!(
                    std::io::stderr(),
                    "{test} still running after {limit:?}: aborting rather than hanging"
                );
                std::process::abort();
            }
        });
        Self { done }
    }
}

impl Drop for Watchdog {
    fn drop(&mut self) {
        let (lock, finished) = &*self.done;
        *lock.lock().unwrap_or_else(|err| err.into_inner()) = true;
        finished.notify_all();
    }
}

/// Every test that can start an ambilight worker takes this, since workers
/// share a process-wide counter other tests assert on.
pub(crate) fn worker_test_guard() -> MutexGuard<'static, ()> {
    super::WORKER_TEST_GUARD
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// One ordered record of what the hardware saw, shared by every fake.
#[derive(Default)]
pub(crate) struct EventLog {
    seq: AtomicU64,
    entries: Mutex<Vec<(u64, String)>>,
    packets: Mutex<Vec<(u64, Vec<u8>)>>,
}

impl EventLog {
    fn next(&self) -> u64 {
        self.seq.fetch_add(1, Ordering::SeqCst) + 1
    }

    pub(crate) fn record(&self, entry: impl Into<String>) -> u64 {
        let seq = self.next();
        self.entries.lock().unwrap().push((seq, entry.into()));
        seq
    }

    /// The events, minus strip packets.
    pub(crate) fn events(&self) -> Vec<String> {
        self.entries
            .lock()
            .unwrap()
            .iter()
            .map(|(_, e)| e.clone())
            .collect()
    }

    pub(crate) fn seq_of(&self, entry: &str) -> Option<u64> {
        self.entries
            .lock()
            .unwrap()
            .iter()
            .find(|(_, e)| e == entry)
            .map(|(seq, _)| *seq)
    }

    pub(crate) fn packets(&self) -> Vec<(u64, Vec<u8>)> {
        self.packets.lock().unwrap().clone()
    }

    pub(crate) fn clear(&self) {
        self.entries.lock().unwrap().clear();
        self.packets.lock().unwrap().clear();
    }
}

struct RecordingUsb(Arc<EventLog>);

impl LedPacketSender for RecordingUsb {
    fn send(&self, _port_name: &str, packet: &[u8]) -> Result<(), LedOutputError> {
        let seq = self.0.next();
        self.0.packets.lock().unwrap().push((seq, packet.to_vec()));
        Ok(())
    }

    fn disconnect_session(&self, _port_name: &str) {}
}

struct StillFrame;

impl AmbilightFrameSource for StillFrame {
    fn capture_frame(&mut self) -> Result<Arc<CapturedFrame>, AmbilightCaptureError> {
        std::thread::sleep(Duration::from_millis(5));
        Ok(Arc::new(CapturedFrame::new(
            2,
            2,
            vec![[200, 40, 10], [10, 200, 40], [40, 10, 200], [90, 90, 90]],
        )))
    }
}

/// A Hue runtime that answers from a script. A start that succeeds publishes
/// a one-channel stream into its `HueOutputLive`, exactly as
/// `set_active_stream` does, so a worker naming Hue really drives it.
pub(crate) struct FakeHue {
    log: Arc<EventLog>,
    live: Arc<HueOutputLive>,
    active: AtomicBool,
    starts: Mutex<VecDeque<(&'static str, Option<&'static str>)>>,
    /// The area each start asked for, in order.
    start_areas: Mutex<Vec<String>>,
    /// The area the live stream holds; `None` for one opened elsewhere.
    live_area: Mutex<Option<String>>,
    stops: Mutex<VecDeque<&'static str>>,
    probes: Mutex<VecDeque<HueAreaVerdict>>,
    gate: Mutex<Option<Arc<tokio::sync::Semaphore>>>,
    stop_gate: Mutex<Option<Arc<tokio::sync::Semaphore>>>,
    probe_gate: Mutex<Option<Arc<tokio::sync::Semaphore>>>,
    entered: AtomicUsize,
    stops_entered: AtomicUsize,
    probed: AtomicUsize,
    receivers: Mutex<Vec<HueFrameRx>>,
    /// What each stop was told to do to the lights, in order.
    stop_lights: Mutex<Vec<HueLightsAfterStop>>,
}

impl FakeHue {
    pub(crate) fn new(log: Arc<EventLog>) -> Arc<Self> {
        Arc::new(Self {
            log,
            live: HueOutputLive::new(),
            active: AtomicBool::new(false),
            starts: Mutex::default(),
            start_areas: Mutex::default(),
            live_area: Mutex::default(),
            stops: Mutex::default(),
            probes: Mutex::default(),
            gate: Mutex::default(),
            stop_gate: Mutex::default(),
            probe_gate: Mutex::default(),
            entered: AtomicUsize::new(0),
            stops_entered: AtomicUsize::new(0),
            probed: AtomicUsize::new(0),
            receivers: Mutex::default(),
            stop_lights: Mutex::default(),
        })
    }

    /// What each stop so far was told to do to the lights.
    pub(crate) fn stop_lights(&self) -> Vec<HueLightsAfterStop> {
        self.stop_lights.lock().unwrap().clone()
    }

    pub(crate) fn script_starts(&self, codes: &[&'static str]) {
        self.starts
            .lock()
            .unwrap()
            .extend(codes.iter().map(|code| (*code, None)));
    }

    /// A start that answers `code` with the status `details` the real start
    /// gate writes — its blocker tokens.
    pub(crate) fn script_start_with_details(&self, code: &'static str, details: &'static str) {
        self.starts
            .lock()
            .unwrap()
            .push_back((code, Some(details)));
    }

    /// The area each start asked for, in order.
    pub(crate) fn start_areas(&self) -> Vec<String> {
        self.start_areas.lock().unwrap().clone()
    }

    /// The area the live stream holds.
    pub(crate) fn live_area(&self) -> Option<String> {
        self.live_area.lock().unwrap().clone()
    }

    pub(crate) fn script_stops(&self, codes: &[&'static str]) {
        self.stops.lock().unwrap().extend(codes);
    }

    pub(crate) fn script_probes(&self, verdicts: &[HueAreaVerdict]) {
        self.probes.lock().unwrap().extend(verdicts);
    }

    /// Starts wait at the door until a permit is added to the returned gate.
    pub(crate) fn hold_starts(&self) -> Arc<tokio::sync::Semaphore> {
        let gate = Arc::new(tokio::sync::Semaphore::new(0));
        self.gate.lock().unwrap().replace(Arc::clone(&gate));
        gate
    }

    pub(crate) fn starts_entered(&self) -> usize {
        self.entered.load(Ordering::SeqCst)
    }

    /// Stops wait at the door until a permit is added to the returned gate.
    pub(crate) fn hold_stops(&self) -> Arc<tokio::sync::Semaphore> {
        let gate = Arc::new(tokio::sync::Semaphore::new(0));
        self.stop_gate.lock().unwrap().replace(Arc::clone(&gate));
        gate
    }

    pub(crate) fn stops_entered(&self) -> usize {
        self.stops_entered.load(Ordering::SeqCst)
    }

    /// Probes wait at the door until a permit is added to the returned gate. A
    /// probe held there is not a timer, so a paused clock cannot run the area
    /// wait past it.
    pub(crate) fn hold_probes(&self) -> Arc<tokio::sync::Semaphore> {
        let gate = Arc::new(tokio::sync::Semaphore::new(0));
        self.probe_gate.lock().unwrap().replace(Arc::clone(&gate));
        gate
    }

    pub(crate) fn probes_made(&self) -> usize {
        self.probed.load(Ordering::SeqCst)
    }

    /// A stream someone else opened: up, with nothing here asking for it.
    pub(crate) fn stream_up(&self) {
        self.publish_stream();
        self.active.store(true, Ordering::SeqCst);
    }

    /// The stream went away under the runtime (a reconnect teardown).
    pub(crate) fn stream_drops(&self) {
        self.live.publish(None);
    }

    pub(crate) fn streaming(&self) -> bool {
        self.live.current().is_some()
    }

    /// Frames the worker handed the stream, newest first, within `wait`.
    pub(crate) fn received_frame(&self, wait: Duration) -> bool {
        let receivers = self.receivers.lock().unwrap();
        receivers
            .last()
            .is_some_and(|rx| rx.recv_timeout(wait).is_ok())
    }

    fn publish_stream(&self) {
        let (color_sender, rx) = HueColorSender::with_mailbox(1);
        self.receivers.lock().unwrap().push(rx);
        self.live.publish(Some(HueActiveOutputContext {
            channels: vec![HueAreaChannel {
                channel_id: 0,
                light_ids: vec!["light-1".to_string()],
                screen_region: HueScreenRegion::Center,
                position_x: 0.0,
                position_y: 0.5,
                position_z: None,
            }],
            color_sender,
        }));
    }

    fn result(
        state: HueRuntimeState,
        code: &str,
        details: Option<&str>,
        active: bool,
    ) -> HueRuntimeCommandResult {
        HueRuntimeCommandResult {
            active,
            status: status_with(
                state,
                code,
                "fake",
                details.map(str::to_string),
                HueRuntimeTriggerSource::System,
            ),
            last_solid_color: None,
        }
    }
}

impl HueDriver for FakeHue {
    fn start(&self, request: StartHueStreamRequest) -> HueFuture<'_, HueRuntimeCommandResult> {
        Box::pin(async move {
            self.log.record("hue:start");
            self.start_areas
                .lock()
                .unwrap()
                .push(request.area_id.clone());
            self.entered.fetch_add(1, Ordering::SeqCst);
            let gate = self.gate.lock().unwrap().clone();
            if let Some(gate) = gate {
                gate.acquire().await.expect("gate open").forget();
            }
            let (code, details) = self
                .starts
                .lock()
                .unwrap()
                .pop_front()
                .unwrap_or(("HUE_STREAM_RUNNING_DTLS", None));
            let (state, active) = match code {
                "HUE_STREAM_RUNNING" | "HUE_STREAM_RUNNING_DTLS" => {
                    self.publish_stream();
                    self.live_area.lock().unwrap().replace(request.area_id);
                    (HueRuntimeState::Running, true)
                }
                "HUE_START_NOOP_ALREADY_ACTIVE" => (HueRuntimeState::Running, true),
                "HUE_STREAM_STARTING" => (HueRuntimeState::Starting, true),
                "TRANSIENT_RETRY_SCHEDULED" => (HueRuntimeState::Reconnecting, true),
                "AUTH_INVALID_CREDENTIALS" => (HueRuntimeState::Failed, false),
                _ => (HueRuntimeState::Idle, false),
            };
            self.active.store(active, Ordering::SeqCst);
            Self::result(state, code, details, active)
        })
    }

    fn stop(
        &self,
        trigger: HueRuntimeTriggerSource,
        lights: HueLightsAfterStop,
    ) -> HueFuture<'_, HueRuntimeCommandResult> {
        Box::pin(async move {
            let trigger = serde_json::to_value(&trigger).unwrap();
            self.log
                .record(format!("hue:stop:{}", trigger.as_str().unwrap_or_default()));
            self.stop_lights.lock().unwrap().push(lights);
            self.stops_entered.fetch_add(1, Ordering::SeqCst);
            let gate = self.stop_gate.lock().unwrap().clone();
            if let Some(gate) = gate {
                gate.acquire().await.expect("gate open").forget();
            }
            let code = self
                .stops
                .lock()
                .unwrap()
                .pop_front()
                .unwrap_or("HUE_STREAM_STOPPED");
            self.live.publish(None);
            self.live_area.lock().unwrap().take();
            self.active.store(false, Ordering::SeqCst);
            Self::result(HueRuntimeState::Idle, code, None, false)
        })
    }

    fn probe_area(&self, _request: StartHueStreamRequest) -> HueFuture<'_, HueAreaVerdict> {
        Box::pin(async move {
            self.probed.fetch_add(1, Ordering::SeqCst);
            self.log.record("hue:probe");
            let gate = self.probe_gate.lock().unwrap().clone();
            if let Some(gate) = gate {
                gate.acquire().await.expect("gate open").forget();
            }
            self.probes
                .lock()
                .unwrap()
                .pop_front()
                .unwrap_or(HueAreaVerdict::Free)
        })
    }

    fn runtime_active(&self) -> bool {
        self.active.load(Ordering::SeqCst) || self.live.current().is_some()
    }

    fn output_live(&self) -> Arc<HueOutputLive> {
        Arc::clone(&self.live)
    }

    fn live_area_id(&self) -> Option<String> {
        self.live
            .current()
            .and_then(|_| self.live_area.lock().unwrap().clone())
    }
}

/// What a test starts from.
pub(crate) struct RigSetup {
    pub(crate) serial_connected: bool,
    pub(crate) calibrated: bool,
    pub(crate) hue_paired: bool,
    /// Merged over the persisted state the three flags produce.
    pub(crate) state: Value,
}

impl Default for RigSetup {
    fn default() -> Self {
        Self {
            serial_connected: true,
            calibrated: true,
            hue_paired: true,
            state: json!({}),
        }
    }
}

/// A mock app carrying the managed state `lib.rs` registers, wired to fakes.
pub(crate) struct Rig {
    pub(crate) app: App<MockRuntime>,
    pub(crate) log: Arc<EventLog>,
    pub(crate) hue: Arc<FakeHue>,
    capture_failure: Arc<Mutex<Option<&'static str>>>,
    snapshots: Arc<Mutex<Vec<Value>>>,
    shell_writes: Arc<Mutex<Vec<Value>>>,
    _worker_guard: MutexGuard<'static, ()>,
}

pub(crate) fn calibration() -> Value {
    json!({
        "templateId": "monitor-34-ultrawide",
        "counts": { "top": 30, "right": 14, "bottom": 0, "left": 15 },
        "bottomMissing": 0,
        "cornerOwnership": "horizontal",
        "visualPreset": "vivid",
        "startAnchor": "left-end",
        "direction": "cw",
        "totalLeds": 59
    })
}

impl Rig {
    pub(crate) fn new(setup: RigSetup) -> Self {
        let worker_guard = worker_test_guard();
        let log = Arc::new(EventLog::default());
        let hue = FakeHue::new(Arc::clone(&log));
        let capture_failure: Arc<Mutex<Option<&'static str>>> = Arc::default();
        let failure = Arc::clone(&capture_failure);
        let owner = LightingRuntimeOwner {
            output_bridge: LedOutputBridge::from_sender(Arc::new(RecordingUsb(Arc::clone(&log)))),
            frame_source_factory: Arc::new(move |_request| match *failure.lock().unwrap() {
                Some(reason) => Err(AmbilightCaptureError::InvalidFrame(reason)),
                None => Ok(Box::new(StillFrame) as Box<dyn AmbilightFrameSource>),
            }),
            ..LightingRuntimeOwner::default()
        };

        let app = tauri::test::mock_app();
        app.manage(LightingRuntimeState::for_tests(owner));
        app.manage(HueDriverHandle(hue.clone()));
        let wled_log = Arc::clone(&log);
        app.manage(WledPowerOffHandle(Arc::new(move |ip| {
            wled_log.record(format!("wled:off:{ip}"));
            Ok(())
        })));
        app.manage(HueRuntimeStateStore::default());
        app.manage(SerialConnectionState::default());
        app.manage(ActiveSinkRegistry::default());
        app.manage(LedTwinState::default());
        app.manage(RuntimeTelemetryState::default());
        app.manage(ShellStateStore::in_memory());

        let rig = Self {
            app,
            log,
            hue,
            capture_failure,
            snapshots: Arc::default(),
            shell_writes: Arc::default(),
            _worker_guard: worker_guard,
        };
        rig.set_serial_connected(setup.serial_connected);

        let mut state = json!({});
        if setup.calibrated {
            state["ledCalibration"] = calibration();
        }
        if setup.hue_paired {
            state["lastHueBridge"] = json!({ "ip": "192.168.1.50", "id": "abc" });
            state["lastHueAreaId"] = json!("area-1");
            state["hueAppKey"] = json!("app-key");
            state["hueClientKey"] = json!("client-key");
        }
        for (key, value) in setup.state.as_object().cloned().unwrap_or_default() {
            state[key] = value;
        }
        rig.seed(state);

        let log = Arc::clone(&rig.log);
        rig.app.listen(LIGHTING_MODE_CHANGED_EVENT, move |event| {
            let payload: Value = serde_json::from_str(event.payload()).unwrap();
            let targets = payload["config"]["targets"]
                .as_array()
                .map(|t| {
                    t.iter()
                        .filter_map(Value::as_str)
                        .collect::<Vec<_>>()
                        .join(",")
                })
                .unwrap_or_default();
            log.record(format!(
                "mode:{}:{targets}",
                payload["config"]["kind"].as_str().unwrap_or_default()
            ));
        });
        let snapshots = Arc::clone(&rig.snapshots);
        rig.app
            .listen(LIGHTING_RUNTIME_CHANGED_EVENT, move |event| {
                snapshots
                    .lock()
                    .unwrap()
                    .push(serde_json::from_str(event.payload()).unwrap());
            });
        let writes = Arc::clone(&rig.shell_writes);
        rig.app.listen(SHELL_STATE_CHANGED_EVENT, move |event| {
            let payload: Value = serde_json::from_str(event.payload()).unwrap();
            writes.lock().unwrap().push(payload["set"].clone());
        });
        rig
    }

    pub(crate) fn handle(&self) -> AppHandle<MockRuntime> {
        self.app.handle().clone()
    }

    pub(crate) fn state(&self) -> tauri::State<'_, LightingRuntimeState> {
        self.app.state::<LightingRuntimeState>()
    }

    pub(crate) fn seed(&self, state: Value) {
        let set = state.as_object().cloned().unwrap_or_default();
        self.app
            .state::<ShellStateStore>()
            .patch(set, Vec::new(), None, |_| {})
            .expect("seed the shell state");
    }

    pub(crate) fn saved(&self, key: &str) -> Option<Value> {
        self.app
            .state::<ShellStateStore>()
            .snapshot()
            .state
            .and_then(|state| state.get(key).cloned())
    }

    /// Every key Rust wrote to the shell state since the rig was built.
    pub(crate) fn written_keys(&self) -> Vec<String> {
        self.shell_writes
            .lock()
            .unwrap()
            .iter()
            .flat_map(|set| {
                set.as_object()
                    .map(|o| o.keys().cloned().collect::<Vec<_>>())
                    .unwrap_or_default()
            })
            .collect()
    }

    pub(crate) fn published(&self) -> Vec<Value> {
        self.snapshots.lock().unwrap().clone()
    }

    pub(crate) fn set_serial_connected(&self, connected: bool) {
        let serial = self.app.state::<SerialConnectionState>();
        let mut status = serial.last_status.lock().unwrap();
        status.connected = connected;
        status.port_name = connected.then(|| PORT.to_string());
    }

    pub(crate) fn fail_capture(&self, reason: Option<&'static str>) {
        self.capture_failure.lock().unwrap().clone_from(&reason);
    }

    pub(crate) fn running(&self) -> super::LightingModeConfig {
        self.state()
            .runtime
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .active_mode
            .clone()
    }

    pub(crate) fn worker_running(&self) -> bool {
        self.state()
            .runtime
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .worker
            .is_some()
    }
}

impl Drop for Rig {
    fn drop(&mut self) {
        let _ = stop_lighting_blocking(self.app.handle());
        let deadline = Instant::now() + Duration::from_secs(3);
        while ACTIVE_AMBILIGHT_WORKERS.load(Ordering::SeqCst) != 0 && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(5));
        }
    }
}
