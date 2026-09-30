//! The lighting transaction itself: one ticket's turn at the lights, from
//! the running state to the newest intent, phase by phase.

use super::*;

#[derive(Clone, Debug, PartialEq)]
pub(super) enum TxKind {
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
    /// The computer locked, slept or blanked its display (`resume: false`), or
    /// the user came back. Turns the lights off as Off does, saves nothing and
    /// raises no outcome: nobody was there to press anything.
    Away {
        resume: bool,
    },
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
pub(super) enum Ending {
    Applied,
    Refused(String),
    StartFailed,
    Superseded,
    CalibrationRequired,
    ShuttingDown,
}

pub(super) struct Transaction<'a, R: Runtime> {
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
        let user_off = (matches!(self.kind, TxKind::Choice(_)) && intent.persist_mode)
            || matches!(self.kind, TxKind::Away { resume: false });
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
            // The local output failed its own start beside another output — a dead port after a
            // replug, a WLED device that stopped answering. Unlike a gate refusal this comes after
            // the teardown, so the mode starts again on the rest, and USB drops from the
            // session's selection until a strip connects. Any other failure (capture) still ends
            // the mode.
            if usb_output_failed(&result) && run_on.len() > 1 && run_on.contains(&OutputTarget::Usb)
            {
                warn!(
                    "[outputs] #{} the local output failed beside another; running without it: {:?}",
                    self.ticket, result.status.details
                );
                run_on.retain(|t| *t != OutputTarget::Usb);
                self.outcome.dropped_targets.push(OutputTarget::Usb);
                self.state
                    .outputs
                    .update_intent(|intent| intent.targets.retain(|t| *t != OutputTarget::Usb));
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
            park_boot_hue(self.app, plan);
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

pub(super) async fn run_ticketed<R: Runtime>(
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
pub(super) fn invalid_request<R: Runtime>(
    app: &AppHandle<R>,
    reason: String,
) -> ApplyOutputsResult {
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

    // A mode chosen while away is what runs on return.
    if request.mode.is_some() && request.origin.is_choice() {
        locked(&state.outputs.away).take();
    }

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
        (Some(mode), _) => {
            // Stamped here, not only when applied, so what is saved carries it.
            let effect = mode.effect.clone().map(normalize_effect);
            state.tuning.store(
                mode.solid.as_ref(),
                mode.ambilight.as_ref(),
                effect.as_ref(),
            );
            if request.origin.is_choice()
                && mode.kind == LightingModeKind::Effect
                && running_kind != LightingModeKind::Effect
            {
                let saved = persisted
                    .as_ref()
                    .and_then(PersistedShellState::lighting_mode)
                    .and_then(|saved| saved.effect);
                state.tuning.restart_sunrise(saved.as_ref());
            }
        }
        (None, LightingOrigin::Boot) => {
            if let Some(mode) = persisted
                .as_ref()
                .and_then(PersistedShellState::lighting_mode)
            {
                state.tuning.store(
                    mode.solid.as_ref(),
                    mode.ambilight.as_ref(),
                    mode.effect.as_ref(),
                );
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
