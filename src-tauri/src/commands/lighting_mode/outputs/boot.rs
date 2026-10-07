//! The launch restore's waits: the boot Hue retry, the parked resume the
//! health monitor answers, and the wait for a strip to connect.

use super::*;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ReleaseWait {
    Free,
    Timeout,
    NotBusy,
    /// The bridge did not answer: the wait parks until it does.
    Unreachable,
    Cancelled,
}

pub(super) async fn sleep_or_cancel(token: &CancelToken, duration: Duration) {
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

pub(super) fn schedule_boot_retry<R: Runtime>(
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

pub(super) async fn run_boot_retry<R: Runtime>(
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
                park_boot_hue(&app, plan);
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
pub(super) async fn resume_boot_hue<R: Runtime>(app: &AppHandle<R>, plan: BootRetryPlan) {
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
pub(super) struct HueHealthView {
    bridge: HueBridgeView,
    stream: HueStreamView,
}

#[derive(Deserialize)]
pub(super) struct HueBridgeView {
    verdict: Option<String>,
    probing: bool,
}

#[derive(Deserialize)]
pub(super) struct HueStreamView {
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
    fire_parked(app, plan);
}

/// Parks a launch restore's Hue plan until the bridge answers. While it
/// waits the health monitor probes the bridge even with no window shown, on
/// a bounded schedule; the wait ends when the plan fires, is cancelled, or
/// its window runs out. See docs/architecture/lighting-transaction.md.
pub(super) fn park_boot_hue<R: Runtime>(app: &AppHandle<R>, plan: BootRetryPlan) {
    let state = app.state::<LightingRuntimeState>();
    match state.outputs.park_boot_hue(plan) {
        Parked::Spent => {}
        Parked::FireNow(plan) => {
            info!("[outputs] the bridge already answers; resuming the launch restore now");
            fire_parked(app, plan);
        }
        Parked::Waiting(generation) => {
            health::note_boot_resume_pending(app, true);
            let window = state.outputs.boot_hue_park_window();
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(window).await;
                lapse_boot_hue_park(&app, generation);
            });
        }
    }
}

/// The bridge never answered within the park's window: stop probing and say
/// so the way the area wait's end does.
pub(super) fn lapse_boot_hue_park<R: Runtime>(app: &AppHandle<R>, generation: u64) {
    let state = app.state::<LightingRuntimeState>();
    let Some(plan) = state.outputs.lapse_boot_hue_park(generation) else {
        return;
    };
    warn!("[outputs] the bridge never answered while the launch restore waited; giving up");
    health::note_boot_resume_pending(app, false);
    state.snapshot.publish(app, |snapshot| match plan {
        BootRetryPlan::Resume { .. } => snapshot.boot_hue_retry = Some(BootHueRetryState::GaveUp),
        BootRetryPlan::Rejoin { left_out } => snapshot.hue_held_out_reason = Some(left_out),
    });
}

/// Runs a taken plan off the caller's thread — `note_hue_reachable` runs
/// inside the monitor's publish.
pub(super) fn fire_parked<R: Runtime>(app: &AppHandle<R>, plan: BootRetryPlan) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        health::note_boot_resume_pending(&app, false);
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

pub(super) fn hue_paired<R: Runtime>(app: &AppHandle<R>) -> bool {
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
pub(super) fn wait_for_local_sink<R: Runtime>(app: &AppHandle<R>, kind: LightingModeKind) {
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
