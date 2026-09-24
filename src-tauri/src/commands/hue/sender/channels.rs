//! Resolving entertainment-area channels and per-light metadata from the
//! bridge: the CLIP v2 GETs that describe what a stream will drive, before
//! any frame goes out. Carved out of `sender.rs`.

use std::collections::HashMap;

use log::warn;
use serde_json::{json, Value};

use super::super::super::hue_http::{classify_hue_response, HueHttpFault};
use super::super::super::hue_onboarding::AreaListError;
use super::super::frame::{channel_position_to_screen_region, HueAreaChannel};
use super::super::light_restore::{parse_light_state, HueLightSnapshot};
use super::super::state_store::HueChannelPlacementOverride;
use super::super::transport::{async_client_for_key, read_body, send_error_text};

// ---------------------------------------------------------------------------
// Channel resolution from the bridge
// ---------------------------------------------------------------------------

/// `AreaListError` rather than a bare `String`: `get_hue_area_channels` has to
/// collapse a 403 onto `AUTH_INVALID_RE_PAIR_REQUIRED` without matching on the
/// fault's `Display` text — the same rule the area-list path already follows.
pub(crate) async fn fetch_area_channels(
    bridge_ip: &str,
    username: &str,
    area_id: &str,
) -> Result<Vec<HueAreaChannel>, AreaListError> {
    let client = async_client_for_key(username).map_err(AreaListError::Other)?;
    let endpoint =
        format!("https://{bridge_ip}/clip/v2/resource/entertainment_configuration/{area_id}");
    // `error_for_status` bypassed the 403 classifier, so an expired key
    // surfaced as "this area has no channels" instead of a re-pair prompt.
    let response = client
        .get(endpoint)
        .header("hue-application-key", username)
        .send()
        .await
        .map_err(|error| AreaListError::Unreachable(send_error_text(&error)))?;
    let response = classify_hue_response(response)
        .await
        .map_err(|fault| match fault {
            HueHttpFault::AuthInvalid => AreaListError::AuthInvalid,
            other => AreaListError::Other(other.to_string()),
        })?;
    let payload = read_body(response).await.map_err(AreaListError::Other)?;

    let parsed: Value =
        serde_json::from_str(&payload).map_err(|error| AreaListError::Other(error.to_string()))?;
    let raw_channels = parsed
        .get("data")
        .and_then(|value| value.as_array())
        .and_then(|items| items.first())
        .and_then(|item| item.get("channels"))
        .and_then(|value| value.as_array())
        .ok_or_else(|| {
            AreaListError::Other("Missing channels in entertainment area payload".to_string())
        })?;

    fn push_unique(target: &mut Vec<String>, id: &str) {
        if !target.iter().any(|existing| existing == id) {
            target.push(id.to_string());
        }
    }

    async fn fetch_resource(
        client: &reqwest::Client,
        bridge_ip: &str,
        username: &str,
        rtype: &str,
        rid: &str,
    ) -> Result<Value, String> {
        let endpoint = format!("https://{bridge_ip}/clip/v2/resource/{rtype}/{rid}");
        // Same classifier bypass the outer `fetch_area_channels` GET had: bare
        // `error_for_status` collapses a Hue 403 into a generic status error,
        // so an expired application key can never promote to AuthInvalid.
        let response = client
            .get(endpoint)
            .header("hue-application-key", username)
            .send()
            .await
            .map_err(|error| send_error_text(&error))?;
        let response = classify_hue_response(response)
            .await
            .map_err(|fault| fault.to_string())?;
        let payload = read_body(response).await?;
        serde_json::from_str::<Value>(&payload).map_err(|error| error.to_string())
    }

    async fn resolve_to_light_ids(
        client: &reqwest::Client,
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
                match fetch_resource(client, bridge_ip, username, &current_rtype, &current_rid)
                    .await
                {
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
            let svc_array = item
                .get("light_services")
                .or_else(|| item.get("services"))
                .and_then(|value| value.as_array());
            if let Some(light_services) = svc_array {
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

    // Build one `HueAreaChannel` per entertainment channel, preserving position.
    let mut result: Vec<HueAreaChannel> = Vec::new();

    for (idx, raw_ch) in raw_channels.iter().enumerate() {
        // Extract the channel_id from the bridge payload.
        let channel_id = raw_ch
            .get("channel_id")
            .and_then(|v| v.as_u64())
            .unwrap_or(idx as u64) as u8;

        let (pos_x, pos_y, pos_z) = parse_channel_position(raw_ch);

        let screen_region = channel_position_to_screen_region(pos_x, pos_y);

        let mut light_ids: Vec<String> = Vec::new();

        let Some(members) = raw_ch.get("members").and_then(|value| value.as_array()) else {
            result.push(HueAreaChannel {
                channel_id,
                light_ids,
                screen_region,
                position_x: pos_x,
                position_y: pos_y,
                position_z: pos_z,
            });
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
            for light_id in resolve_to_light_ids(&client, bridge_ip, username, rtype, rid).await {
                push_unique(&mut light_ids, &light_id);
            }
        }

        result.push(HueAreaChannel {
            channel_id,
            light_ids,
            screen_region,
            position_x: pos_x,
            position_y: pos_y,
            position_z: pos_z,
        });
    }

    Ok(result)
}

/// A bridge channel's `position` as `(x, y, z)`. A missing `x`/`y` reads as
/// 0.0, but a missing `z` stays `None`: the height is carried to the room map,
/// and a made-up 0 would be seeded there as if the bridge had measured it.
pub(crate) fn parse_channel_position(raw_channel: &serde_json::Value) -> (f32, f32, Option<f32>) {
    let pos = raw_channel.get("position");
    let axis = |key: &str| pos.and_then(|p| p.get(key)).and_then(|v| v.as_f64());
    let x = axis("x").unwrap_or(0.0) as f32;
    let y = axis("y").unwrap_or(0.0) as f32;
    let z = axis("z").map(|z| (z as f32).clamp(-1.0, 1.0));
    (x, y, z)
}

/// Overlay the user's own placements onto a channel list fetched from the bridge.
///
/// Matched on `channel_id`, never on position in the list: an ordinal shifts the
/// moment a light leaves the area. A `channel_id` with no match is skipped and
/// the start still succeeds — it means the light is gone, not that we failed.
pub(crate) fn apply_channel_placements(
    channels: &mut [HueAreaChannel],
    placements: &[HueChannelPlacementOverride],
) {
    for placement in placements {
        let Some(channel) = channels
            .iter_mut()
            .find(|c| c.channel_id == placement.channel_id)
        else {
            continue;
        };
        channel.position_x = placement.position_x.clamp(-1.0, 1.0);
        channel.position_y = placement.position_y.clamp(-1.0, 1.0);
        if let Some(z) = placement.position_z {
            channel.position_z = Some(z.clamp(-1.0, 1.0));
        }
        // Always re-derived, never carried on the wire — that is what keeps the
        // region a label rather than a second writable source.
        channel.screen_region =
            channel_position_to_screen_region(channel.position_x, channel.position_y);
    }
}

// ---------------------------------------------------------------------------
// Per-light archetype + gamut metadata
// ---------------------------------------------------------------------------
//
// CLIP v2 `/resource/light/{id}` exposes a `color.gamut_type` field
// (`"A"`, `"B"`, `"C"`, or `"other"`) that we need before applying the
// per-bulb gamut triangle clip. The archetype string (e.g.
// `"hue_go"`, `"sultan_bulb"`) is also surfaced for telemetry and for
// future bulb-specific dimming curves.
//
// The fetch helper is `async` (uses the same `reqwest::Client` pool as
// `fetch_area_channels`) and must run **outside** the streaming hot
// path: callers should populate the cache once at runtime activation
// and then read it under the runtime lock during frame build. The cache
// itself is a plain `HashMap<lightId, HueLightMetadata>` so it can be
// embedded inside `HueActiveStreamContext` without extra synchronisation
// (the lock that protects the active stream context already covers it).

/// Hue per-bulb gamut type as advertised by the bridge under
/// `color.gamut_type` in the `/resource/light/{id}` payload. The four
/// canonical Hue gamuts are A (early bulbs), B (Hue v1 bulbs from
/// 2012-2016), C (modern Hue Color White & Ambiance), and `Other`
/// (unknown / fallback).
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum HueGamutType {
    A,
    B,
    C,
    Other,
}

impl HueGamutType {
    pub fn from_clip_str(value: &str) -> Self {
        match value.trim() {
            "A" | "a" => HueGamutType::A,
            "B" | "b" => HueGamutType::B,
            "C" | "c" => HueGamutType::C,
            _ => HueGamutType::Other,
        }
    }
}

/// Per-bulb metadata fetched from `/clip/v2/resource/light/{id}`. The
/// runtime keeps a `light_id → HueLightMetadata` cache so the streaming
/// hot path never hits the bridge to look up gamut info.
#[derive(Clone, Debug)]
pub struct HueLightMetadata {
    pub light_id: String,
    /// Bulb archetype (e.g. `"sultan_bulb"`, `"hue_go"`) reported by CLIP v2.
    ///
    /// Parsed and carried, read by nobody in production. The frame builder
    /// takes `gamut_type` and not this; the telemetry surface it was meant for
    /// was never built. Kept because bulb-specific dimming curves need it and
    /// re-deriving it means another CLIP round trip, but do not read the old
    /// note as a statement that something consumes it — nothing does.
    #[allow(dead_code)]
    pub archetype: Option<String>,
    /// Gamut triangle this bulb supports — read by the frame builder hot
    /// path for per-bulb CIE xy clipping.
    pub gamut_type: HueGamutType,
}

/// Parse a single CLIP v2 `/resource/light/{id}` response payload and
/// extract the archetype + gamut type. Public so the unit tests in
/// `sender::channels_tests` can exercise the parser without a live bridge.
pub fn parse_light_metadata(light_id: &str, payload: &Value) -> Option<HueLightMetadata> {
    let item = payload
        .get("data")
        .and_then(|v| v.as_array())
        .and_then(|items| items.first())?;
    let archetype = item
        .get("metadata")
        .and_then(|m| m.get("archetype"))
        .and_then(|a| a.as_str())
        .map(|s| s.to_string());
    let gamut_type = item
        .get("color")
        .and_then(|c| c.get("gamut_type"))
        .and_then(|g| g.as_str())
        .map(HueGamutType::from_clip_str)
        .unwrap_or(HueGamutType::Other);
    Some(HueLightMetadata {
        light_id: light_id.to_string(),
        archetype,
        gamut_type,
    })
}

/// Fetch `/clip/v2/resource/light/{light_id}` and return its `data[0]` item,
/// reusing a caller-supplied `reqwest::Client` so an entire batch of light
/// fetches (the pre-stream metadata pass) shares one client — and its pooled connection.
///
/// Errors propagate as a string so the caller can decide whether to fall back
/// to `HueGamutType::Other` (loud) or skip the clipping step (silent).
async fn fetch_light_item_with_client(
    client: &reqwest::Client,
    bridge_ip: &str,
    username: &str,
    light_id: &str,
) -> Result<Value, String> {
    // SECURITY: Validate light_id to prevent path traversal
    if !light_id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-')
    {
        return Err(format!("Invalid light_id format: {light_id}"));
    }

    let endpoint = format!("https://{bridge_ip}/clip/v2/resource/light/{light_id}");
    // Classified, not `error_for_status`-ed, so an expired key is named as such
    // rather than surfacing as a bare 403. Fail-soft contract is unchanged.
    let response = client
        .get(endpoint)
        .header("hue-application-key", username)
        .send()
        .await
        .map_err(|error| send_error_text(&error))?;
    let response = classify_hue_response(response)
        .await
        .map_err(|fault| fault.to_string())?;
    let body = read_body(response).await?;
    let mut value: Value = serde_json::from_str(&body).map_err(|error| error.to_string())?;
    value
        .get_mut("data")
        .and_then(|v| v.as_array_mut())
        .filter(|items| !items.is_empty())
        .map(|items| items.swap_remove(0))
        .ok_or_else(|| {
            format!("Bridge response for light `{light_id}` did not include a data array")
        })
}

/// Convenience: drain a slice of resolved channels into a flat list of
/// unique light ids. Used by the runtime to populate the metadata cache
/// in a single batch (one `fetch_light_item_with_client` call per light id).
pub fn unique_light_ids(channels: &[HueAreaChannel]) -> Vec<String> {
    let mut out = Vec::new();
    for ch in channels {
        for id in &ch.light_ids {
            if !out.iter().any(|existing: &String| existing == id) {
                out.push(id.clone());
            }
        }
    }
    out
}

/// Both things one `GET /clip/v2/resource/light/{id}` per light yields: the
/// gamut metadata the frame builder clips with, and the state a stop restores.
#[derive(Default)]
pub(crate) struct HueLightFetch {
    pub(crate) metadata: HashMap<String, HueLightMetadata>,
    pub(crate) states: Vec<HueLightSnapshot>,
}

/// Pre-fetch per-light metadata for every unique light id referenced by the
/// provided channels and return it as a ready-to-share `Arc<HashMap>`.
///
/// Metadata-only on purpose: the reconnect path uses this, and a reconnect must
/// never re-read the state a stop restores — by then the lights show our
/// stream, or the bridge's "colour restored, left on" state after one.
pub async fn fetch_light_metadata_for_channels(
    bridge_ip: &str,
    username: &str,
    channels: &[HueAreaChannel],
) -> HashMap<String, HueLightMetadata> {
    fetch_lights_for_channels(bridge_ip, username, channels)
        .await
        .metadata
}

/// Metadata and pre-stream state for every unique light in `channels`, from
/// one GET per light. The start path calls this right before the sender
/// activates the area, which makes it the snapshot point for the restore.
///
/// Failure mode is **graceful**: any single fetch error is swallowed (the
/// bridge response shape can vary across firmware versions and we never want
/// a metadata fetch to abort entertainment-area activation). The returned map
/// omits the failing light ids; the frame builder treats absent entries as
/// `HueGamutType::Other` and skips the per-bulb gamut clip — i.e. the bulb
/// keeps the v1.4 behaviour while the rest of the area benefits from the
/// per-bulb projection. A light missing from `states` is not restored.
///
/// Bridge fan-out is sequential: a typical Hue entertainment area has
/// 1-10 lights and CLIP v2 light fetches each return in <50 ms on a LAN,
/// well below the activation budget. If a future area type pushes that
/// envelope this helper can be parallelised with `futures::future::join_all`
/// without changing the public signature.
pub(crate) async fn fetch_lights_for_channels(
    bridge_ip: &str,
    username: &str,
    channels: &[HueAreaChannel],
) -> HueLightFetch {
    let mut out = HueLightFetch::default();
    // One client across every light fetch, mirroring how `fetch_area_channels`
    // threads a single client through its fan-out. If the client cannot be
    // built we cannot fetch any metadata — return the empty cache so the frame
    // builder treats every light as `HueGamutType::Other` (the graceful default).
    let client = match async_client_for_key(username) {
        Ok(client) => client,
        Err(err) => {
            warn!("light metadata HTTP client build failed: {err}; falling back to HueGamutType::Other for all lights");
            return out;
        }
    };
    for light_id in unique_light_ids(channels) {
        // Per-light graceful failure isolation: a single failed fetch logs and
        // is omitted from the cache; the others must still succeed. No `?` here.
        match fetch_light_item_with_client(&client, bridge_ip, username, &light_id).await {
            Ok(item) => {
                if let Some(state) = parse_light_state(&item) {
                    out.states.push(HueLightSnapshot {
                        light_id: light_id.clone(),
                        state,
                    });
                }
                if let Some(meta) = parse_light_metadata(&light_id, &json!({ "data": [item] })) {
                    out.metadata.insert(meta.light_id.clone(), meta);
                }
            }
            Err(err) => {
                warn!("light metadata fetch failed for `{light_id}`: {err}; falling back to HueGamutType::Other");
            }
        }
    }
    out
}
