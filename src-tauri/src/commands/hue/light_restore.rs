//! Put an entertainment area's lights back the way they were before we
//! streamed to them.
//!
//! Ending entertainment (`action: stop`) makes the bridge restore each light's
//! colour but leave it **on** — a light that was off before Ambilight is on
//! afterwards. So the state is read before the stream starts and written back
//! once Hue output ends. When each of those happens, and when neither may, is
//! in docs/architecture/hue.md ("Lights return to their pre-stream state").

use std::collections::VecDeque;
use std::time::{Duration, Instant};

use log::{info, warn};
use serde_json::{json, Value};

use super::super::hue_http::{classify_hue_response_blocking, HueHttpFault};
use super::credential_store::REDACTED;
use super::sender::{RequestPacer, HUE_HTTP_FALLBACK_MAX_REQUESTS_PER_SEC};
use super::state_store::HueRuntimeOwner;
use super::transport::{blocking_client_for_key, read_body_blocking, send_error_text};

/// Ceiling on one interactive restore. At the ~10 req/s light budget this
/// covers ~25 lights; a bigger area is restored as far as the budget reaches.
pub(crate) const HUE_LIGHT_RESTORE_BUDGET: Duration = Duration::from_millis(2_500);

/// Longest one restore PUT may take. A bridge that stops answering costs one
/// of these, not the whole budget: a send failure ends the restore.
const HUE_LIGHT_RESTORE_REQUEST_TIMEOUT: Duration = Duration::from_millis(1_500);

/// Below this much time left a request cannot complete; stop instead of
/// firing one the deadline will cut off.
const HUE_LIGHT_RESTORE_MIN_REQUEST_WINDOW: Duration = Duration::from_millis(50);

/// A throttled light is tried again at most this many times in one restore.
const HUE_LIGHT_RESTORE_MAX_ATTEMPTS: u8 = 2;

/// The light's active colour mode. CLIP v2 reports `color.xy` in both modes,
/// so the mode is read from `color_temperature.mirek_valid`, not from which
/// field is present.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum HueLightColor {
    Xy { x: f64, y: f64 },
    Mirek(u16),
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct HueLightState {
    pub(crate) on: bool,
    /// Absent on a light with no `dimming` (an on/off plug).
    pub(crate) brightness: Option<f64>,
    /// Absent on a light with no colour or colour-temperature feature.
    pub(crate) color: Option<HueLightColor>,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct HueLightSnapshot {
    pub(crate) light_id: String,
    pub(crate) state: HueLightState,
}

/// What one logical Hue session found before it first started streaming,
/// keyed by bridge + area. Held in `HueRuntimeOwner::light_restore`.
#[derive(Clone)]
pub(crate) struct HueLightRestore {
    pub(crate) bridge_ip: String,
    pub(crate) username: String,
    pub(crate) area_id: String,
    pub(crate) lights: Vec<HueLightSnapshot>,
}

impl std::fmt::Debug for HueLightRestore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HueLightRestore")
            .field("bridge_ip", &self.bridge_ip)
            .field("username", &REDACTED)
            .field("area_id", &self.area_id)
            .field("lights", &self.lights)
            .finish()
    }
}

impl HueLightRestore {
    fn is_for(&self, bridge_ip: &str, area_id: &str) -> bool {
        self.bridge_ip == bridge_ip && self.area_id == area_id
    }
}

/// Parse the restorable state out of one `data[]` item of
/// `GET /clip/v2/resource/light/{id}`. `None` when there is nothing we could
/// faithfully write back: no `on` feature, or the light is already `streaming`
/// (its current state belongs to a streamer, not to the user).
pub(crate) fn parse_light_state(item: &Value) -> Option<HueLightState> {
    let on = item.get("on")?.get("on")?.as_bool()?;
    if item.get("mode").and_then(Value::as_str) == Some("streaming") {
        return None;
    }
    let brightness = item
        .get("dimming")
        .and_then(|dimming| dimming.get("brightness"))
        .and_then(Value::as_f64);

    let temperature = item.get("color_temperature");
    let mirek = temperature
        .and_then(|ct| ct.get("mirek"))
        .and_then(Value::as_u64)
        .and_then(|mirek| u16::try_from(mirek).ok());
    // `mirek` is null outside the ct spectrum and `mirek_valid` says whether a
    // present one is live. A bridge that omits the flag gets the value's word.
    let mirek_valid = temperature
        .and_then(|ct| ct.get("mirek_valid"))
        .and_then(Value::as_bool)
        .unwrap_or(mirek.is_some());
    let xy = item
        .get("color")
        .and_then(|color| color.get("xy"))
        .and_then(|xy| Some((xy.get("x")?.as_f64()?, xy.get("y")?.as_f64()?)));

    let color = match (mirek, mirek_valid, xy) {
        (Some(mirek), true, _) => Some(HueLightColor::Mirek(mirek)),
        (_, _, Some((x, y))) => Some(HueLightColor::Xy { x, y }),
        _ => None,
    };

    Some(HueLightState {
        on,
        brightness,
        color,
    })
}

/// The PUT body that puts one light back. An off light gets `on` alone: v1
/// refused colour writes to an off light, and the bridge has already put its
/// colour back on leaving entertainment.
pub(crate) fn restore_body(state: &HueLightState) -> Value {
    if !state.on {
        return json!({ "on": { "on": false } });
    }
    let mut body = json!({ "on": { "on": true } });
    if let Some(brightness) = state.brightness.filter(|b| *b > 0.0) {
        body["dimming"] = json!({ "brightness": brightness.min(100.0) });
    }
    match state.color {
        Some(HueLightColor::Mirek(mirek)) => {
            body["color_temperature"] = json!({ "mirek": mirek });
        }
        Some(HueLightColor::Xy { x, y }) => {
            body["color"] = json!({ "xy": { "x": x, "y": y } });
        }
        None => {}
    }
    body
}

// ---------------------------------------------------------------------------
// Session bookkeeping — every fn here runs under the runtime lock, no I/O
// ---------------------------------------------------------------------------

/// Hold a freshly captured snapshot, unless this bridge + area already has
/// one. An existing one is from before the *first* start of the session;
/// anything read since shows our own stream or the bridge's post-stream
/// "restored but on" state, which is exactly what must not be written back.
pub(crate) fn adopt_light_snapshot(owner: &mut HueRuntimeOwner, fresh: HueLightRestore) {
    if let Some(held) = owner.light_restore.as_mut() {
        if held.is_for(&fresh.bridge_ip, &fresh.area_id) {
            // Same session — keep its lights, but address the bridge with
            // the key in use now (a re-pair in between replaced it).
            held.username = fresh.username;
            return;
        }
    }
    if fresh.lights.is_empty() {
        return;
    }
    if let Some(displaced) = owner.light_restore.replace(fresh) {
        // `take_light_restore_for_other_area` runs first on every start, so
        // this is only reachable if two starts interleave.
        warn!(
            "[hue-restore] dropped the snapshot of area {} without restoring it",
            displaced.area_id
        );
    }
}

/// A snapshot for a different bridge or area than the one about to start.
/// Its session ended without a stop (a failed or refused run), so its lights
/// are restored before the new area is read.
pub(crate) fn take_light_restore_for_other_area(
    owner: &mut HueRuntimeOwner,
    bridge_ip: &str,
    area_id: &str,
) -> Option<HueLightRestore> {
    match owner.light_restore.as_ref() {
        Some(held) if !held.is_for(bridge_ip, area_id) => owner.light_restore.take(),
        _ => None,
    }
}

/// The snapshot a start abandoned mid-way should restore: the session's own
/// if one is held (it predates everything), else what this start captured.
pub(crate) fn take_light_restore_for_abandoned_start(
    owner: &mut HueRuntimeOwner,
    fresh: HueLightRestore,
) -> HueLightRestore {
    owner
        .light_restore
        .take_if(|held| held.is_for(&fresh.bridge_ip, &fresh.area_id))
        .unwrap_or(fresh)
}

// ---------------------------------------------------------------------------
// The restore itself
// ---------------------------------------------------------------------------

/// Why a restore stopped before every light was written.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum HueLightRestoreStop {
    Deadline,
    AuthInvalid,
    Unreachable(String),
    NoClient(String),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct HueLightRestoreReport {
    pub(crate) restored: usize,
    pub(crate) total: usize,
    pub(crate) stopped: Option<HueLightRestoreStop>,
}

enum PutOutcome {
    Restored,
    Throttled(Option<u64>),
    Rejected(String),
    AuthInvalid,
    Unreachable(String),
}

/// Write each snapshot back, paced to the bridge's light budget
/// (`HUE_HTTP_FALLBACK_MAX_REQUESTS_PER_SEC`), and return by `deadline`
/// whatever the bridge does. Blocking; never fatal — every outcome is logged
/// and reported, none is raised.
///
/// Must run after the area's `action: stop` has landed: during entertainment
/// the bridge overrides these writes and then puts its own state back.
pub(crate) fn restore_lights(
    restore: &HueLightRestore,
    deadline: Instant,
) -> HueLightRestoreReport {
    let started = Instant::now();
    let total = restore.lights.len();
    let mut report = HueLightRestoreReport {
        restored: 0,
        total,
        stopped: None,
    };
    if total == 0 {
        return report;
    }
    let client = match blocking_client_for_key(&restore.username) {
        Ok(client) => client,
        Err(err) => {
            warn!(
                "[hue-restore] no HTTP client, area {} left as is: {err}",
                restore.area_id
            );
            report.stopped = Some(HueLightRestoreStop::NoClient(err));
            return report;
        }
    };

    let mut pacer = RequestPacer::new(HUE_HTTP_FALLBACK_MAX_REQUESTS_PER_SEC);
    let mut queue: VecDeque<(&HueLightSnapshot, u8)> =
        restore.lights.iter().map(|light| (light, 0)).collect();

    while let Some((light, attempts)) = queue.pop_front() {
        let now = Instant::now();
        let slot_at = now + pacer.time_until_slot(now);
        if deadline.saturating_duration_since(slot_at) < HUE_LIGHT_RESTORE_MIN_REQUEST_WINDOW {
            report.stopped = Some(HueLightRestoreStop::Deadline);
            break;
        }
        std::thread::sleep(slot_at.saturating_duration_since(now));
        let now = Instant::now();
        pacer.consume(now);
        let timeout =
            HUE_LIGHT_RESTORE_REQUEST_TIMEOUT.min(deadline.saturating_duration_since(now));

        match put_light_state(&client, restore, light, timeout) {
            PutOutcome::Restored => {
                report.restored += 1;
                pacer.on_success();
            }
            PutOutcome::Throttled(retry_after_ms) => {
                pacer.on_throttle(retry_after_ms);
                if attempts + 1 < HUE_LIGHT_RESTORE_MAX_ATTEMPTS {
                    queue.push_back((light, attempts + 1));
                } else {
                    warn!(
                        "[hue-restore] light {} still throttled, left as is",
                        light.light_id
                    );
                }
            }
            PutOutcome::Rejected(reason) => {
                warn!(
                    "[hue-restore] light {} refused the restore: {reason}",
                    light.light_id
                );
            }
            PutOutcome::AuthInvalid => {
                warn!(
                    "[hue-restore] the bridge refused the application key (re-pair required); \
                     area {} left as the bridge restored it",
                    restore.area_id
                );
                report.stopped = Some(HueLightRestoreStop::AuthInvalid);
                break;
            }
            PutOutcome::Unreachable(reason) => {
                warn!(
                    "[hue-restore] bridge unreachable, area {} left as is: {reason}",
                    restore.area_id
                );
                report.stopped = Some(HueLightRestoreStop::Unreachable(reason));
                break;
            }
        }
    }

    let elapsed = started.elapsed();
    if report.restored == total {
        info!(
            "[hue-restore] area {}: restored {}/{} light(s) in {elapsed:?}",
            restore.area_id, report.restored, total
        );
    } else {
        warn!(
            "[hue-restore] area {}: restored {}/{} light(s) in {elapsed:?} ({:?})",
            restore.area_id, report.restored, total, report.stopped
        );
    }
    report
}

fn put_light_state(
    client: &reqwest::blocking::Client,
    restore: &HueLightRestore,
    light: &HueLightSnapshot,
    timeout: Duration,
) -> PutOutcome {
    // The id came from the bridge, but it is spliced into a path.
    if !light
        .light_id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-')
    {
        return PutOutcome::Rejected(format!("invalid light id `{}`", light.light_id));
    }
    let endpoint = format!(
        "https://{}/clip/v2/resource/light/{}",
        restore.bridge_ip, light.light_id
    );
    let response = match client
        .put(endpoint)
        .timeout(timeout)
        .header("hue-application-key", &restore.username)
        .json(&restore_body(&light.state))
        .send()
    {
        Ok(response) => response,
        Err(err) => return PutOutcome::Unreachable(send_error_text(&err)),
    };
    match classify_hue_response_blocking(response) {
        Ok(response) => {
            // A 2xx can still carry per-property refusals in `errors[]`.
            let body = read_body_blocking(response).unwrap_or_default();
            let errors = serde_json::from_str::<Value>(&body)
                .ok()
                .and_then(|value| value.get("errors").and_then(Value::as_array).cloned())
                .unwrap_or_default();
            if errors.is_empty() {
                PutOutcome::Restored
            } else {
                PutOutcome::Rejected(Value::Array(errors).to_string())
            }
        }
        Err(HueHttpFault::AuthInvalid) => PutOutcome::AuthInvalid,
        Err(fault) => match fault.throttle_hint() {
            Some(retry_after_ms) => PutOutcome::Throttled(retry_after_ms),
            None => PutOutcome::Rejected(fault.to_string()),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn light(payload: Value) -> Option<HueLightState> {
        parse_light_state(&payload)
    }

    fn restore(area_id: &str, lights: &[(&str, bool)]) -> HueLightRestore {
        HueLightRestore {
            bridge_ip: "192.168.1.2".to_string(),
            username: "key".to_string(),
            area_id: area_id.to_string(),
            lights: lights
                .iter()
                .map(|(id, on)| HueLightSnapshot {
                    light_id: id.to_string(),
                    state: HueLightState {
                        on: *on,
                        brightness: None,
                        color: None,
                    },
                })
                .collect(),
        }
    }

    /// The shape read off a real bridge (2026-09-23), off and in ct mode.
    #[test]
    fn a_ct_light_is_read_as_ct_even_though_it_reports_xy_too() {
        let state = light(json!({
            "on": { "on": false },
            "dimming": { "brightness": 30.83, "min_dim_level": 0.1 },
            "color": { "xy": { "x": 0.4583, "y": 0.4099 } },
            "color_temperature": { "mirek": 367, "mirek_valid": true },
            "mode": "normal"
        }))
        .unwrap();
        assert!(!state.on);
        assert_eq!(state.brightness, Some(30.83));
        assert_eq!(state.color, Some(HueLightColor::Mirek(367)));
    }

    #[test]
    fn an_xy_light_is_read_as_xy_when_mirek_is_not_valid() {
        let state = light(json!({
            "on": { "on": true },
            "dimming": { "brightness": 80.0 },
            "color": { "xy": { "x": 0.2, "y": 0.3 } },
            "color_temperature": { "mirek": null, "mirek_valid": false }
        }))
        .unwrap();
        assert_eq!(state.color, Some(HueLightColor::Xy { x: 0.2, y: 0.3 }));

        // A stale number beside `mirek_valid: false` is still not ct.
        let stale = light(json!({
            "on": { "on": true },
            "color": { "xy": { "x": 0.2, "y": 0.3 } },
            "color_temperature": { "mirek": 250, "mirek_valid": false }
        }))
        .unwrap();
        assert_eq!(stale.color, Some(HueLightColor::Xy { x: 0.2, y: 0.3 }));
    }

    #[test]
    fn a_plug_and_a_streaming_light_are_read_for_what_they_are() {
        let plug = light(json!({ "on": { "on": true } })).unwrap();
        assert_eq!(plug.brightness, None);
        assert_eq!(plug.color, None);

        assert!(light(json!({ "on": { "on": true }, "mode": "streaming" })).is_none());
        assert!(light(json!({ "dimming": { "brightness": 3.0 } })).is_none());
    }

    #[test]
    fn an_off_light_is_only_switched_off() {
        let body = restore_body(&HueLightState {
            on: false,
            brightness: Some(30.0),
            color: Some(HueLightColor::Mirek(367)),
        });
        assert_eq!(body, json!({ "on": { "on": false } }));
    }

    #[test]
    fn an_on_light_gets_its_brightness_and_only_its_active_colour_mode() {
        let ct = restore_body(&HueLightState {
            on: true,
            brightness: Some(30.83),
            color: Some(HueLightColor::Mirek(367)),
        });
        assert_eq!(
            ct,
            json!({
                "on": { "on": true },
                "dimming": { "brightness": 30.83 },
                "color_temperature": { "mirek": 367 }
            })
        );

        let xy = restore_body(&HueLightState {
            on: true,
            brightness: Some(55.0),
            color: Some(HueLightColor::Xy { x: 0.2, y: 0.3 }),
        });
        assert_eq!(
            xy,
            json!({
                "on": { "on": true },
                "dimming": { "brightness": 55.0 },
                "color": { "xy": { "x": 0.2, "y": 0.3 } }
            })
        );
    }

    #[test]
    fn a_second_start_of_the_same_session_keeps_the_first_snapshot() {
        let mut owner = HueRuntimeOwner::default();
        adopt_light_snapshot(&mut owner, restore("area", &[("light-1", false)]));
        let mut later = restore("area", &[("light-1", true)]);
        later.username = "re-paired".to_string();
        adopt_light_snapshot(&mut owner, later);

        let held = owner.light_restore.as_ref().unwrap();
        assert!(
            !held.lights[0].state.on,
            "the streamed state replaced the original"
        );
        assert_eq!(held.username, "re-paired");
    }

    #[test]
    fn another_area_is_handed_back_for_restore_and_an_empty_capture_holds_nothing() {
        let mut owner = HueRuntimeOwner::default();
        adopt_light_snapshot(&mut owner, restore("area", &[]));
        assert!(owner.light_restore.is_none());

        adopt_light_snapshot(&mut owner, restore("area-a", &[("light-1", false)]));
        assert!(take_light_restore_for_other_area(&mut owner, "192.168.1.2", "area-a").is_none());
        let other = take_light_restore_for_other_area(&mut owner, "192.168.1.2", "area-b").unwrap();
        assert_eq!(other.area_id, "area-a");
        assert!(owner.light_restore.is_none());
    }

    #[test]
    fn an_abandoned_start_prefers_the_session_snapshot() {
        let mut owner = HueRuntimeOwner::default();
        adopt_light_snapshot(&mut owner, restore("area", &[("light-1", false)]));
        let chosen = take_light_restore_for_abandoned_start(
            &mut owner,
            restore("area", &[("light-1", true)]),
        );
        assert!(!chosen.lights[0].state.on);
        assert!(owner.light_restore.is_none());

        let fresh = take_light_restore_for_abandoned_start(
            &mut owner,
            restore("area", &[("light-1", true)]),
        );
        assert!(fresh.lights[0].state.on);
    }
}
