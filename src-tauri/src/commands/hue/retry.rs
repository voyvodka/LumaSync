//! Bounded-retry policy + state-machine transition fns for the Hue runtime.
//!
//! Carved out of the original `hue_stream_lifecycle.rs` during the v1.5 G8
//! split. This module is the single home of:
//!
//! - `next_backoff_ms` (exponential backoff, capped) for the
//!   `Reconnecting → Reconnecting → Failed` ladder.
//! - `register_transient_fault` and `register_auth_invalid` — the only two
//!   fns allowed to flip the runtime to `Reconnecting` / `Failed` and to
//!   record the matching error code + telemetry timestamp.
//! - `start_with_evidence` — the strict-gate state transition consumed by
//!   `start_hue_stream` and `restart_hue_stream`.
//! - `status_refresh_with_evidence` — the periodic poll path used by
//!   `get_hue_stream_status`.
//! - `stop_with_timeout` — the synchronous cleanup that drops both
//!   `active_stream` and `persistent_sender` so the background mpsc
//!   channel can close.
//!
//! Behaviour is preserved exactly — the retry-budget arithmetic, the
//! `HUE_STOPPED_BY_USER` guard, and the auth-invalid → `Repair` action
//! hint are byte-for-byte identical to the pre-split implementation.

use std::time::Instant;

use super::state_store::{
    make_result, status_with, HueRetryPolicy, HueRuntimeActionHint, HueRuntimeCommandResult,
    HueRuntimeGateEvidence, HueRuntimeOwner, HueRuntimeState, HueRuntimeTriggerSource,
};

pub(crate) fn next_backoff_ms(policy: &HueRetryPolicy, attempt_index: u8) -> u64 {
    let exponent = u32::from(attempt_index.saturating_sub(1));
    let factor = 2_u64.saturating_pow(exponent);
    let raw = policy.base_backoff_ms.saturating_mul(factor);
    raw.min(policy.cap_backoff_ms)
}

pub(crate) fn register_transient_fault(
    owner: &mut HueRuntimeOwner,
    details: &str,
    trigger_source: HueRuntimeTriggerSource,
) -> HueRuntimeCommandResult {
    if owner.user_override_pending {
        owner.state = HueRuntimeState::Idle;
        owner.last_status = status_with(
            HueRuntimeState::Idle,
            "HUE_STOPPED_BY_USER",
            "User action canceled reconnect workflow.",
            None,
            trigger_source,
        );
        return make_result(owner);
    }

    owner.state = HueRuntimeState::Reconnecting;
    let next_attempt_index = owner.reconnect_attempt.saturating_add(1);
    if next_attempt_index >= owner.retry_policy.max_attempts {
        owner.reconnect_attempt = owner.retry_policy.max_attempts;
        owner.state = HueRuntimeState::Failed;
        owner.last_status = status_with(
            HueRuntimeState::Failed,
            "TRANSIENT_RETRY_EXHAUSTED",
            "Transient retry budget exhausted. Hue runtime moved to failed state.",
            Some(details.to_string()),
            trigger_source,
        );
        owner.last_status.action_hint = Some(HueRuntimeActionHint::Retry);
        owner.last_status.remaining_attempts = Some(0);
        owner.last_status.next_attempt_ms = None;
        return make_result(owner);
    }

    owner.reconnect_attempt = next_attempt_index;
    owner.last_status = status_with(
        HueRuntimeState::Reconnecting,
        "TRANSIENT_RETRY_SCHEDULED",
        "Hue runtime scheduled bounded reconnect attempt.",
        Some(details.to_string()),
        trigger_source,
    );
    owner.last_status.action_hint = Some(HueRuntimeActionHint::Reconnect);
    owner.last_status.remaining_attempts = Some(
        owner
            .retry_policy
            .max_attempts
            .saturating_sub(owner.reconnect_attempt),
    );
    owner.last_status.next_attempt_ms = Some(next_backoff_ms(
        &owner.retry_policy,
        owner.reconnect_attempt,
    ));
    // Record error for telemetry.
    owner.last_error_code = Some(owner.last_status.code.clone());
    owner.last_error_at = Some(Instant::now());
    make_result(owner)
}

pub(crate) fn register_auth_invalid(
    owner: &mut HueRuntimeOwner,
    details: &str,
    trigger_source: HueRuntimeTriggerSource,
) -> HueRuntimeCommandResult {
    owner.state = HueRuntimeState::Failed;
    owner.last_status = status_with(
        HueRuntimeState::Failed,
        "AUTH_INVALID_CREDENTIALS",
        "Hue credentials are invalid and require repair.",
        Some(details.to_string()),
        trigger_source,
    );
    owner.last_status.action_hint = Some(HueRuntimeActionHint::Repair);
    owner.last_status.remaining_attempts = Some(0);
    owner.last_status.next_attempt_ms = None;
    // Record error for telemetry.
    owner.last_error_code = Some(owner.last_status.code.clone());
    owner.last_error_at = Some(Instant::now());
    make_result(owner)
}

pub(crate) fn start_with_evidence(
    owner: &mut HueRuntimeOwner,
    evidence: &HueRuntimeGateEvidence,
    trigger_source: HueRuntimeTriggerSource,
) -> HueRuntimeCommandResult {
    owner.user_override_pending = false;

    if matches!(
        owner.state,
        HueRuntimeState::Starting | HueRuntimeState::Running | HueRuntimeState::Reconnecting
    ) {
        owner.state = HueRuntimeState::Running;
        owner.last_status = status_with(
            HueRuntimeState::Running,
            "HUE_START_NOOP_ALREADY_ACTIVE",
            "Hue runtime already active. Start request is a no-op.",
            None,
            trigger_source,
        );
        return make_result(owner);
    }

    if evidence.auth_invalid_evidence {
        owner.state = HueRuntimeState::Failed;
        owner.active_stream = None;
        owner.last_status = status_with(
            HueRuntimeState::Failed,
            "AUTH_INVALID_CREDENTIALS",
            "Hue credentials are invalid. Re-pair is required before starting stream.",
            Some("Bridge returned explicit auth-invalid evidence.".to_string()),
            trigger_source,
        );
        owner.last_status.action_hint = Some(HueRuntimeActionHint::Repair);
        return make_result(owner);
    }

    let strict_gate_ok = evidence.bridge_configured
        && evidence.credentials_valid
        && evidence.area_selected
        && evidence.readiness_current
        && evidence.ready;

    if !strict_gate_ok {
        let mut missing = Vec::new();
        if !evidence.bridge_configured {
            missing.push("bridge");
        }
        if !evidence.credentials_valid {
            missing.push("credentials");
        }
        if !evidence.area_selected {
            missing.push("area");
        }
        if !evidence.readiness_current {
            missing.push("readiness");
        }
        if evidence.readiness_current && !evidence.ready {
            missing.push("ready");
        }

        owner.state = HueRuntimeState::Idle;
        owner.active_stream = None;
        owner.last_status = status_with(
            HueRuntimeState::Idle,
            "CONFIG_NOT_READY_GATE_BLOCKED",
            "Hue stream start blocked by strict backend readiness gate.",
            Some(format!("Missing prerequisites: {}", missing.join(", "))),
            trigger_source,
        );
        owner.last_status.action_hint = Some(if !evidence.area_selected {
            HueRuntimeActionHint::AdjustArea
        } else {
            HueRuntimeActionHint::Revalidate
        });
        return make_result(owner);
    }

    owner.reconnect_attempt = 0;
    owner.state = HueRuntimeState::Starting;
    owner.last_status = status_with(
        HueRuntimeState::Starting,
        "HUE_STREAM_STARTING",
        "Hue runtime is starting.",
        None,
        trigger_source.clone(),
    );

    owner.state = HueRuntimeState::Running;
    owner.last_status = status_with(
        HueRuntimeState::Running,
        "HUE_STREAM_RUNNING",
        "Hue runtime is running.",
        None,
        trigger_source,
    );
    make_result(owner)
}

pub(crate) fn status_refresh_with_evidence(
    owner: &mut HueRuntimeOwner,
    evidence: &HueRuntimeGateEvidence,
    details: Option<String>,
) -> HueRuntimeCommandResult {
    if owner.user_override_pending
        || !matches!(
            owner.state,
            HueRuntimeState::Starting | HueRuntimeState::Running | HueRuntimeState::Reconnecting
        )
    {
        return make_result(owner);
    }

    if evidence.auth_invalid_evidence {
        let reason =
            details.unwrap_or_else(|| "Hue readiness reported auth-invalid evidence.".to_string());
        return register_auth_invalid(owner, &reason, HueRuntimeTriggerSource::System);
    }

    if !evidence.readiness_current {
        let reason = details.unwrap_or_else(|| {
            "Hue readiness check reported a transient transport fault.".to_string()
        });
        return register_transient_fault(owner, &reason, HueRuntimeTriggerSource::System);
    }

    if !evidence.ready {
        owner.state = HueRuntimeState::Running;
        owner.last_status = status_with(
            HueRuntimeState::Running,
            "CONFIG_NOT_READY_GATE_BLOCKED",
            "Hue stream is active but area readiness is currently not satisfied.",
            details,
            HueRuntimeTriggerSource::System,
        );
        owner.last_status.action_hint = Some(HueRuntimeActionHint::Revalidate);
        owner.last_status.remaining_attempts = Some(
            owner
                .retry_policy
                .max_attempts
                .saturating_sub(owner.reconnect_attempt),
        );
        owner.last_status.next_attempt_ms = None;
        return make_result(owner);
    }

    owner.reconnect_attempt = 0;
    owner.state = HueRuntimeState::Running;
    owner.last_status = status_with(
        HueRuntimeState::Running,
        "HUE_STREAM_RUNNING",
        "Hue runtime is running.",
        details,
        HueRuntimeTriggerSource::System,
    );
    make_result(owner)
}

pub(crate) fn stop_with_timeout(
    owner: &mut HueRuntimeOwner,
    timed_out: bool,
    trigger_source: HueRuntimeTriggerSource,
) -> HueRuntimeCommandResult {
    owner.user_override_pending = true;
    owner.state = HueRuntimeState::Stopping;
    owner.last_status = status_with(
        HueRuntimeState::Stopping,
        "HUE_STREAM_STOPPING",
        "Hue runtime stop requested. Running deterministic cleanup.",
        Some("cleanup-order=stream-stop->state-restore".to_string()),
        trigger_source.clone(),
    );

    // Dropping active_stream (and thus the sender Arc) closes the mpsc channel,
    // which causes the background thread to exit. DTLS deactivation is performed
    // by the caller AFTER releasing the lock to avoid blocking the mutex on HTTP I/O.

    owner.reconnect_attempt = 0;
    owner.active_stream = None;
    // A4: Drop persistent_sender so the background thread's mpsc channel closes
    // immediately (Arc refcount falls to zero). Without this, wait_for_shutdown
    // always times out because the thread's recv loop never sees Disconnected.
    owner.persistent_sender = None;
    owner.state = HueRuntimeState::Idle;
    if timed_out {
        owner.last_status = status_with(
            HueRuntimeState::Idle,
            "HUE_STOP_TIMEOUT_PARTIAL",
            "Hue runtime reached stop timeout; partial-stop cleanup reported.",
            Some("retry stop to ensure bridge state restore".to_string()),
            trigger_source,
        );
        owner.last_status.action_hint = Some(HueRuntimeActionHint::Retry);
    } else {
        owner.last_status = status_with(
            HueRuntimeState::Idle,
            "HUE_STREAM_STOPPED",
            "Hue runtime stopped and state restored to non-stream mode.",
            None,
            trigger_source,
        );
    }
    make_result(owner)
}

#[cfg(test)]
mod tests {
    use super::*;

    use super::super::state_store::test_helpers::{
        dummy_active_stream_context, strict_gate_missing_readiness, strict_gate_ready,
    };

    #[test]
    fn start_fails_with_config_not_ready_when_strict_gate_is_missing() {
        let mut owner = HueRuntimeOwner::default();
        let result = start_with_evidence(
            &mut owner,
            &strict_gate_missing_readiness(),
            HueRuntimeTriggerSource::ModeControl,
        );

        assert_eq!(result.status.code, "CONFIG_NOT_READY_GATE_BLOCKED");
        assert_eq!(result.status.state, HueRuntimeState::Idle);
        assert!(!result.active);
    }

    #[test]
    fn start_is_idempotent_while_starting_or_running() {
        let mut owner = HueRuntimeOwner::default();

        let _ = start_with_evidence(
            &mut owner,
            &strict_gate_ready(),
            HueRuntimeTriggerSource::ModeControl,
        );
        let second = start_with_evidence(
            &mut owner,
            &strict_gate_ready(),
            HueRuntimeTriggerSource::ModeControl,
        );

        assert_eq!(second.status.code, "HUE_START_NOOP_ALREADY_ACTIVE");
        assert_eq!(second.status.state, HueRuntimeState::Running);
        assert!(second.active);
    }

    #[test]
    fn transient_faults_exhaust_into_failed_and_auth_invalid_sets_repair_hint() {
        let mut owner = HueRuntimeOwner::default();

        let _ = start_with_evidence(
            &mut owner,
            &strict_gate_ready(),
            HueRuntimeTriggerSource::ModeControl,
        );

        let first =
            register_transient_fault(&mut owner, "udp timeout", HueRuntimeTriggerSource::System);
        assert_eq!(first.status.code, "TRANSIENT_RETRY_SCHEDULED");
        assert_eq!(first.status.state, HueRuntimeState::Reconnecting);

        let _ =
            register_transient_fault(&mut owner, "udp timeout", HueRuntimeTriggerSource::System);
        let exhausted =
            register_transient_fault(&mut owner, "udp timeout", HueRuntimeTriggerSource::System);

        assert_eq!(exhausted.status.code, "TRANSIENT_RETRY_EXHAUSTED");
        assert_eq!(exhausted.status.state, HueRuntimeState::Failed);
        assert_eq!(
            exhausted.status.action_hint,
            Some(HueRuntimeActionHint::Retry)
        );

        let auth =
            register_auth_invalid(&mut owner, "unauthorized", HueRuntimeTriggerSource::System);
        assert_eq!(auth.status.code, "AUTH_INVALID_CREDENTIALS");
        assert_eq!(auth.status.action_hint, Some(HueRuntimeActionHint::Repair));
    }

    #[test]
    fn command_status_refresh_marks_running_runtime_as_reconnecting_on_transient_fault() {
        let mut owner = HueRuntimeOwner::default();
        let ready_gate = strict_gate_ready();
        let mut transient_fault_gate = strict_gate_ready();
        transient_fault_gate.readiness_current = false;
        transient_fault_gate.ready = false;

        let _ = start_with_evidence(
            &mut owner,
            &ready_gate,
            HueRuntimeTriggerSource::ModeControl,
        );
        let result = status_refresh_with_evidence(&mut owner, &transient_fault_gate, None);

        assert_eq!(result.status.state, HueRuntimeState::Reconnecting);
        assert_eq!(result.status.code, "TRANSIENT_RETRY_SCHEDULED");
        assert!(result.status.next_attempt_ms.is_some());
        assert_eq!(result.status.remaining_attempts, Some(2));
    }

    #[test]
    fn command_status_refresh_preserves_retry_budget_for_not_ready_area_state() {
        let mut owner = HueRuntimeOwner::default();
        let ready_gate = strict_gate_ready();
        let mut not_ready_gate = strict_gate_ready();
        not_ready_gate.ready = false;

        let _ = start_with_evidence(
            &mut owner,
            &ready_gate,
            HueRuntimeTriggerSource::ModeControl,
        );
        owner.reconnect_attempt = 1;

        let result = status_refresh_with_evidence(
            &mut owner,
            &not_ready_gate,
            Some("area readiness dropped".to_string()),
        );

        assert_eq!(result.status.state, HueRuntimeState::Running);
        assert_eq!(result.status.code, "CONFIG_NOT_READY_GATE_BLOCKED");
        assert_eq!(
            result.status.action_hint,
            Some(HueRuntimeActionHint::Revalidate)
        );
        assert_eq!(result.status.remaining_attempts, Some(2));
        assert_eq!(owner.reconnect_attempt, 1);
    }

    #[test]
    fn command_status_refresh_exhausts_retry_budget_and_marks_failed() {
        let mut owner = HueRuntimeOwner::default();
        let ready_gate = strict_gate_ready();
        let mut transient_fault_gate = strict_gate_ready();
        transient_fault_gate.readiness_current = false;
        transient_fault_gate.ready = false;

        let _ = start_with_evidence(
            &mut owner,
            &ready_gate,
            HueRuntimeTriggerSource::ModeControl,
        );
        let _ = status_refresh_with_evidence(&mut owner, &transient_fault_gate, None);
        let _ = status_refresh_with_evidence(&mut owner, &transient_fault_gate, None);
        let exhausted = status_refresh_with_evidence(&mut owner, &transient_fault_gate, None);

        assert_eq!(exhausted.status.state, HueRuntimeState::Failed);
        assert_eq!(exhausted.status.code, "TRANSIENT_RETRY_EXHAUSTED");
        assert_eq!(exhausted.status.remaining_attempts, Some(0));
    }

    #[test]
    fn command_status_refresh_marks_auth_invalid_fault_as_repair_required() {
        let mut owner = HueRuntimeOwner::default();
        let ready_gate = strict_gate_ready();
        let mut auth_invalid_gate = strict_gate_ready();
        auth_invalid_gate.auth_invalid_evidence = true;

        let _ = start_with_evidence(
            &mut owner,
            &ready_gate,
            HueRuntimeTriggerSource::ModeControl,
        );
        let result = status_refresh_with_evidence(&mut owner, &auth_invalid_gate, None);

        assert_eq!(result.status.state, HueRuntimeState::Failed);
        assert_eq!(result.status.code, "AUTH_INVALID_CREDENTIALS");
        assert_eq!(
            result.status.action_hint,
            Some(HueRuntimeActionHint::Repair)
        );
    }

    #[test]
    fn user_stop_prevents_new_reconnect_attempts_during_status_refresh() {
        let mut owner = HueRuntimeOwner::default();

        let _ = start_with_evidence(
            &mut owner,
            &strict_gate_ready(),
            HueRuntimeTriggerSource::ModeControl,
        );
        owner.active_stream = Some(dummy_active_stream_context());
        let _ = stop_with_timeout(&mut owner, false, HueRuntimeTriggerSource::DeviceSurface);

        let mut transient_fault_gate = strict_gate_ready();
        transient_fault_gate.readiness_current = false;
        transient_fault_gate.ready = false;

        let result = status_refresh_with_evidence(&mut owner, &transient_fault_gate, None);

        assert_eq!(result.status.state, HueRuntimeState::Idle);
        assert_eq!(result.status.code, "HUE_STREAM_STOPPED");
        assert_eq!(owner.reconnect_attempt, 0);
    }

    #[test]
    fn stop_runs_deterministic_cleanup_and_timeout_reports_partial_stop() {
        let mut owner = HueRuntimeOwner::default();
        let _ = start_with_evidence(
            &mut owner,
            &strict_gate_ready(),
            HueRuntimeTriggerSource::ModeControl,
        );

        let timeout = stop_with_timeout(&mut owner, true, HueRuntimeTriggerSource::DeviceSurface);

        assert_eq!(timeout.status.code, "HUE_STOP_TIMEOUT_PARTIAL");
        assert_eq!(timeout.status.state, HueRuntimeState::Idle);
        assert_eq!(
            timeout.status.action_hint,
            Some(HueRuntimeActionHint::Retry)
        );
        assert!(!timeout.active);
    }
}
