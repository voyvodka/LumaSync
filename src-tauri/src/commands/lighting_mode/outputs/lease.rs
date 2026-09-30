//! The Hue test lease — a test pattern borrowing the stream.

use super::*;

/// Bring Hue up for a test run that targets it, and hand back only what the
/// lease itself opened. A stream a live mode owns, or that a mode started
/// during the run adopted, is left to that mode: stopping it would turn off
/// lights the test never turned on.
pub(super) async fn lease_hue<R: Runtime>(
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
pub(super) async fn lease_acquire<R: Runtime>(
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
    // The start would sit out its HTTP timeouts (~7 s) against a bridge the
    // monitor already found silent, and the pattern — and its Stop — wait on it.
    if hue_known_unreachable(app) {
        state.outputs.set_lease(LeaseState::NotOurs);
        outcome.hue_left_out = Some(HueLeftOutReason::Unreachable);
        warn!("[outputs] the bridge is known unreachable; the test runs without Hue");
        return true;
    }
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

/// Only a settled verdict counts: a probe in flight still carries the last one.
pub(super) fn hue_known_unreachable<R: Runtime>(app: &AppHandle<R>) -> bool {
    let Some(monitor) = app.try_state::<health::HueHealthMonitor>() else {
        return false;
    };
    let bridge = monitor.snapshot().bridge;
    bridge.gave_up
        || (!bridge.probing && bridge.verdict == Some(health::HueBridgeVerdict::Unreachable))
}

pub(super) async fn lease_release<R: Runtime>(
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
