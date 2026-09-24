//! Put an entertainment area's lights back the way they were before we
//! streamed to them.
//!
//! Ending entertainment (`action: stop`) makes the bridge put its own
//! post-stream state on each light — always **on**, and not necessarily the
//! brightness or colour it had — and that lands a few hundred ms *after* the
//! stop is acknowledged. So the state is read before the stream starts,
//! written back once Hue output ends, and written again where the bridge
//! undoes it. When each of those happens, and when none may, is in
//! docs/architecture/hue.md ("Lights return to their pre-stream state").

use std::collections::{HashMap, HashSet, VecDeque};
use std::time::{Duration, Instant};

use log::{info, warn};
use serde::Deserialize;
use serde_json::{json, Value};

use super::super::hue_http::{classify_hue_response_blocking, HueHttpFault};
use super::credential_store::REDACTED;
use super::sender::{RequestPacer, HUE_HTTP_FALLBACK_MAX_REQUESTS_PER_SEC};
use super::state_store::HueRuntimeOwner;
use super::transport::{blocking_client_for_key, read_body_blocking, send_error_text};

/// Ceiling on one interactive restore: a first pass over ~25 lights at the
/// ~10 req/s light budget, then the watch. A bigger area is restored as far
/// as the budget reaches.
pub(crate) const HUE_LIGHT_RESTORE_BUDGET: Duration = Duration::from_millis(4_000);

/// How long after the first pass the lights are watched for the bridge's own
/// post-entertainment state landing on top of ours. Measured on a BSB002 at
/// 300–600 ms after our writes; see docs/architecture/hue.md.
pub(crate) const HUE_LIGHT_RESTORE_WATCH: Duration = Duration::from_millis(1_500);

/// Gap between two reads of the lights during the watch.
const HUE_LIGHT_RESTORE_POLL_INTERVAL: Duration = Duration::from_millis(250);

/// A light the bridge keeps changing back is written again at most this many
/// times, so a user adjusting it in the Hue app is not fought for long.
const HUE_LIGHT_RESTORE_MAX_REAPPLY: u8 = 2;

const HUE_LIGHT_RESTORE_BRIGHTNESS_TOLERANCE: f64 = 1.0;
const HUE_LIGHT_RESTORE_MIREK_TOLERANCE: u16 = 2;
const HUE_LIGHT_RESTORE_XY_TOLERANCE: f64 = 0.01;

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

    /// The same lights, each to be written and watched as off. Everything the
    /// restore guards — the area check, the watch, the newer-session stop —
    /// holds unchanged, since an off light is compared on `on` alone.
    pub(crate) fn switched_off(mut self) -> Self {
        for light in &mut self.lights {
            light.state = HueLightState {
                on: false,
                brightness: None,
                color: None,
            };
        }
        self
    }
}

/// What a stop does to the area's lights once the stream has ended.
/// `ShellState.hueOffBehavior` in `src/shared/contracts/shell.ts` for the
/// persisted choice; every stop but a user's Off restores.
/// docs/architecture/hue.md ("Off turns the lights off").
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum HueLightsAfterStop {
    /// Put back what the lights were before the session first streamed.
    Restore,
    /// Switch every light of the area off.
    TurnOff,
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

/// Why a restore stopped before it was done.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum HueLightRestoreStop {
    Deadline,
    AuthInvalid,
    Unreachable(String),
    NoClient(String),
    /// Another streamer holds the area; its lights are not ours to write.
    AreaTaken,
    /// A newer session of ours began; writing now would paint under it.
    Superseded,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct HueLightRestoreReport {
    /// Lights the first pass wrote.
    pub(crate) restored: usize,
    /// Writes the watch repeated because the bridge had changed a light back.
    pub(crate) reapplied: usize,
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

/// What one watch poll read for a light.
enum LightReading {
    State(HueLightState),
    Streaming,
}

enum ReadFailure {
    /// Ends the restore, as it would a write.
    Stop(HueLightRestoreStop),
    /// This read is lost; the next one may land.
    Skip,
}

/// Write each snapshot back, paced to the bridge's light budget
/// (`HUE_HTTP_FALLBACK_MAX_REQUESTS_PER_SEC`), then watch the lights and
/// write again any the bridge changes back. Returns by `deadline` whatever the
/// bridge does. Blocking; never fatal — every outcome is logged and reported,
/// none is raised.
///
/// Must run after the area's `action: stop` has landed: during entertainment
/// the bridge overrides these writes. `superseded` is asked before every write
/// and every poll; once it answers `true` nothing more is written.
/// docs/architecture/hue.md ("Lights return to their pre-stream state").
pub(crate) fn restore_lights(
    restore: &HueLightRestore,
    deadline: Instant,
    superseded: &dyn Fn() -> bool,
) -> HueLightRestoreReport {
    let started = Instant::now();
    let total = restore.lights.len();
    let mut report = HueLightRestoreReport {
        restored: 0,
        reapplied: 0,
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
    let mut run = RestoreRun {
        client: &client,
        restore,
        deadline,
        superseded,
        pacer: RequestPacer::new(HUE_HTTP_FALLBACK_MAX_REQUESTS_PER_SEC),
    };

    if let Err(stop) = run.wait_for_area_free(deadline.min(started + HUE_LIGHT_RESTORE_WATCH)) {
        warn!(
            "[hue-restore] area {} left as is: {stop:?}",
            restore.area_id
        );
        report.stopped = Some(stop);
        return report;
    }

    let (written, stopped) = run.write(restore.lights.iter().collect());
    report.restored = written.len();
    report.stopped = stopped;
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

    if report.stopped.is_none() && !written.is_empty() {
        let watch_started = Instant::now();
        run.watch(&written, &mut report);
        info!(
            "[hue-restore] area {}: watched {:?}, re-applied {} write(s) the bridge undid ({:?})",
            restore.area_id,
            watch_started.elapsed(),
            report.reapplied,
            report.stopped
        );
    }
    report
}

struct RestoreRun<'a> {
    client: &'a reqwest::blocking::Client,
    restore: &'a HueLightRestore,
    deadline: Instant,
    superseded: &'a dyn Fn() -> bool,
    pacer: RequestPacer,
}

struct Watched<'a> {
    light: &'a HueLightSnapshot,
    reapplied: u8,
    holds: bool,
    gave_up: bool,
}

impl Watched<'_> {
    fn settled(&self) -> bool {
        self.gave_up || (self.reapplied > 0 && self.holds)
    }
}

impl RestoreRun<'_> {
    /// Time one request may take before `end`, or `None` when too little is
    /// left for one to complete.
    fn request_window(end: Instant) -> Option<Duration> {
        let left = end.saturating_duration_since(Instant::now());
        (left >= HUE_LIGHT_RESTORE_MIN_REQUEST_WINDOW)
            .then(|| HUE_LIGHT_RESTORE_REQUEST_TIMEOUT.min(left))
    }

    /// Sleep one poll interval, unless `end` comes first. `false` means stop.
    fn wait_for_next_poll(end: Instant) -> bool {
        let poll_at = Instant::now() + HUE_LIGHT_RESTORE_POLL_INTERVAL;
        if end.saturating_duration_since(poll_at) < HUE_LIGHT_RESTORE_MIN_REQUEST_WINDOW {
            return false;
        }
        std::thread::sleep(poll_at.saturating_duration_since(Instant::now()));
        true
    }

    /// Our own stream has ended by now, so a busy area is another streamer —
    /// or a reconnect of ours the stop overtook, which gives it back within
    /// moments. Waits until `end` for it to come free.
    fn wait_for_area_free(&mut self, end: Instant) -> Result<(), HueLightRestoreStop> {
        loop {
            if (self.superseded)() {
                return Err(HueLightRestoreStop::Superseded);
            }
            match self.area_is_active(end) {
                Ok(false) | Err(ReadFailure::Skip) => return Ok(()),
                Err(ReadFailure::Stop(stop)) => return Err(stop),
                Ok(true) => {}
            }
            if !Self::wait_for_next_poll(end) {
                return Err(HueLightRestoreStop::AreaTaken);
            }
        }
    }

    /// PUT each light, paced, retrying a throttled one once. Returns the
    /// lights the bridge took, and why it stopped early if it did.
    fn write<'l>(
        &mut self,
        lights: Vec<&'l HueLightSnapshot>,
    ) -> (Vec<&'l HueLightSnapshot>, Option<HueLightRestoreStop>) {
        let mut written = Vec::with_capacity(lights.len());
        let mut queue: VecDeque<(&HueLightSnapshot, u8)> =
            lights.into_iter().map(|light| (light, 0)).collect();

        while let Some((light, attempts)) = queue.pop_front() {
            let now = Instant::now();
            let slot_at = now + self.pacer.time_until_slot(now);
            if self.deadline.saturating_duration_since(slot_at)
                < HUE_LIGHT_RESTORE_MIN_REQUEST_WINDOW
            {
                return (written, Some(HueLightRestoreStop::Deadline));
            }
            std::thread::sleep(slot_at.saturating_duration_since(now));
            if (self.superseded)() {
                return (written, Some(HueLightRestoreStop::Superseded));
            }
            let now = Instant::now();
            self.pacer.consume(now);
            let timeout =
                HUE_LIGHT_RESTORE_REQUEST_TIMEOUT.min(self.deadline.saturating_duration_since(now));

            match put_light_state(self.client, self.restore, light, timeout) {
                PutOutcome::Restored => {
                    written.push(light);
                    self.pacer.on_success();
                }
                PutOutcome::Throttled(retry_after_ms) => {
                    self.pacer.on_throttle(retry_after_ms);
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
                        self.restore.area_id
                    );
                    return (written, Some(HueLightRestoreStop::AuthInvalid));
                }
                PutOutcome::Unreachable(reason) => {
                    warn!(
                        "[hue-restore] bridge unreachable, area {} left as is: {reason}",
                        self.restore.area_id
                    );
                    return (written, Some(HueLightRestoreStop::Unreachable(reason)));
                }
            }
        }
        (written, None)
    }

    /// After leaving entertainment the bridge puts its own idea of each
    /// light's state back, and on a real bridge that lands a few hundred ms
    /// *after* our writes. Poll the lights and write again any that no longer
    /// read as their snapshot, until every light has been written again and
    /// read back holding, or the watch window ends.
    fn watch(&mut self, written: &[&HueLightSnapshot], report: &mut HueLightRestoreReport) {
        let end = self.deadline.min(Instant::now() + HUE_LIGHT_RESTORE_WATCH);
        let mut watched: Vec<Watched> = written
            .iter()
            .map(|light| Watched {
                light,
                reapplied: 0,
                holds: true,
                gave_up: false,
            })
            .collect();

        while Self::wait_for_next_poll(end) {
            if (self.superseded)() {
                report.stopped = Some(HueLightRestoreStop::Superseded);
                return;
            }
            let readings = match self.read_lights(end) {
                Ok(readings) => readings,
                Err(ReadFailure::Skip) => continue,
                Err(ReadFailure::Stop(stop)) => {
                    report.stopped = Some(stop);
                    return;
                }
            };
            let streaming = watched.iter().any(|w| {
                matches!(
                    readings.get(&w.light.light_id),
                    Some(LightReading::Streaming)
                )
            });
            if streaming && matches!(self.area_is_active(end), Ok(true)) {
                report.stopped = Some(HueLightRestoreStop::AreaTaken);
                return;
            }

            let mut undone = Vec::new();
            for w in watched.iter_mut().filter(|w| !w.gave_up) {
                w.holds = match readings.get(&w.light.light_id) {
                    Some(LightReading::State(state)) => reads_as(&w.light.state, state),
                    // Not written until the bridge says the light left streaming.
                    Some(LightReading::Streaming) => continue,
                    None => continue,
                };
                if w.holds {
                    continue;
                }
                if w.reapplied < HUE_LIGHT_RESTORE_MAX_REAPPLY {
                    undone.push(w.light);
                } else {
                    w.gave_up = true;
                    warn!(
                        "[hue-restore] light {} changed again after {} re-writes; left as it is",
                        w.light.light_id, w.reapplied
                    );
                }
            }
            if !undone.is_empty() {
                let (again, stopped) = self.write(undone);
                report.reapplied += again.len();
                for light in again {
                    if let Some(w) = watched
                        .iter_mut()
                        .find(|w| w.light.light_id == light.light_id)
                    {
                        w.reapplied += 1;
                        w.holds = false;
                    }
                }
                if stopped.is_some() {
                    report.stopped = stopped;
                    return;
                }
            }
            if watched.iter().all(Watched::settled) {
                return;
            }
        }
    }

    /// One `GET /clip/v2/resource/light` — every light on the bridge in a
    /// single request, so the watch costs no light budget.
    fn read_lights(&self, end: Instant) -> Result<HashMap<String, LightReading>, ReadFailure> {
        let timeout = Self::request_window(end).ok_or(ReadFailure::Skip)?;
        let endpoint = format!("https://{}/clip/v2/resource/light", self.restore.bridge_ip);
        let body = self.get(&endpoint, timeout)?;
        let wanted: HashSet<&str> = self
            .restore
            .lights
            .iter()
            .map(|light| light.light_id.as_str())
            .collect();
        let mut readings = HashMap::new();
        for item in body
            .get("data")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let Some(id) = item.get("id").and_then(Value::as_str) else {
                continue;
            };
            if !wanted.contains(id) {
                continue;
            }
            let reading = if item.get("mode").and_then(Value::as_str) == Some("streaming") {
                Some(LightReading::Streaming)
            } else {
                parse_light_state(item).map(LightReading::State)
            };
            if let Some(reading) = reading {
                readings.insert(id.to_string(), reading);
            }
        }
        Ok(readings)
    }

    /// Does anyone stream to the area? Read the way readiness reads it.
    fn area_is_active(&self, end: Instant) -> Result<bool, ReadFailure> {
        if !is_safe_resource_id(&self.restore.area_id) {
            return Err(ReadFailure::Skip);
        }
        let timeout = Self::request_window(end).ok_or(ReadFailure::Skip)?;
        let endpoint = format!(
            "https://{}/clip/v2/resource/entertainment_configuration/{}",
            self.restore.bridge_ip, self.restore.area_id
        );
        let body = self.get(&endpoint, timeout)?;
        let Some(area) = body
            .get("data")
            .and_then(Value::as_array)
            .and_then(|data| data.first())
        else {
            return Err(ReadFailure::Skip);
        };
        Ok(area.get("status").and_then(Value::as_str) == Some("active")
            || area
                .get("active_streamer")
                .is_some_and(|streamer| !streamer.is_null()))
    }

    fn get(&self, endpoint: &str, timeout: Duration) -> Result<Value, ReadFailure> {
        let response = self
            .client
            .get(endpoint)
            .timeout(timeout)
            .header("hue-application-key", &self.restore.username)
            .send()
            .map_err(|err| {
                ReadFailure::Stop(HueLightRestoreStop::Unreachable(send_error_text(&err)))
            })?;
        match classify_hue_response_blocking(response) {
            Ok(response) => read_body_blocking(response)
                .ok()
                .and_then(|body| serde_json::from_str(&body).ok())
                .ok_or(ReadFailure::Skip),
            Err(HueHttpFault::AuthInvalid) => {
                Err(ReadFailure::Stop(HueLightRestoreStop::AuthInvalid))
            }
            Err(_) => Err(ReadFailure::Skip),
        }
    }
}

/// Does what the bridge reports read as the snapshot? Loose enough for the
/// bridge's own quantising of brightness (1/254 steps) and colour.
pub(crate) fn reads_as(snapshot: &HueLightState, reading: &HueLightState) -> bool {
    if snapshot.on != reading.on {
        return false;
    }
    if !snapshot.on {
        return true;
    }
    if let Some(want) = snapshot.brightness.filter(|b| *b > 0.0) {
        match reading.brightness {
            Some(have)
                if (have - want.min(100.0)).abs() <= HUE_LIGHT_RESTORE_BRIGHTNESS_TOLERANCE => {}
            _ => return false,
        }
    }
    match (snapshot.color, reading.color) {
        (None, _) => true,
        (Some(HueLightColor::Mirek(want)), Some(HueLightColor::Mirek(have))) => {
            want.abs_diff(have) <= HUE_LIGHT_RESTORE_MIREK_TOLERANCE
        }
        (Some(HueLightColor::Xy { x, y }), Some(HueLightColor::Xy { x: hx, y: hy })) => {
            (x - hx).abs() <= HUE_LIGHT_RESTORE_XY_TOLERANCE
                && (y - hy).abs() <= HUE_LIGHT_RESTORE_XY_TOLERANCE
        }
        _ => false,
    }
}

/// An id from the bridge, spliced into a path.
fn is_safe_resource_id(id: &str) -> bool {
    !id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

fn put_light_state(
    client: &reqwest::blocking::Client,
    restore: &HueLightRestore,
    light: &HueLightSnapshot,
    timeout: Duration,
) -> PutOutcome {
    if !is_safe_resource_id(&light.light_id) {
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

    /// The watch compares what the bridge reports with the snapshot: close
    /// enough for the bridge's own quantising, not for its post-stream state.
    #[test]
    fn a_light_reads_as_its_snapshot_within_the_bridges_rounding_only() {
        let ct = |on, brightness, mirek| HueLightState {
            on,
            brightness: Some(brightness),
            color: Some(HueLightColor::Mirek(mirek)),
        };
        let before = ct(true, 56.92, 446);
        assert!(reads_as(&before, &ct(true, 57.09, 447)));
        // What a BSB002 put on the lights after the stop, 2026-09-24.
        assert!(!reads_as(&before, &ct(true, 30.83, 367)));
        assert!(!reads_as(&before, &ct(true, 56.92, 367)));
        assert!(!reads_as(&before, &ct(false, 56.92, 446)));

        // An off light only has to be off.
        assert!(reads_as(&ct(false, 10.0, 200), &ct(false, 90.0, 400)));

        let xy = HueLightState {
            on: true,
            brightness: Some(40.0),
            color: Some(HueLightColor::Xy { x: 0.30, y: 0.30 }),
        };
        let mut near = xy.clone();
        near.color = Some(HueLightColor::Xy { x: 0.305, y: 0.296 });
        assert!(reads_as(&xy, &near));
        assert!(
            !reads_as(&xy, &ct(true, 40.0, 367)),
            "left in ct mode is not the xy colour"
        );
    }

    /// Off reuses the restore with every light's state replaced by "off": one
    /// `on` write per light, and a light the bridge switched back on no longer
    /// reads as holding, whatever colour it came back in.
    #[test]
    fn a_switched_off_restore_writes_off_alone_and_watches_on_alone() {
        let mut held = restore("area", &[("light-1", true), ("light-2", false)]);
        held.lights[0].state.brightness = Some(56.92);
        held.lights[0].state.color = Some(HueLightColor::Mirek(446));

        let off = held.switched_off();

        assert_eq!(off.area_id, "area");
        assert_eq!(off.lights.len(), 2);
        let lit = HueLightState {
            on: true,
            brightness: Some(30.83),
            color: Some(HueLightColor::Mirek(367)),
        };
        for light in &off.lights {
            assert_eq!(restore_body(&light.state), json!({ "on": { "on": false } }));
            assert!(!reads_as(&light.state, &lit));
            assert!(reads_as(
                &light.state,
                &HueLightState {
                    on: false,
                    ..lit.clone()
                }
            ));
        }
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
