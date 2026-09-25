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
use crate::commands::device_connection::{ActiveSinkRegistry, SerialConnectionState};
use crate::commands::hue::hue_config::{hue_start_request, room_geometry_from_state};
use crate::commands::hue::light_restore::HueLightsAfterStop;
use crate::commands::hue::state_store::{HueRuntimeTriggerSource, StartHueStreamRequest};
use crate::commands::hue_onboarding::ACTIVE_STREAMER_REASON;
use crate::commands::shell_state::{self, PersistedShellState};
use crate::commands::status::CommandStatus;
use crate::commands::wled_discovery::{power_off_wled, WledPowerOffError};

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
    /// A launch restore Hue was left out of because the bridge did not
    /// answer, waiting for the health monitor to see it reachable.
    boot_hue_parked: Mutex<Option<BootRetryPlan>>,
    /// Set once a parked resume fired: at most one per launch.
    boot_hue_park_spent: AtomicBool,
    /// Whether the last Hue health publish said the bridge answers; the park
    /// fires on the edge into it.
    hue_reachable: AtomicBool,
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
            intent.clone_from(&LightingIntent {
                known: true,
                kind: mode.kind,
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

    fn park_boot_hue(&self, plan: BootRetryPlan) {
        if self.boot_hue_park_spent.load(Ordering::SeqCst) {
            return;
        }
        info!("[outputs] boot Hue resume parked until the bridge answers: {plan:?}");
        locked(&self.boot_hue_parked).replace(plan);
    }

    fn cancel_boot_hue_park(&self, reason: &str) {
        if locked(&self.boot_hue_parked).take().is_some() {
            info!("[outputs] parked boot Hue resume cancelled: {reason}");
        }
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
    state.outputs.cancel_boot_hue_park(reason);
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

/// The targets a running mode drives. Absent or empty is USB (legacy D-10).
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
    let serial = app
        .state::<SerialConnectionState>()
        .last_status
        .lock()
        .map(|status| status.output_port().is_some())
        .unwrap_or(false);
    serial
        || app
            .state::<ActiveSinkRegistry>()
            .active_wled_config()
            .is_some()
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
        LightingModeKind::Off => {}
    }
    mode
}

/// Writes `lightingMode`: the kind and both payloads. The selection is
/// `lastOutputTargets`, saved on arrival, so no copy of it goes here.
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
    // Stamped per dispatch and never part of the saved mode; `targets` is a
    // copy an older build wrote, which nothing read.
    for derived in ["ledCalibration", "roomGeometry", "targets"] {
        mode.remove(derived);
    }
    let mut set = Map::new();
    set.insert("lightingMode".to_string(), Value::Object(mode));
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
// The transaction
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq)]
enum TxKind {
    Choice(LightingOrigin),
    Boot,
    /// The boot restore's one retry once a held area frees.
    BootRetry,
    /// The boot restore's resume once the strip or WLED panel it found
    /// missing connects.
    BootSinkRetry,
    /// `previous` is the selection before the strip went away.
    UsbUnplug {
        previous: OutputTargets,
    },
    Release {
        trigger: HueRuntimeTriggerSource,
        previous: OutputTargets,
    },
    /// A saved setting the running mode reads changed: re-apply what runs, on
    /// what it runs on. Changes no intent and saves nothing.
    Refresh,
}

impl TxKind {
    fn is_boot(&self) -> bool {
        matches!(self, Self::Boot | Self::BootRetry | Self::BootSinkRetry)
    }

    fn release_trigger(&self) -> Option<HueRuntimeTriggerSource> {
        match self {
            Self::Release { trigger, .. } => Some(trigger.clone()),
            _ => None,
        }
    }

    /// The selection to put back when the mode ends because its last target
    /// went: the user did not deselect anything.
    fn selection_to_keep(&self) -> Option<OutputTargets> {
        match self {
            Self::UsbUnplug { previous } | Self::Release { previous, .. } => Some(previous.clone()),
            _ => None,
        }
    }
}

/// How a transaction ended, before it is put on the wire.
enum Ending {
    Applied,
    Refused(String),
    StartFailed,
    Superseded,
    CalibrationRequired,
    ShuttingDown,
}

struct Transaction<'a, R: Runtime> {
    app: &'a AppHandle<R>,
    state: State<'a, LightingRuntimeState>,
    driver: Arc<dyn HueDriver>,
    ticket: u64,
    kind: TxKind,
    outcome: ApplyOutputsOutcome,
    applied_generation: u64,
    /// The mode this transaction asked for runs, with the payloads it read.
    carried: bool,
    /// `Some(x)` sets the snapshot's held-out reason to `x` when it finishes.
    held_out: Option<Option<HueLeftOutReason>>,
    /// What the last Hue start answered in its status `details`.
    hue_start_details: Option<String>,
    /// The launch restore left the strip out because none was there yet.
    boot_sink_missing: bool,
}

impl<'a, R: Runtime> Transaction<'a, R> {
    fn new(app: &'a AppHandle<R>, ticket: u64, kind: TxKind) -> Self {
        Self {
            app,
            state: app.state::<LightingRuntimeState>(),
            driver: hue_driver_for(app),
            ticket,
            kind,
            outcome: ApplyOutputsOutcome::default(),
            applied_generation: 0,
            carried: false,
            held_out: None,
            hue_start_details: None,
            boot_sink_missing: false,
        }
    }

    fn superseded(&self) -> bool {
        self.state.outputs.is_superseded(self.ticket)
    }

    fn publish_phase(&self, phase: LightingPhase) {
        let ticket = self.ticket;
        self.state.snapshot.publish(self.app, |snapshot| {
            snapshot.phase = phase;
            snapshot.request_id = Some(ticket);
        });
    }

    fn hue_live(&self) -> bool {
        self.driver.output_live().current().is_some()
    }

    fn persisted(&self) -> Option<PersistedShellState> {
        shell_state::persisted(self.app)
    }

    fn hue_request(&self) -> Option<StartHueStreamRequest> {
        self.persisted()
            .and_then(|state| hue_start_request(&state, HueRuntimeTriggerSource::ModeControl))
    }

    async fn apply(
        &mut self,
        kind: &LightingModeKind,
        targets: &[OutputTarget],
    ) -> Result<LightingModeCommandResult, String> {
        self.apply_waiving(kind, targets, false).await
    }

    /// `waive_hue_gate` keeps a mode that already runs on Hue on it while the
    /// stream is between sessions (reconnecting): the worker follows the slot.
    async fn apply_waiving(
        &mut self,
        kind: &LightingModeKind,
        targets: &[OutputTarget],
        waive_hue_gate: bool,
    ) -> Result<LightingModeCommandResult, String> {
        let stored = self.state.tuning.stored();
        self.applied_generation = stored.generation;
        let payload = payload_for(*kind, targets, &stored, self.persisted().as_ref());
        let hue_output = self.driver.output_live();
        info!(
            "[outputs] #{} apply {:?} on {:?}",
            self.ticket, payload.kind, payload.targets
        );
        let result = blocking(self.app, move |app| {
            let result = apply_config_blocking(app, payload, hue_output, waive_hue_gate)?;
            publish_running(app, &result.mode);
            Ok(result)
        })
        .await;
        if let Ok(result) = &result {
            self.outcome.apply_status = Some(result.status.clone());
        }
        result
    }

    async fn stop_lighting(&mut self) -> Result<LightingModeCommandResult, String> {
        info!("[outputs] #{} stop lighting", self.ticket);
        blocking(self.app, stop_lighting_blocking).await
    }

    /// `true` when the stop confirmed. One that did not stays listed active.
    /// Every stop restores the lights but a user's Off, which reads
    /// `hueOffBehavior` itself (`reconcile_off`).
    async fn stop_hue(&mut self, trigger: HueRuntimeTriggerSource) -> bool {
        self.stop_hue_then(trigger, HueLightsAfterStop::Restore)
            .await
    }

    async fn stop_hue_then(
        &mut self,
        trigger: HueRuntimeTriggerSource,
        lights: HueLightsAfterStop,
    ) -> bool {
        info!(
            "[outputs] #{} stop Hue ({trigger:?}, lights: {lights:?})",
            self.ticket
        );
        let result = self.driver.stop(trigger, lights).await;
        self.state.outputs.set_owner(HueOwner::Nobody);
        let confirmed = result.status.code == "HUE_STREAM_STOPPED";
        self.state
            .outputs
            .hue_stop_unconfirmed
            .store(!confirmed, Ordering::SeqCst);
        if !confirmed && !self.outcome.stop_failed.contains(&OutputTarget::Hue) {
            self.outcome.stop_failed.push(OutputTarget::Hue);
        }
        confirmed
    }

    /// Starts Hue and says whether it is up, or on its way up. A start left
    /// retrying keeps going unseen; nothing here will use it, so it is
    /// cancelled at once.
    async fn start_hue(&mut self, request: StartHueStreamRequest) -> bool {
        self.publish_phase(LightingPhase::StartingHue);
        info!(
            "[outputs] #{} start Hue on area {}",
            self.ticket, request.area_id
        );
        let started = self.driver.start(request).await;
        let code = started.status.code;
        self.outcome.hue_start_code = Some(code.clone());
        self.hue_start_details = started.status.details;
        let ok = is_hue_start_ok(&code);
        if ok && code != "HUE_START_NOOP_ALREADY_ACTIVE" {
            self.state.outputs.set_owner(HueOwner::Transaction);
        }
        if code == "TRANSIENT_RETRY_SCHEDULED" {
            self.stop_hue(HueRuntimeTriggerSource::System).await;
        }
        ok
    }

    /// The saved area, when the live stream holds another one. A stream
    /// opened elsewhere names no area here and is left where it is.
    fn hue_area_moved(&self) -> Option<StartHueStreamRequest> {
        let live = self.driver.live_area_id()?;
        let request = self.hue_request()?;
        (request.area_id != live).then_some(request)
    }

    /// Takes the stream to the saved area. A start on a running stream is a
    /// no-op whatever its area, so the old session stops first — its lights go
    /// back — and the new area is read after that.
    async fn move_hue(&mut self, request: StartHueStreamRequest) -> bool {
        info!(
            "[outputs] #{} the saved Hue area is now {}; moving the stream",
            self.ticket, request.area_id
        );
        self.publish_phase(LightingPhase::StartingHue);
        if !self.stop_hue(HueRuntimeTriggerSource::System).await {
            return false;
        }
        self.start_hue(request).await
    }

    /// A choice that named Hue alone, and Hue did not start: the reply says
    /// why, since nothing runs to carry a held-out reason.
    fn note_hue_not_started(&mut self, had_config: bool) {
        if matches!(self.kind, TxKind::Choice(_)) {
            self.outcome.hue_not_started = Some(self.hue_refusal(had_config));
        }
    }

    fn hue_refusal(&self, had_config: bool) -> HueLeftOutReason {
        hue_refusal_reason(
            had_config,
            self.outcome.hue_start_code.as_deref(),
            self.hue_start_details.as_deref(),
        )
    }

    async fn reconcile(&mut self) -> Result<Ending, String> {
        let intent = self.state.outputs.intent();
        if self.kind == TxKind::Refresh {
            if self.state.is_closing() {
                return Ok(Ending::ShuttingDown);
            }
            let running = blocking(self.app, read_running).await?;
            return self.reconcile_refresh(&intent, &running).await;
        }
        self.publish_phase(if intent.kind == LightingModeKind::Off {
            LightingPhase::Stopping
        } else {
            LightingPhase::Applying
        });
        if self.state.is_closing() {
            return Ok(Ending::ShuttingDown);
        }
        let running = blocking(self.app, read_running).await?;
        if let Some(trigger) = self.kind.release_trigger() {
            if running.kind == LightingModeKind::Off {
                self.state.tuning.close(None).await;
                self.stop_hue(trigger).await;
                self.commit().await;
                return Ok(Ending::Applied);
            }
        }
        if intent.kind == LightingModeKind::Off {
            return self.reconcile_off(&intent, &running).await;
        }
        let ending = self.reconcile_on(&intent, &running).await?;
        if self.boot_sink_missing && !matches!(ending, Ending::Superseded | Ending::ShuttingDown) {
            wait_for_local_sink(self.app, intent.kind);
        }
        Ok(ending)
    }

    async fn reconcile_off(
        &mut self,
        intent: &LightingIntent,
        running: &LightingModeConfig,
    ) -> Result<Ending, String> {
        let hue_up = self.hue_live() || self.driver.runtime_active();
        // Pressing Off — in a window, the popup or the tray — turns the lights
        // off. Every other way lighting ends lets them go back as they were.
        // docs/architecture/lighting-transaction.md ("Off turns the lights off").
        let user_off = matches!(self.kind, TxKind::Choice(_)) && intent.persist_mode;
        let stop_hue = match self.kind {
            // The user chose Off. As the frontend's Off did, a configured bridge
            // gets its stop even when no stream is known here, which also
            // cancels a retry. A target change while Off stops nothing.
            TxKind::Choice(_) if intent.persist_mode => hue_up || self.hue_request().is_some(),
            _ => hue_up && self.state.outputs.owner() == HueOwner::Transaction,
        };
        self.state.tuning.close(None).await;
        // The worker holds a handle on the Hue sender, which exits only once
        // every handle is gone, so the worker stops first — whatever its
        // targets. See docs/architecture/hue.md.
        let mut usb_off = None;
        if running.kind != LightingModeKind::Off {
            match self.stop_lighting().await {
                Ok(_) if user_off => {
                    let ended = running.clone();
                    usb_off = blocking(self.app, move |app| Ok(blank_usb_after_off(app, &ended)))
                        .await
                        .unwrap_or_default();
                }
                Ok(_) => {}
                Err(error) => {
                    warn!("[outputs] stop_lighting before the Hue stop failed: {error}");
                    self.outcome.stop_failed.push(OutputTarget::Usb);
                }
            }
        }
        // Read now, not from the request: the setting may have changed since
        // the mode started, and in another window.
        let hue_lights = if user_off {
            self.persisted()
                .map(|persisted| persisted.hue_off_behavior())
                .unwrap_or(HueLightsAfterStop::TurnOff)
        } else {
            HueLightsAfterStop::Restore
        };
        let wled = usb_off.and_then(|off| off.wled);
        let app = self.app;
        let wled_off = async move {
            if let Some(cfg) = wled {
                let power_off = wled_power_off_for(app);
                let result = blocking(app, move |_| Ok(power_off(cfg.ip))).await;
                log_wled_power_off(cfg.ip, result);
            }
        };
        if stop_hue {
            if self.superseded() {
                wled_off.await;
                return Ok(Ending::Superseded);
            }
            self.publish_phase(LightingPhase::Stopping);
            let _ = tokio::join!(
                self.stop_hue_then(HueRuntimeTriggerSource::ModeControl, hue_lights),
                wled_off
            );
        } else {
            wled_off.await;
        }
        if let Some(previous) = self.kind.selection_to_keep() {
            if intent.targets.is_empty() {
                self.state
                    .outputs
                    .update_intent(|intent| intent.targets = previous);
            }
        }
        self.held_out = Some(None);
        if intent.persist_mode {
            persist_mode(self.app, &intent.kind, &self.state.tuning.stored());
            self.state
                .outputs
                .update_intent(|intent| intent.persist_mode = false);
        }
        self.carried = true;
        self.commit().await;
        Ok(Ending::Applied)
    }

    async fn reconcile_on(
        &mut self,
        intent: &LightingIntent,
        running: &LightingModeConfig,
    ) -> Result<Ending, String> {
        let usb_present = usb_available(self.app);
        let has_calibration = self
            .persisted()
            .as_ref()
            .and_then(PersistedShellState::led_calibration)
            .is_some();
        // With no strip or WLED panel there is nothing to lay out yet: the
        // device gate answers that choice instead, and a Hue beside it runs.
        if matches!(self.kind, TxKind::Choice(_))
            && intent.kind != running.kind
            && intent.targets.contains(&OutputTarget::Usb)
            && !has_calibration
            && usb_present
        {
            self.settle_kind(running.kind);
            return Ok(Ending::CalibrationRequired);
        }

        let usb_selected = intent.targets.contains(&OutputTarget::Usb);
        let want_usb = usb_selected && (!self.kind.is_boot() || usb_present);
        // Auto-reconnect is still settling the strip when the launch restore
        // runs; the first local sink to connect resumes it (`wait_for_local_sink`).
        self.boot_sink_missing = self.kind == TxKind::Boot && usb_selected && !usb_present;
        // A strip that came up first resumes the mode on itself; Hue is the
        // held area's wait to bring back, or the unanswered bridge's, not this one's.
        let want_hue = intent.targets.contains(&OutputTarget::Hue)
            && self.kind.release_trigger().is_none()
            && !(self.kind == TxKind::BootSinkRetry
                && (self.state.outputs.boot_retry_pending()
                    || self.state.outputs.boot_hue_parked()));
        let running_before = running_targets(running);
        let hue_ran_before = running_before.contains(&OutputTarget::Hue);

        self.state.tuning.close(Some(intent.kind)).await;

        // Phase 1 — Hue first: the worker is handed the stream it will drive,
        // so a stream that is not up yet leaves the worker without Hue.
        let mut hue_ok = self.hue_live();
        let mut had_config = true;
        let mut hue_moved = false;
        if want_hue && hue_ok {
            if let Some(request) = self.hue_area_moved() {
                hue_moved = true;
                hue_ok = self.move_hue(request).await;
                if self.state.is_closing() {
                    return Ok(Ending::ShuttingDown);
                }
                if self.superseded() {
                    return Ok(Ending::Superseded);
                }
            }
        }
        if want_hue && !hue_ok && !hue_moved {
            match self.hue_request() {
                None => had_config = false,
                Some(request) => {
                    hue_ok = self.start_hue(request).await;
                    if self.state.is_closing() {
                        return Ok(Ending::ShuttingDown);
                    }
                }
            }
            if self.superseded() {
                return Ok(Ending::Superseded);
            }
        }

        // Phase 2 — the mode, on what can run it.
        let mut run_on: Vec<OutputTarget> = Vec::new();
        if want_usb {
            run_on.push(OutputTarget::Usb);
        }
        if want_hue && hue_ok {
            run_on.push(OutputTarget::Hue);
        }
        let mut hue_left_out = want_hue && !hue_ok;

        if run_on.is_empty() {
            if want_hue {
                // Hue alone, and Hue did not come up: nothing to run it on.
                self.note_hue_not_started(had_config);
                let mut running_after = running.clone();
                // The stream it ran on has moved away and did not come back:
                // what ran has nothing left to drive.
                if hue_moved && running.kind != LightingModeKind::Off {
                    self.publish_phase(LightingPhase::Stopping);
                    match self.stop_lighting().await {
                        Ok(result) => running_after = result.mode,
                        Err(error) => {
                            warn!("[outputs] stop_lighting after a failed Hue move: {error}");
                            self.outcome.stop_failed.push(OutputTarget::Usb);
                        }
                    }
                }
                return self
                    .refuse(
                        intent,
                        running,
                        running_after,
                        "HUE_NOT_READY".to_string(),
                        hue_ran_before,
                        had_config,
                    )
                    .await;
            }
            return self.end_mode(running, hue_ran_before).await;
        }

        let unchanged = intent.kind == running.kind
            && run_on == running_before
            && !hue_moved
            && self.state.tuning.is_current();
        let mut running_after = running.clone();
        let mut gate_absorbed = false;
        let mut apply_code = None;
        if unchanged {
            self.applied_generation = self.state.tuning.stored().generation;
        } else {
            self.publish_phase(LightingPhase::Applying);
            let mut result = match self.apply(&intent.kind, &run_on).await {
                Ok(result) => result,
                Err(error) => {
                    warn!("[outputs] apply failed: {error}");
                    return self
                        .refuse(
                            intent,
                            running,
                            running.clone(),
                            error,
                            hue_ran_before,
                            had_config,
                        )
                        .await;
                }
            };

            // The Hue gate refused a [usb, hue] run: run on USB alone. The
            // gate returns before the previous mode is touched, so this is a
            // clean second attempt; the stream this opened feeds nothing.
            if result.status.code == "HUE_NOT_READY" && run_on.len() > 1 {
                hue_left_out = true;
                if self.state.outputs.owner() == HueOwner::Transaction {
                    self.stop_hue(HueRuntimeTriggerSource::System).await;
                }
                run_on.retain(|t| *t == OutputTarget::Usb);
                if self.superseded() {
                    return Ok(Ending::Superseded);
                }
                result = match self.apply(&intent.kind, &run_on).await {
                    Ok(result) => result,
                    Err(error) => {
                        return self
                            .refuse(
                                intent,
                                running,
                                running.clone(),
                                error,
                                hue_ran_before,
                                had_config,
                            )
                            .await;
                    }
                };
            }

            // The device gate refused USB beside another output. It returned
            // before teardown, so the mode runs on the rest — the running mode
            // when USB was being added, the new choice when it was a mode — and
            // USB drops from this session's selection until a strip connects.
            if result.status.code == "DEVICE_NOT_CONNECTED" && run_on.len() > 1 {
                run_on.retain(|t| *t != OutputTarget::Usb);
                self.outcome.dropped_targets.push(OutputTarget::Usb);
                self.state
                    .outputs
                    .update_intent(|intent| intent.targets.retain(|t| *t != OutputTarget::Usb));
                if run_on == running_before && running.kind == intent.kind {
                    gate_absorbed = true;
                } else {
                    if self.superseded() {
                        return Ok(Ending::Superseded);
                    }
                    result = match self.apply(&intent.kind, &run_on).await {
                        Ok(result) => result,
                        Err(error) => {
                            return self
                                .refuse(
                                    intent,
                                    running,
                                    running.clone(),
                                    error,
                                    hue_ran_before,
                                    had_config,
                                )
                                .await;
                        }
                    };
                }
            }
            running_after = result.mode;
            apply_code = Some(result.status.code);
        }

        if apply_code.as_deref() == Some("LIGHTING_MODE_SHUTTING_DOWN") {
            return Ok(Ending::ShuttingDown);
        }
        let gated = apply_code.as_deref().is_some_and(is_gate_code) && !gate_absorbed;
        if gated || running_after.kind != intent.kind {
            let reason = apply_code.unwrap_or_default();
            if reason == "HUE_NOT_READY" && run_on == [OutputTarget::Hue] {
                self.note_hue_not_started(had_config);
            }
            return self
                .refuse(
                    intent,
                    running,
                    running_after,
                    reason,
                    hue_ran_before,
                    had_config,
                )
                .await;
        }

        let ran = running_targets(&running_after);
        if ran.contains(&OutputTarget::Hue) {
            self.held_out = Some(None);
            if self.state.outputs.owner() == HueOwner::Lease {
                // A mode started during a test adopts its stream; the lease
                // leaves it to the mode when it ends.
                self.state.outputs.set_owner(HueOwner::Transaction);
            }
        }
        if hue_left_out && ran.contains(&OutputTarget::Usb) {
            let reason = self.hue_refusal(had_config);
            self.outcome.hue_left_out = Some(reason);
            self.outcome.dropped_targets.push(OutputTarget::Hue);
            self.state
                .outputs
                .update_intent(|intent| intent.targets.retain(|t| *t != OutputTarget::Hue));
            if !self.maybe_schedule_rejoin(reason, had_config) {
                self.held_out = Some(Some(reason));
            }
        }

        // Phase 3 — Hue down, after the worker has let go of it.
        self.hue_down(&running_after, hue_ran_before).await;
        self.carried = true;
        self.commit().await;
        if intent.persist_mode {
            persist_mode(self.app, &intent.kind, &self.state.tuning.stored());
            self.state
                .outputs
                .update_intent(|intent| intent.persist_mode = false);
        }
        Ok(Ending::Applied)
    }

    /// Re-applies the running mode on what it runs on, so the payload is
    /// stamped from the settings as saved now. A mode that ended, or a test
    /// pattern that owns the strip, is left alone.
    async fn reconcile_refresh(
        &mut self,
        intent: &LightingIntent,
        running: &LightingModeConfig,
    ) -> Result<Ending, String> {
        if running.kind == LightingModeKind::Off || blocking(self.app, test_pattern_active).await? {
            return Ok(Ending::Applied);
        }
        let mut targets = running_targets(running);
        let hue_ran_before = targets.contains(&OutputTarget::Hue);
        self.state.tuning.close(Some(running.kind)).await;
        if hue_ran_before {
            if let Some(request) = self.hue_area_moved() {
                let moved = self.move_hue(request).await;
                if self.state.is_closing() {
                    return Ok(Ending::ShuttingDown);
                }
                if self.superseded() {
                    return Ok(Ending::Superseded);
                }
                if !moved {
                    let reason = self.hue_refusal(true);
                    targets.retain(|t| *t != OutputTarget::Hue);
                    if targets.is_empty() {
                        return self.end_mode(running, hue_ran_before).await;
                    }
                    self.outcome.hue_left_out = Some(reason);
                    self.outcome.dropped_targets.push(OutputTarget::Hue);
                    self.held_out = Some(Some(reason));
                    self.state
                        .outputs
                        .update_intent(|intent| intent.targets.retain(|t| *t != OutputTarget::Hue));
                }
            }
        }
        self.publish_phase(LightingPhase::Applying);
        // What runs on Hue keeps it through a reconnect: the Hue gate would
        // refuse the whole re-apply, and the strip would never see the change.
        let waive_hue_gate = targets.contains(&OutputTarget::Hue);
        let result = match self
            .apply_waiving(&running.kind, &targets, waive_hue_gate)
            .await
        {
            Ok(result) => result,
            Err(error) => {
                warn!("[outputs] settings refresh failed: {error}");
                return self
                    .refuse(
                        intent,
                        running,
                        running.clone(),
                        error,
                        hue_ran_before,
                        true,
                    )
                    .await;
            }
        };
        if result.status.code == "LIGHTING_MODE_SHUTTING_DOWN" {
            return Ok(Ending::ShuttingDown);
        }
        if is_gate_code(&result.status.code) || result.mode.kind != running.kind {
            let reason = result.status.code.clone();
            return self
                .refuse(intent, running, result.mode, reason, hue_ran_before, true)
                .await;
        }
        self.carried = true;
        self.commit().await;
        Ok(Ending::Applied)
    }

    /// The mode did not run. What was running still runs — unless it drives a
    /// target the user has just deselected, which must not stay lit. A torn
    /// down mode (`running_after` Off) is a failed start, not a refusal.
    async fn refuse(
        &mut self,
        intent: &LightingIntent,
        running: &LightingModeConfig,
        mut running_after: LightingModeConfig,
        reason: String,
        hue_ran_before: bool,
        had_config: bool,
    ) -> Result<Ending, String> {
        let deselected = running_targets(&running_after)
            .iter()
            .any(|target| !intent.targets.contains(target));
        if deselected && !self.kind.is_boot() {
            self.publish_phase(LightingPhase::Stopping);
            match self.stop_lighting().await {
                Ok(result) => running_after = result.mode,
                Err(error) => {
                    warn!("[outputs] stop_lighting after a refused re-apply failed: {error}");
                    self.outcome.stop_failed.push(OutputTarget::Usb);
                }
            }
        }
        self.hue_down(&running_after, hue_ran_before).await;
        self.maybe_schedule_resume(intent, &running_after, had_config);
        self.settle_kind(running_after.kind);
        if running_after.kind == LightingModeKind::Off && running.kind != LightingModeKind::Off {
            self.outcome.mode_ended = true;
            self.held_out = Some(None);
        }
        self.commit().await;
        let start_failed = running_after.kind == LightingModeKind::Off
            && !is_gate_code(&reason)
            && self
                .outcome
                .apply_status
                .as_ref()
                .is_some_and(|status| status.code == reason);
        if start_failed {
            Ok(Ending::StartFailed)
        } else {
            Ok(Ending::Refused(reason))
        }
    }

    /// Nothing is left to run the mode on: it ends, the way Off does, and the
    /// selection is kept for when the target comes back. Session only.
    async fn end_mode(
        &mut self,
        running: &LightingModeConfig,
        hue_ran_before: bool,
    ) -> Result<Ending, String> {
        if running.kind != LightingModeKind::Off {
            self.publish_phase(LightingPhase::Stopping);
            if let Err(error) = self.stop_lighting().await {
                warn!("[outputs] stop_lighting failed: {error}");
                self.outcome.stop_failed.push(OutputTarget::Usb);
            }
            self.outcome.mode_ended = true;
        }
        self.hue_down(&LightingModeConfig::default(), hue_ran_before)
            .await;
        let keep = self.kind.selection_to_keep();
        self.state.outputs.update_intent(|intent| {
            intent.kind = LightingModeKind::Off;
            intent.persist_mode = false;
            if let Some(targets) = keep {
                intent.targets = targets;
            }
        });
        self.held_out = Some(None);
        self.commit().await;
        Ok(Ending::Applied)
    }

    /// Level-triggered release: a Hue stream the running mode does not use is
    /// stopped if this module opened it, or if the mode that used it is gone.
    /// A test lease's stream is its own to stop.
    async fn hue_down(&mut self, running_after: &LightingModeConfig, hue_ran_before: bool) {
        let needed = running_targets(running_after).contains(&OutputTarget::Hue);
        let releasing = self.kind.release_trigger();
        if needed || !(self.hue_live() || self.driver.runtime_active()) {
            return;
        }
        let owner = self.state.outputs.owner();
        let ours = releasing.is_some() || owner == HueOwner::Transaction || hue_ran_before;
        if !ours || (owner == HueOwner::Lease && releasing.is_none()) {
            return;
        }
        self.publish_phase(LightingPhase::Stopping);
        self.stop_hue(releasing.unwrap_or(HueRuntimeTriggerSource::System))
            .await;
    }

    /// Installs what retunes may reach now and applies one that arrived
    /// while this transaction ran.
    async fn commit(&mut self) {
        let hue_output = self.driver.output_live();
        let accepting = blocking(self.app, move |app| {
            Ok(accepting_for_running(app, hue_output))
        })
        .await
        .unwrap_or(None);
        self.state
            .tuning
            .commit(accepting, self.applied_generation, self.carried)
            .await;
    }

    /// What was asked for did not run: the intent follows what does, so a
    /// later reconcile does not retry a choice that was already answered.
    fn settle_kind(&self, kind: LightingModeKind) {
        self.state.outputs.update_intent(|intent| {
            if intent.kind != kind {
                intent.kind = kind;
                intent.persist_mode = false;
            }
        });
    }

    /// A launch whose restore a held area refused waits for it once.
    fn maybe_schedule_resume(
        &self,
        intent: &LightingIntent,
        running: &LightingModeConfig,
        had_config: bool,
    ) {
        if self.kind != TxKind::Boot || !had_config || running.kind != LightingModeKind::Off {
            return;
        }
        let plan = BootRetryPlan::Resume { kind: intent.kind };
        if self.outcome.hue_start_code.as_deref() != Some("CONFIG_NOT_READY_GATE_BLOCKED") {
            self.maybe_park(plan, had_config);
            return;
        }
        if let Some(request) = self.hue_request() {
            schedule_boot_retry(self.app, plan, request);
        }
    }

    /// The same wait for a restore running on USB with Hue left out. Its
    /// first probe decides the notice, so nothing is raised yet.
    fn maybe_schedule_rejoin(&self, left_out: HueLeftOutReason, had_config: bool) -> bool {
        if self.kind != TxKind::Boot || !had_config {
            return false;
        }
        let plan = BootRetryPlan::Rejoin { left_out };
        if self.outcome.hue_start_code.as_deref() != Some("CONFIG_NOT_READY_GATE_BLOCKED") {
            self.maybe_park(plan, had_config);
            return false;
        }
        let Some(request) = self.hue_request() else {
            return false;
        };
        schedule_boot_retry(self.app, plan, request);
        true
    }

    /// A launch whose Hue start failed for a bridge that did not answer —
    /// Wi-Fi not up yet at login — waits for the health monitor to see it
    /// answer. The gate's refusal gets there through the area wait instead.
    fn maybe_park(&self, plan: BootRetryPlan, had_config: bool) {
        let refused = self
            .outcome
            .hue_start_code
            .as_deref()
            .is_some_and(|code| !is_hue_start_ok(code));
        if refused && self.hue_refusal(had_config) == HueLeftOutReason::Unreachable {
            self.state.outputs.park_boot_hue(plan);
        }
    }

    fn finish(self, ending: Ending) -> ApplyOutputsResult {
        let status = match ending {
            Ending::Superseded => outputs_status(
                "OUTPUTS_SUPERSEDED",
                "A newer lighting request took over.",
                None,
            ),
            Ending::ShuttingDown => outputs_status(
                "OUTPUTS_SHUTTING_DOWN",
                "The app is shutting down; nothing new was started.",
                None,
            ),
            Ending::CalibrationRequired => outputs_status(
                "OUTPUTS_CALIBRATION_REQUIRED",
                "The LED strip needs a calibration before this mode can use it.",
                None,
            ),
            Ending::Refused(reason) => outputs_status(
                "OUTPUTS_REFUSED",
                "The lighting change was refused; what was running still runs.",
                Some(reason),
            ),
            Ending::StartFailed => outputs_status(
                "OUTPUTS_START_FAILED",
                "The lighting mode could not start, and nothing is running.",
                self.outcome
                    .apply_status
                    .as_ref()
                    .and_then(|s| s.details.clone()),
            ),
            Ending::Applied
                if self.outcome.hue_left_out.is_some()
                    || !self.outcome.stop_failed.is_empty()
                    || !self.outcome.dropped_targets.is_empty() =>
            {
                outputs_status(
                    "OUTPUTS_APPLIED_PARTIAL",
                    "The lighting mode runs, but not on every output asked for.",
                    None,
                )
            }
            Ending::Applied => outputs_status("OUTPUTS_APPLIED", "Lighting updated.", None),
        };
        let superseded = status.code == "OUTPUTS_SUPERSEDED";
        let snapshot = if superseded {
            self.state.snapshot.read()
        } else {
            let intent = self.state.outputs.intent();
            let held_out = self.held_out;
            let ticket = self.ticket;
            let hue_live = self.hue_live();
            let hue_unconfirmed = self.state.outputs.hue_stop_unconfirmed();
            // Every choice's answer rides the snapshot, whoever made it: the
            // tray has no reply to read and the main window did not ask.
            let last_outcome = match self.kind {
                TxKind::Choice(origin) => Some(LightingOutcome {
                    request_id: ticket,
                    origin,
                    status: status.clone(),
                    outcome: self.outcome.clone(),
                }),
                _ => None,
            };
            self.state.snapshot.publish(self.app, |snapshot| {
                // A Hue stop after the last apply changed what is driven.
                let mode = snapshot.mode.clone();
                snapshot.set_running(&mode, hue_live, hue_unconfirmed);
                snapshot.phase = LightingPhase::Idle;
                snapshot.request_id = Some(ticket);
                snapshot.selected_targets = intent.targets.iter().copied().collect();
                if let Some(held_out) = held_out {
                    snapshot.hue_held_out_reason = held_out;
                }
                if last_outcome.is_some() {
                    snapshot.last_outcome = last_outcome;
                }
            })
        };
        info!(
            "[outputs] #{} {} — running {:?} on {:?}",
            self.ticket, status.code, snapshot.mode.kind, snapshot.active_targets
        );
        ApplyOutputsResult {
            status,
            request_id: self.ticket,
            snapshot,
            outcome: self.outcome,
        }
    }
}

async fn run_ticketed<R: Runtime>(
    app: &AppHandle<R>,
    ticket: u64,
    kind: TxKind,
) -> Result<ApplyOutputsResult, String> {
    let state = app.state::<LightingRuntimeState>();
    let _turn = state.transitions.lock().await;
    let mut transaction = Transaction::new(app, ticket, kind);
    if transaction.superseded() {
        return Ok(transaction.finish(Ending::Superseded));
    }
    match transaction.reconcile().await {
        Ok(ending) => Ok(transaction.finish(ending)),
        Err(error) => {
            let ticket = transaction.ticket;
            state.snapshot.publish(app, |snapshot| {
                snapshot.phase = LightingPhase::Idle;
                snapshot.request_id = Some(ticket);
            });
            Err(error)
        }
    }
}

/// A request that names an output this build does not know. Nothing was
/// recorded, saved or touched.
fn invalid_request<R: Runtime>(app: &AppHandle<R>, reason: String) -> ApplyOutputsResult {
    let state = app.state::<LightingRuntimeState>();
    warn!("[outputs] request refused: {reason}");
    ApplyOutputsResult {
        status: outputs_status(
            "OUTPUTS_INVALID_REQUEST",
            "The lighting request named an output that does not exist; nothing was changed.",
            Some(reason),
        ),
        request_id: state.outputs.lease_id(),
        snapshot: state.snapshot.read(),
        outcome: ApplyOutputsOutcome::default(),
    }
}

/// The body of `apply_outputs`, over an `AppHandle` so tests drive it directly.
pub(crate) async fn apply_outputs_with<R: Runtime>(
    app: &AppHandle<R>,
    request: ApplyOutputsRequest,
) -> Result<ApplyOutputsResult, String> {
    let targets = match request.targets.as_ref().map(parse_targets).transpose() {
        Ok(targets) => targets,
        Err(reason) => return Ok(invalid_request(app, reason)),
    };
    let request = Request {
        mode: request.mode,
        targets,
        origin: request.origin,
    };
    if request.origin == LightingOrigin::LeaseHue {
        return lease_hue(app, request).await;
    }
    let state = app.state::<LightingRuntimeState>();
    let kind = match request.origin {
        LightingOrigin::Boot => TxKind::Boot,
        LightingOrigin::UsbUnplug => TxKind::UsbUnplug {
            previous: state.outputs.intent().targets,
        },
        origin => TxKind::Choice(origin),
    };

    // The user always wins over the launch's wait for a held area. A target
    // change that still includes Hue lets a resume keep waiting; a rejoin is
    // answered by any output choice, since the user's own add speaks for itself.
    let cancels_retry = request.mode.is_some()
        || request.origin == LightingOrigin::Boot
        || request.targets.as_ref().is_some_and(|targets| {
            !targets.contains(&OutputTarget::Hue) || state.outputs.pending_retry_is_rejoin()
        });
    if cancels_retry {
        cancel_boot_retry(app, "a newer lighting request");
    }
    // Any request that says what should run answers the launch's wait for a
    // strip: a choice speaks for itself, and an unplug or a newer launch
    // restore changes what the wait was for.
    if request.mode.is_some() || request.targets.is_some() || request.origin == LightingOrigin::Boot
    {
        state
            .outputs
            .cancel_boot_sink_wait("a newer lighting request");
    }

    let ticket = state.outputs.issue_ticket();
    let persisted = shell_state::persisted(app);
    let running_kind = state.snapshot.read().mode.kind;
    let targets_to_save = state
        .outputs
        .record_arrival(&request, running_kind, persisted.as_ref());
    match (&request.mode, request.origin) {
        (Some(mode), _) => state
            .tuning
            .store(mode.solid.as_ref(), mode.ambilight.as_ref()),
        (None, LightingOrigin::Boot) => {
            if let Some(mode) = persisted
                .as_ref()
                .and_then(PersistedShellState::lighting_mode)
            {
                state
                    .tuning
                    .store(mode.solid.as_ref(), mode.ambilight.as_ref());
            }
        }
        _ => {}
    }
    if request.origin.is_choice() && (request.mode.is_some() || request.targets.is_some()) {
        // A new choice answers "is Hue in the mode" afresh.
        state
            .snapshot
            .publish(app, |snapshot| snapshot.hue_held_out_reason = None);
    }
    if let Some(targets) = targets_to_save {
        let _ = blocking(app, move |app| {
            persist_targets(app, &targets);
            Ok(())
        })
        .await;
    }
    run_ticketed(app, ticket, kind).await
}

/// The body of the settings refresh, over an `AppHandle` so tests drive it
/// directly. `None` when nothing runs to refresh.
///
/// It takes the newest ticket as it stands rather than a new one: a refresh
/// must never supersede a choice in flight, and a choice arriving after it
/// supersedes it — that choice re-applies anyway, since the save marked the
/// running payload stale.
pub(crate) async fn refresh_running_with<R: Runtime>(
    app: &AppHandle<R>,
) -> Result<Option<ApplyOutputsResult>, String> {
    let state = app.state::<LightingRuntimeState>();
    if state.snapshot.read().mode.kind == LightingModeKind::Off {
        return Ok(None);
    }
    let ticket = state.outputs.latest_ticket.load(Ordering::SeqCst);
    run_ticketed(app, ticket, TxKind::Refresh).await.map(Some)
}

/// Called for every write a window makes to the shell state. A write naming a
/// setting the running mode reads re-applies the mode once the edit settles.
/// This replaces the per-setting re-dispatches each settings panel used to
/// make, which reached only the window that made them.
pub fn note_settings_saved<'k, R: Runtime>(
    app: &AppHandle<R>,
    keys: impl IntoIterator<Item = &'k str>,
) {
    let keys: Vec<&str> = keys.into_iter().collect();
    let Some(state) = app.try_state::<LightingRuntimeState>() else {
        return;
    };
    if state.outputs.boot_hue_parked() && keys.iter().any(|key| HUE_PAIRING_KEYS.contains(key)) {
        // Read after the save, not in it: this runs under the shell-state lock.
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            if !hue_paired(&app) {
                app.state::<LightingRuntimeState>()
                    .outputs
                    .cancel_boot_hue_park("the bridge was forgotten");
            }
        });
    }
    let read: Vec<&str> = keys
        .into_iter()
        .filter(|key| SETTINGS_THE_MODE_READS.contains(key))
        .collect();
    if read.is_empty() {
        return;
    }
    if read.iter().any(|key| *key != "ledCalibration") {
        state
            .outputs
            .settings_beyond_calibration
            .store(true, Ordering::SeqCst);
    }
    let generation = state
        .outputs
        .settings_generation
        .fetch_add(1, Ordering::SeqCst)
        + 1;
    state.tuning.mark_stale();
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(SETTINGS_REFRESH_DEBOUNCE).await;
        let Some(state) = app.try_state::<LightingRuntimeState>() else {
            return;
        };
        if state.outputs.settings_generation.load(Ordering::SeqCst) != generation {
            return;
        }
        // Read here, not in the save: that runs under the shell-state lock.
        let beyond = state
            .outputs
            .settings_beyond_calibration
            .swap(false, Ordering::SeqCst);
        if !beyond && calibration_is_current(&app) {
            return;
        }
        match refresh_running_with(&app).await {
            Ok(Some(result)) => info!("[outputs] settings refresh: {}", result.status.code),
            Ok(None) => {}
            Err(error) => warn!("[outputs] settings refresh failed: {error}"),
        }
    });
}

/// LED Setup saves the layout on every step, most of them leaving it as the
/// running mode already carries it; a mode off the strip does not read it.
fn calibration_is_current<R: Runtime>(app: &AppHandle<R>) -> bool {
    let running = app.state::<LightingRuntimeState>().snapshot.read().mode;
    !running_targets(&running).contains(&OutputTarget::Usb)
        || running.led_calibration
            == shell_state::persisted(app).and_then(|state| state.led_calibration())
}

/// The tray's mode check group. It runs the transaction from Rust, so it works
/// whether or not a window is loaded.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TrayLighting {
    Off,
    Ambilight,
    Solid,
}

impl TrayLighting {
    pub const ALL: [Self; 3] = [Self::Off, Self::Ambilight, Self::Solid];

    pub fn kind(self) -> LightingModeKind {
        match self {
            Self::Off => LightingModeKind::Off,
            Self::Ambilight => LightingModeKind::Ambilight,
            Self::Solid => LightingModeKind::Solid,
        }
    }

    /// `TRAY_MENU_IDS.MODE_*` in `src/shared/contracts/shell.ts`.
    pub fn menu_id(self) -> &'static str {
        match self {
            Self::Off => "tray-mode-off",
            Self::Ambilight => "tray-mode-ambilight",
            Self::Solid => "tray-mode-solid",
        }
    }

    pub fn from_menu_id(id: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|item| item.menu_id() == id)
    }
}

/// One item of the tray's mode group as it should read now.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TrayModeItem {
    pub item: TrayLighting,
    pub checked: bool,
    pub enabled: bool,
}

/// The mode group for what runs. `locked` is what the main window's own mode
/// buttons have disabled (`TrayLabels.lockedModes`); a transaction in flight
/// greys all three, as a choice in flight does there.
pub fn tray_mode_items(
    running: LightingModeKind,
    transitioning: bool,
    locked: &[LightingModeKind],
) -> [TrayModeItem; 3] {
    TrayLighting::ALL.map(|item| TrayModeItem {
        item,
        checked: item.kind() == running,
        enabled: !transitioning && !locked.contains(&item.kind()),
    })
}

/// The request a tray item sends. The payloads are left out on purpose: the
/// transaction keeps the last colour — `DEFAULT_SOLID` before any — and the
/// last Ambilight settings.
pub(crate) fn tray_request(item: TrayLighting) -> ApplyOutputsRequest {
    ApplyOutputsRequest {
        mode: Some(LightingModeConfig {
            kind: item.kind(),
            ..LightingModeConfig::default()
        }),
        targets: None,
        origin: LightingOrigin::Tray,
    }
}

/// The answer is published as the snapshot's `lastOutcome`: the tray has no
/// window to read a reply, so the main window raises it.
pub fn run_tray_lighting<R: Runtime>(app: &AppHandle<R>, item: TrayLighting) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        match apply_outputs_with(&app, tray_request(item)).await {
            Ok(result) => info!("[outputs] tray {item:?}: {}", result.status.code),
            Err(error) => warn!("[outputs] tray {item:?} failed: {error}"),
        }
    });
}

/// The body of `release_hue_output`.
pub(crate) async fn release_hue_with<R: Runtime>(
    app: &AppHandle<R>,
    trigger: HueRuntimeTriggerSource,
) -> Result<ApplyOutputsResult, String> {
    cancel_boot_retry(app, "Hue was stopped");
    let state = app.state::<LightingRuntimeState>();
    let ticket = state.outputs.issue_ticket();
    let previous = state.outputs.intent().targets;
    state
        .outputs
        .update_intent(|intent| intent.targets.retain(|t| *t != OutputTarget::Hue));
    run_ticketed(app, ticket, TxKind::Release { trigger, previous }).await
}

// ---------------------------------------------------------------------------
// WLED switch-off — a user's Off on a WLED "usb" channel
// ---------------------------------------------------------------------------

pub(crate) type WledPowerOff =
    dyn Fn(std::net::Ipv4Addr) -> Result<(), WledPowerOffError> + Send + Sync;

/// Managed only by tests; production switches the device off over HTTP.
pub(crate) struct WledPowerOffHandle(pub(crate) Arc<WledPowerOff>);

fn wled_power_off_for<R: Runtime>(app: &AppHandle<R>) -> Arc<WledPowerOff> {
    if let Some(handle) = app.try_state::<WledPowerOffHandle>() {
        return Arc::clone(&handle.0);
    }
    // The production switch-off talks to a device on the network.
    if cfg!(test) {
        panic!("a test reached the production WLED switch-off — manage a WledPowerOffHandle");
    }
    Arc::new(power_off_wled)
}

fn log_wled_power_off(
    ip: std::net::Ipv4Addr,
    result: Result<Result<(), WledPowerOffError>, String>,
) {
    match result {
        Ok(Ok(())) => info!("[lighting-off] WLED {ip} switched off"),
        Ok(Err(error)) => warn!("[lighting-off] WLED {ip} not switched off: {error:?}"),
        Err(error) => warn!("[lighting-off] WLED {ip} switch-off did not run: {error}"),
    }
}

// ---------------------------------------------------------------------------
// The Hue test lease — a test pattern borrowing the stream
// ---------------------------------------------------------------------------

/// Bring Hue up for a test run that targets it, and hand back only what the
/// lease itself opened. A stream a live mode owns, or that a mode started
/// during the run adopted, is left to that mode: stopping it would turn off
/// lights the test never turned on.
async fn lease_hue<R: Runtime>(
    app: &AppHandle<R>,
    request: Request,
) -> Result<ApplyOutputsResult, String> {
    let state = app.state::<LightingRuntimeState>();
    let _turn = state.transitions.lock().await;
    let id = state.outputs.lease_id();
    let driver = hue_driver_for(app);
    let mut outcome = ApplyOutputsOutcome::default();
    let acquire = request
        .targets
        .as_ref()
        .is_some_and(|targets| targets.contains(&OutputTarget::Hue));

    let refused = if acquire {
        lease_acquire(app, state.inner(), driver.as_ref(), &mut outcome).await
    } else {
        lease_release(app, state.inner(), driver.as_ref(), &mut outcome).await?;
        false
    };
    let status = if refused {
        outputs_status(
            "OUTPUTS_REFUSED",
            "Hue could not be started for the test; it runs without Hue.",
            outcome.hue_start_code.clone(),
        )
    } else if outcome.stop_failed.is_empty() {
        outputs_status("OUTPUTS_APPLIED", "Lighting updated.", None)
    } else {
        outputs_status(
            "OUTPUTS_APPLIED_PARTIAL",
            "The Hue stream did not confirm its stop.",
            None,
        )
    };
    Ok(ApplyOutputsResult {
        status,
        request_id: id,
        snapshot: state.snapshot.read(),
        outcome,
    })
}

/// `true` when the lease could not bring Hue up.
async fn lease_acquire<R: Runtime>(
    app: &AppHandle<R>,
    state: &LightingRuntimeState,
    driver: &dyn HueDriver,
    outcome: &mut ApplyOutputsOutcome,
) -> bool {
    if state.outputs.lease() != LeaseState::Idle {
        return false;
    }
    if driver.output_live().current().is_some() {
        state.outputs.set_lease(LeaseState::NotOurs);
        return false;
    }
    let Some(request) = shell_state::persisted(app)
        .and_then(|persisted| hue_start_request(&persisted, HueRuntimeTriggerSource::ModeControl))
    else {
        state.outputs.set_lease(LeaseState::NotOurs);
        outcome.hue_left_out = Some(HueLeftOutReason::Config);
        return true;
    };
    let code = driver.start(request).await.status.code;
    outcome.hue_start_code = Some(code.clone());
    let opened = is_hue_start_ok(&code) && code != "HUE_START_NOOP_ALREADY_ACTIVE";
    if opened {
        state.outputs.set_owner(HueOwner::Lease);
        state.outputs.set_lease(LeaseState::Held);
    } else {
        state.outputs.set_lease(LeaseState::NotOurs);
    }
    if !is_hue_start_ok(&code) {
        warn!("[outputs] Hue lease start refused ({code}); the test runs without Hue");
        return true;
    }
    false
}

async fn lease_release<R: Runtime>(
    app: &AppHandle<R>,
    state: &LightingRuntimeState,
    driver: &dyn HueDriver,
    outcome: &mut ApplyOutputsOutcome,
) -> Result<(), String> {
    let held = state.outputs.lease() == LeaseState::Held;
    state.outputs.set_lease(LeaseState::Idle);
    if !held {
        return Ok(());
    }
    let running = blocking(app, read_running).await?;
    if running_targets(&running).contains(&OutputTarget::Hue) {
        info!("[outputs] a running mode adopted the leased Hue stream; leaving it up");
        state.outputs.set_owner(HueOwner::Transaction);
        return Ok(());
    }
    if state.outputs.owner() != HueOwner::Lease {
        return Ok(());
    }
    let result = driver
        .stop(
            HueRuntimeTriggerSource::ModeControl,
            HueLightsAfterStop::Restore,
        )
        .await;
    state.outputs.set_owner(HueOwner::Nobody);
    if result.status.code != "HUE_STREAM_STOPPED" {
        outcome.stop_failed.push(OutputTarget::Hue);
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// The boot retry — the one Hue retry made without the user
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ReleaseWait {
    Free,
    Timeout,
    NotBusy,
    /// The bridge did not answer: the wait parks until it does.
    Unreachable,
    Cancelled,
}

async fn sleep_or_cancel(token: &CancelToken, duration: Duration) {
    let notified = token.notify.notified();
    tokio::pin!(notified);
    // Registered before the flag is read, so a cancel between the two wakes it.
    notified.as_mut().enable();
    if token.is_cancelled() {
        return;
    }
    tokio::select! {
        _ = tokio::time::sleep(duration) => {}
        _ = notified => {}
    }
}

/// Polls until the area frees, stops being merely busy, or the window
/// closes. `on_busy` fires once, when the first probe confirms busy.
pub(crate) async fn wait_for_area_release<P, F>(
    mut probe: P,
    token: &CancelToken,
    mut on_busy: impl FnMut(),
    poll: Duration,
    window: Duration,
) -> ReleaseWait
where
    P: FnMut() -> F,
    F: Future<Output = HueAreaVerdict>,
{
    let started = tokio::time::Instant::now();
    let mut busy_seen = false;
    loop {
        if token.is_cancelled() {
            return ReleaseWait::Cancelled;
        }
        let verdict = probe().await;
        if token.is_cancelled() {
            return ReleaseWait::Cancelled;
        }
        match verdict {
            HueAreaVerdict::Free => return ReleaseWait::Free,
            // None clears by polling: a re-pair or an unusable area never
            // does, a bridge that does not answer does once it answers.
            HueAreaVerdict::Unreachable => return ReleaseWait::Unreachable,
            HueAreaVerdict::Other => return ReleaseWait::NotBusy,
            HueAreaVerdict::Busy => {}
        }
        if !busy_seen {
            busy_seen = true;
            on_busy();
        }
        if started.elapsed() + poll > window {
            return ReleaseWait::Timeout;
        }
        sleep_or_cancel(token, poll).await;
    }
}

fn schedule_boot_retry<R: Runtime>(
    app: &AppHandle<R>,
    plan: BootRetryPlan,
    request: StartHueStreamRequest,
) {
    let state = app.state::<LightingRuntimeState>();
    let token = Arc::new(CancelToken::default());
    if let Some(previous) = locked(&state.outputs.boot_retry).replace(BootRetry {
        token: Arc::clone(&token),
        plan,
    }) {
        previous.token.cancel();
    }
    info!("[outputs] boot Hue retry scheduled: {plan:?}");
    tokio::spawn(run_boot_retry(app.clone(), plan, token, request));
}

async fn run_boot_retry<R: Runtime>(
    app: AppHandle<R>,
    plan: BootRetryPlan,
    token: Arc<CancelToken>,
    request: StartHueStreamRequest,
) {
    let driver = hue_driver_for(&app);
    let announce = || {
        info!(
            "[outputs] boot Hue retry: the area is still held; waiting for the bridge to free it"
        );
        app.state::<LightingRuntimeState>()
            .snapshot
            .publish(&app, |snapshot| match plan {
                BootRetryPlan::Resume { .. } => {
                    snapshot.boot_hue_retry = Some(BootHueRetryState::Waiting)
                }
                BootRetryPlan::Rejoin { .. } => {
                    snapshot.hue_held_out_reason = Some(HueLeftOutReason::Busy)
                }
            });
    };
    let outcome = wait_for_area_release(
        || driver.probe_area(request.clone()),
        &token,
        announce,
        BOOT_HUE_RETRY_POLL,
        BOOT_HUE_RETRY_WINDOW,
    )
    .await;

    let state = app.state::<LightingRuntimeState>();
    {
        let mut slot = locked(&state.outputs.boot_retry);
        if slot
            .as_ref()
            .is_some_and(|retry| Arc::ptr_eq(&retry.token, &token))
        {
            slot.take();
        }
    }
    let notice = |snapshot: &mut LightingRuntimeSnapshot, resume, rejoin| match plan {
        BootRetryPlan::Resume { .. } => snapshot.boot_hue_retry = resume,
        BootRetryPlan::Rejoin { .. } => snapshot.hue_held_out_reason = rejoin,
    };
    match outcome {
        ReleaseWait::Cancelled => {}
        ReleaseWait::Timeout => {
            warn!("[outputs] boot Hue retry: the area stayed held for the whole wait");
            state.snapshot.publish(&app, |snapshot| {
                notice(
                    snapshot,
                    Some(BootHueRetryState::GaveUp),
                    Some(HueLeftOutReason::BusyGaveUp),
                )
            });
        }
        ReleaseWait::NotBusy | ReleaseWait::Unreachable => {
            let left_out = match plan {
                BootRetryPlan::Rejoin { left_out } => Some(left_out),
                BootRetryPlan::Resume { .. } => None,
            };
            if outcome == ReleaseWait::Unreachable {
                info!("[outputs] boot Hue retry: the bridge did not answer");
                state.outputs.park_boot_hue(plan);
            } else {
                warn!("[outputs] boot Hue retry: the refusal was not a busy area; not retrying");
            }
            state
                .snapshot
                .publish(&app, |snapshot| notice(snapshot, None, left_out));
        }
        ReleaseWait::Free => {
            info!("[outputs] boot Hue retry: the area is free");
            state
                .snapshot
                .publish(&app, |snapshot| notice(snapshot, None, None));
            resume_boot_hue(&app, plan).await;
        }
    }
}

/// Resumes a launch restore Hue was kept out of: the mode it could not run,
/// or Hue beside the strip it runs on. Once.
async fn resume_boot_hue<R: Runtime>(app: &AppHandle<R>, plan: BootRetryPlan) {
    let state = app.state::<LightingRuntimeState>();
    match plan {
        BootRetryPlan::Resume { kind } => {
            let snapshot = state.snapshot.read();
            if snapshot.mode.kind == LightingModeKind::Off {
                state.outputs.update_intent(|intent| intent.kind = kind);
            } else {
                // Only the strip's own resume runs a mode without the user
                // (every choice cancels this wait); it left Hue to this one.
                // Anything else has had its say.
                let hue_to_add = snapshot.mode.kind == kind
                    && !snapshot.active_targets.contains(&OutputTarget::Hue)
                    && state.outputs.intent().targets.contains(&OutputTarget::Hue);
                if !hue_to_add {
                    return;
                }
            }
        }
        BootRetryPlan::Rejoin { .. } => {
            state.outputs.update_intent(|intent| {
                intent.targets.insert(OutputTarget::Hue);
            });
        }
    }
    let ticket = state.outputs.issue_ticket();
    if let Err(error) = run_ticketed(app, ticket, TxKind::BootRetry).await {
        warn!("[outputs] boot Hue retry failed: {error}");
    }
}

// ---------------------------------------------------------------------------
// The parked boot Hue resume — answered by the health monitor
// ---------------------------------------------------------------------------

/// The slice of `hue://health` the parked resume reads.
#[derive(Deserialize)]
struct HueHealthView {
    bridge: HueBridgeView,
    stream: HueStreamView,
}

#[derive(Deserialize)]
struct HueBridgeView {
    verdict: Option<String>,
    probing: bool,
}

#[derive(Deserialize)]
struct HueStreamView {
    active: bool,
}

/// Follows the health monitor's own event rather than polling: a launch
/// restore parked for a bridge that did not answer resumes on the first
/// publish that says it does. See docs/architecture/lighting-transaction.md
/// ("The launch's wait for the bridge").
pub fn listen_hue_health<R: Runtime>(app: &AppHandle<R>) {
    let handle = app.clone();
    app.listen(crate::events::HUE_HEALTH_CHANGED_EVENT, move |event| {
        match serde_json::from_str::<HueHealthView>(event.payload()) {
            // A probe in flight still carries the previous verdict; only its
            // answer counts.
            Ok(view) => note_hue_reachable(
                &handle,
                view.stream.active
                    || (!view.bridge.probing
                        && view.bridge.verdict.as_deref() == Some("reachable")),
            ),
            Err(error) => warn!("[outputs] unreadable Hue health event: {error}"),
        }
    });
}

/// One health publish. On the edge into reachable a parked resume runs, once;
/// by then a quit or a forgotten bridge has taken it back.
pub(crate) fn note_hue_reachable<R: Runtime>(app: &AppHandle<R>, reachable: bool) {
    let Some(state) = app.try_state::<LightingRuntimeState>() else {
        return;
    };
    let Some(plan) = state.outputs.take_boot_hue_park(reachable) else {
        return;
    };
    // Off the emitting thread: this runs inside the monitor's publish.
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if app.state::<LightingRuntimeState>().is_closing() {
            return;
        }
        if !hue_paired(&app) {
            info!("[outputs] the bridge answers, but it is no longer paired; not resuming");
            return;
        }
        info!("[outputs] the bridge answers; resuming the launch restore on Hue ({plan:?})");
        resume_boot_hue(&app, plan).await;
    });
}

fn hue_paired<R: Runtime>(app: &AppHandle<R>) -> bool {
    shell_state::persisted(app)
        .and_then(|persisted| hue_start_request(&persisted, HueRuntimeTriggerSource::ModeControl))
        .is_some()
}

// ---------------------------------------------------------------------------
// The boot wait for a strip — the launch restore's resume once one connects
// ---------------------------------------------------------------------------

/// Called by a launch restore that left the local output out because no strip
/// or WLED panel was bound yet. See docs/architecture/lighting-transaction.md
/// ("The launch's wait for a strip").
fn wait_for_local_sink<R: Runtime>(app: &AppHandle<R>, kind: LightingModeKind) {
    let state = app.state::<LightingRuntimeState>();
    locked(&state.outputs.boot_sink_wait).replace(BootSinkWait {
        kind,
        deadline: Instant::now() + BOOT_SINK_WAIT_WINDOW,
    });
    info!("[outputs] boot restore: no strip or WLED panel yet; waiting for one to connect");
    // One that connected while the restore ran found no wait to answer.
    if usb_available(app) {
        note_local_sink_connected(app);
    }
}

/// A serial strip or a WLED panel was bound. Resumes a launch restore that
/// was waiting for one: the mode it could not run, or the strip beside the
/// Hue it ran on.
pub fn note_local_sink_connected<R: Runtime>(app: &AppHandle<R>) {
    let Some(state) = app.try_state::<LightingRuntimeState>() else {
        return;
    };
    let Some(wait) = locked(&state.outputs.boot_sink_wait).take() else {
        return;
    };
    if Instant::now() >= wait.deadline {
        info!("[outputs] a strip connected after the boot wait ended; the user picks the mode");
        return;
    }
    let seen = state.outputs.latest_ticket.load(Ordering::SeqCst);
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let state = app.state::<LightingRuntimeState>();
        // A request since the connect has had its say.
        if state.outputs.latest_ticket.load(Ordering::SeqCst) != seen {
            return;
        }
        let snapshot = state.snapshot.read();
        if snapshot.mode.kind == LightingModeKind::Off {
            state
                .outputs
                .update_intent(|intent| intent.kind = wait.kind);
        } else if snapshot.active_targets.contains(&OutputTarget::Usb) {
            return;
        }
        info!("[outputs] a strip connected; resuming the launch restore on it");
        let ticket = state.outputs.issue_ticket();
        match run_ticketed(&app, ticket, TxKind::BootSinkRetry).await {
            Ok(result) => info!("[outputs] boot strip resume: {}", result.status.code),
            Err(error) => warn!("[outputs] boot strip resume failed: {error}"),
        }
    });
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
