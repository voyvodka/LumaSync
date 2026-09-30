//! The lighting transaction: one command takes the running mode and its
//! outputs to what the user asked for, in the order the hardware needs, and
//! says what runs afterwards. The ordering rules it owns used to live in the
//! frontend orchestrator. Design: docs/architecture/lighting-transaction.md.
//!
//! Level-triggered: a request writes its intent on arrival and takes a
//! ticket; the transaction that gets the turn reconciles the running state
//! toward the *current* intent, and one whose ticket is no longer the newest
//! stops at the next phase boundary without touching hardware again.
#![deny(clippy::await_holding_lock)]

use std::future::Future;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use log::{info, warn};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use tauri::{AppHandle, Listener, Manager, Runtime, State};

use super::config::{normalize_effect, WledLiveFrameAdvisory};
use super::hue_driver::{hue_driver_for, HueAreaVerdict, HueDriver};
use super::snapshot::{
    parse_targets, publish_running, BootHueRetryState, HueLeftOutReason, LightingPhase,
    LightingRuntimeSnapshot, OutputTarget, OutputTargets,
};
use super::transition::{apply_config_blocking, blank_usb_after_off};
use super::tuning::{accepting_for_running, StoredTuning};
use super::{
    stop_lighting_blocking, AmbilightPayload, LightingModeCommandResult, LightingModeConfig,
    LightingModeKind, LightingRuntimeState,
};
use crate::commands::hue::health::{self, BOOT_RESUME_PROBE_WINDOW};
use crate::commands::hue::hue_config::{hue_start_request, room_geometry_from_state};
use crate::commands::hue::light_restore::HueLightsAfterStop;
use crate::commands::hue::state_store::{HueRuntimeTriggerSource, StartHueStreamRequest};
use crate::commands::hue_onboarding::ACTIVE_STREAMER_REASON;
use crate::commands::local_outputs::LocalOutputRegistry;
use crate::commands::shell_state::{self, PersistedShellState};
use crate::commands::status::CommandStatus;
use crate::commands::wled_discovery::{power_off_wled, WledPowerOffError};

mod away_tray;
mod boot;
mod lease;
mod transaction;
mod wled_off;

// Every item keeps its `outputs::` path: the callers and the tests name them there.
pub use away_tray::*;
pub use boot::*;
use lease::*;
pub(crate) use transaction::*;
pub(crate) use wled_off::*;

/// The readiness loop's cadence while a streamer holds the area.
pub(crate) const BOOT_HUE_RETRY_POLL: Duration = Duration::from_secs(3);

/// The bridge drops a silent session after ~10 s; after a killed process it
/// took 10–20 s.
pub(crate) const BOOT_HUE_RETRY_WINDOW: Duration = Duration::from_secs(25);

/// How long a launch restore that found no strip or WLED panel waits for one.
/// Auto-reconnect settles a serial controller for ~2 s after its scan; this
/// covers a slow USB enumeration too.
pub(crate) const BOOT_SINK_WAIT_WINDOW: Duration = Duration::from_secs(30);

/// A settings save waits this long for the edit to settle before the running
/// mode is re-applied: the room map saves on every drag move.
pub(crate) const SETTINGS_REFRESH_DEBOUNCE: Duration = Duration::from_millis(300);

/// Saved keys the running mode reads when it is applied. A save of any of them,
/// from any window, re-applies what runs once the edit settles. LED Setup saves
/// `ledCalibration` while a test pattern owns the strip; the refresh leaves a
/// test alone, and the test's own stop re-reads it.
const SETTINGS_THE_MODE_READS: &[&str] = &[
    "selectedDisplayId",
    "lightingIntensityPreset",
    "colorCorrection",
    "firmwareProfile",
    "selectedChipType",
    "ledColorOrder",
    "roomMap",
    "lastHueAreaId",
    "ledCalibration",
];

/// Saved keys a Hue pairing lives in. A save that leaves no pairing behind
/// takes back a launch restore parked for the bridge.
const HUE_PAIRING_KEYS: &[&str] = &[
    "lastHueBridge",
    "hueAppKey",
    "hueClientKey",
    "credentialStorageBackend",
];

// ---------------------------------------------------------------------------
// Wire shapes — `src/shared/contracts/lightingRuntime.ts`
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum LightingOrigin {
    User,
    Tray,
    Popup,
    Boot,
    UsbUnplug,
    LeaseHue,
}

impl LightingOrigin {
    /// A choice: its targets are saved on arrival and its mode once it runs.
    fn is_choice(self) -> bool {
        matches!(self, Self::User | Self::Tray | Self::Popup)
    }
}

/// `targets` arrives as names so an unknown one is answered with a coded
/// status, which a failed deserialisation could never carry.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyOutputsRequest {
    #[serde(default)]
    pub mode: Option<LightingModeConfig>,
    #[serde(default)]
    pub targets: Option<Vec<String>>,
    pub origin: LightingOrigin,
}

/// A request whose targets parsed.
struct Request {
    mode: Option<LightingModeConfig>,
    targets: Option<OutputTargets>,
    origin: LightingOrigin,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyOutputsOutcome {
    pub hue_start_code: Option<String>,
    pub hue_left_out: Option<HueLeftOutReason>,
    /// A choice that named Hue did not run on it, and ran on nothing else.
    pub hue_not_started: Option<HueLeftOutReason>,
    pub apply_status: Option<CommandStatus>,
    pub stop_failed: Vec<OutputTarget>,
    pub dropped_targets: Vec<OutputTarget>,
    pub mode_ended: bool,
    /// The bound WLED device and the strip layout disagree on the LED count:
    /// part of the strip will not follow. Only said by the apply that found it.
    pub wled_advisory: Option<WledLiveFrameAdvisory>,
}

/// A choice's answer as the snapshot carries it, so a surface that did not
/// make the choice — the main window for the tray and the popup — can say
/// what happened. Only choices publish one; a superseded one publishes none.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LightingOutcome {
    pub request_id: u64,
    pub origin: LightingOrigin,
    pub status: CommandStatus,
    pub outcome: ApplyOutputsOutcome,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyOutputsResult {
    pub status: CommandStatus,
    pub request_id: u64,
    pub snapshot: LightingRuntimeSnapshot,
    pub outcome: ApplyOutputsOutcome,
}

/// Sole constructor for the transaction's status, so the contract verifier
/// can harvest its codes from one call shape.
fn outputs_status(code: &str, message: &str, details: Option<String>) -> CommandStatus {
    CommandStatus {
        code: code.to_string(),
        message: message.to_string(),
        details,
    }
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/// What the user asked for, as of the newest request.
#[derive(Clone, Debug, Default)]
pub(crate) struct LightingIntent {
    known: bool,
    pub(crate) kind: LightingModeKind,
    /// The selection for this session; a left-out target drops from it.
    pub(crate) targets: OutputTargets,
    /// A choice asked for `kind` and it has not been saved yet. Level, not
    /// edge: a choice superseded by an unplug is saved by whichever
    /// transaction runs it.
    persist_mode: bool,
}

/// Who opened the Hue stream, which decides who may stop it.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
enum HueOwner {
    /// Nobody here — or a surface this module does not see, such as the
    /// Devices card. Left alone unless the running mode used it.
    #[default]
    Nobody,
    Transaction,
    Lease,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
enum LeaseState {
    #[default]
    Idle,
    /// The lease opened the stream, so it owes it a stop.
    Held,
    /// It was streaming already, or refused: hands off.
    NotOurs,
}

#[derive(Clone, Copy, Debug)]
enum BootRetryPlan {
    Resume { kind: LightingModeKind },
    Rejoin { left_out: HueLeftOutReason },
}

/// What parking a launch restore's Hue plan came to.
enum Parked {
    /// This launch already resumed once.
    Spent,
    /// The monitor already has the bridge answering.
    FireNow(BootRetryPlan),
    /// Waiting, under this generation, for the bridge to answer.
    Waiting(u64),
}

#[derive(Default)]
pub(crate) struct CancelToken {
    cancelled: AtomicBool,
    notify: tokio::sync::Notify,
}

impl CancelToken {
    pub(crate) fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
        self.notify.notify_waiters();
    }

    pub(crate) fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }
}

struct BootRetry {
    token: Arc<CancelToken>,
    plan: BootRetryPlan,
}

/// A launch restore that left the local output out because no strip or WLED
/// panel was there yet. Answered by the first one to connect before `deadline`.
#[derive(Clone, Copy, Debug)]
struct BootSinkWait {
    kind: LightingModeKind,
    deadline: Instant,
}

#[derive(Default)]
pub(crate) struct OutputsState {
    next_ticket: AtomicU64,
    latest_ticket: AtomicU64,
    intent: Mutex<LightingIntent>,
    hue_owner: Mutex<HueOwner>,
    lease: Mutex<LeaseState>,
    hue_stop_unconfirmed: AtomicBool,
    boot_retry: Mutex<Option<BootRetry>>,
    boot_sink_wait: Mutex<Option<BootSinkWait>>,
    /// What going away put out, for coming back to put back. Memory only: a
    /// crash while away resumes the last real choice from disk at launch.
    away: Mutex<Option<LightingModeKind>>,
    /// A launch restore Hue was left out of because the bridge did not
    /// answer, waiting for the health monitor to see it reachable.
    boot_hue_parked: Mutex<Option<BootRetryPlan>>,
    /// Set once a parked resume fired: at most one per launch.
    boot_hue_park_spent: AtomicBool,
    /// Whether the last Hue health publish said the bridge answers; the park
    /// fires on the edge into it, or at once when it already does.
    hue_reachable: AtomicBool,
    /// Tells a park's timeout from a later park's.
    boot_hue_park_generation: AtomicU64,
    /// `None` is `BOOT_RESUME_PROBE_WINDOW`; tests shorten it.
    boot_hue_park_window: Mutex<Option<Duration>>,
    /// Bumped by every save of a setting the mode reads; a refresh runs only
    /// if no later save arrived during its debounce.
    settings_generation: AtomicU64,
    /// A save since the last refresh named a setting other than the LED
    /// calibration, so the refresh runs whatever the calibration says.
    settings_beyond_calibration: AtomicBool,
}

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl OutputsState {
    fn issue_ticket(&self) -> u64 {
        let ticket = self.next_ticket.fetch_add(1, Ordering::SeqCst) + 1;
        self.latest_ticket.fetch_max(ticket, Ordering::SeqCst);
        ticket
    }

    /// An id for a lease operation: unique, but never the newest ticket, so a
    /// test pattern borrowing Hue supersedes no mode change.
    fn lease_id(&self) -> u64 {
        self.next_ticket.fetch_add(1, Ordering::SeqCst) + 1
    }

    fn is_superseded(&self, ticket: u64) -> bool {
        self.latest_ticket.load(Ordering::SeqCst) != ticket
    }

    pub(crate) fn intent(&self) -> LightingIntent {
        locked(&self.intent).clone()
    }

    pub(crate) fn hue_stop_unconfirmed(&self) -> bool {
        self.hue_stop_unconfirmed.load(Ordering::SeqCst)
    }

    fn owner(&self) -> HueOwner {
        locked(&self.hue_owner).to_owned()
    }

    fn set_owner(&self, owner: HueOwner) {
        locked(&self.hue_owner).clone_from(&owner);
    }

    fn lease(&self) -> LeaseState {
        locked(&self.lease).to_owned()
    }

    fn set_lease(&self, lease: LeaseState) {
        locked(&self.lease).clone_from(&lease);
    }

    /// Writes the request into the intent. Returns the targets to save, when
    /// the request is a choice that named them.
    fn record_arrival(
        &self,
        request: &Request,
        running_kind: LightingModeKind,
        persisted: Option<&PersistedShellState>,
    ) -> Option<OutputTargets> {
        let saved = || {
            persisted
                .and_then(PersistedShellState::last_output_targets)
                .map(|targets| {
                    targets
                        .iter()
                        .filter_map(|name| {
                            let target = OutputTarget::parse(name);
                            if target.is_none() {
                                warn!("[outputs] saved output target {name:?} is unknown; ignored");
                            }
                            target
                        })
                        .collect()
                })
                .unwrap_or_else(|| OutputTargets::from([OutputTarget::Usb]))
        };
        let mut intent = locked(&self.intent);
        if request.origin == LightingOrigin::Boot {
            let mode = request
                .mode
                .clone()
                .or_else(|| persisted.and_then(PersistedShellState::lighting_mode))
                .unwrap_or_default();
            // Only while nothing runs: a webview reload restores too, and must
            // not turn off lights the user has on.
            // Nor light a locked screen: a restore while away (a reload, a
            // crashed webview) waits for the return like everything else.
            let stay_off = (running_kind == LightingModeKind::Off
                && persisted.is_some_and(PersistedShellState::launch_lights_off))
                || locked(&self.away).is_some();
            intent.clone_from(&LightingIntent {
                known: true,
                kind: if stay_off {
                    LightingModeKind::Off
                } else {
                    mode.kind
                },
                targets: request.targets.clone().unwrap_or_else(saved),
                persist_mode: false,
            });
            return None;
        }
        if !intent.known {
            intent.clone_from(&LightingIntent {
                known: true,
                kind: running_kind,
                targets: saved(),
                persist_mode: false,
            });
        }
        if let Some(mode) = &request.mode {
            intent.kind = mode.kind;
            intent.persist_mode = request.origin.is_choice();
        }
        let targets = request.targets.clone()?;
        intent.targets = targets.clone();
        if request.origin.is_choice() {
            return Some(targets);
        }
        None
    }

    fn update_intent(&self, change: impl FnOnce(&mut LightingIntent)) {
        change(&mut locked(&self.intent));
    }

    fn take_boot_retry(&self) -> Option<BootRetry> {
        locked(&self.boot_retry).take()
    }

    fn boot_retry_pending(&self) -> bool {
        locked(&self.boot_retry).is_some()
    }

    fn cancel_boot_sink_wait(&self, reason: &str) {
        if locked(&self.boot_sink_wait).take().is_some() {
            info!("[outputs] boot wait for a strip cancelled: {reason}");
        }
    }

    /// A wait past its window lapses unanswered.
    #[cfg(test)]
    pub(crate) fn lapse_boot_sink_wait(&self) {
        if let Some(wait) = locked(&self.boot_sink_wait).as_mut() {
            wait.deadline = Instant::now();
        }
    }

    fn pending_retry_is_rejoin(&self) -> bool {
        matches!(
            locked(&self.boot_retry).as_ref().map(|retry| retry.plan),
            Some(BootRetryPlan::Rejoin { .. })
        ) || matches!(
            *locked(&self.boot_hue_parked),
            Some(BootRetryPlan::Rejoin { .. })
        )
    }

    fn boot_hue_parked(&self) -> bool {
        locked(&self.boot_hue_parked).is_some()
    }

    fn park_boot_hue(&self, plan: BootRetryPlan) -> Parked {
        if self.boot_hue_park_spent.load(Ordering::SeqCst) {
            return Parked::Spent;
        }
        // The monitor already has the bridge answering: an edge will not come.
        if self.hue_reachable.load(Ordering::SeqCst) {
            self.boot_hue_park_spent.store(true, Ordering::SeqCst);
            return Parked::FireNow(plan);
        }
        info!("[outputs] boot Hue resume parked until the bridge answers: {plan:?}");
        let generation = self.boot_hue_park_generation.fetch_add(1, Ordering::SeqCst) + 1;
        locked(&self.boot_hue_parked).replace(plan);
        Parked::Waiting(generation)
    }

    fn cancel_boot_hue_park(&self, reason: &str) -> bool {
        let cancelled = locked(&self.boot_hue_parked).take().is_some();
        if cancelled {
            info!("[outputs] parked boot Hue resume cancelled: {reason}");
        }
        cancelled
    }

    /// The park `generation` made, if it is still waiting once its window ends.
    fn lapse_boot_hue_park(&self, generation: u64) -> Option<BootRetryPlan> {
        if self.boot_hue_park_generation.load(Ordering::SeqCst) != generation {
            return None;
        }
        locked(&self.boot_hue_parked).take()
    }

    fn boot_hue_park_window(&self) -> Duration {
        locked(&self.boot_hue_park_window).unwrap_or(BOOT_RESUME_PROBE_WINDOW)
    }

    /// A park window short enough for a test to see it end.
    #[cfg(test)]
    pub(crate) fn set_boot_hue_park_window(&self, window: Duration) {
        locked(&self.boot_hue_park_window).replace(window);
    }

    /// The parked plan, on the edge into reachable. Takes it: it fires once.
    fn take_boot_hue_park(&self, reachable: bool) -> Option<BootRetryPlan> {
        let was = self.hue_reachable.swap(reachable, Ordering::SeqCst);
        if !reachable || was {
            return None;
        }
        let plan = locked(&self.boot_hue_parked).take()?;
        self.boot_hue_park_spent.store(true, Ordering::SeqCst);
        Some(plan)
    }
}

/// Forgetting the bridge ends every launch wait on it: the area wait and a
/// resume parked for the bridge to answer. Called first thing, so no step of
/// the forget that fails can leave one behind to fire on a later answer.
pub(crate) fn cancel_boot_hue_waits<R: Runtime>(app: &AppHandle<R>, reason: &str) {
    if app.try_state::<LightingRuntimeState>().is_some() {
        cancel_boot_retry(app, reason);
    }
}

/// A boot retry the user overtook: every choice supersedes it, and its notice
/// goes with it. A resume parked until the bridge answers goes too.
fn cancel_boot_retry<R: Runtime>(app: &AppHandle<R>, reason: &str) {
    let state = app.state::<LightingRuntimeState>();
    if state.outputs.cancel_boot_hue_park(reason) {
        health::note_boot_resume_pending(app, false);
    }
    let Some(retry) = state.outputs.take_boot_retry() else {
        // A wait that already gave up still says so; the choice answers it as
        // it would a pending one. Without this the notice outlived the choice
        // whenever the wait ended first.
        if state.snapshot.read().boot_hue_retry == Some(BootHueRetryState::GaveUp) {
            state
                .snapshot
                .publish(app, |snapshot| snapshot.boot_hue_retry = None);
        }
        return;
    };
    info!("[outputs] boot Hue retry cancelled: {reason}");
    retry.token.cancel();
    state.snapshot.publish(app, |snapshot| match retry.plan {
        BootRetryPlan::Resume { .. } => snapshot.boot_hue_retry = None,
        BootRetryPlan::Rejoin { .. } => {
            if snapshot.hue_held_out_reason == Some(HueLeftOutReason::Busy) {
                snapshot.hue_held_out_reason = None;
            }
        }
    });
}

// ---------------------------------------------------------------------------
// Small readers
// ---------------------------------------------------------------------------

fn target_strings<'t>(targets: impl IntoIterator<Item = &'t OutputTarget>) -> Vec<String> {
    targets
        .into_iter()
        .map(|t| t.as_str().to_string())
        .collect()
}

/// The targets a running mode drives. Absent or empty is USB, as a mode saved before targets
/// existed was.
/// `apply_mode_change` refuses an unknown name, so none runs to be dropped here.
fn running_targets(mode: &LightingModeConfig) -> Vec<OutputTarget> {
    if mode.kind == LightingModeKind::Off {
        return Vec::new();
    }
    let targets = mode.targets.as_deref().unwrap_or_default();
    if targets.is_empty() {
        return vec![OutputTarget::Usb];
    }
    targets
        .iter()
        .filter_map(|t| OutputTarget::parse(t))
        .collect::<OutputTargets>()
        .into_iter()
        .collect()
}

/// `isHueStartCodeOk`: the stream is up, or on its way up.
fn is_hue_start_ok(code: &str) -> bool {
    matches!(
        code,
        "HUE_STREAM_RUNNING"
            | "HUE_STREAM_RUNNING_DTLS"
            | "HUE_STREAM_STARTING"
            | "HUE_START_NOOP_ALREADY_ACTIVE"
    )
}

/// Why a start that named Hue could not use it. The start gate's `details`
/// end in `"; readiness: <code>[, <sentinel>]"` — a wire contract documented
/// on `CONFIG_NOT_READY_GATE_BLOCKED` in `hue.ts` — and only those tokens are
/// read, never the prose around them.
fn hue_refusal_reason(
    had_config: bool,
    start_code: Option<&str>,
    start_details: Option<&str>,
) -> HueLeftOutReason {
    if !had_config {
        return HueLeftOutReason::Config;
    }
    let blockers: Vec<&str> = start_details
        .and_then(|details| details.split_once("; readiness: "))
        .map(|(_, tokens)| tokens.split(", ").map(str::trim).collect())
        .unwrap_or_default();
    match start_code {
        Some(code) if code.starts_with("AUTH_INVALID_") || code.starts_with("HUE-AUTH-") => {
            HueLeftOutReason::Auth
        }
        _ if blockers.contains(&ACTIVE_STREAMER_REASON) => HueLeftOutReason::InUse,
        Some("HUE_STREAM_RUNNING_NO_LIGHTS") => HueLeftOutReason::NoLights,
        _ if blockers.contains(&"HUE_STREAM_NOT_READY") => HueLeftOutReason::NoLights,
        _ => HueLeftOutReason::Unreachable,
    }
}

/// A start that failed on the local output alone: its own open or write error, carried in the
/// details of the mode's start failure.
fn usb_output_failed(result: &LightingModeCommandResult) -> bool {
    matches!(
        result.status.code.as_str(),
        "SOLID_MODE_APPLY_FAILED" | "AMBILIGHT_MODE_START_FAILED" | "EFFECT_MODE_START_FAILED"
    ) && result
        .status
        .details
        .as_deref()
        .is_some_and(|details| details.starts_with("LED_OUTPUT_") || details.starts_with("WLED_"))
}

/// Refusals `apply_mode_change` returns before it touches the running mode.
fn is_gate_code(code: &str) -> bool {
    matches!(
        code,
        "DEVICE_NOT_CONNECTED"
            | "HUE_NOT_READY"
            | "LIGHTING_MODE_SHUTTING_DOWN"
            | "LIGHTING_MODE_INVALID_CONFIG"
    )
}

fn usb_available<R: Runtime>(app: &AppHandle<R>) -> bool {
    app.state::<LocalOutputRegistry>().driven().is_some()
}

/// The mode to apply: the newest payloads, stamped the way the frontend's
/// hydration stamped them — display, smoothing preset and room geometry. The
/// calibration and output stamps are filled by `apply_config_blocking`.
fn payload_for(
    kind: LightingModeKind,
    targets: &[OutputTarget],
    stored: &StoredTuning,
    persisted: Option<&PersistedShellState>,
) -> LightingModeConfig {
    let saved_mode = persisted.and_then(PersistedShellState::lighting_mode);
    let mut mode = LightingModeConfig {
        kind,
        targets: Some(target_strings(targets)),
        display_id: persisted
            .and_then(PersistedShellState::selected_display_id)
            .filter(|id| !id.is_empty()),
        ..LightingModeConfig::default()
    };
    match kind {
        LightingModeKind::Solid => {
            mode.solid = stored
                .solid
                .clone()
                .or_else(|| saved_mode.and_then(|saved| saved.solid));
        }
        LightingModeKind::Ambilight => {
            let mut ambilight = stored
                .ambilight
                .clone()
                .or_else(|| persisted.and_then(PersistedShellState::ambilight))
                .unwrap_or(AmbilightPayload {
                    brightness: 1.0,
                    ..AmbilightPayload::default()
                });
            ambilight.lighting_smoothing_preset = Some(
                persisted
                    .and_then(PersistedShellState::lighting_intensity_preset)
                    .unwrap_or_default(),
            );
            mode.ambilight = Some(ambilight);
            mode.room_geometry = persisted.and_then(room_geometry_from_state);
        }
        LightingModeKind::Effect => {
            mode.effect = stored
                .effect
                .clone()
                .or_else(|| saved_mode.and_then(|saved| saved.effect));
            // Drawn in screen space: Hue samples it by room, as it does the screen.
            mode.room_geometry = persisted.and_then(room_geometry_from_state);
        }
        LightingModeKind::Off => {}
    }
    mode
}

/// Writes `lightingMode`: the kind and both payloads. The selection is
/// `lastOutputTargets`, saved on arrival, so no copy of it goes here. A lit
/// kind is also `lastLitKind`, in the same write: an Off leaves it, so Lights'
/// power button (and a later tray "turn on") knows what to bring back after a
/// relaunch that found the lights off.
fn persist_mode<R: Runtime>(app: &AppHandle<R>, kind: &LightingModeKind, stored: &StoredTuning) {
    let mut mode = shell_state::persisted(app)
        .and_then(|state| state.lighting_mode_object())
        .unwrap_or_default();
    let mut put = |key: &str, value: Option<Value>| {
        if let Some(value) = value {
            mode.insert(key.to_string(), value);
        }
    };
    put("kind", serde_json::to_value(kind).ok());
    put(
        "solid",
        stored
            .solid
            .as_ref()
            .and_then(|s| serde_json::to_value(s).ok()),
    );
    put(
        "ambilight",
        stored
            .ambilight
            .as_ref()
            .and_then(|a| serde_json::to_value(a).ok()),
    );
    put(
        "effect",
        stored
            .effect
            .as_ref()
            .and_then(|e| serde_json::to_value(e).ok()),
    );
    // Stamped per dispatch and never part of the saved mode; `targets` is a
    // copy an older build wrote, which nothing read.
    for derived in ["ledCalibration", "roomGeometry", "targets"] {
        mode.remove(derived);
    }
    let mut set = Map::new();
    set.insert("lightingMode".to_string(), Value::Object(mode));
    if *kind != LightingModeKind::Off {
        if let Ok(lit) = serde_json::to_value(kind) {
            set.insert("lastLitKind".to_string(), lit);
        }
    }
    if let Err(error) = shell_state::patch_from_rust(app, set) {
        warn!("[outputs] could not save lightingMode: {error}");
    }
}

fn persist_targets<R: Runtime>(app: &AppHandle<R>, targets: &OutputTargets) {
    let mut set = Map::new();
    set.insert(
        "lastOutputTargets".to_string(),
        Value::from(target_strings(targets)),
    );
    if let Err(error) = shell_state::patch_from_rust(app, set) {
        warn!("[outputs] could not save lastOutputTargets: {error}");
    }
}

/// A retune's settled write: the running choice with its newest payloads.
pub(crate) fn persist_running_choice<R: Runtime>(app: &AppHandle<R>) {
    let state = app.state::<LightingRuntimeState>();
    let intent = state.outputs.intent();
    if intent.kind == LightingModeKind::Off || state.snapshot.read().mode.kind != intent.kind {
        return;
    }
    persist_mode(app, &intent.kind, &state.tuning.stored());
}

async fn blocking<R, T, F>(app: &AppHandle<R>, work: F) -> Result<T, String>
where
    R: Runtime,
    T: Send + 'static,
    F: FnOnce(&AppHandle<R>) -> Result<T, String> + Send + 'static,
{
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || work(&app))
        .await
        .unwrap_or_else(|error| Err(format!("LIGHTING_TRANSITION_WORKER_FAILED: {error}")))
}

/// A poisoned lock still says what runs; the stop that follows reports it.
fn read_running<R: Runtime>(app: &AppHandle<R>) -> Result<LightingModeConfig, String> {
    let state = app.state::<LightingRuntimeState>();
    let owner = state
        .runtime
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    Ok(owner.active_mode.clone())
}

/// A test pattern owns the strip: its own stop restores the mode, re-reading
/// the saved settings, so a refresh leaves it alone.
fn test_pattern_active<R: Runtime>(app: &AppHandle<R>) -> Result<bool, String> {
    let state = app.state::<LightingRuntimeState>();
    let owner = state
        .runtime
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    Ok(owner.preview.active_test_pattern.is_some())
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Take the running mode and its outputs to the request, in the order the
/// hardware needs. Coded refusals ride `status`; a rejection is a broken
/// runtime lock, never a refusal.
#[tauri::command]
pub async fn apply_outputs<R: Runtime>(
    app: AppHandle<R>,
    request: ApplyOutputsRequest,
) -> Result<ApplyOutputsResult, String> {
    apply_outputs_with(&app, request).await
}

/// Take Hue out of the running mode and stop its stream. With nothing else
/// selected the mode ends, the way Off does; nothing is saved either way.
#[tauri::command]
pub async fn release_hue_output<R: Runtime>(
    app: AppHandle<R>,
    trigger_source: HueRuntimeTriggerSource,
) -> Result<ApplyOutputsResult, String> {
    release_hue_with(&app, trigger_source).await
}

/// The last published snapshot. Sync and lock-free: it answers at once, even
/// while a transition holds the runtime.
#[tauri::command]
pub fn get_lighting_runtime(
    runtime_state: State<'_, LightingRuntimeState>,
) -> LightingRuntimeSnapshot {
    runtime_state.snapshot.read()
}
