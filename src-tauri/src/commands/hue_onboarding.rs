use std::{net::Ipv4Addr, str::FromStr, time::Duration};

use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

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
    let client = match hue_http_client() {
        Ok(client) => client,
        Err(error) => {
            return HueDiscoveryResponse {
                status: command_status(
                    "HUE_DISCOVERY_FAILED",
                    "Could not initialize Hue discovery client.",
                    Some(error),
                ),
                bridges: Vec::new(),
            }
        }
    };

    let fetch = async {
        client
            .get("https://discovery.meethue.com/")
            .send()
            .await?
            .error_for_status()?
            .text()
            .await
    };
    match fetch.await {
        Ok(payload) => parse_discovery_payload(&payload),
        Err(error) => HueDiscoveryResponse {
            status: command_status(
                "HUE_DISCOVERY_FAILED",
                "Could not discover Hue bridges automatically. You can continue with manual IP.",
                Some(error.to_string()),
            ),
            bridges: Vec::new(),
        },
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
    let fetch = async {
        client
            .get(endpoint)
            .send()
            .await?
            .error_for_status()?
            .text()
            .await
    };
    match fetch.await {
        Ok(payload) => parse_bridge_config_payload(&bridge_ip, &payload),
        Err(error) => HueVerifyBridgeIpResponse {
            status: command_status(
                "HUE_IP_UNREACHABLE",
                "Could not reach Hue bridge at the provided IP. Verify bridge power/network and try again.",
                Some(error.to_string()),
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
        };
    }

    let client = match hue_http_client() {
        Ok(client) => client,
        Err(error) => {
            return HuePairBridgeResponse {
                status: command_status(
                    "HUE_PAIRING_FAILED",
                    "Could not initialize Hue pairing client.",
                    Some(error),
                ),
                credentials: None,
            }
        }
    };

    let endpoint = format!("http://{bridge_ip}/api");
    let body = json!({
        "devicetype": "lumasync#desktop",
        "generateclientkey": true,
    });
    let fetch = async {
        client
            .post(endpoint)
            .json(&body)
            .send()
            .await?
            .error_for_status()?
            .text()
            .await
    };
    match fetch.await {
        Ok(payload) => parse_pairing_payload(&payload),
        Err(error) => HuePairBridgeResponse {
            status: command_status(
                "HUE_PAIRING_FAILED",
                "Pairing request failed. Press bridge link button, then retry within 30 seconds.",
                Some(error.to_string()),
            ),
            credentials: None,
        },
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
    let fetch = async {
        client
            .get(endpoint)
            .send()
            .await?
            .error_for_status()?
            .text()
            .await
    };
    match fetch.await {
        Ok(payload) => parse_credentials_validation_payload(&payload),
        Err(error) => HueValidateCredentialsResponse {
            status: command_status(
                "HUE_CREDENTIAL_CHECK_FAILED",
                "Could not validate Hue credentials. Check bridge reachability and retry.",
                Some(error.to_string()),
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
        Ok(areas) => HueEntertainmentAreaListResponse {
            status: command_status(
                "HUE_AREA_LIST_OK",
                "Hue entertainment areas loaded successfully.",
                None,
            ),
            areas,
        },
        Err(error) => HueEntertainmentAreaListResponse {
            status: command_status(
                "HUE_AREA_LIST_FAILED",
                "Could not list Hue entertainment areas with current credentials.",
                Some(error),
            ),
            areas: Vec::new(),
        },
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

            let ready = reasons.is_empty();
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
        Err(error) => HueStreamReadinessResponse {
            status: command_status(
                "HUE_STREAM_READINESS_FAILED",
                "Could not evaluate Hue stream readiness.",
                Some(error),
            ),
            readiness: HueStreamReadiness {
                ready: false,
                reasons: vec![
                    "Bridge or credentials could not be validated for readiness check.".to_string(),
                ],
            },
        },
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
        };
    };

    if let Some(error_type) = first_item
        .get("error")
        .and_then(|error| error.get("type"))
        .and_then(|value| value.as_i64())
    {
        if error_type == 101 {
            return HuePairBridgeResponse {
                status: command_status(
                    "HUE_PAIRING_PENDING_LINK_BUTTON",
                    "Press the bridge link button, then retry pairing within 30 seconds.",
                    None,
                ),
                credentials: None,
            };
        }

        return HuePairBridgeResponse {
            status: command_status(
                "HUE_PAIRING_FAILED",
                "Bridge rejected pairing request.",
                first_item
                    .get("error")
                    .and_then(|error| error.get("description"))
                    .and_then(|value| value.as_str())
                    .map(str::to_string),
            ),
            credentials: None,
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
        },
        _ => HuePairBridgeResponse {
            status: command_status(
                "HUE_PAIRING_FAILED",
                "Pairing succeeded partially but credentials were incomplete.",
                Some("Missing username/clientkey in bridge success payload.".to_string()),
            ),
            credentials: None,
        },
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
) -> Result<Vec<HueEntertainmentArea>, String> {
    if !is_valid_ipv4(bridge_ip) {
        return Err("Invalid bridge IPv4 format".to_string());
    }

    let client = hue_http_client()?;
    let endpoint = format!("https://{bridge_ip}/clip/v2/resource/entertainment_configuration");
    let response = client
        .get(endpoint)
        .header("hue-application-key", username)
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|error| error.to_string())?;
    let payload = response.text().await.map_err(|error| error.to_string())?;

    parse_area_list_payload(&payload)
}

fn parse_area_list_payload(payload: &str) -> Result<Vec<HueEntertainmentArea>, String> {
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
            let room_name = area
                .get("metadata")
                .and_then(|metadata| metadata.get("archetype"))
                .and_then(|value| value.as_str())
                .map(str::to_string);
            let channel_count = area
                .get("channels")
                .and_then(|value| value.as_array())
                .map(|channels| channels.len())
                .unwrap_or(0);
            let active_streamer = area
                .get("active_streamer")
                .is_some_and(|active| !active.is_null());

            HueEntertainmentArea {
                id,
                name,
                room_name,
                channel_count,
                active_streamer,
            }
        })
        .collect::<Vec<_>>();

    areas.sort_by(|left, right| left.name.to_lowercase().cmp(&right.name.to_lowercase()));
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
    Ipv4Addr::from_str(value).is_ok()
}

fn command_status(code: &str, message: &str, details: Option<String>) -> CommandStatus {
    CommandStatus {
        code: code.to_string(),
        message: message.to_string(),
        details,
    }
}
