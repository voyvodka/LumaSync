use std::sync::Mutex;

use reqwest::blocking::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::State;

use super::hue_onboarding::{check_hue_stream_readiness, CommandStatus};

const DEFAULT_RETRY_MAX_ATTEMPTS: u8 = 3;
const DEFAULT_RETRY_BASE_MS: u64 = 400;
const DEFAULT_RETRY_CAP_MS: u64 = 2_000;
const HUE_HTTP_TIMEOUT_MS: u64 = 5_000;

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

#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SetHueSolidColorRequest {
    pub r: u8,
    pub g: u8,
    pub b: u8,
    pub brightness: Option<f32>,
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
    active_stream: Option<HueActiveStreamContext>,
    reconnect_attempt: u8,
    user_override_pending: bool,
    last_status: HueRuntimeStatus,
    #[cfg_attr(not(test), allow(dead_code))]
    retry_policy: HueRetryPolicy,
}

#[derive(Clone, Debug)]
struct HueActiveStreamContext {
    bridge_ip: String,
    username: String,
    area_id: String,
    light_ids: Vec<String>,
}

#[derive(Clone, Debug)]
pub struct HueActiveOutputContext {
    pub bridge_ip: String,
    pub username: String,
    pub light_ids: Vec<String>,
}

impl Default for HueRuntimeOwner {
    fn default() -> Self {
        Self {
            state: HueRuntimeState::Idle,
            active_stream: None,
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

fn status_refresh_with_evidence(
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

fn store_active_stream_context(
    owner: &mut HueRuntimeOwner,
    request: &StartHueStreamRequest,
    light_ids: Vec<String>,
    start_result: &HueRuntimeCommandResult,
) {
    if start_result.active {
        owner.active_stream = Some(HueActiveStreamContext {
            bridge_ip: request.bridge_ip.clone(),
            username: request.username.clone(),
            area_id: request.area_id.clone(),
            light_ids,
        });
    }
}

fn hue_http_client() -> Result<Client, String> {
    Client::builder()
        .timeout(std::time::Duration::from_millis(HUE_HTTP_TIMEOUT_MS))
        .danger_accept_invalid_certs(true)
        .build()
        .map_err(|error| error.to_string())
}

fn fetch_area_light_ids(
    bridge_ip: &str,
    username: &str,
    area_id: &str,
) -> Result<Vec<String>, String> {
    let client = hue_http_client()?;
    let endpoint =
        format!("https://{bridge_ip}/clip/v2/resource/entertainment_configuration/{area_id}");
    let payload = client
        .get(endpoint)
        .header("hue-application-key", username)
        .send()
        .and_then(|response| response.error_for_status())
        .and_then(|response| response.text())
        .map_err(|error| error.to_string())?;

    let parsed: Value = serde_json::from_str(&payload).map_err(|error| error.to_string())?;
    let channels = parsed
        .get("data")
        .and_then(|value| value.as_array())
        .and_then(|items| items.first())
        .and_then(|item| item.get("channels"))
        .and_then(|value| value.as_array())
        .ok_or_else(|| "Missing channels in entertainment area payload".to_string())?;

    fn push_unique(target: &mut Vec<String>, id: &str) {
        if !target.iter().any(|existing| existing == id) {
            target.push(id.to_string());
        }
    }

    fn fetch_resource(
        client: &Client,
        bridge_ip: &str,
        username: &str,
        rtype: &str,
        rid: &str,
    ) -> Result<Value, String> {
        let endpoint = format!("https://{bridge_ip}/clip/v2/resource/{rtype}/{rid}");
        let payload = client
            .get(endpoint)
            .header("hue-application-key", username)
            .send()
            .and_then(|response| response.error_for_status())
            .and_then(|response| response.text())
            .map_err(|error| error.to_string())?;

        serde_json::from_str::<Value>(&payload).map_err(|error| error.to_string())
    }

    fn resolve_to_light_ids(
        client: &Client,
        bridge_ip: &str,
        username: &str,
        seed_rtype: &str,
        seed_rid: &str,
    ) -> Vec<String> {
        let mut resolved = Vec::new();

        if seed_rtype == "light" {
            resolved.push(seed_rid.to_string());
            return resolved;
        }

        let mut current_rtype = seed_rtype.to_string();
        let mut current_rid = seed_rid.to_string();
        for _ in 0..4 {
            let resource =
                match fetch_resource(client, bridge_ip, username, &current_rtype, &current_rid) {
                    Ok(value) => value,
                    Err(_) => return resolved,
                };

            let Some(item) = resource
                .get("data")
                .and_then(|value| value.as_array())
                .and_then(|items| items.first())
            else {
                return resolved;
            };

            if let Some(light_services) = item
                .get("light_services")
                .and_then(|value| value.as_array())
            {
                for light in light_services {
                    let rid = light.get("rid").and_then(|value| value.as_str());
                    let rtype = light.get("rtype").and_then(|value| value.as_str());
                    if matches!(rtype, Some("light")) {
                        if let Some(light_id) = rid {
                            push_unique(&mut resolved, light_id);
                        }
                    }
                }
                if !resolved.is_empty() {
                    return resolved;
                }
            }

            let Some(owner) = item.get("owner") else {
                return resolved;
            };
            let Some(next_rtype) = owner.get("rtype").and_then(|value| value.as_str()) else {
                return resolved;
            };
            let Some(next_rid) = owner.get("rid").and_then(|value| value.as_str()) else {
                return resolved;
            };

            if next_rtype == "light" {
                push_unique(&mut resolved, next_rid);
                return resolved;
            }

            current_rtype = next_rtype.to_string();
            current_rid = next_rid.to_string();
        }

        resolved
    }

    let mut light_ids: Vec<String> = Vec::new();

    if let Some(light_services) = parsed
        .get("data")
        .and_then(|value| value.as_array())
        .and_then(|items| items.first())
        .and_then(|item| item.get("light_services"))
        .and_then(|value| value.as_array())
    {
        for light in light_services {
            let rtype = light.get("rtype").and_then(|value| value.as_str());
            let rid = light.get("rid").and_then(|value| value.as_str());
            if matches!(rtype, Some("light")) {
                if let Some(light_id) = rid {
                    push_unique(&mut light_ids, light_id);
                }
            }
        }
    }

    for channel in channels {
        let Some(members) = channel.get("members").and_then(|value| value.as_array()) else {
            continue;
        };

        for member in members {
            let Some(service) = member.get("service") else {
                continue;
            };

            let Some(rtype) = service.get("rtype").and_then(|value| value.as_str()) else {
                continue;
            };
            let Some(rid) = service.get("rid").and_then(|value| value.as_str()) else {
                continue;
            };

            for light_id in resolve_to_light_ids(&client, bridge_ip, username, rtype, rid) {
                push_unique(&mut light_ids, &light_id);
            }
        }
    }

    Ok(light_ids)
}

fn rgb_to_xy(r: u8, g: u8, b: u8) -> (f64, f64) {
    let mut red = f64::from(r) / 255.0;
    let mut green = f64::from(g) / 255.0;
    let mut blue = f64::from(b) / 255.0;

    red = if red > 0.04045 {
        ((red + 0.055) / 1.055).powf(2.4)
    } else {
        red / 12.92
    };
    green = if green > 0.04045 {
        ((green + 0.055) / 1.055).powf(2.4)
    } else {
        green / 12.92
    };
    blue = if blue > 0.04045 {
        ((blue + 0.055) / 1.055).powf(2.4)
    } else {
        blue / 12.92
    };

    let x = red * 0.664_511 + green * 0.154_324 + blue * 0.162_028;
    let y = red * 0.283_881 + green * 0.668_433 + blue * 0.047_685;
    let z = red * 0.000_088 + green * 0.072_31 + blue * 0.986_039;
    let sum = x + y + z;

    if sum <= f64::EPSILON {
        return (0.3127, 0.3290);
    }

    (x / sum, y / sum)
}

fn apply_solid_color_to_hue_lights(
    bridge_ip: &str,
    username: &str,
    light_ids: &[String],
    r: u8,
    g: u8,
    b: u8,
    brightness: f32,
) -> Result<(), String> {
    let client = hue_http_client()?;
    let (x, y) = rgb_to_xy(r, g, b);
    let dimming = f64::from((brightness.clamp(0.0, 1.0) * 100.0) as f32);

    for light_id in light_ids {
        let endpoint = format!("https://{bridge_ip}/clip/v2/resource/light/{light_id}");
        let response_text = client
            .put(endpoint)
            .header("hue-application-key", username)
            .json(&json!({
                "on": { "on": true },
                "dimming": { "brightness": dimming },
                "color": { "xy": { "x": x, "y": y } }
            }))
            .send()
            .and_then(|response| response.error_for_status())
            .and_then(|response| response.text())
            .map_err(|error| error.to_string())?;

        let parsed =
            serde_json::from_str::<Value>(&response_text).map_err(|error| error.to_string())?;
        let has_errors = parsed
            .get("errors")
            .and_then(|value| value.as_array())
            .is_some_and(|errors| !errors.is_empty());
        if has_errors {
            return Err(format!("Hue light update returned errors: {response_text}"));
        }
    }

    Ok(())
}

pub fn snapshot_hue_output_context(
    runtime_state: &HueRuntimeStateStore,
) -> Result<Option<HueActiveOutputContext>, String> {
    let owner = runtime_state
        .runtime
        .lock()
        .map_err(|error| format!("HUE_RUNTIME_LOCK_FAILED: {error}"))?;

    Ok(owner
        .active_stream
        .as_ref()
        .map(|stream| HueActiveOutputContext {
            bridge_ip: stream.bridge_ip.clone(),
            username: stream.username.clone(),
            light_ids: stream.light_ids.clone(),
        }))
}

pub fn apply_hue_color_with_context(
    context: &HueActiveOutputContext,
    r: u8,
    g: u8,
    b: u8,
    brightness: f32,
) -> Result<(), String> {
    if context.light_ids.is_empty() {
        return Err("HUE_COLOR_APPLY_SKIPPED_NO_LIGHTS".to_string());
    }

    apply_solid_color_to_hue_lights(
        &context.bridge_ip,
        &context.username,
        &context.light_ids,
        r,
        g,
        b,
        brightness,
    )
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
    owner.active_stream = None;
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
        .clone()
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

    let result = start_with_evidence(&mut owner, &gate, trigger);
    let light_ids = if result.active {
        fetch_area_light_ids(&request.bridge_ip, &request.username, &request.area_id)
            .unwrap_or_default()
    } else {
        Vec::new()
    };
    let has_no_lights = result.active && light_ids.is_empty();
    store_active_stream_context(&mut owner, &request, light_ids, &result);

    if has_no_lights {
        owner.last_status = status_with(
            HueRuntimeState::Running,
            "HUE_STREAM_RUNNING_NO_LIGHTS",
            "Hue runtime started but no color-addressable lights were resolved for the selected area.",
            Some("Revalidate area members and restart Hue runtime.".to_string()),
            HueRuntimeTriggerSource::System,
        );
        owner.last_status.action_hint = Some(HueRuntimeActionHint::Revalidate);
        return Ok(make_result(&owner));
    }

    Ok(result)
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
pub fn restart_hue_stream(
    request: StartHueStreamRequest,
    runtime_state: State<'_, HueRuntimeStateStore>,
) -> Result<HueRuntimeCommandResult, String> {
    let mut owner = runtime_state
        .runtime
        .lock()
        .map_err(|error| format!("HUE_RUNTIME_LOCK_FAILED: {error}"))?;
    let trigger = request
        .trigger_source
        .clone()
        .unwrap_or(HueRuntimeTriggerSource::DeviceSurface);

    let _ = stop_with_timeout(&mut owner, false, trigger.clone());

    let readiness = check_hue_stream_readiness(
        request.bridge_ip.clone(),
        request.username.clone(),
        request.area_id.clone(),
    );

    let gate = HueRuntimeGateEvidence {
        bridge_configured: !request.bridge_ip.trim().is_empty(),
        credentials_valid: !request.username.trim().is_empty(),
        area_selected: !request.area_id.trim().is_empty(),
        readiness_current: readiness.status.code != "HUE_STREAM_READINESS_FAILED",
        ready: readiness.readiness.ready,
        auth_invalid_evidence: readiness.status.code.starts_with("AUTH_INVALID_")
            || readiness.status.code == "HUE_CREDENTIAL_INVALID",
    };

    let result = start_with_evidence(&mut owner, &gate, trigger);
    let light_ids = if result.active {
        fetch_area_light_ids(&request.bridge_ip, &request.username, &request.area_id)
            .unwrap_or_default()
    } else {
        Vec::new()
    };
    let has_no_lights = result.active && light_ids.is_empty();
    store_active_stream_context(&mut owner, &request, light_ids, &result);

    if has_no_lights {
        owner.last_status = status_with(
            HueRuntimeState::Running,
            "HUE_STREAM_RUNNING_NO_LIGHTS",
            "Hue runtime restarted but no color-addressable lights were resolved for the selected area.",
            Some("Revalidate area members and retry.".to_string()),
            HueRuntimeTriggerSource::System,
        );
        owner.last_status.action_hint = Some(HueRuntimeActionHint::Revalidate);
        return Ok(make_result(&owner));
    }

    Ok(result)
}

#[tauri::command]
pub fn set_hue_solid_color(
    request: SetHueSolidColorRequest,
    runtime_state: State<'_, HueRuntimeStateStore>,
) -> Result<HueRuntimeCommandResult, String> {
    let mut owner = runtime_state
        .runtime
        .lock()
        .map_err(|error| format!("HUE_RUNTIME_LOCK_FAILED: {error}"))?;

    let trigger = request
        .trigger_source
        .clone()
        .unwrap_or(HueRuntimeTriggerSource::ModeControl);

    let Some(active_stream) = owner.active_stream.clone() else {
        owner.last_status = status_with(
            HueRuntimeState::Idle,
            "HUE_COLOR_APPLY_SKIPPED",
            "Hue color apply skipped because stream context is not active.",
            Some("Start Hue runtime before sending color updates.".to_string()),
            trigger,
        );
        return Ok(make_result(&owner));
    };

    if active_stream.light_ids.is_empty() {
        owner.last_status = status_with(
            HueRuntimeState::Running,
            "HUE_COLOR_APPLY_SKIPPED_NO_LIGHTS",
            "Hue color apply skipped because no addressable lights were resolved for the selected area.",
            Some("Revalidate area and restart Hue runtime to refresh channel mapping.".to_string()),
            trigger,
        );
        owner.last_status.action_hint = Some(HueRuntimeActionHint::Revalidate);
        return Ok(make_result(&owner));
    }

    let brightness = request.brightness.unwrap_or(1.0).clamp(0.0, 1.0);
    match apply_solid_color_to_hue_lights(
        &active_stream.bridge_ip,
        &active_stream.username,
        &active_stream.light_ids,
        request.r,
        request.g,
        request.b,
        brightness,
    ) {
        Ok(_) => {
            owner.state = HueRuntimeState::Running;
            owner.last_status = status_with(
                HueRuntimeState::Running,
                "HUE_COLOR_APPLIED",
                "Hue solid color update applied.",
                None,
                trigger,
            );
            Ok(make_result(&owner))
        }
        Err(reason) => {
            let result = register_transient_fault(&mut owner, &reason, trigger);
            Ok(result)
        }
    }
}

#[tauri::command]
pub fn get_hue_stream_status(
    runtime_state: State<'_, HueRuntimeStateStore>,
) -> Result<HueRuntimeCommandResult, String> {
    let mut owner = runtime_state
        .runtime
        .lock()
        .map_err(|error| format!("HUE_RUNTIME_LOCK_FAILED: {error}"))?;

    if matches!(
        owner.state,
        HueRuntimeState::Starting | HueRuntimeState::Running | HueRuntimeState::Reconnecting
    ) {
        if let Some(active_stream) = owner.active_stream.clone() {
            let readiness = check_hue_stream_readiness(
                active_stream.bridge_ip,
                active_stream.username,
                active_stream.area_id,
            );
            let gate = HueRuntimeGateEvidence {
                bridge_configured: true,
                credentials_valid: true,
                area_selected: true,
                readiness_current: readiness.status.code != "HUE_STREAM_READINESS_FAILED",
                ready: readiness.readiness.ready,
                auth_invalid_evidence: readiness.status.code.starts_with("AUTH_INVALID_")
                    || readiness.status.code == "HUE_CREDENTIAL_INVALID",
            };
            let details = readiness
                .status
                .details
                .clone()
                .or_else(|| Some(readiness.status.message.clone()));
            return Ok(status_refresh_with_evidence(&mut owner, &gate, details));
        }
    }

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
    fn start_success_persists_active_stream_context_for_status_refresh() {
        let mut owner = HueRuntimeOwner::default();
        let request = StartHueStreamRequest {
            bridge_ip: "192.168.1.2".to_string(),
            username: "hue-user".to_string(),
            area_id: "living-room".to_string(),
            trigger_source: Some(HueRuntimeTriggerSource::ModeControl),
        };

        let start_result = start_with_evidence(
            &mut owner,
            &strict_gate_ready(),
            HueRuntimeTriggerSource::ModeControl,
        );
        store_active_stream_context(
            &mut owner,
            &request,
            vec!["light-1".to_string()],
            &start_result,
        );

        let active_stream = owner.active_stream.as_ref().expect("active stream context");
        assert_eq!(active_stream.bridge_ip, "192.168.1.2");
        assert_eq!(active_stream.username, "hue-user");
        assert_eq!(active_stream.area_id, "living-room");
        assert_eq!(active_stream.light_ids, vec!["light-1".to_string()]);
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
        owner.active_stream = Some(HueActiveStreamContext {
            bridge_ip: "192.168.1.2".to_string(),
            username: "username".to_string(),
            area_id: "area".to_string(),
            light_ids: vec!["light-1".to_string()],
        });
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
