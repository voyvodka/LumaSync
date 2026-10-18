//! Callers other than the user's own choice: away edges, settings saves,
//! the tray menu and a Hue release.

use super::*;

/// Which way the user went: away (locked, asleep, display off) or back.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AwayEdge {
    Leave,
    Return,
}

/// An away edge whose intent is already recorded and whose ticket is taken,
/// waiting only for its turn at the lights.
pub(crate) struct AwayTurn {
    ticket: u64,
    kind: TxKind,
}

impl AwayTurn {
    pub(crate) async fn run<R: Runtime>(
        self,
        app: &AppHandle<R>,
    ) -> Result<ApplyOutputsResult, String> {
        run_ticketed(app, self.ticket, self.kind).await
    }
}

/// Records an away edge at once, on the thread that heard it, so a quick lock
/// and unlock take their tickets in the order they happened; only the lights
/// wait for a turn. `None` when there is nothing to do: the setting keeps the
/// lights on, they were already off, or nothing was put out to put back.
/// docs/architecture/lighting-transaction.md ("Away").
pub(crate) fn prepare_away<R: Runtime>(app: &AppHandle<R>, edge: AwayEdge) -> Option<AwayTurn> {
    let state = app.state::<LightingRuntimeState>();
    let outputs = &state.outputs;
    let kind = match edge {
        AwayEdge::Leave => {
            if shell_state::persisted(app).is_some_and(|persisted| persisted.away_lights_kept()) {
                return None;
            }
            let intent = outputs.intent();
            if !intent.known || intent.kind == LightingModeKind::Off {
                return None;
            }
            // A choice still on its way in is saved now: the Off below takes
            // its turn before it would have been.
            if intent.persist_mode {
                persist_mode(app, &intent.kind, &state.tuning.stored());
            }
            locked(&outputs.away).replace(intent.kind);
            outputs.update_intent(|intent| {
                intent.kind = LightingModeKind::Off;
                intent.persist_mode = false;
            });
            cancel_boot_retry(app, "the user went away");
            outputs.cancel_boot_sink_wait("the user went away");
            TxKind::Away { resume: false }
        }
        AwayEdge::Return => {
            // The mode only: an output unplugged while away stays out of it.
            let kind = locked(&outputs.away).take()?;
            outputs.update_intent(|intent| intent.kind = kind);
            TxKind::Away { resume: true }
        }
    };
    Some(AwayTurn {
        ticket: outputs.issue_ticket(),
        kind,
    })
}

/// `prepare_away` and its turn in one, for a caller with nothing to order.
#[cfg(test)]
pub(crate) async fn away_with<R: Runtime>(
    app: &AppHandle<R>,
    edge: AwayEdge,
) -> Result<Option<ApplyOutputsResult>, String> {
    match prepare_away(app, edge) {
        Some(turn) => turn.run(app).await.map(Some),
        None => Ok(None),
    }
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
            if !hue_paired(&app)
                && app
                    .state::<LightingRuntimeState>()
                    .outputs
                    .cancel_boot_hue_park("the bridge was forgotten")
            {
                health::note_boot_resume_pending(&app, false);
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
pub(super) fn calibration_is_current<R: Runtime>(app: &AppHandle<R>) -> bool {
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
    Effect,
}

impl TrayLighting {
    pub const ALL: [Self; 4] = [Self::Off, Self::Ambilight, Self::Solid, Self::Effect];

    pub fn kind(self) -> LightingModeKind {
        match self {
            Self::Off => LightingModeKind::Off,
            Self::Ambilight => LightingModeKind::Ambilight,
            Self::Solid => LightingModeKind::Solid,
            Self::Effect => LightingModeKind::Effect,
        }
    }

    /// `TRAY_MENU_IDS.MODE_*` in `src/shared/contracts/shell.ts`.
    pub fn menu_id(self) -> &'static str {
        match self {
            Self::Off => "tray-mode-off",
            Self::Ambilight => "tray-mode-ambilight",
            Self::Solid => "tray-mode-solid",
            Self::Effect => "tray-mode-effect",
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
) -> [TrayModeItem; 4] {
    TrayLighting::ALL.map(|item| TrayModeItem {
        item,
        checked: item.kind() == running,
        enabled: !transitioning && !locked.contains(&item.kind()),
    })
}

/// The request a tray item sends. The payloads are left out on purpose: the
/// transaction keeps the last colour — `DEFAULT_SOLID` before any — the last
/// Ambilight settings, and the last effect.
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
