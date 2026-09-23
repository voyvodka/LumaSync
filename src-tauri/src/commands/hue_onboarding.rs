//! Hue bridge discovery, pairing, and Entertainment Area onboarding commands —
//! the read/pair path that runs before a stream can start.

use log::{debug, error, info, warn};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::hue::area_cache::{invalidate_hue_area_cache, read_area_snapshot, HueReadFreshness};
use super::hue::bridge_identity::{normalize_bridge_id, BridgeTrust, IDENTITY_MISMATCH_CODE};
use super::hue::credential_store::effective_hue_app_key;
use super::hue::state_store::{streams_area, HueRuntimeStateStore};
use super::hue::transport::{
    answering_bridge_id, async_client, async_client_for_key, cloud_client, identity_rejection,
    is_tls_failure, is_valid_bridge_addr, plain_http_client, read_body, send_error_text,
};

/// `details` for the "nothing resolved" arms. The reused
/// `AUTH_INVALID_RE_PAIR_REQUIRED` message asserts the bridge returned a 403,
/// which is not what happened here — the distinction lives in `details` rather
/// than in a new code, because a new code would fall through every shipped
/// `switch` into the default branch and render the wrong card.
const NO_APP_KEY_DETAILS: &str =
    "No Hue application key in the OS keychain or the request payload.";

use super::hue_http::{classify_hue_response, HueHttpFault};
// Every Hue onboarding command returns this and never throws — callers branch
// on `code`.
use super::status::CommandStatus;

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

#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct HuePairingCredentials {
    pub username: String,
    pub client_key: String,
}

/// Response for `pair_hue_bridge` — pairing status, credentials on success,
/// and where they ended up persisted.
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

/// Response for `migrate_hue_credentials` — which backend now holds the
/// credential pair.
#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct HueCredentialMigrationResponse {
    pub status: CommandStatus,
    /// `"keychain"` only once the pair has been written AND read back, which is
    /// what licenses the caller to delete its plaintext copy.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub backend: Option<String>,
}

/// Response for `validate_hue_credentials` — whether the stored bridge
/// credentials still work.
#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct HueValidateCredentialsResponse {
    pub status: CommandStatus,
    pub valid: bool,
}

/// One bridge-side Entertainment Area, as shown in the frontend area picker.
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

/// Whether the selected area can currently start a stream, plus why not.
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

/// Discover Hue bridges on the network via cloud + mDNS discovery run in
/// parallel, merging and deduplicating the results by bridge id.
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
            if let (Some(certificate), Some(configured)) = (answering, configured) {
                if certificate != configured {
                    warn!(
                        "Hue bridge at {bridge_ip}: certificate names {certificate}, \
                         config reports {configured}"
                    );
                    return HueVerifyBridgeIpResponse {
                        status: identity_mismatch_status(format!(
                            "{IDENTITY_MISMATCH_CODE}: the certificate names bridge \
                             {certificate} but the bridge reports {configured}"
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

/// Pair with the Hue bridge at `bridge_ip`, requesting the bridge link
/// button and persisting the resulting credentials (keychain-first).
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

    let client = match async_client(&BridgeTrust::pairing()) {
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
    let store = super::hue::credential_store::default_store();
    pair_bridge_at(&client, &bridge_ip, store.as_ref()).await
}

/// The network half of `pair_hue_bridge`, split so a test can point it at a
/// local stand-in for the bridge and a store of its own.
pub(crate) async fn pair_bridge_at(
    client: &Client,
    bridge_ip: &str,
    store: &dyn super::hue::credential_store::SecretStore,
) -> HuePairBridgeResponse {
    let body = json!({
        "devicetype": "lumasync#desktop",
        "generateclientkey": true,
    });
    // The pair's owner is the bridge the certificate of this very response
    // names — never the address, which a DHCP renewal reassigns.
    let mut answering = None;
    let outcome: Result<String, PairingTransportError> =
        match send_clip_v1(client, bridge_ip, "/api", None, |client, url| {
            client.post(url).json(&body)
        })
        .await
        {
            Ok(response) => {
                answering = answering_bridge_id(&response);
                match classify_hue_response(response).await {
                    Ok(ok) => read_body(ok).await.map_err(PairingTransportError::Generic),
                    Err(fault) => Err(PairingTransportError::from_fault(fault)),
                }
            }
            Err(error) => Err(match identity_rejection(&error) {
                Some(rejection) => PairingTransportError::Identity(rejection.to_string()),
                None => PairingTransportError::Generic(send_error_text(&error)),
            }),
        };
    match outcome {
        Ok(payload) => {
            let mut result = parse_pairing_payload(&payload);
            // A re-pair issues a new application key, so nothing cached under
            // the previous one may survive into the post-pair session.
            invalidate_hue_area_cache();
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
                if answering.is_none() {
                    warn!("[hue-cred] pairing answer carried no bridge certificate; pair unscoped");
                }
                let outcome = super::hue::credential_store::migrate_hue_credentials_to_keychain(
                    store,
                    answering.as_deref().unwrap_or_default(),
                    &creds.username,
                    &creds.client_key,
                );
                let backend = outcome.backend(store);
                info!(
                    "[hue-cred] pairing migration {}: backend={}",
                    outcome.status_code(),
                    backend.as_str()
                );
                result.credential_storage_backend = Some(backend.as_str().to_string());
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
        Err(PairingTransportError::Identity(detail)) => {
            warn!("Hue bridge pairing refused the bridge at {bridge_ip}: {detail}");
            HuePairBridgeResponse {
                status: identity_mismatch_status(detail),
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
    BridgeBusy {
        detail: String,
    },
    /// The certificate was refused, so nothing was sent.
    Identity(String),
    Generic(String),
}

impl PairingTransportError {
    fn from_fault(fault: HueHttpFault) -> Self {
        match fault {
            HueHttpFault::RateLimited { .. } => Self::RateLimited,
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

/// Move an existing plaintext credential pair into the OS keychain. Additive
/// boot cleanup for installs that paired before the keychain landed; the caller
/// may clear its plaintext copy only when `backend` comes back `"keychain"`.
// Off the main thread: a keychain write can wait on the user answering a
// system prompt, which froze the whole UI while it was a sync command.
#[tauri::command]
pub async fn migrate_hue_credentials(
    username: String,
    client_key: String,
) -> HueCredentialMigrationResponse {
    tauri::async_runtime::spawn_blocking(move || {
        migrate_hue_credentials_blocking(&username, &client_key)
    })
    .await
    .unwrap_or_else(|join_error| {
        // No backend: the caller keeps its plaintext copy unless told otherwise.
        HueCredentialMigrationResponse {
            status: command_status(
                super::hue::credential_store::MigrationOutcome::Failed.status_code(),
                "Hue credential keychain migration did not complete.",
                Some(join_error.to_string()),
            ),
            backend: None,
        }
    })
}

fn migrate_hue_credentials_blocking(
    username: &str,
    client_key: &str,
) -> HueCredentialMigrationResponse {
    let store = super::hue::credential_store::default_store();
    // No bridge context here: this is the boot cleanup for installs that
    // paired before the keychain existed, and the caller only carries the two
    // plaintext halves. The pair stays unscoped, which is exactly the
    // behaviour it already had, and the owner is recorded on the next
    // authenticated contact (`adopt_bridge_owner`) or real pairing. Adding a
    // bridge argument would be a command-surface change for a path that has
    // nothing to put in it.
    let outcome = super::hue::credential_store::migrate_hue_credentials_to_keychain(
        store.as_ref(),
        "",
        username,
        client_key,
    );
    let backend = outcome.backend(store.as_ref());
    info!(
        "[hue-cred] boot migration {}: backend={}",
        outcome.status_code(),
        backend.as_str()
    );

    HueCredentialMigrationResponse {
        status: command_status(
            outcome.status_code(),
            "Hue credential keychain migration completed.",
            None,
        ),
        backend: Some(backend.as_str().to_string()),
    }
}

/// Verify that previously stored Hue credentials are still accepted by the
/// bridge, distinguishing an explicit rejection from a reachability failure.
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

    // An empty `username` means "resolve from the OS keychain"; a non-empty one
    // is the legacy plaintext value and still wins nothing over the keychain.
    let username = effective_hue_app_key(&username);
    if username.is_empty() {
        return HueValidateCredentialsResponse {
            status: command_status(
                "HUE_CREDENTIAL_INVALID",
                "No stored Hue application key. Re-pair the bridge to continue.",
                Some(NO_APP_KEY_DETAILS.to_string()),
            ),
            valid: false,
        };
    }

    let client = match async_client_for_key(&username) {
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

    // Not `/api/<key>/config`: the bridge answers that for ANY key with its
    // public config, `bridgeid` included, so a revoked key validated. This
    // resource needs the key, and a refusal comes back through the classifier.
    let endpoint = format!("https://{bridge_ip}/clip/v2/resource/bridge");
    let store = super::hue::credential_store::default_store();
    validate_app_key_at(&client, &endpoint, &bridge_ip, &username, store.as_ref()).await
}

/// The network half of `validate_hue_credentials`, split so a test can point
/// it at a local stand-in for the bridge and a store of its own.
pub(crate) async fn validate_app_key_at(
    client: &Client,
    endpoint: &str,
    bridge_ip: &str,
    username: &str,
    store: &dyn super::hue::credential_store::SecretStore,
) -> HueValidateCredentialsResponse {
    let mut answering = None;
    let outcome = match client
        .get(endpoint)
        .header("hue-application-key", username)
        .send()
        .await
    {
        Ok(response) => {
            answering = answering_bridge_id(&response);
            match classify_hue_response(response).await {
                Ok(ok) => read_body(ok).await,
                // A bridge that explicitly rejected the key is not unreachable.
                // Collapsing this into the transport arm made the frontend
                // render "bridge offline" for an expired application key.
                Err(HueHttpFault::AuthInvalid) => {
                    error!("Hue credentials rejected by bridge {bridge_ip}");
                    return HueValidateCredentialsResponse {
                        status: command_status(
                            "HUE_CREDENTIAL_INVALID",
                            "Bridge rejected the stored application key. Re-pair required.",
                            None,
                        ),
                        valid: false,
                    };
                }
                Err(fault) => Err(fault.to_string()),
            }
        }
        // Refused before the key was sent: not an offline bridge, and not a
        // verdict on the key either.
        Err(error) => match identity_rejection(&error) {
            Some(rejection) => {
                warn!("Hue credential check refused the bridge at {bridge_ip}: {rejection}");
                return HueValidateCredentialsResponse {
                    status: identity_mismatch_status(rejection.to_string()),
                    valid: false,
                };
            }
            None => Err(send_error_text(&error)),
        },
    };
    match outcome {
        Ok(payload) => {
            let result = parse_bridge_resource_payload(&payload);
            if result.valid {
                info!("Hue credentials validated for bridge {bridge_ip}");
                if let Some(bridge_id) = answering {
                    super::hue::credential_store::adopt_bridge_owner(store, username, &bridge_id);
                }
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

/// List the bridge's Entertainment Areas for the area picker. Always a
/// forced round-trip so a newly created area shows up immediately.
#[tauri::command]
pub async fn list_hue_entertainment_areas(
    bridge_ip: String,
    username: String,
) -> HueEntertainmentAreaListResponse {
    if !is_valid_bridge_addr(&bridge_ip) {
        return HueEntertainmentAreaListResponse {
            status: command_status(
                "HUE_IP_INVALID",
                "Bridge IP is not a local-network IPv4 address.",
                Some("Use a value like 192.168.1.50".to_string()),
            ),
            areas: Vec::new(),
        };
    }

    let username = effective_hue_app_key(&username);
    if username.is_empty() {
        return HueEntertainmentAreaListResponse {
            status: command_status(
                "AUTH_INVALID_RE_PAIR_REQUIRED",
                "Hue bridge rejected our credentials. Re-pair the bridge to continue.",
                Some(NO_APP_KEY_DETAILS.to_string()),
            ),
            areas: Vec::new(),
        };
    }

    // User-initiated listing (area picker / refresh) — always a real trip so a
    // freshly created Entertainment Area shows up immediately.
    match load_hue_entertainment_areas(&bridge_ip, &username, HueReadFreshness::Force).await {
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
        // The area *list* keeps collapsing the two: retaining a last-known list
        // there is a separate consumer surface, not part of this change.
        Err(AreaListError::Other(message) | AreaListError::Unreachable(message)) => {
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

/// Sentinel in `HueStreamReadiness.reasons` (`HUE_READINESS_REASON` in
/// `hue.ts`): the area's `active_streamer` is set and is not known to be us.
pub(crate) const ACTIVE_STREAMER_REASON: &str = "HUE_STREAM_NOT_READY_ACTIVE_STREAMER";

/// Whose session an area's `active_streamer` is, as far as the caller knows.
///
/// The bridge names the streamer only by an `auth_v1` id, and ours would take
/// an extra `GET /auth/v1` to learn, so ownership is read from our own runtime
/// instead: if our live stream holds this bridge and area, the streamer is us.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ActiveStreamerView {
    /// Any active streamer blocks. Every gate that is about to start a session
    /// passes this — ours has been stopped by then, so a holder is foreign.
    Foreign,
    /// Our running session holds this area; its `active_streamer` is us and
    /// is not a reason the area is unready.
    Ours,
}

/// Frontend-facing readiness poll. Runs off the shared area-snapshot cache:
/// the Devices-tab loop and the App health reconciler (via
/// `get_hue_stream_status`) ask the same question seconds apart, and only one
/// of them needs to reach the bridge.
///
/// The `Result` is structural (a `State` argument requires it); every path is `Ok`.
#[tauri::command]
pub async fn check_hue_stream_readiness(
    bridge_ip: String,
    username: String,
    area_id: String,
    runtime_state: tauri::State<'_, HueRuntimeStateStore>,
) -> Result<HueStreamReadinessResponse, String> {
    let streamer = if streams_area(&runtime_state, &bridge_ip, &area_id) {
        ActiveStreamerView::Ours
    } else {
        ActiveStreamerView::Foreign
    };
    Ok(check_hue_stream_readiness_with_freshness(
        bridge_ip,
        username,
        area_id,
        HueReadFreshness::Cached,
        streamer,
    )
    .await)
}

/// Readiness with an explicit freshness policy. Anything that is about to
/// start, restart, or reconnect a stream passes `Force` — a gate decision must
/// never be taken on a snapshot that predates the mutation it is gating.
pub(crate) async fn check_hue_stream_readiness_with_freshness(
    bridge_ip: String,
    username: String,
    area_id: String,
    freshness: HueReadFreshness,
    streamer: ActiveStreamerView,
) -> HueStreamReadinessResponse {
    if !is_valid_bridge_addr(&bridge_ip) {
        return HueStreamReadinessResponse {
            status: command_status(
                "HUE_IP_INVALID",
                "Bridge IP is not a local-network IPv4 address.",
                Some("Use a value like 192.168.1.50".to_string()),
            ),
            readiness: HueStreamReadiness {
                ready: false,
                reasons: vec!["Invalid bridge IP address format.".to_string()],
            },
        };
    }

    let username = effective_hue_app_key(&username);
    if username.is_empty() {
        return HueStreamReadinessResponse {
            status: command_status(
                "AUTH_INVALID_RE_PAIR_REQUIRED",
                "Hue bridge rejected our credentials. Re-pair the bridge to continue.",
                Some(NO_APP_KEY_DETAILS.to_string()),
            ),
            readiness: HueStreamReadiness {
                ready: false,
                reasons: vec!["No stored Hue application key.".to_string()],
            },
        };
    }

    match load_hue_entertainment_areas(&bridge_ip, &username, freshness).await {
        Ok(areas) => evaluate_area_readiness(&areas, &area_id, streamer),
        Err(AreaListError::AuthInvalid) => {
            warn!("Hue readiness: the bridge refused the application key — re-pair required");
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
        Err(AreaListError::Other(message) | AreaListError::Unreachable(message)) => {
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

/// The readiness verdict for `area_id` on an area list the bridge returned.
fn evaluate_area_readiness(
    areas: &[HueEntertainmentArea],
    area_id: &str,
    streamer: ActiveStreamerView,
) -> HueStreamReadinessResponse {
    let Some(area) = areas.iter().find(|area| area.id == area_id) else {
        return HueStreamReadinessResponse {
            status: command_status(
                "HUE_STREAM_NOT_READY",
                "Selected Hue area was not found. Re-select an area and retry.",
                Some(format!("Missing areaId={area_id}")),
            ),
            readiness: HueStreamReadiness {
                ready: false,
                reasons: vec!["Selected area is unavailable on current bridge state.".to_string()],
            },
        };
    };

    let mut reasons = Vec::new();
    if area.channel_count == 0 {
        reasons.push("Selected area has no entertainment channels configured.".to_string());
    }
    if area.active_streamer && streamer == ActiveStreamerView::Foreign {
        reasons.push(ACTIVE_STREAMER_REASON.to_string());
    }

    let ready = reasons.is_empty();
    let only_active_streamer = reasons.len() == 1 && reasons[0] == ACTIVE_STREAMER_REASON;
    if ready && streamer == ActiveStreamerView::Ours {
        // Our own session answering the ~5 s health poll: nothing worth a line.
    } else if ready {
        info!("Hue stream readiness gate passed for area {area_id}");
    } else if only_active_streamer {
        // Another client holds the area; the frontend re-asks every 3 s until
        // it lets go, so this stays at debug.
        debug!("Hue stream readiness gate blocked by an active streamer for area {area_id}");
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

/// Interpret a 2xx `GET /clip/v2/resource/bridge` body as valid, invalid, or
/// unexpected. Only a `data[]` entry carrying `bridge_id` proves the key: that
/// resource is never served without one, unlike v1's public `/config`.
pub fn parse_bridge_resource_payload(payload: &str) -> HueValidateCredentialsResponse {
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

    let bridge_id = value
        .get("data")
        .and_then(|data| data.as_array())
        .and_then(|items| {
            items
                .iter()
                .find_map(|item| item.get("bridge_id").and_then(|id| id.as_str()))
        });
    if let Some(bridge_id) = bridge_id {
        return HueValidateCredentialsResponse {
            status: command_status(
                "HUE_CREDENTIAL_VALID",
                "Hue credentials are valid.",
                Some(format!("bridgeId={bridge_id}")),
            ),
            valid: true,
        };
    }

    // A 200 can still carry a refusal: v1 answers every call with HTTP 200 and
    // an `error.type == 1` envelope, and v2 may put one in `errors[]`.
    if super::hue_http::is_hue_unauthorized_body(payload) {
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
            Some("Response did not include a bridge_id or an authorization error.".to_string()),
        ),
        valid: false,
    }
}

/// Cache-aware front door to `fetch_hue_entertainment_areas`.
///
/// `check_hue_stream_readiness` and `get_hue_stream_status`'s internal
/// readiness chain both land here from independent frontend polling loops;
/// routing them through `hue::area_cache` collapses the overlapping polls
/// into one bridge round-trip. Callers that gate a mutation pass `Force`.
async fn load_hue_entertainment_areas(
    bridge_ip: &str,
    username: &str,
    freshness: HueReadFreshness,
) -> Result<Vec<HueEntertainmentArea>, AreaListError> {
    read_area_snapshot(bridge_ip, username, freshness, || {
        fetch_hue_entertainment_areas(bridge_ip, username)
    })
    .await
}

async fn fetch_hue_entertainment_areas(
    bridge_ip: &str,
    username: &str,
) -> Result<Vec<HueEntertainmentArea>, AreaListError> {
    if !is_valid_bridge_addr(bridge_ip) {
        return Err(AreaListError::Other(
            "Bridge IP is not a local-network IPv4 address".to_string(),
        ));
    }

    let client = async_client_for_key(username).map_err(AreaListError::Other)?;

    let entertainment_payload = fetch_entertainment_payload(&client, bridge_ip, username).await?;

    parse_area_list_payload(&entertainment_payload).map_err(AreaListError::Other)
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
        .map_err(|e| AreaListError::Unreachable(send_error_text(&e)))?;

    let response = classify_hue_response(raw)
        .await
        .map_err(|fault| match fault {
            HueHttpFault::AuthInvalid => AreaListError::AuthInvalid,
            other => AreaListError::Other(other.to_string()),
        })?;

    read_body(response).await.map_err(AreaListError::Other)
}

/// Carrier for `fetch_hue_entertainment_areas` faults. Keeps
/// `AuthInvalid` distinguishable from generic transient failures so the
/// public commands can collapse it onto the uniform
/// `AUTH_INVALID_RE_PAIR_REQUIRED` status code without string matching.
///
/// `Clone` so `hue::area_cache` can hand the same failure to every coalesced
/// caller instead of letting each one re-issue the round-trip.
#[derive(Clone, Debug)]
pub(crate) enum AreaListError {
    AuthInvalid,
    /// No answer at all — DNS, connect, TLS, timeout. Kept apart from `Other`
    /// because "the bridge said something we could not parse" and "the bridge
    /// said nothing" need opposite handling: one is a fault, the other is a
    /// reason to keep showing what we already knew.
    Unreachable(String),
    Other(String),
}

/// Parse a CLIP v2 `entertainment_configuration` payload into
/// `HueEntertainmentArea` entries.
pub fn parse_area_list_payload(payload: &str) -> Result<Vec<HueEntertainmentArea>, String> {
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

            HueEntertainmentArea {
                id,
                name,
                room_name: None,
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

/// The address answered with a certificate that is not the bridge's we expect
/// (or not a bridge's at all). Nothing carrying a secret was sent.
fn identity_mismatch_status(details: String) -> CommandStatus {
    command_status(
        "HUE_BRIDGE_IDENTITY_MISMATCH",
        "The device at this address is not the Hue bridge LumaSync paired with, or its certificate changed.",
        Some(details),
    )
}

/// Send a CLIP v1 request to the bridge, preferring HTTPS and falling back to
/// plain HTTP.
///
/// Hue Bridge Pro (2025) serves the local API on HTTPS/443 only — port 80 is
/// closed, so the legacy `http://<ip>/api` calls fail at the transport layer
/// and surface as a bogus `HUE_PAIRING_FAILED` (issue #167). Square v2 bridges
/// answer on both ports, so HTTPS-first is safe for every generation; the HTTP
/// retry only exists for older firmware whose TLS stack we cannot reach.
///
/// The fallback triggers on transport errors only, and never on a failed TLS
/// handshake (a refused certificate included): reqwest reports those as
/// connect errors too, and that failure is exactly what a downgrade attacker
/// manufactures. Once a bridge answers with any HTTP status the response is
/// returned untouched so `classify_hue_response` keeps owning the
/// 403/`error.type` re-pair contract.
///
/// `http_fallback` must stay `None` on the pairing call — it returns the
/// DTLS `clientkey`. See docs/architecture/hue.md (downgrade-attack constraint).
pub(crate) async fn send_clip_v1<F>(
    client: &Client,
    bridge_ip: &str,
    path: &str,
    http_fallback: Option<&Client>,
    build: F,
) -> Result<reqwest::Response, reqwest::Error>
where
    F: Fn(&Client, String) -> reqwest::RequestBuilder,
{
    let https_error = match build(client, format!("https://{bridge_ip}{path}"))
        .send()
        .await
    {
        Ok(response) => return Ok(response),
        Err(error) => error,
    };

    let Some(http_client) = http_fallback else {
        return Err(https_error);
    };
    if !https_error.is_connect() || is_tls_failure(&https_error) {
        return Err(https_error);
    }

    match build(http_client, format!("http://{bridge_ip}{path}"))
        .send()
        .await
    {
        Ok(response) => {
            info!("Hue bridge {bridge_ip} answered on plain HTTP after HTTPS failed");
            Ok(response)
        }
        // Surface the HTTPS failure: on a Bridge Pro that is the actionable one.
        Err(_) => Err(https_error),
    }
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
    use super::{
        parse_area_list_payload, parse_bridge_resource_payload, parse_discovery_payload,
        parse_pairing_payload,
    };

    // ── discovery ────────────────────────────────────────────────────────

    /// An empty list is a legitimate answer from the cloud discovery endpoint,
    /// not a failure: the manual-IP path is still open, and the code says so.
    #[test]
    fn an_empty_discovery_list_is_not_reported_as_a_failure() {
        let response = parse_discovery_payload("[]");

        assert_eq!(response.status.code, "HUE_DISCOVERY_EMPTY");
        assert!(response.bridges.is_empty());
    }

    #[test]
    fn a_discovered_bridge_carries_its_ip_into_the_display_name() {
        let response = parse_discovery_payload(
            r#"[{"id":"001788fffe123456","internalipaddress":"192.168.1.50"}]"#,
        );

        assert_eq!(response.status.code, "HUE_DISCOVERY_OK");
        assert_eq!(response.bridges.len(), 1);
        assert_eq!(response.bridges[0].ip, "192.168.1.50");
        assert_eq!(response.bridges[0].id, "001788fffe123456");
        assert!(response.bridges[0].name.contains("192.168.1.50"));
    }

    #[test]
    fn unparseable_discovery_json_fails_with_the_reason_attached() {
        let response = parse_discovery_payload("<html>gateway timeout</html>");

        assert_eq!(response.status.code, "HUE_DISCOVERY_FAILED");
        assert!(response.status.details.is_some());
    }

    // ── pairing ──────────────────────────────────────────────────────────

    #[test]
    fn pairing_succeeds_only_when_both_secrets_are_present() {
        let response =
            parse_pairing_payload(r#"[{"success":{"username":"app-key","clientkey":"PSK-HEX"}}]"#);

        assert_eq!(response.status.code, "HUE_PAIRING_OK");
        let credentials = response.credentials.expect("credentials on success");
        assert_eq!(credentials.username, "app-key");
        assert_eq!(credentials.client_key, "PSK-HEX");
    }

    /// Without `clientkey` there is no DTLS pre-shared key, so streaming could
    /// never start. Reporting this as success would strand the user at the next
    /// step with no explanation.
    #[test]
    fn a_success_missing_the_client_key_is_a_failure_not_a_partial_success() {
        let response = parse_pairing_payload(r#"[{"success":{"username":"app-key"}}]"#);

        assert_eq!(response.status.code, "HUE_PAIRING_FAILED");
        assert!(response.credentials.is_none());
    }

    /// Error 101 is the overwhelmingly common first-run case and the only one
    /// with an action the user can take, so it must not collapse into the
    /// catch-all.
    #[test]
    fn the_unpressed_link_button_gets_its_own_code() {
        let response = parse_pairing_payload(
            r#"[{"error":{"type":101,"description":"link button not pressed"}}]"#,
        );

        assert_eq!(response.status.code, "HUE_PAIRING_LINK_BUTTON_NOT_PRESSED");
        assert!(response.credentials.is_none());
    }

    #[test]
    fn each_recoverable_pairing_error_keeps_its_own_code() {
        for (payload, expected) in [
            (
                r#"[{"error":{"type":7,"description":"invalid value for devicetype"}}]"#,
                "HUE_PAIRING_DEVICETYPE_INVALID",
            ),
            (
                r#"[{"error":{"type":429,"description":"too many requests"}}]"#,
                "HUE_PAIRING_RATE_LIMITED",
            ),
            (
                r#"[{"error":{"type":503,"description":"bridge busy"}}]"#,
                "HUE_PAIRING_BRIDGE_BUSY",
            ),
        ] {
            assert_eq!(parse_pairing_payload(payload).status.code, expected);
        }
    }

    /// Type 7 is a generic "invalid value" — only the devicetype flavour has a
    /// dedicated code, and the rest must fall back rather than be mislabelled.
    #[test]
    fn a_type_7_that_is_not_about_devicetype_falls_back_to_the_catch_all() {
        let response =
            parse_pairing_payload(r#"[{"error":{"type":7,"description":"invalid value for x"}}]"#);

        assert_eq!(response.status.code, "HUE_PAIRING_FAILED");
    }

    #[test]
    fn an_unknown_pairing_error_type_collapses_to_the_catch_all() {
        let response =
            parse_pairing_payload(r#"[{"error":{"type":9999,"description":"who knows"}}]"#);

        assert_eq!(response.status.code, "HUE_PAIRING_FAILED");
    }

    // ── credential validation ────────────────────────────────────────────

    const BRIDGE_RESOURCE: &str =
        r#"{"errors":[],"data":[{"id":"b1","bridge_id":"ecb5fafffe123456","type":"bridge"}]}"#;

    #[test]
    fn a_bridge_resource_with_a_bridge_id_proves_the_credentials_work() {
        let response = parse_bridge_resource_payload(BRIDGE_RESOURCE);

        assert_eq!(response.status.code, "HUE_CREDENTIAL_VALID");
        assert_eq!(
            response.status.details.as_deref(),
            Some("bridgeId=ecb5fafffe123456")
        );
        assert!(response.valid);
    }

    /// The v1 public config — which the bridge serves for ANY key — must never
    /// validate. Accepting its `bridgeid` is how a bogus key passed.
    #[test]
    fn the_public_v1_config_does_not_prove_a_key() {
        let response = parse_bridge_resource_payload(
            r#"{"name":"Hue Bridge","bridgeid":"ECB5FAFFFE123456","apiversion":"1.78.0"}"#,
        );

        assert_eq!(response.status.code, "HUE_CREDENTIAL_CHECK_FAILED");
        assert!(!response.valid);
    }

    /// A refusal can arrive on a 200: v1's `error.type 1` envelope or a v2
    /// `errors[]` auth description.
    #[test]
    fn an_unauthorized_error_on_a_200_asks_for_a_re_pair() {
        for body in [
            r#"[{"error":{"type":1,"address":"/lights","description":"unauthorized user"}}]"#,
            r#"{"errors":[{"description":"unauthorized user"}],"data":[]}"#,
        ] {
            let response = parse_bridge_resource_payload(body);
            assert_eq!(response.status.code, "HUE_CREDENTIAL_INVALID", "{body}");
            assert!(!response.valid);
        }
    }

    /// A different error must NOT read as invalid credentials: that would send
    /// the user through a re-pair they do not need.
    #[test]
    fn another_error_type_is_inconclusive_rather_than_invalid() {
        let response = parse_bridge_resource_payload(
            r#"[{"error":{"type":3,"description":"resource not available"}}]"#,
        );

        assert_eq!(response.status.code, "HUE_CREDENTIAL_CHECK_FAILED");
        assert!(!response.valid);
    }

    // ── readiness ownership ──────────────────────────────────────────────

    fn held_area() -> super::HueEntertainmentArea {
        super::HueEntertainmentArea {
            id: "area-1".to_string(),
            name: "TV".to_string(),
            room_name: None,
            channel_count: 3,
            active_streamer: true,
        }
    }

    /// While our own session streams, the bridge reports us as the area's
    /// active streamer. That must not read as a foreign session holding it.
    #[test]
    fn our_own_session_is_not_a_foreign_active_streamer() {
        let response = super::evaluate_area_readiness(
            &[held_area()],
            "area-1",
            super::ActiveStreamerView::Ours,
        );
        assert_eq!(response.status.code, "HUE_STREAM_READY");
        assert!(response.readiness.ready);
        assert!(response.readiness.reasons.is_empty());
    }

    #[test]
    fn a_streamer_that_is_not_ours_blocks_with_the_sentinel() {
        let response = super::evaluate_area_readiness(
            &[held_area()],
            "area-1",
            super::ActiveStreamerView::Foreign,
        );
        assert_eq!(response.status.code, "HUE_STREAM_NOT_READY");
        assert_eq!(
            response.readiness.reasons,
            vec![super::ACTIVE_STREAMER_REASON.to_string()]
        );
    }

    /// Ownership only relaxes the streamer check, never the others.
    #[test]
    fn our_session_does_not_excuse_an_area_with_no_channels() {
        let mut area = held_area();
        area.channel_count = 0;
        let response =
            super::evaluate_area_readiness(&[area], "area-1", super::ActiveStreamerView::Ours);
        assert!(!response.readiness.ready);
        assert!(!response
            .readiness
            .reasons
            .contains(&super::ACTIVE_STREAMER_REASON.to_string()));
    }

    // ── credential validation against a local stand-in for the bridge ────

    fn serve_once(
        status: &str,
        content_type: &str,
        body: &str,
    ) -> (String, std::thread::JoinHandle<()>) {
        use std::io::{BufRead, BufReader, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!(
            "http://{}/clip/v2/resource/bridge",
            listener.local_addr().unwrap()
        );
        let reply = format!(
            "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        let handle = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            loop {
                let mut line = String::new();
                if reader.read_line(&mut line).unwrap() == 0 || line == "\r\n" {
                    break;
                }
            }
            stream.write_all(reply.as_bytes()).unwrap();
        });
        (endpoint, handle)
    }

    async fn validate_against(
        status: &str,
        content_type: &str,
        body: &str,
    ) -> super::HueValidateCredentialsResponse {
        let (endpoint, server) = serve_once(status, content_type, body);
        let client = reqwest::Client::new();
        let store = super::super::hue::credential_store::tests::InMemoryStore::default();
        let response =
            super::validate_app_key_at(&client, &endpoint, "192.168.1.180", "bogus", &store).await;
        server.join().unwrap();
        response
    }

    /// The hardware case: a bogus key on a BSB002 gets the bridge's HTML 403.
    #[tokio::test]
    async fn a_bogus_key_answered_with_the_bridges_html_403_is_invalid() {
        let response = validate_against(
            "403 Forbidden",
            "text/html",
            super::super::hue_http::tests::BRIDGE_403_PAGE,
        )
        .await;
        assert_eq!(response.status.code, "HUE_CREDENTIAL_INVALID");
        assert!(!response.valid);
    }

    #[tokio::test]
    async fn a_key_the_bridge_serves_its_resource_to_is_valid() {
        let response = validate_against("200 OK", "application/json", BRIDGE_RESOURCE).await;
        assert_eq!(response.status.code, "HUE_CREDENTIAL_VALID");
        assert!(response.valid);
    }

    /// A proxy's 403 is a reachability problem, never a dead key.
    #[tokio::test]
    async fn a_proxy_403_is_a_failed_check_not_an_invalid_key() {
        let response = validate_against(
            "403 Forbidden",
            "text/html",
            "<html><head><title>Forbidden</title></head></html>",
        )
        .await;
        assert_eq!(response.status.code, "HUE_CREDENTIAL_CHECK_FAILED");
    }

    // ── area list ────────────────────────────────────────────────────────

    /// The names deliberately mix cases so that a plain byte-order sort gives a
    /// *different* answer — ASCII puts every capital ahead of every lowercase,
    /// so `["alpha","Beta","Gamma","delta"]` would come back as
    /// `Beta, Gamma, alpha, delta`. Same-case data would pass either way and
    /// prove nothing.
    #[test]
    fn areas_come_back_sorted_case_insensitively_by_name() {
        let payload = r#"{"data":[
            {"id":"d","metadata":{"name":"delta"},"channels":[]},
            {"id":"b","metadata":{"name":"Beta"},"channels":[]},
            {"id":"g","metadata":{"name":"Gamma"},"channels":[]},
            {"id":"a","metadata":{"name":"alpha"},"channels":[]}
        ]}"#;

        let areas = parse_area_list_payload(payload).expect("valid payload");

        let names: Vec<&str> = areas.iter().map(|a| a.name.as_str()).collect();
        assert_eq!(names, vec!["alpha", "Beta", "delta", "Gamma"]);
    }

    /// `active_streamer` is what surfaces HUE_STREAM_NOT_READY_ACTIVE_STREAMER
    /// later, so a present-but-null value must read as "free", not "in use".
    #[test]
    fn a_null_active_streamer_means_the_area_is_free() {
        let payload = r#"{"data":[
            {"id":"a","metadata":{"name":"Free"},"channels":[],"active_streamer":null},
            {"id":"b","metadata":{"name":"Taken"},"channels":[],"active_streamer":{"rid":"x"}}
        ]}"#;

        let areas = parse_area_list_payload(payload).expect("valid payload");

        assert!(!areas[0].active_streamer, "explicit null is not a streamer");
        assert!(areas[1].active_streamer);
    }

    #[test]
    fn a_channel_count_is_read_from_the_channel_array_length() {
        let payload = r#"{"data":[
            {"id":"a","metadata":{"name":"Room"},"channels":[{"channel_id":0},{"channel_id":1}]}
        ]}"#;

        let areas = parse_area_list_payload(payload).expect("valid payload");

        assert_eq!(areas[0].channel_count, 2);
    }

    #[test]
    fn an_area_with_no_metadata_name_still_parses_with_a_placeholder() {
        let payload = r#"{"data":[{"id":"a","channels":[]}]}"#;

        let areas = parse_area_list_payload(payload).expect("valid payload");

        assert_eq!(areas[0].name, "Unnamed Area");
    }

    #[test]
    fn a_payload_with_no_data_array_is_an_error_not_an_empty_list() {
        assert!(parse_area_list_payload(r#"{"errors":[]}"#).is_err());
        assert!(parse_area_list_payload("not json").is_err());
    }
}
