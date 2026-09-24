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
use std::time::Duration;

use log::{info, warn};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use tauri::{AppHandle, Manager, Runtime, State};

use super::hue_driver::{hue_driver_for, HueAreaVerdict, HueDriver};
use super::snapshot::{
    normalize_targets, publish_running, BootHueRetryState, HueLeftOutReason, LightingPhase,
    LightingRuntimeSnapshot, OutputTarget,
};
use super::tuning::{accepting_for_running, StoredTuning};
use super::{
    apply_config_blocking, stop_lighting_blocking, AmbilightPayload, LightingModeCommandResult,
    LightingModeConfig, LightingModeKind, LightingRuntimeState,
};
use crate::commands::device_connection::{ActiveSinkRegistry, SerialConnectionState};
use crate::commands::hue::hue_config::{hue_start_request, room_geometry_from_state};
use crate::commands::hue::state_store::{HueRuntimeTriggerSource, StartHueStreamRequest};
use crate::commands::shell_state::{self, PersistedShellState};
use crate::commands::status::CommandStatus;

/// The readiness loop's cadence while a streamer holds the area.
pub(crate) const BOOT_HUE_RETRY_POLL: Duration = Duration::from_secs(3);

/// The bridge drops a silent session after ~10 s; after a killed process it
/// took 10–20 s.
pub(crate) const BOOT_HUE_RETRY_WINDOW: Duration = Duration::from_secs(25);

// ---------------------------------------------------------------------------
// Wire shapes — `src/shared/contracts/lightingRuntime.ts`
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
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

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyOutputsRequest {
    #[serde(default)]
    pub mode: Option<LightingModeConfig>,
    #[serde(default)]
    pub targets: Option<Vec<OutputTarget>>,
    pub origin: LightingOrigin,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyOutputsOutcome {
    pub hue_start_code: Option<String>,
    pub hue_left_out: Option<HueLeftOutReason>,
    pub apply_status: Option<CommandStatus>,
    pub stop_failed: Vec<OutputTarget>,
    pub dropped_targets: Vec<OutputTarget>,
    pub mode_ended: bool,
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
    pub(crate) targets: Vec<OutputTarget>,
    /// What `lastOutputTargets` holds — the persisted mode carries these.
    pub(crate) saved_targets: Vec<OutputTarget>,
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

#[derive(Default)]
pub(crate) struct OutputsState {
    next_ticket: AtomicU64,
    latest_ticket: AtomicU64,
    intent: Mutex<LightingIntent>,
    hue_owner: Mutex<HueOwner>,
    lease: Mutex<LeaseState>,
    hue_stop_unconfirmed: AtomicBool,
    boot_retry: Mutex<Option<BootRetry>>,
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
        request: &ApplyOutputsRequest,
        running_kind: LightingModeKind,
        persisted: Option<&PersistedShellState>,
    ) -> Option<Vec<OutputTarget>> {
        let saved = || {
            persisted
                .and_then(PersistedShellState::last_output_targets)
                .map(|targets| {
                    normalize_targets(targets.iter().filter_map(|t| OutputTarget::parse(t)))
                })
                .unwrap_or_else(|| vec![OutputTarget::Usb])
        };
        let mut intent = locked(&self.intent);
        if request.origin == LightingOrigin::Boot {
            let mode = request
                .mode
                .clone()
                .or_else(|| persisted.and_then(PersistedShellState::lighting_mode))
                .unwrap_or_default();
            let targets = request
                .targets
                .clone()
                .map(normalize_targets)
                .unwrap_or_else(saved);
            intent.clone_from(&LightingIntent {
                known: true,
                kind: mode.kind,
                targets: targets.clone(),
                saved_targets: targets,
                persist_mode: false,
            });
            return None;
        }
        if !intent.known {
            let targets = saved();
            intent.clone_from(&LightingIntent {
                known: true,
                kind: running_kind,
                targets: targets.clone(),
                saved_targets: targets,
                persist_mode: false,
            });
        }
        if let Some(mode) = &request.mode {
            intent.kind = mode.kind;
            intent.persist_mode = request.origin.is_choice();
        }
        let targets = request.targets.clone().map(normalize_targets)?;
        intent.targets = targets.clone();
        if request.origin.is_choice() {
            intent.saved_targets = targets.clone();
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

    fn pending_retry_is_rejoin(&self) -> bool {
        matches!(
            locked(&self.boot_retry).as_ref().map(|retry| retry.plan),
            Some(BootRetryPlan::Rejoin { .. })
        )
    }
}

/// A boot retry the user overtook: every choice supersedes it, and its notice
/// goes with it.
fn cancel_boot_retry<R: Runtime>(app: &AppHandle<R>, reason: &str) {
    let state = app.state::<LightingRuntimeState>();
    let Some(retry) = state.outputs.take_boot_retry() else {
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

fn target_strings(targets: &[OutputTarget]) -> Vec<String> {
    targets.iter().map(|t| t.as_str().to_string()).collect()
}

/// The targets a running mode drives. Absent or empty is USB (legacy D-10).
fn running_targets(mode: &LightingModeConfig) -> Vec<OutputTarget> {
    if mode.kind == LightingModeKind::Off {
        return Vec::new();
    }
    let targets = mode.targets.as_deref().unwrap_or_default();
    if targets.is_empty() {
        return vec![OutputTarget::Usb];
    }
    normalize_targets(targets.iter().filter_map(|t| OutputTarget::parse(t)))
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

/// `hueLeftOutReason`: with a config in hand, a gate refusal means the
/// readiness probe failed, which reads as unreachable.
fn hue_left_out_reason(had_config: bool, start_code: Option<&str>) -> HueLeftOutReason {
    if !had_config {
        return HueLeftOutReason::Config;
    }
    match start_code {
        Some(code) if code.starts_with("AUTH_INVALID_") || code.starts_with("HUE-AUTH-") => {
            HueLeftOutReason::Auth
        }
        _ => HueLeftOutReason::Unreachable,
    }
}

fn is_gate_code(code: &str) -> bool {
    matches!(
        code,
        "DEVICE_NOT_CONNECTED" | "HUE_NOT_READY" | "LIGHTING_MODE_SHUTTING_DOWN"
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

/// Writes `lightingMode` as the frontend did: the kind, both payloads, and the
/// saved targets — never a set a left-out target was dropped from.
fn persist_mode<R: Runtime>(
    app: &AppHandle<R>,
    kind: &LightingModeKind,
    stored: &StoredTuning,
    saved_targets: &[OutputTarget],
) {
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
        "targets",
        serde_json::to_value(target_strings(saved_targets)).ok(),
    );
    // Stamped per dispatch and never part of the saved mode.
    for derived in ["ledCalibration", "roomGeometry"] {
        mode.remove(derived);
    }
    let mut set = Map::new();
    set.insert("lightingMode".to_string(), Value::Object(mode));
    if let Err(error) = shell_state::patch_from_rust(app, set) {
        warn!("[outputs] could not save lightingMode: {error}");
    }
}

fn persist_targets<R: Runtime>(app: &AppHandle<R>, targets: &[OutputTarget]) {
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
    persist_mode(
        app,
        &intent.kind,
        &state.tuning.stored(),
        &intent.saved_targets,
    );
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

// ---------------------------------------------------------------------------
// The transaction
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq)]
enum TxKind {
    Choice(LightingOrigin),
    Boot,
    /// The boot restore's one retry once a held area frees.
    BootRetry,
    /// `previous` is the selection before the strip went away.
    UsbUnplug {
        previous: Vec<OutputTarget>,
    },
    Release {
        trigger: HueRuntimeTriggerSource,
        previous: Vec<OutputTarget>,
    },
}

impl TxKind {
    fn is_boot(&self) -> bool {
        matches!(self, Self::Boot | Self::BootRetry)
    }

    fn release_trigger(&self) -> Option<HueRuntimeTriggerSource> {
        match self {
            Self::Release { trigger, .. } => Some(trigger.clone()),
            _ => None,
        }
    }

    /// The selection to put back when the mode ends because its last target
    /// went: the user did not deselect anything.
    fn selection_to_keep(&self) -> Option<Vec<OutputTarget>> {
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
        let stored = self.state.tuning.stored();
        self.applied_generation = stored.generation;
        let payload = payload_for(*kind, targets, &stored, self.persisted().as_ref());
        let hue_output = self.driver.output_live();
        info!(
            "[outputs] #{} apply {:?} on {:?}",
            self.ticket, payload.kind, payload.targets
        );
        let result = blocking(self.app, move |app| {
            let result = apply_config_blocking(app, payload, hue_output)?;
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
    async fn stop_hue(&mut self, trigger: HueRuntimeTriggerSource) -> bool {
        info!("[outputs] #{} stop Hue ({trigger:?})", self.ticket);
        let result = self.driver.stop(trigger).await;
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

    async fn reconcile(&mut self) -> Result<Ending, String> {
        let intent = self.state.outputs.intent();
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
        self.reconcile_on(&intent, &running).await
    }

    async fn reconcile_off(
        &mut self,
        intent: &LightingIntent,
        running: &LightingModeConfig,
    ) -> Result<Ending, String> {
        let hue_up = self.hue_live() || self.driver.runtime_active();
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
        if running.kind != LightingModeKind::Off {
            if let Err(error) = self.stop_lighting().await {
                warn!("[outputs] stop_lighting before the Hue stop failed: {error}");
                self.outcome.stop_failed.push(OutputTarget::Usb);
            }
        }
        if stop_hue {
            if self.superseded() {
                return Ok(Ending::Superseded);
            }
            self.publish_phase(LightingPhase::Stopping);
            self.stop_hue(HueRuntimeTriggerSource::ModeControl).await;
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
            persist_mode(
                self.app,
                &intent.kind,
                &self.state.tuning.stored(),
                &intent.saved_targets,
            );
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
        let has_calibration = self
            .persisted()
            .as_ref()
            .and_then(PersistedShellState::led_calibration)
            .is_some();
        if matches!(self.kind, TxKind::Choice(_))
            && intent.kind != running.kind
            && intent.targets.contains(&OutputTarget::Usb)
            && !has_calibration
        {
            self.settle_kind(running.kind);
            return Ok(Ending::CalibrationRequired);
        }

        let want_usb = intent.targets.contains(&OutputTarget::Usb)
            && (!self.kind.is_boot() || usb_available(self.app));
        let want_hue =
            intent.targets.contains(&OutputTarget::Hue) && self.kind.release_trigger().is_none();
        let running_before = running_targets(running);
        let hue_ran_before = running_before.contains(&OutputTarget::Hue);

        self.state.tuning.close(Some(intent.kind)).await;

        // Phase 1 — Hue first: the worker is handed the stream it will drive,
        // so a stream that is not up yet leaves the worker without Hue.
        let mut hue_ok = self.hue_live();
        let mut had_config = true;
        if want_hue && !hue_ok {
            match self.hue_request() {
                None => had_config = false,
                Some(request) => {
                    self.publish_phase(LightingPhase::StartingHue);
                    info!("[outputs] #{} start Hue", self.ticket);
                    let started = self.driver.start(request).await;
                    let code = started.status.code;
                    self.outcome.hue_start_code = Some(code.clone());
                    if self.state.is_closing() {
                        return Ok(Ending::ShuttingDown);
                    }
                    hue_ok = is_hue_start_ok(&code);
                    if hue_ok && code != "HUE_START_NOOP_ALREADY_ACTIVE" {
                        self.state.outputs.set_owner(HueOwner::Transaction);
                    }
                    // A start left retrying keeps going unseen; nothing here
                    // will use it, so it is cancelled before the mode runs.
                    if code == "TRANSIENT_RETRY_SCHEDULED" {
                        self.stop_hue(HueRuntimeTriggerSource::System).await;
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
                return self
                    .refuse(
                        intent,
                        running,
                        running.clone(),
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

            // Adding USB to a running mode the device gate refused: the gate
            // returned before teardown, so the mode keeps running on the rest.
            if result.status.code == "DEVICE_NOT_CONNECTED"
                && running.kind == intent.kind
                && run_on.len() > 1
            {
                run_on.retain(|t| *t != OutputTarget::Usb);
                self.outcome.dropped_targets.push(OutputTarget::Usb);
                self.state
                    .outputs
                    .update_intent(|intent| intent.targets.retain(|t| *t != OutputTarget::Usb));
                if run_on == running_before {
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
            let reason = hue_left_out_reason(had_config, self.outcome.hue_start_code.as_deref());
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
            persist_mode(
                self.app,
                &intent.kind,
                &self.state.tuning.stored(),
                &intent.saved_targets,
            );
            self.state
                .outputs
                .update_intent(|intent| intent.persist_mode = false);
        }
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
        if self.outcome.hue_start_code.as_deref() != Some("CONFIG_NOT_READY_GATE_BLOCKED") {
            return;
        }
        if let Some(request) = self.hue_request() {
            schedule_boot_retry(
                self.app,
                BootRetryPlan::Resume { kind: intent.kind },
                request,
            );
        }
    }

    /// The same wait for a restore running on USB with Hue left out. Its
    /// first probe decides the notice, so nothing is raised yet.
    fn maybe_schedule_rejoin(&self, left_out: HueLeftOutReason, had_config: bool) -> bool {
        if self.kind != TxKind::Boot || !had_config {
            return false;
        }
        if self.outcome.hue_start_code.as_deref() != Some("CONFIG_NOT_READY_GATE_BLOCKED") {
            return false;
        }
        let Some(request) = self.hue_request() else {
            return false;
        };
        schedule_boot_retry(self.app, BootRetryPlan::Rejoin { left_out }, request);
        true
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
            self.state.snapshot.publish(self.app, |snapshot| {
                // A Hue stop after the last apply changed what is driven.
                let mode = snapshot.mode.clone();
                snapshot.set_running(&mode, hue_live, hue_unconfirmed);
                snapshot.phase = LightingPhase::Idle;
                snapshot.request_id = Some(ticket);
                snapshot.selected_targets = intent.targets.clone();
                if let Some(held_out) = held_out {
                    snapshot.hue_held_out_reason = held_out;
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

/// The body of `apply_outputs`, over an `AppHandle` so tests drive it directly.
pub(crate) async fn apply_outputs_with<R: Runtime>(
    app: &AppHandle<R>,
    request: ApplyOutputsRequest,
) -> Result<ApplyOutputsResult, String> {
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
// The Hue test lease — a test pattern borrowing the stream
// ---------------------------------------------------------------------------

/// Bring Hue up for a test run that targets it, and hand back only what the
/// lease itself opened. A stream a live mode owns, or that a mode started
/// during the run adopted, is left to that mode: stopping it would turn off
/// lights the test never turned on.
async fn lease_hue<R: Runtime>(
    app: &AppHandle<R>,
    request: ApplyOutputsRequest,
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
    let result = driver.stop(HueRuntimeTriggerSource::ModeControl).await;
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
            // Unreachable, re-pair, an unusable area: none clear by waiting.
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
        ReleaseWait::NotBusy => {
            warn!("[outputs] boot Hue retry: the refusal was not a busy area; not retrying");
            let left_out = match plan {
                BootRetryPlan::Rejoin { left_out } => Some(left_out),
                BootRetryPlan::Resume { .. } => None,
            };
            state
                .snapshot
                .publish(&app, |snapshot| notice(snapshot, None, left_out));
        }
        ReleaseWait::Free => {
            info!("[outputs] boot Hue retry: the area is free");
            state
                .snapshot
                .publish(&app, |snapshot| notice(snapshot, None, None));
            match plan {
                BootRetryPlan::Resume { kind } => {
                    // Anything that started a mode meanwhile has had its say.
                    if state.snapshot.read().mode.kind != LightingModeKind::Off {
                        return;
                    }
                    state.outputs.update_intent(|intent| intent.kind = kind);
                }
                BootRetryPlan::Rejoin { .. } => {
                    state.outputs.update_intent(|intent| {
                        intent.targets = normalize_targets(
                            intent.targets.iter().copied().chain([OutputTarget::Hue]),
                        )
                    });
                }
            }
            let ticket = state.outputs.issue_ticket();
            if let Err(error) = run_ticketed(&app, ticket, TxKind::BootRetry).await {
                warn!("[outputs] boot Hue retry failed: {error}");
            }
        }
    }
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
