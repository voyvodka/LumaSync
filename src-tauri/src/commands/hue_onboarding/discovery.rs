//! Bridge discovery (cloud + mDNS) and manual-IP verification — the "find a
//! bridge" half of onboarding. Carved out of `hue_onboarding.rs`.

use log::warn;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::super::hue::bridge_identity::{
    normalize_bridge_id, BridgeTrust, IDENTITY_MISMATCH_CODE,
};
use super::super::hue::transport::{
    answering_bridge_id, async_client, cloud_client, identity_rejection, is_valid_bridge_addr,
    plain_http_client, read_body, send_error_text,
};
use super::super::hue_http::classify_hue_response;
use super::super::status::CommandStatus;
use super::{command_status, identity_mismatch_status, send_clip_v1};

/// A discovered or verified Hue bridge, as surfaced to the frontend picker.
#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct HueBridgeSummary {
    pub id: String,
    pub ip: String,
    pub name: String,
    pub model_id: Option<String>,
    pub software_version: Option<String>,
}

/// Response for `discover_hue_bridges` — status plus the merged, deduped
/// bridge list from cloud + mDNS discovery.
#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct HueDiscoveryResponse {
    pub status: CommandStatus,
    pub bridges: Vec<HueBridgeSummary>,
}

/// Response for `verify_hue_bridge_ip` — whether the given IP reaches a real
/// bridge, for the manual-IP onboarding fallback.
#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct HueVerifyBridgeIpResponse {
    pub status: CommandStatus,
    pub bridge: Option<HueBridgeSummary>,
}

#[derive(Deserialize)]
struct DiscoveryBridge {
    id: String,
    #[serde(rename = "internalipaddress")]
    internal_ip_address: String,
}

/// Discover Hue bridges on the network via cloud + mDNS discovery run in
/// parallel, merging and deduplicating the results by bridge id.
#[tauri::command]
pub async fn discover_hue_bridges() -> HueDiscoveryResponse {
    // Run cloud and mDNS discovery in parallel.
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
    let client = cloud_client().map_err(|e| format!("CLIENT_INIT: {e}"))?;
    let response = client
        .get("https://discovery.meethue.com/")
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let ok_response = classify_hue_response(response)
        .await
        .map_err(|fault| fault.to_string())?;
    let payload = read_body(ok_response).await?;
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

/// Check whether a manually entered IP reaches a real Hue bridge, for the
/// manual-IP onboarding fallback when discovery finds nothing.
#[tauri::command]
pub async fn verify_hue_bridge_ip(bridge_ip: String) -> HueVerifyBridgeIpResponse {
    let invalid = verify_hue_bridge_ip_input(&bridge_ip);
    if invalid.status.code == "HUE_IP_INVALID" {
        return invalid;
    }

    let clients = async_client(&BridgeTrust::any())
        .and_then(|https| plain_http_client().map(|http| (https, http)));
    let (client, http_fallback) = match clients {
        Ok(clients) => clients,
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
    verify_bridge_at(&client, &http_fallback, &bridge_ip).await
}

/// The network half of `verify_hue_bridge_ip`, split so a test can point it
/// at a local stand-in for the bridge.
pub(crate) async fn verify_bridge_at(
    client: &Client,
    http_fallback: &Client,
    bridge_ip: &str,
) -> HueVerifyBridgeIpResponse {
    let mut answering = None;
    let outcome = match send_clip_v1(
        client,
        bridge_ip,
        "/api/config",
        Some(http_fallback),
        |client, url| client.get(url),
    )
    .await
    {
        Ok(response) => {
            answering = answering_bridge_id(&response);
            match classify_hue_response(response).await {
                Ok(ok) => read_body(ok).await,
                Err(fault) => Err(fault.to_string()),
            }
        }
        Err(error) => {
            if let Some(rejection) = identity_rejection(&error) {
                warn!("Hue bridge at {bridge_ip} refused: {rejection}");
                return HueVerifyBridgeIpResponse {
                    status: identity_mismatch_status(rejection.to_string()),
                    bridge: None,
                };
            }
            Err(send_error_text(&error))
        }
    };
    match outcome {
        Ok(payload) => {
            let verified = parse_bridge_config_payload(bridge_ip, &payload);
            // The certificate and the config are both the bridge's word, so a
            // disagreement means whatever answered is not one bridge.
            let configured = verified
                .bridge
                .as_ref()
                .and_then(|bridge| normalize_bridge_id(&bridge.id));
            if let (Some(answering_id), Some(configured)) = (answering, configured) {
                if answering_id != configured {
                    warn!(
                        "Hue bridge at {bridge_ip}: certificate names {answering_id}, \
                         config reports {configured}"
                    );
                    return HueVerifyBridgeIpResponse {
                        status: identity_mismatch_status(format!(
                            "{IDENTITY_MISMATCH_CODE}: the certificate names bridge \
                             {answering_id} but the bridge reports {configured}"
                        )),
                        bridge: None,
                    };
                }
            }
            verified
        }
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

/// Validate the IP format only, without a network round-trip; used to
/// short-circuit before reaching the bridge.
pub fn verify_hue_bridge_ip_input(ip: &str) -> HueVerifyBridgeIpResponse {
    if !is_valid_bridge_addr(ip) {
        return HueVerifyBridgeIpResponse {
            status: command_status(
                "HUE_IP_INVALID",
                "Bridge IP is not a local-network IPv4 address.",
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
