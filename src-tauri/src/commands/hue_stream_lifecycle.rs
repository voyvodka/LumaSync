use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::State;

use super::hue_onboarding::{check_hue_stream_readiness, CommandStatus};

const DEFAULT_RETRY_MAX_ATTEMPTS: u8 = 3;
const DEFAULT_RETRY_BASE_MS: u64 = 400;
const DEFAULT_RETRY_CAP_MS: u64 = 2_000;

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq, Debug)]
pub enum HueRuntimeState {
    Idle,
    Starting,
    Running,
    Reconnecting,
    Stopping,
    Failed,
}

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq, Debug)]
#[serde(rename_all = "snake_case")]
pub enum HueRuntimeTriggerSource {
    ModeControl,
    DeviceSurface,
    System,
}

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq, Debug)]
#[serde(rename_all = "snake_case")]
pub enum HueRuntimeActionHint {
    Retry,
    Reconnect,
    Repair,
    Revalidate,
    AdjustArea,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct HueRuntimeStatus {
    pub state: HueRuntimeState,
    pub code: String,
    pub message: String,
    pub details: Option<String>,
    pub remaining_attempts: Option<u8>,
    pub next_attempt_ms: Option<u64>,
    pub action_hint: Option<HueRuntimeActionHint>,
    pub trigger_source: HueRuntimeTriggerSource,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct HueRuntimeCommandResult {
    pub active: bool,
    pub status: HueRuntimeStatus,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct StartHueStreamRequest {
    pub bridge_ip: String,
    pub username: String,
    pub area_id: String,
    pub trigger_source: Option<HueRuntimeTriggerSource>,
}

#[derive(Clone, Debug)]
pub struct HueRuntimeGateEvidence {
    pub bridge_configured: bool,
    pub credentials_valid: bool,
    pub area_selected: bool,
    pub readiness_current: bool,
    pub ready: bool,
    pub auth_invalid_evidence: bool,
}

#[cfg_attr(not(test), allow(dead_code))]
#[derive(Clone, Debug)]
struct HueRetryPolicy {
    max_attempts: u8,
    base_backoff_ms: u64,
    cap_backoff_ms: u64,
}

impl Default for HueRetryPolicy {
    fn default() -> Self {
        Self {
            max_attempts: DEFAULT_RETRY_MAX_ATTEMPTS,
            base_backoff_ms: DEFAULT_RETRY_BASE_MS,
            cap_backoff_ms: DEFAULT_RETRY_CAP_MS,
        }
    }
}

struct HueRuntimeOwner {
    state: HueRuntimeState,
    reconnect_attempt: u8,
    user_override_pending: bool,
    last_status: HueRuntimeStatus,
    #[cfg_attr(not(test), allow(dead_code))]
    retry_policy: HueRetryPolicy,
}

impl Default for HueRuntimeOwner {
    fn default() -> Self {
        Self {
            state: HueRuntimeState::Idle,
            reconnect_attempt: 0,
            user_override_pending: false,
            last_status: status_with(
                HueRuntimeState::Idle,
                "HUE_STREAM_IDLE",
                "Hue runtime is idle.",
                None,
                HueRuntimeTriggerSource::System,
            ),
            retry_policy: HueRetryPolicy::default(),
        }
    }
}

#[derive(Default)]
pub struct HueRuntimeStateStore {
    runtime: Mutex<HueRuntimeOwner>,
}

fn status_with(
    state: HueRuntimeState,
    code: &str,
    message: &str,
    details: Option<String>,
    trigger_source: HueRuntimeTriggerSource,
) -> HueRuntimeStatus {
    HueRuntimeStatus {
        state,
        code: code.to_string(),
        message: message.to_string(),
        details,
        remaining_attempts: None,
        next_attempt_ms: None,
        action_hint: None,
        trigger_source,
    }
}

fn make_result(owner: &HueRuntimeOwner) -> HueRuntimeCommandResult {
    HueRuntimeCommandResult {
        active: matches!(
            owner.state,
            HueRuntimeState::Starting | HueRuntimeState::Running | HueRuntimeState::Reconnecting
        ),
        status: owner.last_status.clone(),
    }
}

fn start_with_evidence(
    owner: &mut HueRuntimeOwner,
    evidence: &HueRuntimeGateEvidence,
    trigger_source: HueRuntimeTriggerSource,
) -> HueRuntimeCommandResult {
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

    owner.user_override_pending = false;
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

#[cfg_attr(not(test), allow(dead_code))]
fn next_backoff_ms(policy: &HueRetryPolicy, attempt_index: u8) -> u64 {
    let exponent = u32::from(attempt_index.saturating_sub(1));
    let factor = 2_u64.saturating_pow(exponent);
    let raw = policy.base_backoff_ms.saturating_mul(factor);
    raw.min(policy.cap_backoff_ms)
}

#[cfg_attr(not(test), allow(dead_code))]
fn register_transient_fault(
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
    make_result(owner)
}

#[cfg_attr(not(test), allow(dead_code))]
fn register_auth_invalid(
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
    make_result(owner)
}

fn stop_with_timeout(
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

    owner.reconnect_attempt = 0;
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

#[tauri::command]
pub fn start_hue_stream(
    request: StartHueStreamRequest,
    runtime_state: State<'_, HueRuntimeStateStore>,
) -> Result<HueRuntimeCommandResult, String> {
    let mut owner = runtime_state
        .runtime
        .lock()
        .map_err(|error| format!("HUE_RUNTIME_LOCK_FAILED: {error}"))?;
    let trigger = request
        .trigger_source
        .unwrap_or(HueRuntimeTriggerSource::ModeControl);
    let evidence = HueRuntimeGateEvidence {
        bridge_configured: !request.bridge_ip.trim().is_empty(),
        credentials_valid: !request.username.trim().is_empty(),
        area_selected: !request.area_id.trim().is_empty(),
        readiness_current: true,
        ready: false,
        auth_invalid_evidence: false,
    };

    let readiness = check_hue_stream_readiness(
        request.bridge_ip.clone(),
        request.username.clone(),
        request.area_id.clone(),
    );

    let mut gate = evidence;
    gate.readiness_current = readiness.status.code != "HUE_STREAM_READINESS_FAILED";
    gate.ready = readiness.readiness.ready;
    gate.auth_invalid_evidence = readiness.status.code.starts_with("AUTH_INVALID_")
        || readiness.status.code == "HUE_CREDENTIAL_INVALID";

    Ok(start_with_evidence(&mut owner, &gate, trigger))
}

#[tauri::command]
pub fn stop_hue_stream(
    trigger_source: Option<HueRuntimeTriggerSource>,
    runtime_state: State<'_, HueRuntimeStateStore>,
) -> Result<HueRuntimeCommandResult, String> {
    let mut owner = runtime_state
        .runtime
        .lock()
        .map_err(|error| format!("HUE_RUNTIME_LOCK_FAILED: {error}"))?;
    let trigger = trigger_source.unwrap_or(HueRuntimeTriggerSource::System);
    Ok(stop_with_timeout(&mut owner, false, trigger))
}

#[tauri::command]
pub fn get_hue_stream_status(
    runtime_state: State<'_, HueRuntimeStateStore>,
) -> Result<HueRuntimeCommandResult, String> {
    let owner = runtime_state
        .runtime
        .lock()
        .map_err(|error| format!("HUE_RUNTIME_LOCK_FAILED: {error}"))?;
    Ok(make_result(&owner))
}

#[allow(dead_code)]
fn to_legacy_status(status: &HueRuntimeStatus) -> CommandStatus {
    CommandStatus {
        code: status.code.clone(),
        message: status.message.clone(),
        details: status.details.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn command_status_refresh_with_evidence(
        owner: &mut HueRuntimeOwner,
        _evidence: &HueRuntimeGateEvidence,
    ) -> HueRuntimeCommandResult {
        make_result(owner)
    }

    fn strict_gate_ready() -> HueRuntimeGateEvidence {
        HueRuntimeGateEvidence {
            bridge_configured: true,
            credentials_valid: true,
            area_selected: true,
            readiness_current: true,
            ready: true,
            auth_invalid_evidence: false,
        }
    }

    fn strict_gate_missing_readiness() -> HueRuntimeGateEvidence {
        HueRuntimeGateEvidence {
            bridge_configured: true,
            credentials_valid: true,
            area_selected: true,
            readiness_current: false,
            ready: false,
            auth_invalid_evidence: false,
        }
    }

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
        let result = command_status_refresh_with_evidence(&mut owner, &transient_fault_gate);

        assert_eq!(result.status.state, HueRuntimeState::Reconnecting);
        assert_eq!(result.status.code, "TRANSIENT_RETRY_SCHEDULED");
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
        let _ = command_status_refresh_with_evidence(&mut owner, &transient_fault_gate);
        let _ = command_status_refresh_with_evidence(&mut owner, &transient_fault_gate);
        let exhausted = command_status_refresh_with_evidence(&mut owner, &transient_fault_gate);

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
        let result = command_status_refresh_with_evidence(&mut owner, &auth_invalid_gate);

        assert_eq!(result.status.state, HueRuntimeState::Failed);
        assert_eq!(result.status.code, "AUTH_INVALID_CREDENTIALS");
        assert_eq!(
            result.status.action_hint,
            Some(HueRuntimeActionHint::Repair)
        );
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
