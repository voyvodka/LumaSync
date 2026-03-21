use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::State;

use super::hue_onboarding::CommandStatus;

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
    _evidence: &HueRuntimeGateEvidence,
    trigger_source: HueRuntimeTriggerSource,
) -> HueRuntimeCommandResult {
    owner.last_status = status_with(
        owner.state.clone(),
        "HUE_STREAM_START_NOT_IMPLEMENTED",
        "Hue start runtime policy is not implemented yet.",
        None,
        trigger_source,
    );
    make_result(owner)
}

fn register_transient_fault(
    owner: &mut HueRuntimeOwner,
    details: &str,
    trigger_source: HueRuntimeTriggerSource,
) -> HueRuntimeCommandResult {
    owner.state = HueRuntimeState::Reconnecting;
    owner.last_status = status_with(
        HueRuntimeState::Reconnecting,
        "TRANSIENT_RETRY_NOT_IMPLEMENTED",
        "Transient reconnect policy is not implemented yet.",
        Some(details.to_string()),
        trigger_source,
    );
    make_result(owner)
}

fn register_auth_invalid(
    owner: &mut HueRuntimeOwner,
    details: &str,
    trigger_source: HueRuntimeTriggerSource,
) -> HueRuntimeCommandResult {
    owner.state = HueRuntimeState::Failed;
    owner.last_status = status_with(
        HueRuntimeState::Failed,
        "AUTH_INVALID_NOT_IMPLEMENTED",
        "Auth-invalid escalation policy is not implemented yet.",
        Some(details.to_string()),
        trigger_source,
    );
    make_result(owner)
}

fn stop_with_timeout(
    owner: &mut HueRuntimeOwner,
    timed_out: bool,
    trigger_source: HueRuntimeTriggerSource,
) -> HueRuntimeCommandResult {
    owner.user_override_pending = true;
    let code = if timed_out {
        "HUE_STREAM_STOP_NOT_IMPLEMENTED_TIMEOUT"
    } else {
        "HUE_STREAM_STOP_NOT_IMPLEMENTED"
    };
    owner.state = HueRuntimeState::Idle;
    owner.last_status = status_with(
        HueRuntimeState::Idle,
        code,
        "Hue stop cleanup policy is not implemented yet.",
        None,
        trigger_source,
    );
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
        readiness_current: false,
        ready: false,
        auth_invalid_evidence: false,
    };
    Ok(start_with_evidence(&mut owner, &evidence, trigger))
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
