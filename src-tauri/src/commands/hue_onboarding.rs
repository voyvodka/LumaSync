use std::{net::Ipv4Addr, str::FromStr, time::Duration};

use log::{error, info, warn};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::hue_http::{classify_hue_response, HueHttpFault};

#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CommandStatus {
    pub code: String,
    pub message: String,
    pub details: Option<String>,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct HueBridgeSummary {
    pub id: String,
    pub ip: String,
    pub name: String,
    pub model_id: Option<String>,
    pub software_version: Option<String>,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct HueDiscoveryResponse {
    pub status: CommandStatus,
    pub bridges: Vec<HueBridgeSummary>,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct HueVerifyBridgeIpResponse {
    pub status: CommandStatus,
    pub bridge: Option<HueBridgeSummary>,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct HuePairingCredentials {
    pub username: String,
    pub client_key: String,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct HuePairBridgeResponse {
    pub status: CommandStatus,
    pub credentials: Option<HuePairingCredentials>,
    /// v1.5 W2-A2 — backend used to persist the new credentials.
    /// Absent on legacy paths (rate-limited, bridge-busy, link-button-not-pressed).
    /// `"keychain"` ⇒ frontend SHOULD clear the legacy plaintext shellStore fields.
    /// `"plaintext-legacy"` ⇒ keychain unavailable, frontend keeps plaintext fallback.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub credential_storage_backend: Option<String>,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct HueValidateCredentialsResponse {
    pub status: CommandStatus,
    pub valid: bool,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct HueEntertainmentArea {
    pub id: String,
    pub name: String,
    pub room_name: Option<String>,
    /// Bridge room archetype (CLIP v2). Whitelist-mirrored by the frontend
    /// contract `HUE_ROOM_ARCHETYPES`; unknown values are remapped to
    /// `"other"` on the Rust side so the UI never sees a raw identifier
    /// the whitelist does not cover.
    pub archetype: Option<String>,
    pub channel_count: usize,
    pub active_streamer: bool,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct HueEntertainmentAreaListResponse {
    pub status: CommandStatus,
    pub areas: Vec<HueEntertainmentArea>,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct HueStreamReadiness {
    pub ready: bool,
    pub reasons: Vec<String>,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct HueStreamReadinessResponse {
    pub status: CommandStatus,
    pub readiness: HueStreamReadiness,
}

#[derive(Deserialize)]
struct DiscoveryBridge {
    id: String,
    #[serde(rename = "internalipaddress")]
    internal_ip_address: String,
}

#[tauri::command]
pub async fn discover_hue_bridges() -> HueDiscoveryResponse {
    // v1.5 W2-A3 — run cloud and mDNS discovery in parallel.
    //
    // Cloud (`https://discovery.meethue.com/`) returns the bridges
    // Signify recorded against the calling NAT IP — works for users on
    // a normal home network.
    //
    // mDNS (`_hue._tcp.local.`) catches LAN-segmented bridges (VLANs,
    // captive portals, devices on guest Wi-Fi) the cloud cannot see.
    // The two snapshots are deduped by uppercase bridge id; cloud
    // wins on conflicts because it carries the canonical id format.
    let cloud_future = run_cloud_discovery();
    let mdns_future = run_mdns_discovery();

    let (cloud_result, mdns_bridges) = tokio::join!(cloud_future, mdns_future);

    merge_discovery_sources(cloud_result, mdns_bridges)
}

/// Run the legacy cloud discovery (`https://discovery.meethue.com/`).
/// Returned `Result` mirrors the previous `outcome` variable so the
/// merge step can preserve the cloud-only status code on the empty path.
async fn run_cloud_discovery() -> Result<HueDiscoveryResponse, String> {
    let client = hue_http_client().map_err(|e| format!("CLIENT_INIT: {e}"))?;
    let response = client
        .get("https://discovery.meethue.com/")
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let ok_response = classify_hue_response(response)
        .await
        .map_err(|fault| fault.to_string())?;
    let payload = ok_response.text().await.map_err(|e| e.to_string())?;
    Ok(parse_discovery_payload(&payload))
}

/// Drive the shared mDNS browser for ~2 s and project the resolved
/// bridges onto `HueBridgeSummary` so they slot into the same response.
/// Errors degrade silently — the cloud path is always the primary
/// source of truth.
async fn run_mdns_discovery() -> Vec<HueBridgeSummary> {
    use std::time::Duration;
    // Run the blocking mDNS snapshot on a worker so it doesn't stall
    // the cloud HTTP request when the deadline is short.
    let bridges = tokio::task::spawn_blocking(|| {
        crate::network::mdns::browse_hue_bridges(Duration::from_millis(2_000))
    })
    .await;

    match bridges {
        Ok(Ok(candidates)) => candidates
            .into_iter()
            .map(|c| HueBridgeSummary {
                name: if c.name.is_empty() {
                    format!("Hue Bridge ({})", c.ip)
                } else {
                    c.name
                },
                id: c.id,
                ip: c.ip,
                model_id: None,
                software_version: None,
            })
            .collect(),
        Ok(Err(err)) => {
            warn!("[hue-discovery] mDNS browse failed: {err}");
            Vec::new()
        }
        Err(join_err) => {
            warn!("[hue-discovery] mDNS task join failed: {join_err}");
            Vec::new()
        }
    }
}

/// Merge cloud + mDNS results into a single response, deduplicated by
/// uppercase bridge id. Status-code precedence:
///
/// 1. If cloud succeeded with bridges → `HUE_DISCOVERY_OK` (mDNS hits
///    are merged in, deduped by id).
/// 2. If cloud was empty but mDNS found bridges → `HUE_DISCOVERY_OK`
///    (LAN-only success path, e.g. user on VLAN with no internet).
/// 3. If both empty → `HUE_DISCOVERY_EMPTY`.
/// 4. If cloud failed AND mDNS empty → `HUE_DISCOVERY_FAILED` (preserves
///    legacy v1.4 behaviour).
fn merge_discovery_sources(
    cloud: Result<HueDiscoveryResponse, String>,
    mdns_bridges: Vec<HueBridgeSummary>,
) -> HueDiscoveryResponse {
    let (mut bridges, cloud_status_code, cloud_error) = match cloud {
        Ok(resp) => (resp.bridges, resp.status.code, None),
        Err(err) => (Vec::new(), "HUE_DISCOVERY_FAILED".to_string(), Some(err)),
    };

    // Merge mDNS bridges, skipping ids that the cloud already returned
    // (cloud keeps the canonical id format and the friendlier name).
    for candidate in mdns_bridges {
        if !bridges
            .iter()
            .any(|b| b.id.eq_ignore_ascii_case(&candidate.id))
        {
            bridges.push(candidate);
        }
    }

    // Stable order so re-issuing discovery returns the same shape.
    bridges.sort_by(|a, b| a.id.cmp(&b.id));

    if !bridges.is_empty() {
        return HueDiscoveryResponse {
            status: command_status(
                "HUE_DISCOVERY_OK",
                "Hue bridges discovered successfully.",
                None,
            ),
            bridges,
        };
    }

    // No bridges from either source.
    if cloud_status_code == "HUE_DISCOVERY_FAILED" {
        HueDiscoveryResponse {
            status: command_status(
                "HUE_DISCOVERY_FAILED",
                "Could not discover Hue bridges automatically. You can continue with manual IP.",
                cloud_error,
            ),
            bridges: Vec::new(),
        }
    } else {
        HueDiscoveryResponse {
            status: command_status(
                "HUE_DISCOVERY_EMPTY",
                "No Hue bridges discovered automatically. You can continue with manual IP.",
                None,
            ),
            bridges: Vec::new(),
        }
    }
}

#[tauri::command]
pub async fn verify_hue_bridge_ip(bridge_ip: String) -> HueVerifyBridgeIpResponse {
    let invalid = verify_hue_bridge_ip_input(&bridge_ip);
    if invalid.status.code == "HUE_IP_INVALID" {
        return invalid;
    }

    let client = match hue_http_client() {
        Ok(client) => client,
        Err(error) => {
            return HueVerifyBridgeIpResponse {
                status: command_status(
                    "HUE_IP_UNREACHABLE",
                    "Could not initialize bridge verification client.",
                    Some(error),
                ),
                bridge: None,
            }
        }
    };

    let endpoint = format!("http://{bridge_ip}/api/config");
    let outcome = match client.get(endpoint).send().await {
        Ok(response) => match classify_hue_response(response).await {
            Ok(ok) => ok.text().await.map_err(|e| e.to_string()),
            Err(fault) => Err(fault.to_string()),
        },
        Err(error) => Err(error.to_string()),
    };
    match outcome {
        Ok(payload) => parse_bridge_config_payload(&bridge_ip, &payload),
        Err(error) => HueVerifyBridgeIpResponse {
            status: command_status(
                "HUE_IP_UNREACHABLE",
                "Could not reach Hue bridge at the provided IP. Verify bridge power/network and try again.",
                Some(error),
            ),
            bridge: None,
        },
    }
}

#[tauri::command]
pub async fn pair_hue_bridge(bridge_ip: String) -> HuePairBridgeResponse {
    let ip_check = verify_hue_bridge_ip_input(&bridge_ip);
    if ip_check.status.code == "HUE_IP_INVALID" {
        return HuePairBridgeResponse {
            status: ip_check.status,
            credentials: None,
            credential_storage_backend: None,
        };
    }

    let client = match hue_http_client() {
        Ok(client) => client,
        Err(error) => {
            warn!("Hue pairing client init failed: {error}");
            return HuePairBridgeResponse {
                status: command_status(
                    "HUE_PAIRING_FAILED",
                    "Could not initialize Hue pairing client.",
                    Some(error),
                ),
                credentials: None,
                credential_storage_backend: None,
            };
        }
    };

    let endpoint = format!("http://{bridge_ip}/api");
    let body = json!({
        "devicetype": "lumasync#desktop",
        "generateclientkey": true,
    });
    let outcome: Result<String, PairingTransportError> =
        match client.post(endpoint).json(&body).send().await {
            Ok(response) => match classify_hue_response(response).await {
                Ok(ok) => ok
                    .text()
                    .await
                    .map_err(|e| PairingTransportError::Generic(e.to_string())),
                Err(fault) => Err(PairingTransportError::from_fault(fault)),
            },
            Err(error) => Err(PairingTransportError::Generic(error.to_string())),
        };
    match outcome {
        Ok(payload) => {
            let mut result = parse_pairing_payload(&payload);
            match result.status.code.as_str() {
                "HUE_PAIRING_OK" => info!("Hue bridge pairing succeeded at {bridge_ip}"),
                "HUE_PAIRING_LINK_BUTTON_NOT_PRESSED" => {
                    info!("Hue pairing waiting for link button at {bridge_ip}")
                }
                code => warn!("Hue bridge pairing failed at {bridge_ip} ({code})"),
            }
            // v1.5 W2-A2 — opportunistically migrate the fresh credentials
            // into the OS keychain. If the keychain is unavailable we keep
            // the plaintext fallback path; the frontend uses the
            // `credentialStorageBackend` field on the response to decide
            // whether it can safely clear `shellStore.hueAppKey` /
            // `shellStore.hueClientKey` after a successful pairing.
            if let Some(creds) = result.credentials.as_ref() {
                let store = super::hue::credential_store::default_store();
                let outcome = super::hue::credential_store::migrate_hue_credentials_to_keychain(
                    store.as_ref(),
                    &creds.username,
                    &creds.client_key,
                );
                info!(
                    "[hue-cred] pairing migration {}: backend={}",
                    outcome.status_code(),
                    outcome.backend().as_str()
                );
                result.credential_storage_backend = Some(outcome.backend().as_str().to_string());
            }
            result
        }
        Err(PairingTransportError::RateLimited) => {
            warn!("Hue bridge pairing rate-limited at {bridge_ip}");
            HuePairBridgeResponse {
                status: command_status(
                    "HUE_PAIRING_RATE_LIMITED",
                    "Bridge throttled pairing attempts. Wait a minute before retrying.",
                    None,
                ),
                credentials: None,
                credential_storage_backend: None,
            }
        }
        Err(PairingTransportError::BridgeBusy { detail }) => {
            warn!("Hue bridge pairing reported bridge busy at {bridge_ip}: {detail}");
            HuePairBridgeResponse {
                status: command_status(
                    "HUE_PAIRING_BRIDGE_BUSY",
                    "Bridge is busy pairing another client. Try again in a moment.",
                    Some(detail),
                ),
                credentials: None,
                credential_storage_backend: None,
            }
        }
        Err(PairingTransportError::Generic(error)) => {
            warn!("Hue bridge pairing failed at {bridge_ip}");
            HuePairBridgeResponse {
                status: command_status(
                    "HUE_PAIRING_FAILED",
                    "Pairing request failed. Press bridge link button, then retry within 30 seconds.",
                    Some(error),
                ),
                credentials: None,
                credential_storage_backend: None,
            }
        }
    }
}

/// Transport-level pairing faults surfaced BEFORE a body parse is possible.
///
/// `parse_pairing_payload` owns the CLIP-body mapping (error.type → status
/// code). This enum only covers the outer HTTP / transport layer so we can
/// split `429 Too Many Requests` and `5xx` into dedicated codes without
/// polluting the payload parser.
enum PairingTransportError {
    RateLimited,
    BridgeBusy { detail: String },
    Generic(String),
}

impl PairingTransportError {
    fn from_fault(fault: HueHttpFault) -> Self {
        match fault {
            HueHttpFault::Transient { status: 429, .. } => Self::RateLimited,
            HueHttpFault::Transient { status, body } if (500..=599).contains(&status) => {
                Self::BridgeBusy {
                    detail: format!("HTTP {status} — {body}"),
                }
            }
            HueHttpFault::ServerError { status } => Self::BridgeBusy {
                detail: format!("HTTP {status}"),
            },
            other => Self::Generic(other.to_string()),
        }
    }
}

#[tauri::command]
pub async fn validate_hue_credentials(
    bridge_ip: String,
    username: String,
    _client_key: Option<String>,
) -> HueValidateCredentialsResponse {
    let ip_check = verify_hue_bridge_ip_input(&bridge_ip);
    if ip_check.status.code == "HUE_IP_INVALID" {
        return HueValidateCredentialsResponse {
            status: ip_check.status,
            valid: false,
        };
    }

    let client = match hue_http_client() {
        Ok(client) => client,
        Err(error) => {
            return HueValidateCredentialsResponse {
                status: command_status(
                    "HUE_CREDENTIAL_CHECK_FAILED",
                    "Could not initialize Hue credential validation client.",
                    Some(error),
                ),
                valid: false,
            }
        }
    };

    let endpoint = format!("http://{bridge_ip}/api/{username}/config");
    let outcome = match client.get(endpoint).send().await {
        Ok(response) => match classify_hue_response(response).await {
            Ok(ok) => ok.text().await.map_err(|e| e.to_string()),
            Err(fault) => Err(fault.to_string()),
        },
        Err(error) => Err(error.to_string()),
    };
    match outcome {
        Ok(payload) => {
            let result = parse_credentials_validation_payload(&payload);
            if result.valid {
                info!("Hue credentials validated for bridge {bridge_ip}");
            } else if result.status.code == "HUE_CREDENTIAL_INVALID" {
                error!("Hue credentials invalid for bridge {bridge_ip}");
            }
            result
        }
        Err(error) => HueValidateCredentialsResponse {
            status: command_status(
                "HUE_CREDENTIAL_CHECK_FAILED",
                "Could not validate Hue credentials. Check bridge reachability and retry.",
                Some(error),
            ),
            valid: false,
        },
    }
}

#[tauri::command]
pub async fn list_hue_entertainment_areas(
    bridge_ip: String,
    username: String,
) -> HueEntertainmentAreaListResponse {
    if !is_valid_ipv4(&bridge_ip) {
        return HueEntertainmentAreaListResponse {
            status: command_status(
                "HUE_IP_INVALID",
                "Bridge IP is not a valid IPv4 address.",
                Some("Use a value like 192.168.1.50".to_string()),
            ),
            areas: Vec::new(),
        };
    }

    match fetch_hue_entertainment_areas(&bridge_ip, &username).await {
        Ok(areas) if areas.is_empty() => HueEntertainmentAreaListResponse {
            status: command_status(
                "HUE_AREA_LIST_EMPTY",
                "No Hue entertainment areas found on this bridge.",
                Some(
                    "Create or assign an Entertainment Area in Hue app, then refresh.".to_string(),
                ),
            ),
            areas,
        },
        Ok(areas) => {
            info!("Loaded {} Hue entertainment areas", areas.len());
            HueEntertainmentAreaListResponse {
                status: command_status(
                    "HUE_AREA_LIST_OK",
                    "Hue entertainment areas loaded successfully.",
                    None,
                ),
                areas,
            }
        }
        Err(AreaListError::AuthInvalid) => {
            warn!("Hue area list rejected with 403 type=1 — re-pair required");
            HueEntertainmentAreaListResponse {
                status: command_status(
                    "AUTH_INVALID_RE_PAIR_REQUIRED",
                    "Hue bridge rejected our credentials. Re-pair the bridge to continue.",
                    Some("Bridge returned HTTP 403 with unauthorized-user error.".to_string()),
                ),
                areas: Vec::new(),
            }
        }
        Err(AreaListError::Other(message)) => {
            warn!("Failed to list Hue entertainment areas: {message}");
            HueEntertainmentAreaListResponse {
                status: command_status(
                    "HUE_AREA_LIST_FAILED",
                    "Could not list Hue entertainment areas with current credentials.",
                    Some(message),
                ),
                areas: Vec::new(),
            }
        }
    }
}

#[tauri::command]
pub async fn check_hue_stream_readiness(
    bridge_ip: String,
    username: String,
    area_id: String,
) -> HueStreamReadinessResponse {
    match fetch_hue_entertainment_areas(&bridge_ip, &username).await {
        Ok(areas) => {
            let selected = areas.iter().find(|area| area.id == area_id);
            let Some(area) = selected else {
                return HueStreamReadinessResponse {
                    status: command_status(
                        "HUE_STREAM_NOT_READY",
                        "Selected Hue area was not found. Re-select an area and retry.",
                        Some(format!("Missing areaId={area_id}")),
                    ),
                    readiness: HueStreamReadiness {
                        ready: false,
                        reasons: vec![
                            "Selected area is unavailable on current bridge state.".to_string()
                        ],
                    },
                };
            };

            let mut reasons = Vec::new();
            if area.channel_count == 0 {
                reasons.push("Selected area has no entertainment channels configured.".to_string());
            }
            if area.active_streamer {
                reasons.push("HUE_STREAM_NOT_READY_ACTIVE_STREAMER".to_string());
            }

            let ready = reasons.is_empty();
            if ready {
                info!("Hue stream readiness gate passed for area {area_id}");
            } else {
                info!("Hue stream readiness gate failed for area {area_id}: {reasons:?}");
            }
            let status = if ready {
                command_status(
                    "HUE_STREAM_READY",
                    "Selected Hue area is ready for streaming.",
                    None,
                )
            } else {
                command_status(
                    "HUE_STREAM_NOT_READY",
                    "Selected Hue area is not stream-ready yet.",
                    Some("Adjust Hue Entertainment Area configuration and revalidate.".to_string()),
                )
            };

            HueStreamReadinessResponse {
                status,
                readiness: HueStreamReadiness { ready, reasons },
            }
        }
        Err(AreaListError::AuthInvalid) => {
            warn!("Hue readiness rejected with 403 type=1 — re-pair required");
            HueStreamReadinessResponse {
                status: command_status(
                    "AUTH_INVALID_RE_PAIR_REQUIRED",
                    "Hue bridge rejected our credentials. Re-pair the bridge to continue.",
                    Some("Bridge returned HTTP 403 with unauthorized-user error.".to_string()),
                ),
                readiness: HueStreamReadiness {
                    ready: false,
                    reasons: vec!["Bridge credentials are invalid; re-pair required.".to_string()],
                },
            }
        }
        Err(AreaListError::Other(message)) => {
            warn!("Hue stream readiness check failed: {message}");
            HueStreamReadinessResponse {
                status: command_status(
                    "HUE_STREAM_READINESS_FAILED",
                    "Could not evaluate Hue stream readiness.",
                    Some(message),
                ),
                readiness: HueStreamReadiness {
                    ready: false,
                    reasons: vec![
                        "Bridge or credentials could not be validated for readiness check."
                            .to_string(),
                    ],
                },
            }
        }
    }
}

pub fn parse_discovery_payload(payload: &str) -> HueDiscoveryResponse {
    match serde_json::from_str::<Vec<DiscoveryBridge>>(payload) {
        Ok(discovered) if discovered.is_empty() => HueDiscoveryResponse {
            status: command_status(
                "HUE_DISCOVERY_EMPTY",
                "No Hue bridges discovered automatically. You can continue with manual IP.",
                None,
            ),
            bridges: Vec::new(),
        },
        Ok(discovered) => {
            let bridges = discovered
                .into_iter()
                .map(|bridge| HueBridgeSummary {
                    name: format!("Hue Bridge ({})", bridge.internal_ip_address),
                    id: bridge.id,
                    ip: bridge.internal_ip_address,
                    model_id: None,
                    software_version: None,
                })
                .collect::<Vec<_>>();

            HueDiscoveryResponse {
                status: command_status(
                    "HUE_DISCOVERY_OK",
                    "Hue bridges discovered successfully.",
                    None,
                ),
                bridges,
            }
        }
        Err(error) => HueDiscoveryResponse {
            status: command_status(
                "HUE_DISCOVERY_FAILED",
                "Bridge discovery returned an unexpected response.",
                Some(error.to_string()),
            ),
            bridges: Vec::new(),
        },
    }
}

pub fn verify_hue_bridge_ip_input(ip: &str) -> HueVerifyBridgeIpResponse {
    if !is_valid_ipv4(ip) {
        return HueVerifyBridgeIpResponse {
            status: command_status(
                "HUE_IP_INVALID",
                "Bridge IP is not a valid IPv4 address.",
                Some("Use a value like 192.168.1.50".to_string()),
            ),
            bridge: None,
        };
    }

    HueVerifyBridgeIpResponse {
        status: command_status(
            "HUE_IP_VALID",
            "Bridge IP format is valid. Verifying reachability...",
            None,
        ),
        bridge: None,
    }
}

/// CLIP pairing error-type → frontend status-code mapping.
///
/// `parse_pairing_payload` reads the first array entry's `error.type`
/// (Hue CLIP v1/v2 envelope) and routes the well-known failure codes to
/// specific status strings. Unknown error types fall through to the
/// catch-all `HUE_PAIRING_FAILED`.
///
/// | error.type | description                  | status code                        |
/// | ---------- | ---------------------------- | ---------------------------------- |
/// | `101`      | link button not pressed      | `HUE_PAIRING_LINK_BUTTON_NOT_PRESSED` |
/// | `7`        | invalid value (+ devicetype) | `HUE_PAIRING_DEVICETYPE_INVALID`   |
/// | `7`        | invalid value (other)        | `HUE_PAIRING_FAILED`               |
/// | `429`/`503`| rate/limit or busy body      | `HUE_PAIRING_RATE_LIMITED` / `HUE_PAIRING_BRIDGE_BUSY` |
/// | anything   | other                        | `HUE_PAIRING_FAILED`               |
pub fn parse_pairing_payload(payload: &str) -> HuePairBridgeResponse {
    let parsed = serde_json::from_str::<Value>(payload);
    let Ok(value) = parsed else {
        return HuePairBridgeResponse {
            status: command_status(
                "HUE_PAIRING_FAILED",
                "Pairing response could not be parsed.",
                parsed.err().map(|e| e.to_string()),
            ),
            credentials: None,
            credential_storage_backend: None,
        };
    };

    let array = value.as_array();
    let Some(first_item) = array.and_then(|items| items.first()) else {
        return HuePairBridgeResponse {
            status: command_status(
                "HUE_PAIRING_FAILED",
                "Pairing response was empty.",
                Some("Bridge did not return success/error payload.".to_string()),
            ),
            credentials: None,
            credential_storage_backend: None,
        };
    };

    if let Some(error_entry) = first_item.get("error") {
        let error_type = error_entry.get("type").and_then(|value| value.as_i64());
        let description = error_entry
            .get("description")
            .and_then(|value| value.as_str())
            .unwrap_or("")
            .to_string();

        return HuePairBridgeResponse {
            status: pairing_error_status(error_type, &description),
            credentials: None,
            credential_storage_backend: None,
        };
    }

    let username = first_item
        .get("success")
        .and_then(|success| success.get("username"))
        .and_then(|value| value.as_str());
    let client_key = first_item
        .get("success")
        .and_then(|success| success.get("clientkey"))
        .and_then(|value| value.as_str());

    match (username, client_key) {
        (Some(username), Some(client_key)) => HuePairBridgeResponse {
            status: command_status(
                "HUE_PAIRING_OK",
                "Hue bridge pairing succeeded. Credentials are ready to persist.",
                None,
            ),
            credentials: Some(HuePairingCredentials {
                username: username.to_string(),
                client_key: client_key.to_string(),
            }),
            credential_storage_backend: None,
        },
        _ => HuePairBridgeResponse {
            status: command_status(
                "HUE_PAIRING_FAILED",
                "Pairing succeeded partially but credentials were incomplete.",
                Some("Missing username/clientkey in bridge success payload.".to_string()),
            ),
            credentials: None,
            credential_storage_backend: None,
        },
    }
}

/// Map a CLIP pairing error envelope to a specific frontend status code.
///
/// Pure (no I/O) so the mapping stays trivially unit-testable. Unknown
/// error types collapse to `HUE_PAIRING_FAILED` to preserve backwards
/// compatibility with frontends that predate the v1.4 G7 split.
fn pairing_error_status(error_type: Option<i64>, description: &str) -> CommandStatus {
    let description_lower = description.to_lowercase();
    match error_type {
        Some(101) => command_status(
            "HUE_PAIRING_LINK_BUTTON_NOT_PRESSED",
            "Press the bridge link button and retry within 30 seconds.",
            None,
        ),
        Some(7) if description_lower.contains("devicetype") => command_status(
            "HUE_PAIRING_DEVICETYPE_INVALID",
            "Bridge rejected the pairing request format.",
            Some(description.to_string()),
        ),
        Some(429) => command_status(
            "HUE_PAIRING_RATE_LIMITED",
            "Bridge throttled pairing attempts. Wait a minute before retrying.",
            Some(description.to_string()),
        ),
        Some(503) => command_status(
            "HUE_PAIRING_BRIDGE_BUSY",
            "Bridge is busy pairing another client. Try again in a moment.",
            Some(description.to_string()),
        ),
        _ => command_status(
            "HUE_PAIRING_FAILED",
            "Bridge rejected pairing request.",
            if description.is_empty() {
                None
            } else {
                Some(description.to_string())
            },
        ),
    }
}

pub fn parse_credentials_validation_payload(payload: &str) -> HueValidateCredentialsResponse {
    let parsed = serde_json::from_str::<Value>(payload);
    let Ok(value) = parsed else {
        return HueValidateCredentialsResponse {
            status: command_status(
                "HUE_CREDENTIAL_CHECK_FAILED",
                "Credential validation response could not be parsed.",
                parsed.err().map(|error| error.to_string()),
            ),
            valid: false,
        };
    };

    if let Some(bridge_id) = value
        .get("bridgeid")
        .and_then(|bridge_id| bridge_id.as_str())
    {
        return HueValidateCredentialsResponse {
            status: command_status(
                "HUE_CREDENTIAL_VALID",
                "Hue credentials are valid.",
                Some(format!("bridgeId={bridge_id}")),
            ),
            valid: true,
        };
    }

    let unauthorized = value
        .as_array()
        .and_then(|items| items.first())
        .and_then(|entry| entry.get("error"))
        .and_then(|error| error.get("type"))
        .and_then(|kind| kind.as_i64())
        .map(|kind| kind == 1)
        .unwrap_or(false);

    if unauthorized {
        return HueValidateCredentialsResponse {
            status: command_status(
                "HUE_CREDENTIAL_INVALID",
                "Hue credentials are invalid or expired. Re-pair required.",
                None,
            ),
            valid: false,
        };
    }

    HueValidateCredentialsResponse {
        status: command_status(
            "HUE_CREDENTIAL_CHECK_FAILED",
            "Credential validation returned an unexpected payload.",
            Some("Response did not include bridgeid or authorization error.".to_string()),
        ),
        valid: false,
    }
}

async fn fetch_hue_entertainment_areas(
    bridge_ip: &str,
    username: &str,
) -> Result<Vec<HueEntertainmentArea>, AreaListError> {
    if !is_valid_ipv4(bridge_ip) {
        return Err(AreaListError::Other(
            "Invalid bridge IPv4 format".to_string(),
        ));
    }

    let client = hue_http_client().map_err(AreaListError::Other)?;

    // Fetch entertainment_configuration and room resources in parallel to
    // enrich each area with its bridge-reported archetype. Two parallel
    // GETs stay comfortably under the CLIP v2 soft rate limit (~3 req/s).
    let entertainment_fut = fetch_entertainment_payload(&client, bridge_ip, username);
    let rooms_fut = fetch_room_payload(&client, bridge_ip, username);
    let (entertainment_res, rooms_res) = tokio::join!(entertainment_fut, rooms_fut);

    let entertainment_payload = entertainment_res?;
    // Room fetch failure must not fail the whole command — archetype is
    // an enrichment signal, not a correctness signal. Missing rooms just
    // means archetype ends up `None` (UI falls back to "other").
    let room_index = rooms_res
        .map(build_room_archetype_index)
        .unwrap_or_default();

    parse_area_list_payload(&entertainment_payload, &room_index).map_err(AreaListError::Other)
}

async fn fetch_entertainment_payload(
    client: &Client,
    bridge_ip: &str,
    username: &str,
) -> Result<String, AreaListError> {
    let endpoint = format!("https://{bridge_ip}/clip/v2/resource/entertainment_configuration");
    let raw = client
        .get(endpoint)
        .header("hue-application-key", username)
        .send()
        .await
        .map_err(|e| AreaListError::Other(e.to_string()))?;

    let response = classify_hue_response(raw)
        .await
        .map_err(|fault| match fault {
            HueHttpFault::AuthInvalid => AreaListError::AuthInvalid,
            other => AreaListError::Other(other.to_string()),
        })?;

    response
        .text()
        .await
        .map_err(|e| AreaListError::Other(e.to_string()))
}

async fn fetch_room_payload(
    client: &Client,
    bridge_ip: &str,
    username: &str,
) -> Result<String, AreaListError> {
    let endpoint = format!("https://{bridge_ip}/clip/v2/resource/room");
    let raw = client
        .get(endpoint)
        .header("hue-application-key", username)
        .send()
        .await
        .map_err(|e| AreaListError::Other(e.to_string()))?;

    let response = classify_hue_response(raw)
        .await
        .map_err(|fault| match fault {
            HueHttpFault::AuthInvalid => AreaListError::AuthInvalid,
            other => AreaListError::Other(other.to_string()),
        })?;

    response
        .text()
        .await
        .map_err(|e| AreaListError::Other(e.to_string()))
}

/// Carrier for `fetch_hue_entertainment_areas` faults. Keeps
/// `AuthInvalid` distinguishable from generic transient failures so the
/// public commands can collapse it onto the uniform
/// `AUTH_INVALID_RE_PAIR_REQUIRED` status code without string matching.
enum AreaListError {
    AuthInvalid,
    Other(String),
}

/// Build a `{service_rid → archetype}` map from a CLIP v2 `/resource/room`
/// payload. Each room's `services[]` lists the light/grouped_light services
/// that belong to it; matching entertainment-configuration services by
/// `rid` yields the room's archetype for each area.
pub fn build_room_archetype_index(payload: String) -> std::collections::HashMap<String, String> {
    let mut index = std::collections::HashMap::new();
    let Ok(value) = serde_json::from_str::<Value>(&payload) else {
        return index;
    };
    let Some(data) = value.get("data").and_then(|value| value.as_array()) else {
        return index;
    };

    for room in data {
        let archetype = room
            .get("metadata")
            .and_then(|metadata| metadata.get("archetype"))
            .and_then(|value| value.as_str())
            .map(normalize_archetype);
        let Some(archetype) = archetype else {
            continue;
        };
        let Some(services) = room.get("services").and_then(|value| value.as_array()) else {
            continue;
        };
        for service in services {
            if let Some(rid) = service.get("rid").and_then(|value| value.as_str()) {
                index.insert(rid.to_string(), archetype.clone());
            }
        }
    }

    index
}

/// Normalize a bridge-reported archetype into the frontend whitelist.
/// Unknown archetypes collapse onto `"other"` so the UI never renders
/// a raw identifier the `HUE_ROOM_ARCHETYPES` whitelist does not cover.
fn normalize_archetype(raw: &str) -> String {
    const ARCHETYPES: &[&str] = &[
        "living_room",
        "kitchen",
        "dining",
        "bedroom",
        "kids_bedroom",
        "bathroom",
        "nursery",
        "recreation",
        "office",
        "gym",
        "hallway",
        "toilet",
        "front_door",
        "garage",
        "terrace",
        "garden",
        "driveway",
        "carport",
        "home",
        "downstairs",
        "upstairs",
        "top_floor",
        "attic",
        "guest_room",
        "staircase",
        "lounge",
        "man_cave",
        "computer",
        "studio",
        "music",
        "tv",
        "reading",
        "closet",
        "storage",
        "laundry_room",
        "balcony",
        "porch",
        "barbecue",
        "pool",
        "other",
    ];
    if ARCHETYPES.contains(&raw) {
        raw.to_string()
    } else {
        "other".to_string()
    }
}

pub fn parse_area_list_payload(
    payload: &str,
    room_index: &std::collections::HashMap<String, String>,
) -> Result<Vec<HueEntertainmentArea>, String> {
    let parsed: Value = serde_json::from_str(payload).map_err(|error| error.to_string())?;
    let data = parsed
        .get("data")
        .and_then(|value| value.as_array())
        .ok_or_else(|| "Missing data array in area list payload".to_string())?;

    let mut areas = data
        .iter()
        .map(|area| {
            let id = area
                .get("id")
                .and_then(|value| value.as_str())
                .unwrap_or_default()
                .to_string();
            let name = area
                .get("metadata")
                .and_then(|metadata| metadata.get("name"))
                .and_then(|value| value.as_str())
                .unwrap_or("Unnamed Area")
                .to_string();
            let channel_count = area
                .get("channels")
                .and_then(|value| value.as_array())
                .map(|channels| channels.len())
                .unwrap_or(0);
            let active_streamer = area
                .get("active_streamer")
                .is_some_and(|active| !active.is_null());

            // Match any service referenced by this entertainment config
            // against the room→archetype index. First hit wins — a single
            // area rarely spans multiple archetypes, and when it does the
            // first room is already the semantically closest one.
            let archetype = area
                .get("light_services")
                .and_then(|value| value.as_array())
                .into_iter()
                .flatten()
                .chain(
                    area.get("locations")
                        .and_then(|loc| loc.get("service_locations"))
                        .and_then(|value| value.as_array())
                        .into_iter()
                        .flatten()
                        .filter_map(|entry| entry.get("service")),
                )
                .filter_map(|entry| entry.get("rid").and_then(|rid| rid.as_str()))
                .find_map(|rid| room_index.get(rid).cloned());

            // Preserve the room's display name if we can find one in the
            // index by reusing the same resolution above. The CLIP v2
            // `/resource/room` payload carries both archetype and name
            // side by side so one traversal is enough for both signals.
            HueEntertainmentArea {
                id,
                name,
                room_name: None,
                archetype,
                channel_count,
                active_streamer,
            }
        })
        .collect::<Vec<_>>();

    areas.sort_by_key(|area| area.name.to_lowercase());
    Ok(areas)
}

fn parse_bridge_config_payload(bridge_ip: &str, payload: &str) -> HueVerifyBridgeIpResponse {
    let parsed = serde_json::from_str::<Value>(payload);
    let Ok(value) = parsed else {
        return HueVerifyBridgeIpResponse {
            status: command_status(
                "HUE_IP_UNREACHABLE",
                "Bridge responded with unexpected payload during IP verification.",
                parsed.err().map(|error| error.to_string()),
            ),
            bridge: None,
        };
    };

    let bridge_id = value
        .get("bridgeid")
        .and_then(|value| value.as_str())
        .unwrap_or("unknown-bridge")
        .to_string();
    let bridge_name = value
        .get("name")
        .and_then(|value| value.as_str())
        .unwrap_or("Hue Bridge")
        .to_string();
    let model_id = value
        .get("modelid")
        .and_then(|value| value.as_str())
        .map(str::to_string);
    let software_version = value
        .get("swversion")
        .and_then(|value| value.as_str())
        .map(str::to_string);

    HueVerifyBridgeIpResponse {
        status: command_status(
            "HUE_IP_VALID",
            "Hue bridge is reachable at the provided IP.",
            None,
        ),
        bridge: Some(HueBridgeSummary {
            id: bridge_id,
            ip: bridge_ip.to_string(),
            name: bridge_name,
            model_id,
            software_version,
        }),
    }
}

fn hue_http_client() -> Result<Client, String> {
    Client::builder()
        .timeout(Duration::from_secs(5))
        .danger_accept_invalid_certs(true)
        .build()
        .map_err(|error| error.to_string())
}

fn is_valid_ipv4(value: &str) -> bool {
    let Ok(addr) = Ipv4Addr::from_str(value) else {
        return false;
    };
    !addr.is_loopback() && !addr.is_unspecified() && !addr.is_multicast() && !addr.is_broadcast()
}

fn command_status(code: &str, message: &str, details: Option<String>) -> CommandStatus {
    CommandStatus {
        code: code.to_string(),
        message: message.to_string(),
        details,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_ipv4_valid_address() {
        assert!(is_valid_ipv4("192.168.1.42"));
    }

    #[test]
    fn parse_ipv4_invalid_returns_false() {
        assert!(!is_valid_ipv4("not-an-ip"));
    }

    #[test]
    fn parse_ipv4_loopback_is_rejected() {
        assert!(!is_valid_ipv4("127.0.0.1"));
    }

    #[test]
    fn parse_ipv4_unspecified_is_rejected() {
        assert!(!is_valid_ipv4("0.0.0.0"));
    }

    #[test]
    fn parse_ipv4_multicast_is_rejected() {
        assert!(!is_valid_ipv4("224.0.0.1"));
    }

    #[test]
    fn parse_ipv4_broadcast_is_rejected() {
        assert!(!is_valid_ipv4("255.255.255.255"));
    }
}
