//! The channel map's light names and its Identify blink. Names come from one
//! bulk `GET /clip/v2/resource/light`; Identify is the CLIP v2 `identify`
//! action, which the API defines on the light's owning `device`. Both are
//! kept off a running stream. See docs/architecture/hue.md ("Light names and
//! Identify").

use std::collections::HashMap;
use std::sync::OnceLock;
use std::time::Instant;

use log::{info, warn};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::State;

use super::super::hue_http::{classify_hue_response, HueHttpFault};
use super::super::status::CommandStatus;
use super::credential_store::effective_hue_app_key;
use super::sender::{RequestPacer, HUE_HTTP_FALLBACK_MAX_REQUESTS_PER_SEC};
use super::state_store::{acquire_hue_runtime, HueRuntimeState, HueRuntimeStateStore};
use super::transport::{async_client_for_key, is_valid_bridge_addr, read_body, send_error_text};

/// More ids than any entertainment area holds; a longer list is refused
/// rather than walked, so the webview cannot queue minutes of bridge writes.
pub(crate) const HUE_LIGHT_REQUEST_MAX_IDS: usize = 64;

/// One light as the Hue app names it.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HueLightName {
    pub id: String,
    pub name: String,
}

/// Result of `get_hue_light_names`. `lights` is empty on every failure arm.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HueLightNamesResponse {
    pub status: CommandStatus,
    pub lights: Vec<HueLightName>,
}

/// Sole constructor for the names status, so the contract verifier can
/// harvest its codes from one call shape.
fn light_names_status(code: &str, message: &str, details: Option<String>) -> CommandStatus {
    CommandStatus {
        code: code.to_string(),
        message: message.to_string(),
        details,
    }
}

/// Sole constructor for the identify status.
fn identify_status(code: &str, message: &str, details: Option<String>) -> CommandStatus {
    CommandStatus {
        code: code.to_string(),
        message: message.to_string(),
        details,
    }
}

fn is_safe_resource_id(id: &str) -> bool {
    !id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

/// Why the bulk read gave nothing back.
#[derive(Debug)]
pub(crate) enum LightsReadError {
    AuthInvalid,
    Other(String),
}

/// Every light on the bridge in one request — no light budget spent.
pub(crate) async fn read_bridge_lights(
    bridge_ip: &str,
    username: &str,
) -> Result<Vec<Value>, LightsReadError> {
    let client = async_client_for_key(username).map_err(LightsReadError::Other)?;
    let response = client
        .get(format!("https://{bridge_ip}/clip/v2/resource/light"))
        .header("hue-application-key", username)
        .send()
        .await
        .map_err(|error| LightsReadError::Other(send_error_text(&error)))?;
    let response = classify_hue_response(response)
        .await
        .map_err(|fault| match fault {
            HueHttpFault::AuthInvalid => LightsReadError::AuthInvalid,
            other => LightsReadError::Other(other.to_string()),
        })?;
    let body = read_body(response).await.map_err(LightsReadError::Other)?;
    let parsed: Value =
        serde_json::from_str(&body).map_err(|error| LightsReadError::Other(error.to_string()))?;
    parsed
        .get("data")
        .and_then(Value::as_array)
        .cloned()
        .ok_or_else(|| LightsReadError::Other("light list carried no data array".to_string()))
}

fn light_id(item: &Value) -> Option<&str> {
    item.get("id").and_then(Value::as_str)
}

/// The names of `wanted`, in the order asked for. A light the bridge does not
/// list, or lists without a name, is left out rather than named by its id.
pub(crate) fn names_for(lights: &[Value], wanted: &[String]) -> Vec<HueLightName> {
    let by_id: HashMap<&str, &Value> = lights
        .iter()
        .filter_map(|item| Some((light_id(item)?, item)))
        .collect();
    let mut out: Vec<HueLightName> = Vec::new();
    for id in wanted {
        if out.iter().any(|named| &named.id == id) {
            continue;
        }
        let name = by_id
            .get(id.as_str())
            .and_then(|item| item.pointer("/metadata/name"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|name| !name.is_empty());
        if let Some(name) = name {
            out.push(HueLightName {
                id: id.clone(),
                name: name.to_string(),
            });
        }
    }
    out
}

/// The owning devices of `wanted`, deduplicated in the order asked for.
pub(crate) fn owner_devices(lights: &[Value], wanted: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for item in lights {
        let Some(id) = light_id(item) else { continue };
        if !wanted.iter().any(|w| w == id) {
            continue;
        }
        let owner = item
            .get("owner")
            .filter(|owner| owner.get("rtype").and_then(Value::as_str) == Some("device"))
            .and_then(|owner| owner.get("rid"))
            .and_then(Value::as_str)
            .filter(|rid| is_safe_resource_id(rid));
        if let Some(owner) = owner {
            if !out.iter().any(|known| known == owner) {
                out.push(owner.to_string());
            }
        }
    }
    // The bridge's own order is arbitrary; blink in the order the row lists.
    out.sort_by_key(|device| {
        lights
            .iter()
            .find(|item| {
                item.pointer("/owner/rid").and_then(Value::as_str) == Some(device.as_str())
            })
            .and_then(light_id)
            .and_then(|id| wanted.iter().position(|w| w == id))
            .unwrap_or(usize::MAX)
    });
    out
}

fn checked_ids(light_ids: Vec<String>) -> Result<Vec<String>, String> {
    if light_ids.len() > HUE_LIGHT_REQUEST_MAX_IDS {
        return Err(format!(
            "{} light ids asked for; at most {HUE_LIGHT_REQUEST_MAX_IDS} are served.",
            light_ids.len()
        ));
    }
    if let Some(bad) = light_ids.iter().find(|id| !is_safe_resource_id(id)) {
        return Err(format!("`{bad}` is not a CLIP v2 resource id."));
    }
    Ok(light_ids)
}

/// The names body, bridge address already checked.
pub(crate) async fn light_names_from_bridge(
    bridge_ip: &str,
    username: &str,
    light_ids: Vec<String>,
) -> HueLightNamesResponse {
    let failed = |status: CommandStatus| HueLightNamesResponse {
        status,
        lights: Vec::new(),
    };
    let light_ids = match checked_ids(light_ids) {
        Ok(ids) => ids,
        Err(reason) => {
            return failed(light_names_status(
                "HUE_LIGHT_NAMES_FAILED",
                "Could not read the Hue light names.",
                Some(reason),
            ))
        }
    };
    if username.is_empty() {
        return failed(light_names_status(
            "AUTH_INVALID_RE_PAIR_REQUIRED",
            "No Hue application key is stored. Re-pair the bridge to continue.",
            Some("No key in the keychain or the request; the bridge was not asked.".to_string()),
        ));
    }
    match read_bridge_lights(bridge_ip, username).await {
        Ok(lights) => HueLightNamesResponse {
            status: light_names_status("HUE_LIGHT_NAMES_OK", "Hue light names loaded.", None),
            lights: names_for(&lights, &light_ids),
        },
        Err(LightsReadError::AuthInvalid) => failed(light_names_status(
            "AUTH_INVALID_RE_PAIR_REQUIRED",
            "Hue bridge rejected our credentials. Re-pair the bridge to continue.",
            None,
        )),
        Err(LightsReadError::Other(reason)) => {
            warn!("[hue-lights] light names not read: {reason}");
            failed(light_names_status(
                "HUE_LIGHT_NAMES_FAILED",
                "Could not read the Hue light names.",
                Some(reason),
            ))
        }
    }
}

/// Names for the lights in `light_ids`, from one read of the bridge's lights.
/// The caller caches the answer; nothing here polls.
#[tauri::command]
pub async fn get_hue_light_names(
    bridge_ip: String,
    username: String,
    light_ids: Vec<String>,
) -> Result<HueLightNamesResponse, String> {
    if !is_valid_bridge_addr(&bridge_ip) {
        return Ok(HueLightNamesResponse {
            status: light_names_status(
                "HUE_LIGHT_NAMES_FAILED",
                "Could not read the Hue light names.",
                Some(format!(
                    "`{bridge_ip}` is not a local-network bridge address."
                )),
            ),
            lights: Vec::new(),
        });
    }
    let username = effective_hue_app_key(&username);
    Ok(light_names_from_bridge(&bridge_ip, &username, light_ids).await)
}

// ---------------------------------------------------------------------------
// Identify
// ---------------------------------------------------------------------------

/// Identify writes share one pacer at the light budget, across every press.
fn identify_pacer() -> &'static tokio::sync::Mutex<RequestPacer> {
    static PACER: OnceLock<tokio::sync::Mutex<RequestPacer>> = OnceLock::new();
    PACER.get_or_init(|| {
        tokio::sync::Mutex::new(RequestPacer::new(HUE_HTTP_FALLBACK_MAX_REQUESTS_PER_SEC))
    })
}

/// A stream (or one coming up) owns the lights; a blink under it is either
/// lost or fights the frames.
fn lights_are_streamed(store: &HueRuntimeStateStore) -> bool {
    let owner = acquire_hue_runtime(&store.runtime);
    matches!(
        owner.state,
        HueRuntimeState::Starting | HueRuntimeState::Running | HueRuntimeState::Reconnecting
    ) || owner.active_stream.is_some()
}

enum IdentifyPut {
    Ok,
    Throttled(Option<u64>),
    AuthInvalid,
    Failed(String),
}

async fn put_identify(
    client: &reqwest::Client,
    bridge_ip: &str,
    username: &str,
    device_id: &str,
) -> IdentifyPut {
    let response = match client
        .put(format!(
            "https://{bridge_ip}/clip/v2/resource/device/{device_id}"
        ))
        .header("hue-application-key", username)
        .json(&json!({ "identify": { "action": "identify" } }))
        .send()
        .await
    {
        Ok(response) => response,
        Err(error) => return IdentifyPut::Failed(send_error_text(&error)),
    };
    let response = match classify_hue_response(response).await {
        Ok(response) => response,
        Err(HueHttpFault::AuthInvalid) => return IdentifyPut::AuthInvalid,
        Err(HueHttpFault::RateLimited { retry_after_ms, .. }) => {
            return IdentifyPut::Throttled(retry_after_ms)
        }
        Err(fault) => return IdentifyPut::Failed(fault.to_string()),
    };
    // A 2xx can still carry a refusal in `errors[]`.
    let body = read_body(response).await.unwrap_or_default();
    let refused = serde_json::from_str::<Value>(&body)
        .ok()
        .and_then(|value| value.get("errors").and_then(Value::as_array).cloned())
        .filter(|errors| !errors.is_empty());
    match refused {
        Some(errors) => IdentifyPut::Failed(Value::Array(errors).to_string()),
        None => IdentifyPut::Ok,
    }
}

/// The identify body, bridge address already checked.
pub(crate) async fn identify_lights_on_bridge(
    bridge_ip: &str,
    username: &str,
    light_ids: Vec<String>,
    runtime: &HueRuntimeStateStore,
) -> CommandStatus {
    let blocked = || {
        identify_status(
            "HUE_IDENTIFY_BLOCKED_STREAMING",
            "Hue is streaming to these lights; stop it to identify one.",
            None,
        )
    };
    if lights_are_streamed(runtime) {
        return blocked();
    }
    let light_ids = match checked_ids(light_ids) {
        Ok(ids) if !ids.is_empty() => ids,
        Ok(_) => {
            return identify_status(
                "HUE_IDENTIFY_FAILED",
                "No Hue light was identified.",
                Some("No light ids were given.".to_string()),
            )
        }
        Err(reason) => {
            return identify_status(
                "HUE_IDENTIFY_FAILED",
                "No Hue light was identified.",
                Some(reason),
            )
        }
    };
    if username.is_empty() {
        return identify_status(
            "AUTH_INVALID_RE_PAIR_REQUIRED",
            "No Hue application key is stored. Re-pair the bridge to continue.",
            Some("No key in the keychain or the request; the bridge was not asked.".to_string()),
        );
    }
    let lights = match read_bridge_lights(bridge_ip, username).await {
        Ok(lights) => lights,
        Err(LightsReadError::AuthInvalid) => {
            return identify_status(
                "AUTH_INVALID_RE_PAIR_REQUIRED",
                "Hue bridge rejected our credentials. Re-pair the bridge to continue.",
                None,
            )
        }
        Err(LightsReadError::Other(reason)) => {
            return identify_status(
                "HUE_IDENTIFY_FAILED",
                "No Hue light was identified.",
                Some(reason),
            )
        }
    };
    let devices = owner_devices(&lights, &light_ids);
    if devices.is_empty() {
        return identify_status(
            "HUE_IDENTIFY_FAILED",
            "No Hue light was identified.",
            Some("The bridge lists none of these lights.".to_string()),
        );
    }
    let client = match async_client_for_key(username) {
        Ok(client) => client,
        Err(reason) => {
            return identify_status(
                "HUE_IDENTIFY_FAILED",
                "No Hue light was identified.",
                Some(reason),
            )
        }
    };

    let mut pacer = identify_pacer().lock().await;
    let mut identified = 0_usize;
    let mut failures: Vec<String> = Vec::new();
    for device in &devices {
        let mut throttled_once = false;
        loop {
            let wait = pacer.time_until_slot(Instant::now());
            if !wait.is_zero() {
                tokio::time::sleep(wait).await;
            }
            // A start that began while we waited owns the lights now.
            if lights_are_streamed(runtime) {
                return blocked();
            }
            pacer.consume(Instant::now());
            match put_identify(&client, bridge_ip, username, device).await {
                IdentifyPut::Ok => {
                    pacer.on_success();
                    identified += 1;
                }
                IdentifyPut::Throttled(retry_after_ms) if !throttled_once => {
                    pacer.on_throttle(retry_after_ms);
                    throttled_once = true;
                    continue;
                }
                IdentifyPut::Throttled(_) => failures.push(format!("{device}: throttled")),
                IdentifyPut::AuthInvalid => {
                    return identify_status(
                        "AUTH_INVALID_RE_PAIR_REQUIRED",
                        "Hue bridge rejected our credentials. Re-pair the bridge to continue.",
                        None,
                    )
                }
                IdentifyPut::Failed(reason) => failures.push(format!("{device}: {reason}")),
            }
            break;
        }
    }
    drop(pacer);

    info!(
        "[hue-lights] identify: {identified}/{} device(s) blinked",
        devices.len()
    );
    if failures.is_empty() {
        identify_status("HUE_IDENTIFY_OK", "The light blinks once.", None)
    } else if identified > 0 {
        identify_status(
            "HUE_IDENTIFY_PARTIAL",
            "Some of the lights did not blink.",
            Some(failures.join("; ")),
        )
    } else {
        identify_status(
            "HUE_IDENTIFY_FAILED",
            "No Hue light was identified.",
            Some(failures.join("; ")),
        )
    }
}

/// Blink the lights in `light_ids` once, through their owning devices.
/// Refused while a stream owns them.
#[tauri::command]
pub async fn identify_hue_lights(
    bridge_ip: String,
    username: String,
    light_ids: Vec<String>,
    runtime_state: State<'_, HueRuntimeStateStore>,
) -> Result<CommandStatus, String> {
    if !is_valid_bridge_addr(&bridge_ip) {
        return Ok(identify_status(
            "HUE_IDENTIFY_FAILED",
            "No Hue light was identified.",
            Some(format!(
                "`{bridge_ip}` is not a local-network bridge address."
            )),
        ));
    }
    let username = effective_hue_app_key(&username);
    Ok(identify_lights_on_bridge(&bridge_ip, &username, light_ids, runtime_state.inner()).await)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::super::state_store::acquire_hue_runtime;
    use super::super::test_bridge::{light_json, FakeHue, Reply};
    use super::*;

    const AREA: &str = "area-1";

    fn named(name: &str) -> Value {
        let mut light = light_json(true, 50.0, Some(366), (0.45, 0.41));
        light["metadata"]["name"] = json!(name);
        light
    }

    fn ids(list: &[&str]) -> Vec<String> {
        list.iter().map(|id| id.to_string()).collect()
    }

    fn bridge() -> FakeHue {
        FakeHue::start(
            &[(AREA, &["light-1", "light-2", "light-3"])],
            &[
                ("light-1", named("Sofa lamp")),
                ("light-2", named("  TV left ")),
                ("light-3", light_json(true, 50.0, None, (0.3, 0.3))),
            ],
            |_| Reply::ok(),
        )
    }

    #[tokio::test]
    async fn names_come_from_one_read_of_every_light() {
        let hue = bridge();
        let response = light_names_from_bridge(
            &hue.bridge.authority,
            "app-key",
            ids(&["light-2", "light-1", "light-3", "gone"]),
        )
        .await;

        assert_eq!(response.status.code, "HUE_LIGHT_NAMES_OK");
        assert_eq!(
            response.lights,
            vec![
                HueLightName {
                    id: "light-2".into(),
                    name: "TV left".into()
                },
                HueLightName {
                    id: "light-1".into(),
                    name: "Sofa lamp".into()
                },
            ],
            "asked-for order, trimmed, unnamed and unknown lights left out"
        );
        let requests = hue.bridge.requests();
        assert_eq!(requests.len(), 1, "one request for the whole area");
        assert_eq!(requests[0].method, "GET");
        assert_eq!(requests[0].path, "/clip/v2/resource/light");
    }

    #[tokio::test]
    async fn a_bad_id_or_a_missing_key_asks_the_bridge_nothing() {
        let hue = bridge();

        let bad = light_names_from_bridge(&hue.bridge.authority, "app-key", ids(&["../x"])).await;
        assert_eq!(bad.status.code, "HUE_LIGHT_NAMES_FAILED");
        let no_key = light_names_from_bridge(&hue.bridge.authority, "", ids(&["light-1"])).await;
        assert_eq!(no_key.status.code, "AUTH_INVALID_RE_PAIR_REQUIRED");
        assert!(hue.bridge.requests().is_empty());
    }

    #[tokio::test]
    async fn identify_blinks_each_owning_device_once_paced_to_the_light_budget() {
        let hue = bridge();
        let runtime = HueRuntimeStateStore::default();

        let status = identify_lights_on_bridge(
            &hue.bridge.authority,
            "app-key",
            ids(&["light-1", "light-2"]),
            &runtime,
        )
        .await;

        assert_eq!(status.code, "HUE_IDENTIFY_OK");
        let puts = hue.bridge.puts_to("/clip/v2/resource/device/");
        assert_eq!(
            puts.iter().map(|r| r.path.as_str()).collect::<Vec<_>>(),
            vec![
                "/clip/v2/resource/device/dev-light-1",
                "/clip/v2/resource/device/dev-light-2"
            ]
        );
        for put in &puts {
            assert_eq!(put.json(), json!({ "identify": { "action": "identify" } }));
        }
        assert!(
            hue.bridge.puts_to("/clip/v2/resource/light/").is_empty(),
            "identify never writes a light's state"
        );
        let gap = puts[1].at.duration_since(puts[0].at);
        let floor = std::time::Duration::from_millis(
            1_000 / u64::from(HUE_HTTP_FALLBACK_MAX_REQUESTS_PER_SEC),
        );
        assert!(
            gap + std::time::Duration::from_millis(5) >= floor,
            "two identifies {gap:?} apart; the light budget allows one per {floor:?}"
        );
    }

    #[tokio::test]
    async fn identify_is_refused_while_a_stream_owns_the_lights() {
        let hue = bridge();
        let runtime = HueRuntimeStateStore::default();
        acquire_hue_runtime(&runtime.runtime).state = HueRuntimeState::Running;

        let status = identify_lights_on_bridge(
            &hue.bridge.authority,
            "app-key",
            ids(&["light-1"]),
            &runtime,
        )
        .await;

        assert_eq!(status.code, "HUE_IDENTIFY_BLOCKED_STREAMING");
        assert!(hue.bridge.requests().is_empty(), "the bridge was not asked");
    }

    #[tokio::test]
    async fn a_device_the_bridge_refuses_makes_the_blink_partial() {
        let hue = bridge();
        hue.remove_device("dev-light-2");
        let runtime = HueRuntimeStateStore::default();

        let status = identify_lights_on_bridge(
            &hue.bridge.authority,
            "app-key",
            ids(&["light-1", "light-2"]),
            &runtime,
        )
        .await;

        assert_eq!(status.code, "HUE_IDENTIFY_PARTIAL");
        assert!(status.details.unwrap_or_default().contains("dev-light-2"));
    }
}
