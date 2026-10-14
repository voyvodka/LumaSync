//! Retunes: a brightness or colour nudge within the running kind. A drag
//! commits at up to 20 Hz, so a retune never waits for a transition — it has
//! its own turn, never takes `transitions` or the runtime lock, and reaches
//! the outputs through what the last transaction left accepting. See
//! docs/architecture/lighting-transaction.md.
#![deny(clippy::await_holding_lock)]

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use log::warn;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime};

use super::config::{normalize_effect, unix_ms_now, EffectId};
use super::effect_source::{effect_ambilight, EffectLiveSlot};
use super::live::{retune_ambilight_live, AmbilightLiveSettings};
use super::runtime::LightingRuntimeOwner;
use super::snapshot::SnapshotSink;
use super::usb_output::{SolidHold, SolidUsbOutput, UsbOutputPlan};
use super::{
    AmbilightPayload, EffectPayload, LightingModeKind, LightingRuntimeState, SolidColorPayload,
};
use crate::commands::hue::state_store::{apply_hue_color_with_context, HueOutputLive};
use crate::commands::led_output::{apply_color_correction_rgb, ColorCorrectionConfig};
use crate::commands::local_outputs::LocalOutputRegistry;
use crate::commands::status::CommandStatus;

/// A retune's persisted write waits this long for the drag to settle.
const RETUNE_PERSIST_DEBOUNCE: Duration = Duration::from_millis(300);

/// `LightingTuning` in `src/shared/contracts/lightingRuntime.ts`.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LightingTuning {
    #[serde(default)]
    pub solid: Option<SolidColorPayload>,
    #[serde(default)]
    pub ambilight: Option<AmbilightPayload>,
    #[serde(default)]
    pub effect: Option<EffectPayload>,
}

impl LightingTuning {
    /// What `normalize_mode_config` does for a start, so a retune stores,
    /// publishes and saves the same values a start would have.
    fn normalized(self) -> Self {
        Self {
            solid: self.solid.map(SolidColorPayload::resolved),
            ambilight: self.ambilight,
            effect: self.effect.map(normalize_effect),
        }
    }

    /// The brightness the retuned payload carries.
    fn brightness(&self) -> Option<f32> {
        self.solid
            .as_ref()
            .map(|solid| solid.brightness)
            .or_else(|| self.ambilight.as_ref().map(|a| a.brightness))
            .or_else(|| self.effect.as_ref().map(|effect| effect.brightness))
    }

    fn kind(&self) -> Option<LightingModeKind> {
        if self.solid.is_some() {
            Some(LightingModeKind::Solid)
        } else if self.ambilight.is_some() {
            Some(LightingModeKind::Ambilight)
        } else if self.effect.is_some() {
            Some(LightingModeKind::Effect)
        } else {
            None
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RetuneLightingResult {
    pub status: CommandStatus,
}

/// Sole constructor for the retune status, so the contract verifier can
/// harvest its codes from one call shape.
fn retune_status(code: &str, message: &str) -> CommandStatus {
    CommandStatus {
        code: code.to_string(),
        message: message.to_string(),
        details: None,
    }
}

/// What a retune can reach right now.
pub(crate) enum Accepting {
    Ambilight(Arc<AmbilightLiveSettings>),
    /// The effect's payload cell, and the worker's brightness it runs under.
    Effect {
        slot: EffectLiveSlot,
        live: Arc<AmbilightLiveSettings>,
    },
    Solid {
        usb: Option<SolidUsbOutput>,
        hue: Option<Arc<HueOutputLive>>,
        hue_correction: ColorCorrectionConfig,
    },
}

impl Accepting {
    /// The kind whose retune `apply` takes.
    fn kind(&self) -> LightingModeKind {
        match self {
            Accepting::Ambilight(_) => LightingModeKind::Ambilight,
            Accepting::Effect { .. } => LightingModeKind::Effect,
            Accepting::Solid { .. } => LightingModeKind::Solid,
        }
    }

    /// Pushes whichever payload matches; `false` when this is the wrong kind.
    fn apply(
        &self,
        solid: Option<&SolidColorPayload>,
        ambilight: Option<&AmbilightPayload>,
        effect: Option<&EffectPayload>,
    ) -> bool {
        if let (Accepting::Effect { slot, live }, Some(effect)) = (self, effect) {
            retune_ambilight_live(live, &effect_ambilight(effect));
            *slot.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = effect.clone();
            return true;
        }
        match (self, solid, ambilight) {
            (Accepting::Ambilight(live), _, Some(cfg)) => {
                retune_ambilight_live(live, cfg);
                true
            }
            (
                Accepting::Solid {
                    usb,
                    hue,
                    hue_correction,
                },
                Some(payload),
                _,
            ) => {
                if let Some(usb) = usb {
                    if let Err(reason) = usb.send(payload) {
                        warn!("[retune] solid USB send failed — {reason}");
                    }
                }
                if let Some(context) = hue.as_ref().and_then(|live| live.current()) {
                    let (r, g, b) = apply_color_correction_rgb(
                        (payload.r, payload.g, payload.b),
                        hue_correction,
                    );
                    if let Err(reason) =
                        apply_hue_color_with_context(&context, r, g, b, payload.brightness)
                    {
                        warn!("[retune] solid Hue send skipped — {reason}");
                    }
                }
                true
            }
            _ => false,
        }
    }
}

/// The newest payload of each kind, from a retune or a transaction's request.
#[derive(Clone, Debug, Default)]
pub(crate) struct StoredTuning {
    pub(crate) solid: Option<SolidColorPayload>,
    pub(crate) ambilight: Option<AmbilightPayload>,
    pub(crate) effect: Option<EffectPayload>,
    /// The one brightness every mode runs at. A payload's own field is the
    /// value it was chosen with; this is what wins (`stamped`).
    pub(crate) brightness: Option<f32>,
    pub(crate) generation: u64,
}

impl StoredTuning {
    /// Every payload at the shared brightness.
    pub(crate) fn stamped(mut self) -> Self {
        if let Some(brightness) = self.brightness {
            if let Some(solid) = self.solid.as_mut() {
                solid.brightness = brightness;
            }
            if let Some(ambilight) = self.ambilight.as_mut() {
                ambilight.brightness = brightness;
            }
            if let Some(effect) = self.effect.as_mut() {
                effect.brightness = brightness;
            }
        }
        self
    }

    fn apply_to(&self, accepting: &Accepting) {
        accepting.apply(
            self.solid.as_ref(),
            self.ambilight.as_ref(),
            self.effect.as_ref(),
        );
    }
}

#[derive(Default)]
struct TuningInner {
    stored: StoredTuning,
    accepting: Option<Arc<Accepting>>,
    /// The kind a transaction in flight is bringing up; a retune of that kind
    /// is applied when it commits.
    awaiting: Option<LightingModeKind>,
    /// The stored generation the running mode already carries. `None` once a
    /// mode command outside the transaction has changed what runs.
    applied: Option<u64>,
}

/// `turn` orders retunes against each other and against a transaction's
/// close and commit, first come first served. A retune sends while holding it,
/// so once a close returns no retune is mid-send and none can start one.
#[derive(Default)]
pub struct TuningCell {
    turn: Arc<tokio::sync::Mutex<()>>,
    inner: Mutex<TuningInner>,
    persist_scheduled: AtomicBool,
}

pub(crate) enum RetuneOutcome {
    Applied,
    Deferred,
    NotRunning,
}

impl TuningCell {
    fn lock(&self) -> MutexGuard<'_, TuningInner> {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// The newest payloads, at the shared brightness.
    pub(crate) fn stored(&self) -> StoredTuning {
        self.lock().stored.clone().stamped()
    }

    pub(crate) fn brightness(&self) -> Option<f32> {
        self.lock().stored.brightness
    }

    /// The running mode already carries the newest payloads.
    pub(crate) fn is_current(&self) -> bool {
        let inner = self.lock();
        inner.applied == Some(inner.stored.generation)
    }

    /// Records a request's payloads as the newest, without applying them, and
    /// `brightness` as the shared one when the request chose it.
    pub(crate) fn store(
        &self,
        solid: Option<&SolidColorPayload>,
        ambilight: Option<&AmbilightPayload>,
        effect: Option<&EffectPayload>,
        brightness: Option<f32>,
    ) {
        if solid.is_none() && ambilight.is_none() && effect.is_none() && brightness.is_none() {
            return;
        }
        let mut inner = self.lock();
        if let Some(brightness) = brightness {
            inner.stored.brightness = Some(brightness);
        }
        if let Some(solid) = solid {
            inner.stored.solid = Some(solid.clone());
        }
        if let Some(ambilight) = ambilight {
            inner.stored.ambilight = Some(ambilight.clone());
        }
        if let Some(effect) = effect {
            inner.stored.effect = Some(effect.clone());
        }
        inner.stored.generation += 1;
    }

    /// The user chose Effect while another kind ran: a stored sunrise starts
    /// over now instead of resuming at the brightness it had reached. A launch
    /// restore, a return from away and a settings refresh do not come here.
    /// `saved` is the saved mode's effect, which `payload_for` falls back to
    /// when nothing was stored this session.
    pub(crate) fn restart_sunrise(&self, saved: Option<&EffectPayload>) {
        let mut inner = self.lock();
        if inner.stored.effect.is_none() {
            inner.stored.effect = saved.cloned();
        }
        if let Some(effect) = inner
            .stored
            .effect
            .as_mut()
            .filter(|effect| effect.id == EffectId::Sunrise)
        {
            effect.started_at_ms = Some(unix_ms_now());
            inner.stored.generation += 1;
        }
    }

    /// A retune that names a sunrise without its start (a sender that built the
    /// payload afresh) keeps the one that runs rather than starting over.
    pub(crate) fn inherit_sunrise_start(&self, effect: &mut EffectPayload) {
        if effect.id != EffectId::Sunrise || effect.started_at_ms.is_some() {
            return;
        }
        effect.started_at_ms = self
            .lock()
            .stored
            .effect
            .as_ref()
            .filter(|stored| stored.id == EffectId::Sunrise)
            .and_then(|stored| stored.started_at_ms);
    }

    /// A saved setting the running mode reads changed, so the next transaction
    /// re-applies even when its request names nothing new.
    pub(crate) fn mark_stale(&self) {
        self.lock().applied = None;
    }

    /// Before a transaction's first stop: nothing reaches the outputs again
    /// until it commits. `awaiting` is the kind it is bringing up.
    pub(crate) async fn close(&self, awaiting: Option<LightingModeKind>) {
        let _turn = self.turn.lock().await;
        let mut inner = self.lock();
        inner.accepting = None;
        inner.awaiting = awaiting;
    }

    /// `close` for the blocking mode commands and the quit path.
    pub(crate) fn close_blocking(&self) {
        let _turn = self.turn.blocking_lock();
        let mut inner = self.lock();
        inner.accepting = None;
        inner.awaiting = None;
        inner.applied = None;
    }

    /// Installs what runs now, and applies a tuning that arrived after the
    /// transaction read `applied_generation`, so a drag during a start lands.
    /// `carried` says the transaction's own apply ran.
    pub(crate) async fn commit(
        &self,
        accepting: Option<Accepting>,
        applied_generation: u64,
        carried: bool,
    ) {
        let turn = Arc::clone(&self.turn).lock_owned().await;
        if let Some((accepting, stored)) = self.install(accepting, applied_generation, carried) {
            let _ = tauri::async_runtime::spawn_blocking(move || {
                let _turn = turn;
                stored.apply_to(&accepting);
            })
            .await;
        }
    }

    /// `commit` for a test pattern's or a preview scene's restore, which runs
    /// outside a transaction on the blocking mode-change queue.
    pub(crate) fn commit_blocking(
        &self,
        accepting: Option<Accepting>,
        applied_generation: u64,
        carried: bool,
    ) {
        let _turn = self.turn.blocking_lock();
        if let Some((accepting, stored)) = self.install(accepting, applied_generation, carried) {
            stored.apply_to(&accepting);
        }
    }

    /// Under the turn: what a commit installs, and the replay it owes.
    fn install(
        &self,
        accepting: Option<Accepting>,
        applied_generation: u64,
        carried: bool,
    ) -> Option<(Arc<Accepting>, StoredTuning)> {
        let mut inner = self.lock();
        inner.awaiting = None;
        inner.accepting = accepting.map(Arc::new);
        if carried {
            inner.applied = Some(inner.stored.generation);
        }
        let moved = inner.stored.generation != applied_generation;
        inner
            .accepting
            .clone()
            .filter(|_| moved)
            .map(|accepting| (accepting, inner.stored.clone().stamped()))
    }

    pub(crate) async fn retune(&self, tuning: LightingTuning) -> RetuneOutcome {
        let Some(kind) = tuning.kind() else {
            return RetuneOutcome::NotRunning;
        };
        let brightness = tuning.brightness();
        let turn = Arc::clone(&self.turn).lock_owned().await;
        let (accepting, awaiting) = {
            let mut inner = self.lock();
            match kind {
                LightingModeKind::Solid => inner.stored.solid = tuning.solid.clone(),
                LightingModeKind::Effect => inner.stored.effect = tuning.effect.clone(),
                _ => inner.stored.ambilight = tuning.ambilight.clone(),
            }
            // The shared brightness moves for a retune that reaches the mode or
            // the one coming up, never for another kind — and with the
            // generation, so a transaction reading the store between the two
            // cannot record this generation at the old brightness.
            let reaches = match inner.accepting.as_deref() {
                Some(accepting) => accepting.kind() == kind,
                None => inner.awaiting == Some(kind),
            };
            if reaches {
                inner.stored.brightness = brightness.or(inner.stored.brightness);
            }
            inner.stored.generation += 1;
            (inner.accepting.clone(), inner.awaiting)
        };
        if let Some(accepting) = accepting {
            let applied = tauri::async_runtime::spawn_blocking(move || {
                let _turn = turn;
                accepting.apply(
                    tuning.solid.as_ref(),
                    tuning.ambilight.as_ref(),
                    tuning.effect.as_ref(),
                )
            })
            .await
            .unwrap_or(false);
            if applied {
                let mut inner = self.lock();
                inner.applied = Some(inner.stored.generation);
                return RetuneOutcome::Applied;
            }
            return RetuneOutcome::NotRunning;
        }
        if awaiting == Some(kind) {
            RetuneOutcome::Deferred
        } else {
            RetuneOutcome::NotRunning
        }
    }

    #[cfg(test)]
    pub(crate) fn accepting_brightness(&self) -> Option<f32> {
        match self.lock().accepting.as_deref() {
            Some(Accepting::Ambilight(live)) => Some(live.read_brightness()),
            _ => None,
        }
    }
}

/// What a retune may reach in the mode now running, read under the runtime
/// lock by a transaction that has just committed. A test pattern and a preview
/// scene are retuned through their own commands, never here.
pub(crate) fn accepting_for_running<R: Runtime>(
    app: &AppHandle<R>,
    hue_output: Arc<HueOutputLive>,
) -> Option<Accepting> {
    let driven = app.state::<LocalOutputRegistry>().driven();
    let state = app.state::<LightingRuntimeState>();
    let owner = state.runtime.lock().ok()?;
    if owner.preview.active_test_pattern.is_some() || owner.preview.scene.is_some() {
        return None;
    }
    match owner.active_mode.kind {
        LightingModeKind::Off => None,
        LightingModeKind::Ambilight => owner.ambilight_live.clone().map(Accepting::Ambilight),
        LightingModeKind::Effect => match (&owner.effect_live, &owner.ambilight_live) {
            (Some(slot), Some(live)) => Some(Accepting::Effect {
                slot: Arc::clone(slot),
                live: Arc::clone(live),
            }),
            _ => None,
        },
        LightingModeKind::Solid => {
            let targets = owner.active_mode.targets.clone().unwrap_or_default();
            let needs_usb = targets.is_empty() || targets.iter().any(|t| t == "usb");
            let plan = driven.map(UsbOutputPlan::from);
            Some(Accepting::Solid {
                usb: plan
                    .filter(|_| needs_usb)
                    .map(|plan| solid_output_for(&owner, plan)),
                hue: targets.iter().any(|t| t == "hue").then_some(hue_output),
                hue_correction: owner
                    .active_mode
                    .color_correction
                    .clone()
                    .unwrap_or_default(),
            })
        }
    }
}

/// The running Solid mode's strip output, carrying the hold a WLED colour is resent by, so a retune
/// repaints the strip and the hold's next resend is the new colour rather than the old one.
pub(super) fn solid_output_for(
    owner: &LightingRuntimeOwner,
    plan: UsbOutputPlan,
) -> SolidUsbOutput {
    SolidUsbOutput::for_mode(&owner.output_bridge, plan, &owner.active_mode)
        .with_hold(owner.solid_hold.as_ref().map(SolidHold::handle))
}

/// Apply a brightness or colour change to the running mode without a
/// transition. Waits for nothing but earlier retunes.
#[tauri::command]
pub async fn retune_lighting<R: Runtime>(
    app: AppHandle<R>,
    tuning: LightingTuning,
) -> Result<RetuneLightingResult, String> {
    let state = app.state::<LightingRuntimeState>();
    let mut tuning = tuning;
    if let Some(effect) = tuning.effect.as_mut() {
        state.tuning.inherit_sunrise_start(effect);
    }
    let tuning = tuning.normalized();
    let outcome = state.tuning.retune(tuning.clone()).await;
    let status = match outcome {
        RetuneOutcome::Applied => {
            let sink: Arc<dyn SnapshotSink> = Arc::new(app.clone());
            state.snapshot.publish_coalesced(sink, |snapshot| {
                if let Some(brightness) = tuning.brightness() {
                    snapshot.brightness = brightness;
                }
                if tuning.solid.is_some() && snapshot.mode.kind == LightingModeKind::Solid {
                    snapshot.mode.solid = tuning.solid.clone();
                }
                if tuning.ambilight.is_some() && snapshot.mode.kind == LightingModeKind::Ambilight {
                    snapshot.mode.ambilight = tuning.ambilight.clone();
                }
                if tuning.effect.is_some() && snapshot.mode.kind == LightingModeKind::Effect {
                    snapshot.mode.effect = tuning.effect.clone();
                }
            });
            schedule_persist(&app);
            crate::commands::preview::feed::refresh(&app);
            retune_status("RETUNE_APPLIED", "The running lighting mode was retuned.")
        }
        RetuneOutcome::Deferred => {
            schedule_persist(&app);
            retune_status(
                "RETUNE_DEFERRED",
                "Stored; the lighting change in progress applies it when it lands.",
            )
        }
        RetuneOutcome::NotRunning => retune_status(
            "RETUNE_NOT_RUNNING",
            "Stored for the next start; nothing of that kind is running.",
        ),
    };
    Ok(RetuneLightingResult { status })
}

/// One trailing write per settled drag, like the frontend writer it replaces.
fn schedule_persist<R: Runtime>(app: &AppHandle<R>) {
    let state = app.state::<LightingRuntimeState>();
    if state.tuning.persist_scheduled.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    let spawned = std::thread::Builder::new()
        .name("lumasync-retune-persist".into())
        .spawn(move || {
            std::thread::sleep(RETUNE_PERSIST_DEBOUNCE);
            let state = app.state::<LightingRuntimeState>();
            state
                .tuning
                .persist_scheduled
                .store(false, Ordering::SeqCst);
            super::outputs::persist_running_choice(&app);
        });
    if let Err(error) = spawned {
        warn!("[retune] persist not scheduled: {error}");
        state
            .tuning
            .persist_scheduled
            .store(false, Ordering::SeqCst);
    }
}
