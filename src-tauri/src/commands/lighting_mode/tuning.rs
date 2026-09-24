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

use super::snapshot::SnapshotSink;
use super::{
    retune_ambilight_live, AmbilightLiveSettings, AmbilightPayload, LightingModeKind,
    LightingRuntimeState, SolidColorPayload, SolidUsbOutput, UsbOutputPlan,
};
use crate::commands::device_connection::{ActiveSinkRegistry, SerialConnectionState};
use crate::commands::hue::state_store::{apply_hue_color_with_context, HueOutputLive};
use crate::commands::led_output::{apply_color_correction_rgb, ColorCorrectionConfig};
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
}

impl LightingTuning {
    fn kind(&self) -> Option<LightingModeKind> {
        match (&self.solid, &self.ambilight) {
            (Some(_), _) => Some(LightingModeKind::Solid),
            (None, Some(_)) => Some(LightingModeKind::Ambilight),
            (None, None) => None,
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
    Solid {
        usb: Option<SolidUsbOutput>,
        hue: Option<Arc<HueOutputLive>>,
        hue_correction: ColorCorrectionConfig,
    },
}

impl Accepting {
    /// Pushes whichever payload matches; `false` when this is the wrong kind.
    fn apply(
        &self,
        solid: Option<&SolidColorPayload>,
        ambilight: Option<&AmbilightPayload>,
    ) -> bool {
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
    pub(crate) generation: u64,
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

    pub(crate) fn stored(&self) -> StoredTuning {
        self.lock().stored.clone()
    }

    /// The running mode already carries the newest payloads.
    pub(crate) fn is_current(&self) -> bool {
        let inner = self.lock();
        inner.applied == Some(inner.stored.generation)
    }

    /// Records a request's payloads as the newest, without applying them.
    pub(crate) fn store(
        &self,
        solid: Option<&SolidColorPayload>,
        ambilight: Option<&AmbilightPayload>,
    ) {
        if solid.is_none() && ambilight.is_none() {
            return;
        }
        let mut inner = self.lock();
        if let Some(solid) = solid {
            inner.stored.solid = Some(solid.clone());
        }
        if let Some(ambilight) = ambilight {
            inner.stored.ambilight = Some(ambilight.clone());
        }
        inner.stored.generation += 1;
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
        let replay = {
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
                .map(|accepting| (accepting, inner.stored.clone()))
        };
        if let Some((accepting, stored)) = replay {
            let _ = tauri::async_runtime::spawn_blocking(move || {
                let _turn = turn;
                accepting.apply(stored.solid.as_ref(), stored.ambilight.as_ref());
            })
            .await;
        }
    }

    pub(crate) async fn retune(&self, tuning: LightingTuning) -> RetuneOutcome {
        let Some(kind) = tuning.kind() else {
            return RetuneOutcome::NotRunning;
        };
        let turn = Arc::clone(&self.turn).lock_owned().await;
        let (accepting, awaiting) = {
            let mut inner = self.lock();
            match kind {
                LightingModeKind::Solid => inner.stored.solid = tuning.solid.clone(),
                _ => inner.stored.ambilight = tuning.ambilight.clone(),
            }
            inner.stored.generation += 1;
            (inner.accepting.clone(), inner.awaiting)
        };
        if let Some(accepting) = accepting {
            let applied = tauri::async_runtime::spawn_blocking(move || {
                let _turn = turn;
                accepting.apply(tuning.solid.as_ref(), tuning.ambilight.as_ref())
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
/// lock by a transaction that has just committed. A test pattern is retuned
/// through its own command, never here.
pub(crate) fn accepting_for_running<R: Runtime>(
    app: &AppHandle<R>,
    hue_output: Arc<HueOutputLive>,
) -> Option<Accepting> {
    let wled = app.state::<ActiveSinkRegistry>().active_wled_config();
    let serial = app
        .state::<SerialConnectionState>()
        .last_status
        .lock()
        .ok()
        .and_then(|status| status.output_port().map(str::to_string));
    let state = app.state::<LightingRuntimeState>();
    let owner = state.runtime.lock().ok()?;
    if owner.preview.active_test_pattern.is_some() {
        return None;
    }
    match owner.active_mode.kind {
        LightingModeKind::Off => None,
        LightingModeKind::Ambilight => owner.ambilight_live.clone().map(Accepting::Ambilight),
        LightingModeKind::Solid => {
            let targets = owner.active_mode.targets.clone().unwrap_or_default();
            let needs_usb = targets.is_empty() || targets.iter().any(|t| t == "usb");
            let plan = match wled {
                Some(config) => Some(UsbOutputPlan::Wled(config)),
                None => serial.map(UsbOutputPlan::Serial),
            };
            Some(Accepting::Solid {
                usb: plan.filter(|_| needs_usb).map(|plan| {
                    SolidUsbOutput::for_mode(&owner.output_bridge, plan, &owner.active_mode)
                }),
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

/// Apply a brightness or colour change to the running mode without a
/// transition. Waits for nothing but earlier retunes.
#[tauri::command]
pub async fn retune_lighting<R: Runtime>(
    app: AppHandle<R>,
    tuning: LightingTuning,
) -> Result<RetuneLightingResult, String> {
    let state = app.state::<LightingRuntimeState>();
    let outcome = state.tuning.retune(tuning.clone()).await;
    let status = match outcome {
        RetuneOutcome::Applied => {
            let sink: Arc<dyn SnapshotSink> = Arc::new(app.clone());
            state.snapshot.publish_coalesced(sink, |snapshot| {
                if tuning.solid.is_some() && snapshot.mode.kind == LightingModeKind::Solid {
                    snapshot.mode.solid = tuning.solid.clone();
                }
                if tuning.ambilight.is_some() && snapshot.mode.kind == LightingModeKind::Ambilight {
                    snapshot.mode.ambilight = tuning.ambilight.clone();
                }
            });
            schedule_persist(&app);
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
