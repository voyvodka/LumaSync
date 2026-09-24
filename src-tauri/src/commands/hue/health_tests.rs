//! The health monitor's schedule on a paused clock, over a fake runtime and
//! bridge, plus the classifier path a re-pair verdict comes from.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::json;
use tokio::time::{advance, Instant};

use super::health::{
    area_backoff, verdict_for, FailureBudget, HealthBackend, HealthFuture, HealthSink,
    HueBridgeVerdict, HueHealthMonitor, HueHealthSnapshot, HueHealthTarget, HueHealthWatch,
    HueStreamHealth, StreamRead, AREA_BLOCKED_INTERVAL, AREA_INTERVAL, BRIDGE_PROBE_INTERVAL,
    STREAM_BRIDGE_INTERVAL, STREAM_LOCAL_HIDDEN, STREAM_LOCAL_VISIBLE,
};
use super::state_store::{HueRuntimeOwner, HueRuntimeState};
use crate::commands::hue_onboarding::{
    HueStreamReadiness, HueStreamReadinessResponse, HueValidateCredentialsResponse,
    ACTIVE_STREAMER_REASON,
};
use crate::commands::status::CommandStatus;

const BRIDGE: &str = "192.168.1.20";
const AREA: &str = "area-1";

#[derive(Default, Clone, Copy, Debug, PartialEq, Eq)]
struct Calls {
    validate: usize,
    readiness: usize,
    stream_local: usize,
    stream_bridge: usize,
}

struct FakeBackend {
    target: Mutex<Option<HueHealthTarget>>,
    validate_code: Mutex<&'static str>,
    readiness: Mutex<(&'static str, Vec<String>)>,
    /// `Some` while a stream runs on that bridge and area.
    live: Mutex<Option<(String, String)>>,
    calls: Mutex<Calls>,
}

impl FakeBackend {
    fn configured() -> Arc<Self> {
        Arc::new(Self {
            target: Mutex::new(Some(target())),
            validate_code: Mutex::new("HUE_CREDENTIAL_VALID"),
            readiness: Mutex::new(("HUE_STREAM_READY", Vec::new())),
            live: Mutex::new(None),
            calls: Mutex::new(Calls::default()),
        })
    }

    fn unconfigured() -> Arc<Self> {
        let backend = Self::configured();
        *backend.target.lock().unwrap() = None;
        backend
    }

    fn calls(&self) -> Calls {
        *self.calls.lock().unwrap()
    }

    fn answer_validate(&self, code: &'static str) {
        *self.validate_code.lock().unwrap() = code;
    }

    fn answer_readiness(&self, code: &'static str, reasons: &[&str]) {
        *self.readiness.lock().unwrap() = (code, reasons.iter().map(|r| r.to_string()).collect());
    }

    fn stream_on(&self, area: Option<&str>) {
        *self.live.lock().unwrap() = area.map(|area| (BRIDGE.to_string(), area.to_string()));
    }

    fn readiness_response(&self) -> HueStreamReadinessResponse {
        let (code, reasons) = self.readiness.lock().unwrap().clone();
        HueStreamReadinessResponse {
            status: CommandStatus::new(code, "readiness", None),
            readiness: HueStreamReadiness {
                ready: code == "HUE_STREAM_READY",
                reasons,
            },
        }
    }
}

impl HealthBackend for FakeBackend {
    fn target(&self) -> Option<HueHealthTarget> {
        self.target.lock().unwrap().clone()
    }

    fn stream(&self, bridge_check: bool) -> HealthFuture<'_, StreamRead> {
        Box::pin(async move {
            let live = self.live.lock().unwrap().clone();
            {
                let mut calls = self.calls.lock().unwrap();
                if bridge_check {
                    calls.stream_bridge += 1;
                } else {
                    calls.stream_local += 1;
                }
            }
            let mut status = HueRuntimeOwner::default().last_status;
            if live.is_some() {
                status.state = HueRuntimeState::Running;
                status.code = "HUE_STREAM_RUNNING".to_string();
            }
            let readiness = (bridge_check && live.is_some()).then(|| self.readiness_response());
            StreamRead {
                health: HueStreamHealth {
                    active: live.is_some(),
                    status,
                },
                stream_area: live,
                readiness,
            }
        })
    }

    fn validate(
        &self,
        _target: HueHealthTarget,
    ) -> HealthFuture<'_, HueValidateCredentialsResponse> {
        Box::pin(async move {
            self.calls.lock().unwrap().validate += 1;
            let code = *self.validate_code.lock().unwrap();
            HueValidateCredentialsResponse {
                status: CommandStatus::new(code, "validate", None),
                valid: code == "HUE_CREDENTIAL_VALID",
            }
        })
    }

    fn readiness(&self, _target: HueHealthTarget) -> HealthFuture<'_, HueStreamReadinessResponse> {
        Box::pin(async move {
            self.calls.lock().unwrap().readiness += 1;
            self.readiness_response()
        })
    }

    fn wall_clock_ms(&self) -> u64 {
        1_700_000_000_000
    }
}

#[derive(Default)]
struct Recorder(Mutex<Vec<HueHealthSnapshot>>);

impl Recorder {
    fn published(&self) -> Vec<HueHealthSnapshot> {
        self.0.lock().unwrap().clone()
    }
}

impl HealthSink for Recorder {
    fn emit_health(&self, snapshot: &HueHealthSnapshot) {
        self.0.lock().unwrap().push(snapshot.clone());
    }
}

fn target() -> HueHealthTarget {
    HueHealthTarget {
        bridge_ip: BRIDGE.to_string(),
        username: String::new(),
        area_id: AREA.to_string(),
    }
}

fn monitor(backend: &Arc<FakeBackend>) -> (HueHealthMonitor, Arc<Recorder>) {
    let recorder = Arc::new(Recorder::default());
    let monitor = HueHealthMonitor::new(backend.clone(), recorder.clone());
    (monitor, recorder)
}

const VISIBLE: HueHealthWatch = HueHealthWatch {
    visible: true,
    area_readiness: false,
};
const VISIBLE_WITH_AREA: HueHealthWatch = HueHealthWatch {
    visible: true,
    area_readiness: true,
};
const HIDDEN: HueHealthWatch = HueHealthWatch {
    visible: false,
    area_readiness: false,
};

/// Runs a pass `after` from now, as the task would when its timer fired.
async fn pass_after(monitor: &HueHealthMonitor, after: Duration) -> Option<Instant> {
    advance(after).await;
    monitor.run_once().await
}

// ---------------------------------------------------------------------------
// Idling
// ---------------------------------------------------------------------------

#[tokio::test(start_paused = true)]
async fn with_no_bridge_configured_nothing_is_scheduled() {
    let backend = FakeBackend::unconfigured();
    let (monitor, _) = monitor(&backend);
    monitor.watch("main", VISIBLE_WITH_AREA);

    assert_eq!(monitor.run_once().await, None, "parks until woken");
    assert_eq!(pass_after(&monitor, Duration::from_secs(600)).await, None);

    let calls = backend.calls();
    assert_eq!(
        (calls.validate, calls.readiness, calls.stream_bridge),
        (0, 0, 0)
    );
    assert!(!monitor.snapshot().configured);
}

#[tokio::test(start_paused = true)]
async fn with_no_window_visible_and_no_stream_it_parks() {
    let backend = FakeBackend::configured();
    let (monitor, _) = monitor(&backend);

    assert_eq!(monitor.run_once().await, None);
    monitor.watch("main", HIDDEN);
    assert_eq!(monitor.run_once().await, None);

    assert_eq!(backend.calls().validate, 0);
    assert!(monitor.snapshot().configured);
}

/// The whole task, idle in the tray for ten minutes: not one bridge call, then
/// a probe as soon as the window shows.
#[tokio::test(start_paused = true)]
async fn the_task_sleeps_in_the_tray_and_wakes_when_a_window_shows() {
    let backend = FakeBackend::configured();
    let (monitor, _) = monitor(&backend);
    let task = tokio::spawn(monitor.clone().run());

    for _ in 0..10 {
        advance(Duration::from_secs(60)).await;
        tokio::task::yield_now().await;
    }
    assert_eq!(backend.calls().validate, 0);
    assert_eq!(backend.calls().readiness, 0);

    monitor.watch("main", VISIBLE);
    for _ in 0..5 {
        tokio::task::yield_now().await;
    }
    assert_eq!(backend.calls().validate, 1);

    monitor.watch("main", HIDDEN);
    for _ in 0..10 {
        advance(Duration::from_secs(60)).await;
        tokio::task::yield_now().await;
    }
    assert_eq!(backend.calls().validate, 1, "hidden again: no more probes");

    monitor.close();
    task.await.unwrap();
}

// ---------------------------------------------------------------------------
// Bridge probe cadence and give-up
// ---------------------------------------------------------------------------

#[tokio::test(start_paused = true)]
async fn the_bridge_is_probed_every_30_seconds_while_visible() {
    let backend = FakeBackend::configured();
    let (monitor, _) = monitor(&backend);
    monitor.watch("main", VISIBLE);

    let start = Instant::now();
    assert_eq!(
        monitor.run_once().await,
        Some(start + BRIDGE_PROBE_INTERVAL)
    );
    assert_eq!(backend.calls().validate, 1);
    assert_eq!(
        monitor.snapshot().bridge.verdict,
        Some(HueBridgeVerdict::Reachable)
    );

    pass_after(&monitor, Duration::from_secs(29)).await;
    assert_eq!(backend.calls().validate, 1);
    pass_after(&monitor, Duration::from_secs(1)).await;
    assert_eq!(backend.calls().validate, 2);
}

#[tokio::test(start_paused = true)]
async fn an_unreachable_bridge_gives_up_after_four_failures_and_90_seconds() {
    let backend = FakeBackend::configured();
    backend.answer_validate("HUE_CREDENTIAL_CHECK_FAILED");
    let (monitor, _) = monitor(&backend);
    monitor.watch("main", VISIBLE);

    monitor.run_once().await;
    for _ in 0..2 {
        pass_after(&monitor, BRIDGE_PROBE_INTERVAL).await;
        assert!(!monitor.snapshot().bridge.gave_up);
    }
    let parked = pass_after(&monitor, BRIDGE_PROBE_INTERVAL).await;
    let snapshot = monitor.snapshot();
    assert!(snapshot.bridge.gave_up, "4 failures over 90 s");
    assert_eq!(snapshot.bridge.verdict, Some(HueBridgeVerdict::Unreachable));
    assert_eq!(parked, None, "a bridge that is gone is not asked again");

    pass_after(&monitor, Duration::from_secs(600)).await;
    assert_eq!(backend.calls().validate, 4);

    // The manual retry probes at once; `gaveUp` stays until the bridge answers.
    monitor.retry();
    monitor.run_once().await;
    assert_eq!(backend.calls().validate, 5);
    assert!(monitor.snapshot().bridge.gave_up);

    backend.answer_validate("HUE_CREDENTIAL_VALID");
    pass_after(&monitor, BRIDGE_PROBE_INTERVAL).await;
    let snapshot = monitor.snapshot();
    assert!(!snapshot.bridge.gave_up);
    assert_eq!(snapshot.bridge.verdict, Some(HueBridgeVerdict::Reachable));
}

#[test]
fn the_budget_needs_both_the_count_and_the_duration() {
    let start = Instant::now();
    let mut budget = FailureBudget::default();
    for second in 0..10 {
        assert!(
            !budget.failure(start + Duration::from_secs(second)),
            "ten quick failures are not an outage"
        );
    }
    let mut budget = FailureBudget::default();
    assert!(!budget.failure(start));
    assert!(
        !budget.failure(start + Duration::from_secs(200)),
        "two failures"
    );

    // Any success resets the streak: two, a success, two more is not four.
    let mut budget = FailureBudget::default();
    budget.failure(start);
    budget.failure(start + Duration::from_secs(60));
    budget.success();
    budget.failure(start + Duration::from_secs(120));
    assert!(!budget.failure(start + Duration::from_secs(240)));
}

/// 403 → re-pair: a key the bridge refuses is an answer from a reachable
/// bridge. It asks for a re-pair and never counts toward giving up.
#[tokio::test(start_paused = true)]
async fn a_refused_key_asks_for_a_re_pair_and_never_gives_up() {
    for code in ["HUE_CREDENTIAL_INVALID", "HUE_BRIDGE_IDENTITY_MISMATCH"] {
        let backend = FakeBackend::configured();
        backend.answer_validate(code);
        let (monitor, _) = monitor(&backend);
        monitor.watch("main", VISIBLE);

        monitor.run_once().await;
        for _ in 0..9 {
            pass_after(&monitor, BRIDGE_PROBE_INTERVAL).await;
        }
        let snapshot = monitor.snapshot();
        assert_eq!(backend.calls().validate, 10, "{code}");
        assert_eq!(
            snapshot.bridge.verdict,
            Some(HueBridgeVerdict::CredentialRejected),
            "{code}"
        );
        assert!(!snapshot.bridge.gave_up, "{code}");
    }
}

#[test]
fn only_a_refusal_or_a_foreign_certificate_reads_as_a_re_pair() {
    assert_eq!(
        verdict_for("HUE_CREDENTIAL_VALID"),
        HueBridgeVerdict::Reachable
    );
    assert_eq!(
        verdict_for("HUE_CREDENTIAL_INVALID"),
        HueBridgeVerdict::CredentialRejected
    );
    assert_eq!(
        verdict_for("HUE_BRIDGE_IDENTITY_MISMATCH"),
        HueBridgeVerdict::CredentialRejected
    );
    for code in ["HUE_CREDENTIAL_CHECK_FAILED", "HUE_IP_INVALID"] {
        assert_eq!(verdict_for(code), HueBridgeVerdict::Unreachable, "{code}");
    }
}

/// The probe's code comes from the shared classifier: a Hue-shaped 403 body is
/// a refused key, a proxy's own 403 is a bridge that did not answer.
#[tokio::test]
async fn a_hue_shaped_403_is_a_refused_key_and_a_proxy_403_is_an_outage() {
    use super::bridge_identity::BridgeTrust;
    use super::credential_store::tests::InMemoryStore;
    use super::pin_store::MemoryPinStore;
    use super::test_bridge::{Reply, TestBridge};
    use super::transport::build_async_client;
    use crate::commands::hue_onboarding::validate_app_key_at;

    let cases = [
        (
            Reply::json(
                403,
                json!({ "errors": [{ "description": "unauthorized user" }] }),
            ),
            HueBridgeVerdict::CredentialRejected,
        ),
        (
            Reply::json(
                403,
                json!([{ "error": { "type": 1, "address": "/", "description": "unauthorized user" } }]),
            ),
            HueBridgeVerdict::CredentialRejected,
        ),
        (
            Reply {
                content_type: "text/html",
                ..Reply::text(403, "<html><title>Access denied</title></html>".to_string())
            },
            HueBridgeVerdict::Unreachable,
        ),
    ];
    for (reply, expected) in cases {
        let reply = Arc::new(Mutex::new(Some(reply)));
        let bridge = TestBridge::start(move |_, _, _| {
            reply
                .lock()
                .unwrap()
                .take()
                .unwrap_or_else(|| Reply::json(500, json!({})))
        });
        let pins = Arc::new(MemoryPinStore::default());
        let client = build_async_client(&BridgeTrust::any(), pins, Duration::from_secs(5)).unwrap();
        let endpoint = format!("https://{}/clip/v2/resource/bridge", bridge.authority);

        let response = validate_app_key_at(
            &client,
            &endpoint,
            &bridge.authority,
            "some-key",
            &InMemoryStore::default(),
        )
        .await;

        assert_eq!(
            verdict_for(&response.status.code),
            expected,
            "{}",
            response.status.code
        );
    }
}

// ---------------------------------------------------------------------------
// Area readiness
// ---------------------------------------------------------------------------

#[tokio::test(start_paused = true)]
async fn the_area_is_read_only_while_a_view_watches_it() {
    let backend = FakeBackend::configured();
    let (monitor, _) = monitor(&backend);
    monitor.watch("main", VISIBLE);
    monitor.run_once().await;
    pass_after(&monitor, Duration::from_secs(60)).await;
    assert_eq!(backend.calls().readiness, 0);

    monitor.watch("main", VISIBLE_WITH_AREA);
    let start = Instant::now();
    let next = monitor.run_once().await;
    assert_eq!(
        backend.calls().readiness,
        1,
        "read at once when a view starts watching"
    );
    assert_eq!(next, Some(start + AREA_INTERVAL));
    let area = monitor.snapshot().area.expect("area slice");
    assert_eq!(area.area_id, AREA);
    assert_eq!(area.status.code, "HUE_STREAM_READY");

    monitor.watch("main", VISIBLE);
    pass_after(&monitor, Duration::from_secs(120)).await;
    assert_eq!(backend.calls().readiness, 1, "no longer watched");
}

#[tokio::test(start_paused = true)]
async fn an_area_held_by_another_streamer_is_read_every_3_seconds() {
    let backend = FakeBackend::configured();
    backend.answer_readiness("HUE_STREAM_NOT_READY", &[ACTIVE_STREAMER_REASON]);
    let (monitor, _) = monitor(&backend);
    monitor.watch("main", VISIBLE_WITH_AREA);

    let start = Instant::now();
    assert_eq!(
        monitor.run_once().await,
        Some(start + AREA_BLOCKED_INTERVAL)
    );
    for _ in 0..5 {
        pass_after(&monitor, AREA_BLOCKED_INTERVAL).await;
    }
    assert_eq!(backend.calls().readiness, 6);
    assert!(
        !monitor.snapshot().bridge.gave_up,
        "a held area is an answer, not an outage"
    );

    // Once it lets go, back to the healthy cadence.
    backend.answer_readiness("HUE_STREAM_READY", &[]);
    pass_after(&monitor, AREA_BLOCKED_INTERVAL).await;
    assert_eq!(backend.calls().readiness, 7);
    for _ in 0..4 {
        pass_after(&monitor, AREA_BLOCKED_INTERVAL).await;
    }
    assert_eq!(backend.calls().readiness, 7, "12 s later: not yet");
    pass_after(&monitor, AREA_BLOCKED_INTERVAL).await;
    assert_eq!(backend.calls().readiness, 8, "15 s later");
}

#[test]
fn the_area_check_backs_off_while_the_bridge_does_not_answer() {
    let delays: Vec<u64> = (1..=6)
        .map(|streak| area_backoff(streak).as_secs())
        .collect();
    assert_eq!(delays, vec![15, 30, 60, 120, 120, 120]);
}

#[tokio::test(start_paused = true)]
async fn a_silent_bridge_slows_the_area_check_and_then_stops_it() {
    let backend = FakeBackend::configured();
    backend.answer_readiness("HUE_STREAM_READINESS_FAILED", &[]);
    let (monitor, _) = monitor(&backend);
    monitor.watch("main", VISIBLE_WITH_AREA);

    let mut reads = Vec::new();
    let start = Instant::now();
    monitor.run_once().await;
    for _ in 0..300 {
        let before = backend.calls().readiness;
        pass_after(&monitor, Duration::from_secs(1)).await;
        if backend.calls().readiness > before {
            reads.push(Instant::now().duration_since(start).as_secs());
        }
    }
    // 0 s, then +15, +30, +60: the fourth failure at 105 s is past 90 s.
    assert_eq!(reads, vec![15, 45, 105]);
    assert_eq!(backend.calls().readiness, 4);

    // The window hiding and showing again does not wake a check that gave up…
    monitor.watch(
        "main",
        HueHealthWatch {
            visible: false,
            area_readiness: true,
        },
    );
    monitor.watch("main", VISIBLE_WITH_AREA);
    pass_after(&monitor, Duration::from_secs(60)).await;
    assert_eq!(backend.calls().readiness, 4);

    // …but the Devices view mounting again starts it over, as its loop did.
    monitor.watch("main", VISIBLE);
    monitor.watch("main", VISIBLE_WITH_AREA);
    monitor.run_once().await;
    assert_eq!(backend.calls().readiness, 5);
}

// ---------------------------------------------------------------------------
// A live stream
// ---------------------------------------------------------------------------

#[tokio::test(start_paused = true)]
async fn a_live_stream_is_read_locally_every_second_and_asks_the_bridge_every_5() {
    let backend = FakeBackend::configured();
    backend.stream_on(Some(AREA));
    let (monitor, _) = monitor(&backend);
    monitor.watch("main", VISIBLE);

    let start = Instant::now();
    assert_eq!(monitor.run_once().await, Some(start + STREAM_LOCAL_VISIBLE));
    assert_eq!(backend.calls().validate, 0, "a live stream is proof enough");
    for _ in 0..10 {
        pass_after(&monitor, STREAM_LOCAL_VISIBLE).await;
    }
    let calls = backend.calls();
    assert_eq!(calls.stream_bridge, 2, "at 5 s and 10 s");
    assert_eq!(calls.validate, 0);
    assert!(monitor.snapshot().stream.active);

    monitor.watch("main", HIDDEN);
    let hidden_at = Instant::now();
    assert_eq!(
        pass_after(&monitor, Duration::ZERO).await,
        Some(hidden_at + STREAM_LOCAL_HIDDEN)
    );
    for _ in 0..12 {
        pass_after(&monitor, STREAM_LOCAL_HIDDEN).await;
    }
    assert_eq!(
        backend.calls().stream_bridge,
        2,
        "hidden: local reads only, the bridge is left alone"
    );
    assert_eq!(STREAM_BRIDGE_INTERVAL, Duration::from_secs(5));
}

#[tokio::test(start_paused = true)]
async fn a_stream_ending_probes_the_bridge_at_once() {
    let backend = FakeBackend::configured();
    backend.stream_on(Some(AREA));
    let (monitor, _) = monitor(&backend);
    monitor.watch("main", VISIBLE);
    monitor.run_once().await;
    pass_after(&monitor, Duration::from_secs(40)).await;
    assert_eq!(backend.calls().validate, 0);

    backend.stream_on(None);
    pass_after(&monitor, STREAM_LOCAL_VISIBLE).await;
    assert_eq!(backend.calls().validate, 1);
    assert!(!monitor.snapshot().stream.active);
}

#[tokio::test(start_paused = true)]
async fn a_live_stream_feeds_the_watched_area_without_a_second_read() {
    let backend = FakeBackend::configured();
    backend.stream_on(Some(AREA));
    let (monitor, _) = monitor(&backend);
    monitor.watch("main", VISIBLE_WITH_AREA);
    monitor.run_once().await;
    pass_after(&monitor, STREAM_BRIDGE_INTERVAL).await;

    assert_eq!(backend.calls().readiness, 0);
    assert_eq!(backend.calls().stream_bridge, 1);
    let area = monitor
        .snapshot()
        .area
        .expect("fed by the stream's own read");
    assert_eq!(area.area_id, AREA);
}

#[tokio::test(start_paused = true)]
async fn a_read_after_a_stop_shows_it_without_asking_the_bridge() {
    let backend = FakeBackend::configured();
    backend.stream_on(Some(AREA));
    let (monitor, _) = monitor(&backend);
    monitor.run_once().await;
    assert!(monitor.snapshot().stream.active);

    backend.stream_on(None);
    let read = monitor.read_now().await;
    assert!(!read.stream.active);
    assert_eq!(read.stream.status.state, HueRuntimeState::Idle);
    assert_eq!(backend.calls().stream_bridge, 0);
    assert_eq!(backend.calls().validate, 0);
}

// ---------------------------------------------------------------------------
// Snapshot revisions and configuration
// ---------------------------------------------------------------------------

#[tokio::test(start_paused = true)]
async fn a_revision_is_published_only_when_the_content_moves() {
    let backend = FakeBackend::configured();
    let (monitor, recorder) = monitor(&backend);
    monitor.watch("main", VISIBLE);
    monitor.run_once().await;
    let after_first = recorder.published().len();
    assert!(after_first > 0);

    monitor.read_now().await;
    monitor.read_now().await;
    assert_eq!(recorder.published().len(), after_first, "nothing moved");

    backend.answer_validate("HUE_CREDENTIAL_INVALID");
    pass_after(&monitor, BRIDGE_PROBE_INTERVAL).await;

    let published = recorder.published();
    assert!(published.len() > after_first);
    for pair in published.windows(2) {
        assert_eq!(pair[1].revision, pair[0].revision + 1);
    }
    assert_eq!(published.last(), Some(&monitor.snapshot()));
    assert_eq!(
        monitor.snapshot().bridge.verdict,
        Some(HueBridgeVerdict::CredentialRejected)
    );
}

#[tokio::test(start_paused = true)]
async fn a_changed_pairing_probes_again_and_keeps_gave_up_until_an_answer() {
    let backend = FakeBackend::configured();
    backend.answer_validate("HUE_CREDENTIAL_CHECK_FAILED");
    let (monitor, _) = monitor(&backend);
    monitor.watch("main", VISIBLE);
    monitor.run_once().await;
    for _ in 0..3 {
        pass_after(&monitor, BRIDGE_PROBE_INTERVAL).await;
    }
    assert!(monitor.snapshot().bridge.gave_up);

    *backend.target.lock().unwrap() = Some(HueHealthTarget {
        area_id: "area-2".to_string(),
        ..target()
    });
    monitor.note_config_changed();
    monitor.run_once().await;
    assert_eq!(backend.calls().validate, 5);
    assert!(monitor.snapshot().bridge.gave_up);

    // Unpairing clears everything, gave-up included.
    *backend.target.lock().unwrap() = None;
    monitor.note_config_changed();
    assert_eq!(monitor.run_once().await, None);
    let snapshot = monitor.snapshot();
    assert!(!snapshot.configured);
    assert_eq!(snapshot.bridge.verdict, None);
    assert!(!snapshot.bridge.gave_up);
}
