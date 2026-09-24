//! HTTP-fallback sender: per-light `PUT /clip/v2/resource/light/{id}` when
//! DTLS is unavailable, paced against the bridge's documented request
//! budget. Carved out of `sender.rs`.

use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use log::{info, warn};
use reqwest::blocking::Client as BlockingClient;
use serde_json::json;

use super::super::super::hue_http::classify_hue_response_blocking;
use super::super::frame::{HueAreaChannel, HueColorSender, HueFrameRx, HueRgb};
use super::entertainment::{new_shutdown_signal, signal_shutdown_complete, ShutdownSignal};

// ---------------------------------------------------------------------------
// HTTP-fallback request budget
// ---------------------------------------------------------------------------

/// Ceiling on `PUT /clip/v2/resource/light/{id}` calls the HTTP fallback may
/// issue in any one-second window.
///
/// Signify's published guidance is ~10 commands/s to `/lights` for the **whole
/// bridge** (ZigBee tops out near 25/s in practice), and 1/s to `/groups`. We
/// spend the light budget, as an app-wide total rather than a per-light one.
pub(crate) const HUE_HTTP_FALLBACK_MAX_REQUESTS_PER_SEC: u32 = 10;

/// Widest the pacer may stretch under sustained throttling. Past this the
/// fallback is visibly broken anyway and stretching further only delays the
/// recovery once the bridge frees up.
pub(super) const HUE_HTTP_FALLBACK_MAX_INTERVAL_MS: u64 = 4_000;

/// How long the loop parks when every light is already up to date. Only
/// bounds the idle wakeup rate — a channel disconnect wakes `recv_timeout`
/// immediately regardless.
const HUE_HTTP_FALLBACK_IDLE_WAIT: Duration = Duration::from_millis(500);

/// Fault-aware request pacer: hands out one send slot at a time and widens
/// its own interval when the bridge says it is being pushed too hard.
///
/// The interval is the whole budget — callers must take exactly one slot per
/// request, never per batch. That is the difference between this and the
/// per-iteration sleep it replaced.
#[derive(Debug)]
pub(crate) struct RequestPacer {
    /// Fastest the pacer will ever go — the documented bridge budget.
    pub(super) floor: Duration,
    ceiling: Duration,
    pub(super) interval: Duration,
    next_slot: Instant,
}

impl RequestPacer {
    pub(crate) fn new(max_requests_per_sec: u32) -> Self {
        let floor = Duration::from_micros(1_000_000 / u64::from(max_requests_per_sec.max(1)));
        Self {
            floor,
            ceiling: Duration::from_millis(HUE_HTTP_FALLBACK_MAX_INTERVAL_MS),
            interval: floor,
            next_slot: Instant::now(),
        }
    }

    pub(crate) fn time_until_slot(&self, now: Instant) -> Duration {
        self.next_slot.saturating_duration_since(now)
    }

    fn slot_due(&self, now: Instant) -> bool {
        now >= self.next_slot
    }

    /// Take the current slot. Anchoring on `max(now, next_slot)` is what
    /// makes the budget a real ceiling: without it, a request that overran
    /// its slot would leave `next_slot` in the past and let the loop fire a
    /// catch-up burst that blows the one-second window wide open.
    pub(crate) fn consume(&mut self, now: Instant) {
        self.next_slot = now.max(self.next_slot) + self.interval;
    }

    pub(crate) fn on_success(&mut self) {
        if self.interval > self.floor {
            self.interval = (self.interval * 9 / 10).max(self.floor);
        }
    }

    /// Widen after a throttle signal, honouring a bridge-supplied
    /// `Retry-After` when it asks for more than our own doubling would.
    pub(crate) fn on_throttle(&mut self, retry_after_ms: Option<u64>) {
        let doubled = self.interval * 2;
        let requested = retry_after_ms
            .map(Duration::from_millis)
            .unwrap_or(Duration::ZERO);
        self.interval = doubled.max(requested).clamp(self.floor, self.ceiling);
    }
}

// ---------------------------------------------------------------------------
// HTTP-fallback per-light PUT sink
// ---------------------------------------------------------------------------

/// Result of one per-light PUT, reduced to the three outcomes the pacing loop
/// reacts to differently.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum LightPutOutcome {
    Ok,
    /// The bridge asked us to slow down (429, or a 5xx from a saturated
    /// ZigBee queue). Carries `Retry-After` in ms when supplied.
    Throttled(Option<u64>),
    /// Anything else. The light is left alone until its colour changes
    /// again — retrying a request the bridge rejected on its merits would
    /// just burn budget the other lights need.
    Failed,
}

/// Injection seam for [`run_http_fallback_loop`] so the request-budget
/// invariant is testable without a bridge.
pub(super) trait LightPutSink {
    fn put_light(&self, light_id: &str, x: f64, y: f64, dimming: f64) -> LightPutOutcome;
}

/// Real sink: one `PUT /clip/v2/resource/light/{id}` per call, classified
/// through the shared response classifier so the 403 re-pair contract and the
/// 429 throttle signal both survive the trip.
struct BridgeLightSink {
    client: Arc<BlockingClient>,
    bridge_ip: String,
    username: String,
}

impl LightPutSink for BridgeLightSink {
    fn put_light(&self, light_id: &str, x: f64, y: f64, dimming: f64) -> LightPutOutcome {
        let endpoint = format!(
            "https://{}/clip/v2/resource/light/{light_id}",
            self.bridge_ip
        );
        let response = match self
            .client
            .put(endpoint)
            .header("hue-application-key", &self.username)
            .json(&json!({
                "on": { "on": true },
                "dimming": { "brightness": dimming },
                "color": { "xy": { "x": x, "y": y } }
            }))
            .send()
        {
            Ok(response) => response,
            Err(err) => {
                warn!("Hue HTTP fallback: PUT light {light_id} failed to send: {err}");
                return LightPutOutcome::Failed;
            }
        };

        match classify_hue_response_blocking(response) {
            Ok(_) => LightPutOutcome::Ok,
            Err(fault) => match fault.throttle_hint() {
                Some(retry_after_ms) => {
                    warn!("Hue HTTP fallback: bridge is throttling ({fault}); widening interval.");
                    LightPutOutcome::Throttled(retry_after_ms)
                }
                None => {
                    warn!("Hue HTTP fallback: PUT light {light_id} rejected: {fault}");
                    LightPutOutcome::Failed
                }
            },
        }
    }
}

// ---------------------------------------------------------------------------
// HTTP-fallback pacing loop
// ---------------------------------------------------------------------------

/// One addressable light plus the entertainment channel whose colour drives
/// it. The HTTP fallback writes lights individually, so the channel grouping
/// survives only as a colour lookup index.
#[derive(Debug, Clone)]
pub(super) struct LightSlot {
    pub(super) channel_index: usize,
    pub(super) light_id: String,
}

/// Colour a light should be showing, quantised so equality is exact and a
/// light already displaying the target never costs a request.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct LightState {
    r: u8,
    g: u8,
    b: u8,
    brightness_q: u8,
}

impl LightState {
    pub(super) fn new(color: HueRgb, brightness: f32) -> Self {
        let [r, g, b] = color.map(|v| (v.clamp(0.0, 1.0) * 255.0).round() as u8);
        Self {
            r,
            g,
            b,
            brightness_q: (brightness.clamp(0.0, 1.0) * 255.0).round() as u8,
        }
    }

    pub(super) fn to_put_args(self) -> (f64, f64, f64) {
        // Linear already (after the gamma stage): no second EOTF.
        let [r, g, b] = [self.r, self.g, self.b].map(|v| f64::from(v) / 255.0);
        let (x, y, _big_y) = super::super::frame::linear_rgb_to_xy(r, g, b);
        (x, y, f64::from(self.brightness_q) / 255.0 * 100.0)
    }
}

/// Flatten channels into per-light slots, first channel wins for a light
/// listed in more than one. A duplicate would otherwise consume two slots
/// per round and fight itself for the light's colour.
pub(super) fn flatten_light_slots(channels: &[HueAreaChannel]) -> Vec<LightSlot> {
    let mut slots: Vec<LightSlot> = Vec::new();
    for (channel_index, channel) in channels.iter().enumerate() {
        for light_id in &channel.light_ids {
            if slots.iter().any(|slot| &slot.light_id == light_id) {
                continue;
            }
            slots.push(LightSlot {
                channel_index,
                light_id: light_id.clone(),
            });
        }
    }
    slots
}

/// Round-robin scan for the next slot whose desired colour differs from what
/// the bridge was last told. Round-robin (rather than "lowest index first")
/// is what stops a single always-dirty light from starving the rest of the
/// area out of the budget.
fn next_dirty_slot(
    desired: &[Option<LightState>],
    sent: &[Option<LightState>],
    cursor: &mut usize,
) -> Option<usize> {
    let len = desired.len();
    for offset in 0..len {
        let index = (*cursor + offset) % len;
        if desired[index].is_some() && desired[index] != sent[index] {
            *cursor = (index + 1) % len;
            return Some(index);
        }
    }
    None
}

/// The HTTP-fallback sender loop: absorbs colour updates at whatever rate
/// they arrive and spends **one** request per pacer slot, so the load the
/// bridge sees is bounded by the budget and not by the light count.
pub(super) fn run_http_fallback_loop<S: LightPutSink>(
    sink: &S,
    slots: &[LightSlot],
    rx: &HueFrameRx,
    pacer: &mut RequestPacer,
) {
    if slots.is_empty() {
        // Nothing addressable, but the channel must still be drained so the
        // sender's disconnect is observed and shutdown can be signalled.
        while rx.recv().is_ok() {}
        return;
    }

    let mut desired: Vec<Option<LightState>> = vec![None; slots.len()];
    let mut sent: Vec<Option<LightState>> = vec![None; slots.len()];
    let mut cursor = 0usize;

    loop {
        let has_work = desired
            .iter()
            .zip(sent.iter())
            .any(|(want, have)| want.is_some() && want != have);
        let wait = if has_work {
            pacer.time_until_slot(Instant::now())
        } else {
            HUE_HTTP_FALLBACK_IDLE_WAIT
        };

        match rx.recv_timeout(wait) {
            Ok(update) => {
                // Coalesce: only the newest frame matters, the rest are
                // already stale by the time a slot frees up.
                let mut latest = update;
                while let Ok(newer) = rx.try_recv() {
                    latest = newer;
                }
                for (index, slot) in slots.iter().enumerate() {
                    if let Some(color) = latest.channel_colors.get(slot.channel_index) {
                        desired[index] = Some(LightState::new(*color, latest.brightness));
                    }
                }
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
        }

        let now = Instant::now();
        if !pacer.slot_due(now) {
            continue;
        }
        let Some(index) = next_dirty_slot(&desired, &sent, &mut cursor) else {
            continue;
        };
        let Some(state) = desired[index] else {
            continue;
        };

        pacer.consume(now);
        let (x, y, dimming) = state.to_put_args();
        match sink.put_light(&slots[index].light_id, x, y, dimming) {
            LightPutOutcome::Ok => {
                sent[index] = Some(state);
                pacer.on_success();
            }
            LightPutOutcome::Throttled(retry_after_ms) => {
                // Deliberately leave the slot dirty: the write never landed,
                // and the wider interval is what stops us re-flooding.
                pacer.on_throttle(retry_after_ms);
            }
            LightPutOutcome::Failed => {
                // Mark clean so a light the bridge keeps rejecting cannot
                // hold a permanent claim on the budget. The next colour
                // change re-dirties it and we try again.
                sent[index] = Some(state);
            }
        }
    }
}

/// Fallback HTTP sender for when DTLS is not available (e.g. missing clientkey).
/// Per-light PUTs, issued one at a time from this single thread under
/// [`RequestPacer`] — the old shape fanned out `channels + lights` scoped
/// threads per frame and paced iterations rather than requests.
///
/// Returns the color sender handle and a shutdown signal that fires when the
/// thread exits.
pub(crate) fn spawn_hue_http_sender(
    client: Arc<BlockingClient>,
    bridge_ip: String,
    username: String,
    channels: Vec<HueAreaChannel>,
) -> (HueColorSender, ShutdownSignal) {
    let (color_sender, rx) = HueColorSender::with_mailbox(channels.len());

    let shutdown = new_shutdown_signal();
    let shutdown_inner = Arc::clone(&shutdown);

    thread::spawn(move || {
        let slots = flatten_light_slots(&channels);
        info!(
            "Hue HTTP fallback sender: {} light(s), budget {} req/s.",
            slots.len(),
            HUE_HTTP_FALLBACK_MAX_REQUESTS_PER_SEC
        );
        let sink = BridgeLightSink {
            client,
            bridge_ip,
            username,
        };
        let mut pacer = RequestPacer::new(HUE_HTTP_FALLBACK_MAX_REQUESTS_PER_SEC);
        run_http_fallback_loop(&sink, &slots, &rx, &mut pacer);

        // Signal that this thread has completed shutdown.
        signal_shutdown_complete(&shutdown_inner);
    });

    (color_sender, shutdown)
}
