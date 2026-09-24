//! Entertainment-area listing and stream-readiness gating — the "is this
//! area ready to stream" half of onboarding. Carved out of
//! `hue_onboarding.rs`.

use log::{debug, info, warn};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::super::hue::area_cache::{read_area_snapshot, HueReadFreshness};
use super::super::hue::credential_store::effective_hue_app_key;
use super::super::hue::state_store::{streams_area, HueRuntimeStateStore};
use super::super::hue::transport::{
    async_client_for_key, is_valid_bridge_addr, read_body, send_error_text,
};
use super::super::hue_http::{classify_hue_response, HueHttpFault};
use super::super::status::CommandStatus;
use super::{command_status, NO_APP_KEY_DETAILS};

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
#[derive(Clone, Serialize, Deserialize, Debug, PartialEq)]
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
pub(super) fn evaluate_area_readiness(
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
