//! One source of Hue health. A single background task owns bridge
//! reachability, the stored key's validity, the selected area's readiness and
//! the stream's own state, and publishes them as one `HueHealthSnapshot` on
//! `hue://health`. No window polls the bridge. Cadences, idling and why it is
//! one task: docs/architecture/hue.md, "One health monitor".

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use log::{info, warn};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, Runtime, State};
use tokio::sync::Notify;
use tokio::time::Instant;

use super::area_cache::HueReadFreshness;
use super::commands::refresh_hue_stream_status;
use super::hue_config::hue_start_request;
use super::state_store::{
    streams_area, HueRuntimeOwner, HueRuntimeStateStore, HueRuntimeStatus, HueRuntimeTriggerSource,
    StartHueStreamRequest,
};
use crate::commands::hue_onboarding::{
    check_hue_stream_readiness_with_freshness, validate_hue_credentials, ActiveStreamerView,
    HueStreamReadiness, HueStreamReadinessResponse, HueValidateCredentialsResponse,
    ACTIVE_STREAMER_REASON,
};
use crate::commands::shell_state;
use crate::commands::status::CommandStatus;

/// `HUE_EVENTS.HEALTH_CHANGED` in `src/shared/contracts/hueHealth.ts`. Defined
/// in `crate::events`; re-exported here since this is the emit site.
pub use crate::events::HUE_HEALTH_CHANGED_EVENT;

/// Local runtime read while a stream is live and a window shows it. No bridge I/O.
pub(crate) const STREAM_LOCAL_VISIBLE: Duration = Duration::from_secs(1);
/// The same with no window visible: keeps the dead-sender probe and the
/// pending-colour flush running for a stream the tray started.
pub(crate) const STREAM_LOCAL_HIDDEN: Duration = Duration::from_secs(5);
/// Readiness round-trip for a live stream while a window shows it — the old
/// status-chip cadence. It is also what feeds the runtime's transient-fault
/// ladder mid-stream, so changing it changes how fast a flaky bridge exhausts it.
pub(crate) const STREAM_BRIDGE_INTERVAL: Duration = Duration::from_secs(5);
/// Credential probe while configured, not streaming and visible.
pub(crate) const BRIDGE_PROBE_INTERVAL: Duration = Duration::from_secs(30);
/// Area readiness while the Devices view watches it.
pub(crate) const AREA_INTERVAL: Duration = Duration::from_secs(15);
/// While another session holds the area: the user is waiting for it to let go.
pub(crate) const AREA_BLOCKED_INTERVAL: Duration = Duration::from_secs(3);
/// Ceiling of the area check's back-off while the bridge does not answer.
pub(crate) const AREA_BACKOFF_CAP: Duration = Duration::from_secs(120);
// Both terms must be met before a signal gives up, so no cadence can turn a
// Wi-Fi hiccup into a missing bridge. See docs/architecture/hue.md.
pub(crate) const GIVE_UP_AFTER_FAILURES: u32 = 4;
pub(crate) const GIVE_UP_AFTER: Duration = Duration::from_secs(90);

/// Shell-state keys that change what the monitor watches. Credential status
/// and the onboarding step are written beside them but describe, not choose.
const CONFIG_KEYS: &[&str] = &[
    "lastHueBridge",
    "lastHueAreaId",
    "hueAppKey",
    "hueClientKey",
    "credentialStorageBackend",
];

// ---------------------------------------------------------------------------
// Wire shapes — `src/shared/contracts/hueHealth.ts`
// ---------------------------------------------------------------------------

/// `HUE_BRIDGE_VERDICT` in `hueHealth.ts`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum HueBridgeVerdict {
    Reachable,
    CredentialRejected,
    Unreachable,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HueBridgeHealth {
    pub verdict: Option<HueBridgeVerdict>,
    pub probing: bool,
    pub gave_up: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HueAreaHealth {
    pub area_id: String,
    pub status: CommandStatus,
    pub readiness: HueStreamReadiness,
    pub checked_at_ms: u64,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HueStreamHealth {
    pub active: bool,
    pub status: HueRuntimeStatus,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HueHealthSnapshot {
    pub revision: u64,
    pub configured: bool,
    pub bridge: HueBridgeHealth,
    pub area: Option<HueAreaHealth>,
    pub stream: HueStreamHealth,
}

/// What one window needs. The main window sends it on every visibility
/// change; the Devices view adds `area_readiness` while it is mounted.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HueHealthWatch {
    pub visible: bool,
    pub area_readiness: bool,
}

// ---------------------------------------------------------------------------
// What the monitor reads through
// ---------------------------------------------------------------------------

/// The saved bridge, area and pairing (`toHueStartConfig`). `username` may be
/// empty — the keychain signal — and is never logged.
#[derive(Clone, PartialEq, Eq)]
pub(crate) struct HueHealthTarget {
    pub(crate) bridge_ip: String,
    pub(crate) username: String,
    pub(crate) area_id: String,
}

impl From<StartHueStreamRequest> for HueHealthTarget {
    fn from(request: StartHueStreamRequest) -> Self {
        Self {
            bridge_ip: request.bridge_ip,
            username: request.username,
            area_id: request.area_id,
        }
    }
}

impl HueHealthTarget {
    fn place(&self) -> (&str, &str) {
        (&self.bridge_ip, &self.area_id)
    }
}

/// One runtime refresh, reduced to what the snapshot carries.
pub(crate) struct StreamRead {
    pub(crate) health: HueStreamHealth,
    /// The live stream's bridge and area, when there is a stream.
    pub(crate) stream_area: Option<(String, String)>,
    /// Present when the refresh asked the bridge.
    pub(crate) readiness: Option<HueStreamReadinessResponse>,
}

pub(crate) type HealthFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// The bridge and runtime calls, injected so the schedule is testable without
/// either. Production runs the very commands the windows used to poll.
pub(crate) trait HealthBackend: Send + Sync {
    fn target(&self) -> Option<HueHealthTarget>;
    fn stream(&self, bridge_check: bool) -> HealthFuture<'_, StreamRead>;
    fn validate(&self, target: HueHealthTarget)
        -> HealthFuture<'_, HueValidateCredentialsResponse>;
    fn readiness(&self, target: HueHealthTarget) -> HealthFuture<'_, HueStreamReadinessResponse>;
    fn wall_clock_ms(&self) -> u64;
}

/// Where a published snapshot goes: every window, or a test's recorder.
pub(crate) trait HealthSink: Send + Sync {
    fn emit_health(&self, snapshot: &HueHealthSnapshot);
}

impl<R: Runtime> HealthSink for AppHandle<R> {
    fn emit_health(&self, snapshot: &HueHealthSnapshot) {
        if let Err(error) = self.emit(HUE_HEALTH_CHANGED_EVENT, snapshot) {
            warn!(
                "[hue-health] could not announce revision {}: {error}",
                snapshot.revision
            );
        }
    }
}

// ---------------------------------------------------------------------------
// Schedule
// ---------------------------------------------------------------------------

/// Consecutive failures of one signal, and when the streak began.
#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct FailureBudget {
    streak: u32,
    started_at: Option<Instant>,
}

impl FailureBudget {
    /// The bridge answered — the streak is over, whatever the answer said.
    pub(crate) fn success(&mut self) {
        self.streak = 0;
        self.started_at = None;
    }

    /// Records a failure and says whether the signal should give up.
    pub(crate) fn failure(&mut self, now: Instant) -> bool {
        let started = *self.started_at.get_or_insert(now);
        self.streak += 1;
        self.streak >= GIVE_UP_AFTER_FAILURES && now.duration_since(started) >= GIVE_UP_AFTER
    }

    pub(crate) fn streak(&self) -> u32 {
        self.streak
    }
}

#[derive(Default)]
struct Signal {
    due: Option<Instant>,
    /// Gave up: nothing schedules it again until a retry or a config change.
    stopped: bool,
    budget: FailureBudget,
}

impl Signal {
    fn rearm(&mut self, now: Instant) {
        self.due = Some(now);
        self.stopped = false;
        self.budget.success();
    }

    fn is_due(&self, now: Instant) -> bool {
        self.due.is_some_and(|due| due <= now)
    }
}

/// Which signals the current demand allows, before asking whether they are due.
struct Eligible {
    local: Option<Duration>,
    stream_bridge: bool,
    bridge: bool,
    area: bool,
}

struct Inner {
    working: HueHealthSnapshot,
    published: HueHealthSnapshot,
    target: Option<HueHealthTarget>,
    target_loaded: bool,
    config_dirty: bool,
    watches: HashMap<String, HueHealthWatch>,
    live: bool,
    stream_area: Option<(String, String)>,
    stream_bridge_due: Option<Instant>,
    bridge: Signal,
    area: Signal,
    /// The first pass may probe the bridge with no window visible, so a
    /// tray-started app has a verdict before anything is shown. Spent by
    /// that pass whether or not it probed.
    launch_probe: bool,
}

impl Inner {
    fn visible(&self) -> bool {
        self.watches.values().any(|watch| watch.visible)
    }

    fn area_wanted(&self) -> bool {
        self.watches
            .values()
            .any(|watch| watch.visible && watch.area_readiness)
    }

    fn eligible(&self) -> Eligible {
        let visible = self.visible();
        let configured = self.target.is_some();
        // A live stream's own readiness round-trip already reads this area.
        let stream_feeds_area = self.live
            && visible
            && match (&self.target, &self.stream_area) {
                (Some(target), Some((ip, area))) => target.place() == (ip.as_str(), area.as_str()),
                _ => false,
            };
        Eligible {
            local: self.live.then_some(if visible {
                STREAM_LOCAL_VISIBLE
            } else {
                STREAM_LOCAL_HIDDEN
            }),
            stream_bridge: self.live && visible,
            // An active stream is proof enough on its own.
            bridge: configured
                && (visible || self.launch_probe)
                && !self.live
                && !self.bridge.stopped,
            area: configured && self.area_wanted() && !self.area.stopped && !stream_feeds_area,
        }
    }

    fn next_wake(&self, now: Instant) -> Option<Instant> {
        let eligible = self.eligible();
        [
            eligible.local.map(|interval| now + interval),
            self.stream_bridge_due.filter(|_| eligible.stream_bridge),
            self.bridge.due.filter(|_| eligible.bridge),
            self.area.due.filter(|_| eligible.area),
        ]
        .into_iter()
        .flatten()
        .min()
    }

    /// Stamps a new revision when the content moved; `None` when it did not.
    fn publish_if_changed(&mut self) -> Option<HueHealthSnapshot> {
        self.working.revision = self.published.revision;
        if self.working == self.published {
            return None;
        }
        self.working.revision = self.published.revision + 1;
        self.published = self.working.clone();
        Some(self.published.clone())
    }

    fn record_area(
        &mut self,
        area_id: String,
        response: HueStreamReadinessResponse,
        now: Instant,
        wall_ms: u64,
    ) {
        let failed = response.status.code == "HUE_STREAM_READINESS_FAILED";
        let blocked = response
            .readiness
            .reasons
            .iter()
            .any(|reason| reason == ACTIVE_STREAMER_REASON);
        self.working.area = Some(HueAreaHealth {
            area_id,
            status: response.status,
            readiness: response.readiness,
            checked_at_ms: wall_ms,
        });
        // STREAM_NOT_READY is an answer, not a miss — an area held by another
        // streamer must never be counted as an unreachable bridge.
        if !failed {
            self.area.budget.success();
            self.area.due = Some(
                now + if blocked {
                    AREA_BLOCKED_INTERVAL
                } else {
                    AREA_INTERVAL
                },
            );
            return;
        }
        let exhausted = self.area.budget.failure(now);
        let streak = self.area.budget.streak();
        // First of a streak only — the blocked cadence is 3 s, so logging every
        // failed tick would bury the log sink during a single outage.
        if streak == 1 {
            warn!("[hue-health] area readiness: the bridge did not answer");
        }
        if exhausted {
            warn!("[hue-health] area readiness gave up after {streak} consecutive failures — manual retry required");
            self.area.stopped = true;
            self.area.due = None;
        } else {
            self.area.due = Some(now + area_backoff(streak));
        }
    }
}

/// 15 s, 30 s, 60 s, then every 120 s while the bridge does not answer.
pub(crate) fn area_backoff(streak: u32) -> Duration {
    let doublings = streak.saturating_sub(1).min(8);
    (AREA_INTERVAL * 2_u32.pow(doublings)).min(AREA_BACKOFF_CAP)
}

/// How a credential probe's answer reads. Only `HUE_CREDENTIAL_INVALID` — the
/// classifier's Hue-shaped 401/403 — and a certificate that is not the paired
/// bridge's ask for a re-pair; both are answers from a bridge on the network.
pub(crate) fn verdict_for(code: &str) -> HueBridgeVerdict {
    match code {
        "HUE_CREDENTIAL_VALID" => HueBridgeVerdict::Reachable,
        "HUE_CREDENTIAL_INVALID" | "HUE_BRIDGE_IDENTITY_MISMATCH" => {
            HueBridgeVerdict::CredentialRejected
        }
        _ => HueBridgeVerdict::Unreachable,
    }
}

// ---------------------------------------------------------------------------
// The monitor
// ---------------------------------------------------------------------------

struct Shared {
    inner: Mutex<Inner>,
    wake: Arc<Notify>,
    closing: AtomicBool,
    backend: Arc<dyn HealthBackend>,
    sink: Arc<dyn HealthSink>,
}

/// Managed by Tauri; clones share one monitor.
#[derive(Clone)]
pub struct HueHealthMonitor(Arc<Shared>);

impl HueHealthMonitor {
    pub(crate) fn new(backend: Arc<dyn HealthBackend>, sink: Arc<dyn HealthSink>) -> Self {
        let idle = HueHealthSnapshot {
            revision: 0,
            configured: false,
            bridge: HueBridgeHealth::default(),
            area: None,
            stream: HueStreamHealth {
                active: false,
                status: HueRuntimeOwner::default().last_status,
            },
        };
        Self(Arc::new(Shared {
            inner: Mutex::new(Inner {
                working: idle.clone(),
                published: idle,
                target: None,
                target_loaded: false,
                config_dirty: false,
                watches: HashMap::new(),
                live: false,
                stream_area: None,
                stream_bridge_due: None,
                bridge: Signal::default(),
                area: Signal::default(),
                launch_probe: true,
            }),
            wake: Arc::new(Notify::new()),
            closing: AtomicBool::new(false),
            backend,
            sink,
        }))
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.0
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Changes the working snapshot and announces it if it moved. The emit
    /// happens after the lock is released, so two publishers can deliver out
    /// of order; the frontend keeps the higher revision.
    fn update<T>(&self, change: impl FnOnce(&mut Inner) -> T) -> T {
        let (out, published) = {
            let mut inner = self.lock();
            let out = change(&mut inner);
            (out, inner.publish_if_changed())
        };
        if let Some(snapshot) = published {
            self.0.sink.emit_health(&snapshot);
        }
        out
    }

    fn closing(&self) -> bool {
        self.0.closing.load(Ordering::SeqCst)
    }

    pub(crate) fn snapshot(&self) -> HueHealthSnapshot {
        self.lock().published.clone()
    }

    pub(crate) fn wake_handle(&self) -> Arc<Notify> {
        Arc::clone(&self.0.wake)
    }

    /// One window's demand. A view that starts watching the area reads it at
    /// once with a fresh budget, as the Devices view's own loop did on every
    /// mount; the window merely showing again reads it only if it is due and
    /// has not given up.
    pub(crate) fn watch(&self, window: &str, watch: HueHealthWatch) {
        let now = Instant::now();
        {
            let mut inner = self.lock();
            let mounted = watch.area_readiness
                && !inner
                    .watches
                    .get(window)
                    .is_some_and(|held| held.area_readiness);
            let area_before = inner.area_wanted();
            if watch == HueHealthWatch::default() {
                inner.watches.remove(window);
            } else {
                inner.watches.insert(window.to_string(), watch);
            }
            if mounted {
                inner.area.rearm(now);
            } else if !area_before && inner.area_wanted() && !inner.area.stopped {
                inner.area.due = Some(now);
            }
        }
        self.0.wake.notify_one();
    }

    /// The manual retry behind the "check again" control. `gave_up` survives
    /// it on purpose — clearing it made the retry button delete itself the
    /// instant it was pressed. Only a bridge that answers clears it.
    pub(crate) fn retry(&self) {
        let now = Instant::now();
        {
            let mut inner = self.lock();
            inner.bridge.rearm(now);
            inner.area.rearm(now);
        }
        self.0.wake.notify_one();
    }

    /// A saved setting that decides what to watch changed.
    pub(crate) fn note_config_changed(&self) {
        self.lock().config_dirty = true;
        self.0.wake.notify_one();
    }

    pub(crate) fn close(&self) {
        self.0.closing.store(true, Ordering::SeqCst);
        self.0.wake.notify_one();
    }

    /// `get_hue_health`: a local runtime read, so a caller right after its own
    /// start or stop sees the result, then the snapshot. Never the bridge.
    pub(crate) async fn read_now(&self) -> HueHealthSnapshot {
        let read = self.0.backend.stream(false).await;
        if self.apply_stream(read, false, Instant::now()) {
            self.0.wake.notify_one();
        }
        self.snapshot()
    }

    fn observe_target(&self, now: Instant) {
        let reload = {
            let inner = self.lock();
            inner.config_dirty || !inner.target_loaded
        };
        if !reload {
            return;
        }
        let target = self.0.backend.target();
        self.update(|inner| {
            let changed = inner.config_dirty || !inner.target_loaded || inner.target != target;
            inner.config_dirty = false;
            inner.target_loaded = true;
            if !changed {
                return;
            }
            let moved = inner.target.as_ref().map(HueHealthTarget::place)
                != target.as_ref().map(HueHealthTarget::place);
            if moved {
                inner.working.area = None;
            }
            inner.target = target;
            inner.working.configured = inner.target.is_some();
            // Fresh budgets and an immediate read, as the loops did when the
            // saved pairing changed under them.
            inner.bridge.rearm(now);
            inner.area.rearm(now);
            if inner.target.is_none() {
                // An unpaired bridge has nothing to retry, so nothing may keep
                // offering one.
                inner.working.bridge = HueBridgeHealth::default();
                inner.working.area = None;
            }
        });
    }

    /// Returns whether the stream went live or stopped being live.
    fn apply_stream(&self, read: StreamRead, did_bridge: bool, now: Instant) -> bool {
        let wall_ms = self.0.backend.wall_clock_ms();
        self.update(|inner| {
            let was_live = inner.live;
            inner.live = read.health.active;
            inner.stream_area = read.stream_area;
            inner.working.stream = read.health;
            if !inner.live {
                inner.stream_bridge_due = None;
            } else if !was_live || did_bridge {
                inner.stream_bridge_due = Some(now + STREAM_BRIDGE_INTERVAL);
            }
            if inner.live {
                inner.working.bridge.gave_up = false;
                inner.working.bridge.probing = false;
                inner.bridge = Signal::default();
            } else if was_live {
                inner.bridge.rearm(now);
            }
            if let (Some(response), Some((ip, area))) = (read.readiness, inner.stream_area.clone())
            {
                let ours = inner
                    .target
                    .as_ref()
                    .is_some_and(|target| target.place() == (ip.as_str(), area.as_str()));
                if ours && inner.area_wanted() {
                    inner.record_area(area, response, now, wall_ms);
                }
            }
            was_live != inner.live
        })
    }

    /// The target to probe when the credential probe is eligible and due.
    fn take_bridge(&self, now: Instant) -> Option<HueHealthTarget> {
        self.update(|inner| {
            if !inner.eligible().bridge || !inner.bridge.is_due(now) {
                return None;
            }
            inner.bridge.due = None;
            inner.working.bridge.probing = true;
            inner.target.clone()
        })
    }

    fn apply_bridge(
        &self,
        probed: &HueHealthTarget,
        response: &HueValidateCredentialsResponse,
        now: Instant,
    ) {
        self.update(|inner| {
            inner.working.bridge.probing = false;
            // Superseded: the pairing changed or a stream came up meanwhile.
            if inner.target.as_ref() != Some(probed) || inner.live {
                return;
            }
            let code = response.status.code.as_str();
            inner.working.bridge.verdict = Some(verdict_for(code));
            inner.bridge.due = Some(now + BRIDGE_PROBE_INTERVAL);
            // Only a bridge that never answered counts against the budget. A
            // bridge that answers CREDENTIAL_INVALID — or with a certificate
            // that is not the paired bridge's — is on the network and needs a
            // re-pair, which the Devices card already offers.
            if code != "HUE_CREDENTIAL_CHECK_FAILED" {
                inner.bridge.budget.success();
                inner.working.bridge.gave_up = false;
                return;
            }
            let exhausted = inner.bridge.budget.failure(now);
            let streak = inner.bridge.budget.streak();
            // First of a streak only: at 30 s a sustained outage would
            // otherwise write a line every tick for as long as the app is open.
            if streak == 1 {
                warn!("[hue-health] bridge probe failed: {code}");
            }
            if exhausted {
                warn!("[hue-health] bridge probe gave up after {streak} consecutive failures — manual retry required");
                inner.bridge.stopped = true;
                inner.bridge.due = None;
                inner.working.bridge.gave_up = true;
            }
        });
    }

    fn take_area(&self, now: Instant) -> Option<HueHealthTarget> {
        let mut inner = self.lock();
        if !inner.eligible().area || !inner.area.is_due(now) {
            return None;
        }
        inner.area.due = None;
        inner.target.clone()
    }

    fn apply_area(
        &self,
        probed: HueHealthTarget,
        response: HueStreamReadinessResponse,
        now: Instant,
    ) {
        let wall_ms = self.0.backend.wall_clock_ms();
        self.update(|inner| {
            if inner.target.as_ref() != Some(&probed) {
                return;
            }
            inner.record_area(probed.area_id, response, now, wall_ms);
        });
    }

    /// One pass: re-read what changed, run whatever is due, and say when the
    /// next pass is needed — `None` parks the task until something wakes it.
    pub(crate) async fn run_once(&self) -> Option<Instant> {
        let now = Instant::now();
        self.observe_target(now);

        let bridge_check = {
            let inner = self.lock();
            inner.eligible().stream_bridge && inner.stream_bridge_due.is_some_and(|due| due <= now)
        };
        let read = self.0.backend.stream(bridge_check).await;
        self.apply_stream(read, bridge_check, Instant::now());
        if self.closing() {
            return None;
        }

        let probe = self.take_bridge(Instant::now());
        self.lock().launch_probe = false;
        if let Some(target) = probe {
            let response = self.0.backend.validate(target.clone()).await;
            self.apply_bridge(&target, &response, Instant::now());
            if self.closing() {
                return None;
            }
        }

        if let Some(target) = self.take_area(Instant::now()) {
            let response = self.0.backend.readiness(target.clone()).await;
            self.apply_area(target, response, Instant::now());
        }

        self.lock().next_wake(Instant::now())
    }

    pub(crate) async fn run(self) {
        loop {
            if self.closing() {
                break;
            }
            let wake_at = self.run_once().await;
            if self.closing() {
                break;
            }
            let wake = self.wake_handle();
            match wake_at {
                Some(at) => {
                    tokio::select! {
                        _ = wake.notified() => {}
                        _ = tokio::time::sleep_until(at) => {}
                    }
                }
                None => wake.notified().await,
            }
        }
        info!("[hue-health] monitor stopped");
    }
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

static WAKE: OnceLock<Arc<Notify>> = OnceLock::new();

/// Tells the monitor the runtime moved (a stream stored or dropped, a start or
/// stop finished). A no-op until `install` has run, which is every test.
pub(crate) fn wake() {
    if let Some(wake) = WAKE.get() {
        wake.notify_one();
    }
}

/// Wakes the monitor on every return path of the command it guards.
pub(crate) struct WakeOnDrop;

impl Drop for WakeOnDrop {
    fn drop(&mut self) {
        wake();
    }
}

struct AppHealthBackend<R: Runtime> {
    app: AppHandle<R>,
}

impl<R: Runtime> HealthBackend for AppHealthBackend<R> {
    fn target(&self) -> Option<HueHealthTarget> {
        let state = shell_state::persisted(&self.app)?;
        hue_start_request(&state, HueRuntimeTriggerSource::System).map(HueHealthTarget::from)
    }

    fn stream(&self, bridge_check: bool) -> HealthFuture<'_, StreamRead> {
        Box::pin(async move {
            let store = self.app.state::<HueRuntimeStateStore>();
            let refreshed = refresh_hue_stream_status(store.inner(), bridge_check).await;
            StreamRead {
                health: HueStreamHealth {
                    active: refreshed.result.active,
                    status: refreshed.result.status,
                },
                stream_area: refreshed.stream_area,
                readiness: refreshed.readiness,
            }
        })
    }

    fn validate(
        &self,
        target: HueHealthTarget,
    ) -> HealthFuture<'_, HueValidateCredentialsResponse> {
        Box::pin(validate_hue_credentials(
            target.bridge_ip,
            target.username,
            None,
        ))
    }

    fn readiness(&self, target: HueHealthTarget) -> HealthFuture<'_, HueStreamReadinessResponse> {
        Box::pin(async move {
            let store = self.app.state::<HueRuntimeStateStore>();
            let streamer = if streams_area(store.inner(), &target.bridge_ip, &target.area_id) {
                ActiveStreamerView::Ours
            } else {
                ActiveStreamerView::Foreign
            };
            check_hue_stream_readiness_with_freshness(
                target.bridge_ip,
                target.username,
                target.area_id,
                HueReadFreshness::Cached,
                streamer,
            )
            .await
        })
    }

    fn wall_clock_ms(&self) -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|elapsed| u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX))
            .unwrap_or(0)
    }
}

/// Manages the monitor and starts its task. After `HueRuntimeStateStore` and
/// the shell state are managed: its first pass reads both.
pub fn install<R: Runtime>(app: &AppHandle<R>) {
    let monitor = HueHealthMonitor::new(
        Arc::new(AppHealthBackend { app: app.clone() }),
        Arc::new(app.clone()),
    );
    let _ = WAKE.set(monitor.wake_handle());
    app.manage(monitor.clone());
    tauri::async_runtime::spawn(monitor.run());
}

/// Hooked into every window's shell-state write.
pub fn note_settings_saved<'k, R: Runtime>(
    app: &AppHandle<R>,
    mut keys: impl Iterator<Item = &'k str>,
) {
    if !keys.any(|key| CONFIG_KEYS.contains(&key)) {
        return;
    }
    if let Some(monitor) = app.try_state::<HueHealthMonitor>() {
        monitor.note_config_changed();
    }
}

/// Ends the task at quit, before the Hue stop, so no probe starts after it.
pub fn close<R: Runtime>(app: &AppHandle<R>) {
    if let Some(monitor) = app.try_state::<HueHealthMonitor>() {
        monitor.close();
    }
}

// ---------------------------------------------------------------------------
// Commands — never reject; the snapshot is the answer.
// ---------------------------------------------------------------------------

/// The current snapshot, after a local runtime read.
#[tauri::command]
pub async fn get_hue_health(
    monitor: State<'_, HueHealthMonitor>,
) -> Result<HueHealthSnapshot, String> {
    Ok(monitor.read_now().await)
}

/// Records what the calling window needs and answers with the snapshot.
#[tauri::command]
pub async fn watch_hue_health<R: Runtime>(
    window: tauri::Window<R>,
    monitor: State<'_, HueHealthMonitor>,
    watch: HueHealthWatch,
) -> Result<HueHealthSnapshot, String> {
    monitor.watch(window.label(), watch);
    Ok(monitor.snapshot())
}

/// Re-arms every signal that gave up, and reads them at once.
#[tauri::command]
pub async fn retry_hue_health(
    monitor: State<'_, HueHealthMonitor>,
) -> Result<HueHealthSnapshot, String> {
    monitor.retry();
    Ok(monitor.snapshot())
}
