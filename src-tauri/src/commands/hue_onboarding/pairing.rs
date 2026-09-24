//! Bridge pairing, credential-keychain migration, and credential validation
//! — the credential-lifecycle half of onboarding. Carved out of
//! `hue_onboarding.rs`.

use log::{error, info, warn};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::super::hue::area_cache::invalidate_hue_area_cache;
use super::super::hue::bridge_identity::BridgeTrust;
use super::super::hue::credential_store::{effective_hue_app_key, HueCredentialBackend};
use super::super::hue::transport::{
    answering_bridge_id, async_client, async_client_for_key, identity_rejection, read_body,
    send_error_text,
};
use super::super::hue_http::{classify_hue_response, HueHttpFault};
use super::super::status::CommandStatus;
use super::discovery::verify_hue_bridge_ip_input;
use super::{command_status, identity_mismatch_status, send_clip_v1, NO_APP_KEY_DETAILS};

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
    /// Backend used to persist the new credentials.
    /// Absent on legacy paths (rate-limited, bridge-busy, link-button-not-pressed).
    /// `"keychain"` ⇒ frontend SHOULD clear the legacy plaintext shellStore fields.
    /// `"plaintext-legacy"` ⇒ keychain unavailable, frontend keeps plaintext fallback.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub credential_storage_backend: Option<HueCredentialBackend>,
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
    pub backend: Option<HueCredentialBackend>,
}

/// Response for `validate_hue_credentials` — whether the stored bridge
/// credentials still work.
#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct HueValidateCredentialsResponse {
    pub status: CommandStatus,
    pub valid: bool,
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
    let store = super::super::hue::credential_store::default_store();
    pair_bridge_at(&client, &bridge_ip, store.as_ref()).await
}

/// The network half of `pair_hue_bridge`, split so a test can point it at a
/// local stand-in for the bridge and a store of its own.
pub(crate) async fn pair_bridge_at(
    client: &Client,
    bridge_ip: &str,
    store: &dyn super::super::hue::credential_store::SecretStore,
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
            // Opportunistically migrate the fresh credentials
            // into the OS keychain. If the keychain is unavailable we keep
            // the plaintext fallback path; the frontend uses the
            // `credentialStorageBackend` field on the response to decide
            // whether it can safely clear `shellStore.hueAppKey` /
            // `shellStore.hueClientKey` after a successful pairing.
            if let Some(creds) = result.credentials.as_ref() {
                if answering.is_none() {
                    warn!("[hue-cred] pairing answer carried no bridge certificate; pair unscoped");
                }
                let outcome =
                    super::super::hue::credential_store::migrate_hue_credentials_to_keychain(
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
                result.credential_storage_backend = Some(backend);
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
                super::super::hue::credential_store::MigrationOutcome::Failed.status_code(),
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
    let store = super::super::hue::credential_store::default_store();
    // No bridge context here: this is the boot cleanup for installs that
    // paired before the keychain existed, and the caller only carries the two
    // plaintext halves. The pair stays unscoped, which is exactly the
    // behaviour it already had, and the owner is recorded on the next
    // authenticated contact (`adopt_bridge_owner`) or real pairing. Adding a
    // bridge argument would be a command-surface change for a path that has
    // nothing to put in it.
    let outcome = super::super::hue::credential_store::migrate_hue_credentials_to_keychain(
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
        backend: Some(backend),
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
    let store = super::super::hue::credential_store::default_store();
    validate_app_key_at(&client, &endpoint, &bridge_ip, &username, store.as_ref()).await
}

/// The network half of `validate_hue_credentials`, split so a test can point
/// it at a local stand-in for the bridge and a store of its own.
pub(crate) async fn validate_app_key_at(
    client: &Client,
    endpoint: &str,
    bridge_ip: &str,
    username: &str,
    store: &dyn super::super::hue::credential_store::SecretStore,
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
                    super::super::hue::credential_store::adopt_bridge_owner(
                        store, username, &bridge_id,
                    );
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
/// compatibility with frontends that predate the specific pairing codes.
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
    if super::super::hue_http::is_hue_unauthorized_body(payload) {
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
