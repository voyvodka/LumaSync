//! The HTTP-fallback request budget: no sliding one-second window may hold
//! more than the pacer's ceiling, whatever the light count or the bridge's
//! throttle behaviour.

use std::sync::atomic::Ordering as AtomicOrdering;
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use super::super::frame::{HueAreaChannel, HueColorSender, HueMotion, HueScreenRegion};
use super::http_fallback::{
    flatten_light_slots, run_http_fallback_loop, LightPutOutcome, LightPutSink, RequestPacer,
    HUE_HTTP_FALLBACK_MAX_INTERVAL_MS,
};

// -----------------------------------------------------------------------
// HTTP-fallback request budget
// -----------------------------------------------------------------------

/// Recording sink: timestamps every PUT so the pacing invariant can be
/// asserted without a bridge, and can be scripted to reply with throttles.
#[derive(Default)]
struct RecordingSink {
    sent_at: Mutex<Vec<(Instant, String)>>,
    throttle_first_n: std::sync::atomic::AtomicUsize,
    latency: Option<Duration>,
}

impl LightPutSink for RecordingSink {
    fn put_light(&self, light_id: &str, _x: f64, _y: f64, _dimming: f64) -> LightPutOutcome {
        self.sent_at
            .lock()
            .unwrap()
            .push((Instant::now(), light_id.to_string()));
        if let Some(latency) = self.latency {
            thread::sleep(latency);
        }
        if self
            .throttle_first_n
            .fetch_update(AtomicOrdering::AcqRel, AtomicOrdering::Acquire, |n| {
                if n > 0 {
                    Some(n - 1)
                } else {
                    None
                }
            })
            .is_ok()
        {
            return LightPutOutcome::Throttled(None);
        }
        LightPutOutcome::Ok
    }
}

impl RecordingSink {
    fn timestamps(&self) -> Vec<Instant> {
        self.sent_at
            .lock()
            .unwrap()
            .iter()
            .map(|(at, _)| *at)
            .collect()
    }

    fn light_ids(&self) -> Vec<String> {
        self.sent_at
            .lock()
            .unwrap()
            .iter()
            .map(|(_, id)| id.clone())
            .collect()
    }
}

fn channel_with_lights(channel_id: u8, light_ids: &[&str]) -> HueAreaChannel {
    HueAreaChannel {
        channel_id,
        light_ids: light_ids.iter().map(|id| (*id).to_string()).collect(),
        screen_region: HueScreenRegion::Center,
        position_x: 0.0,
        position_y: 0.0,
        position_z: None,
    }
}

/// Assert no sliding one-second window holds more than `budget` sends.
fn assert_within_budget(timestamps: &[Instant], budget: usize) {
    for (index, start) in timestamps.iter().enumerate() {
        let window_end = *start + Duration::from_secs(1);
        let count = timestamps[index..]
            .iter()
            .take_while(|at| **at < window_end)
            .count();
        assert!(
            count <= budget,
            "window starting at index {index} held {count} requests, budget is {budget}"
        );
    }
}

/// Safety net for [`run_loop_under_load`], not a measurement window: it
/// only decides how long a starved host is allowed to take before the
/// test gives up and reports what it actually observed.
const LOAD_TEST_DEADLINE: Duration = Duration::from_secs(10);

/// Drive the loop with a firehose of updates until `enough` says the sink
/// has seen what the caller needs, then drop the sender so the loop exits.
///
/// Feeding for a fixed wall-clock span instead turns every "at least N
/// requests got through" assertion into a race against the host's timer
/// granularity. Windows rounds both `thread::sleep` and the loop's
/// `recv_timeout` up to the ~15.6 ms system tick, so the same code that
/// lands sixteen requests locally lands three on the CI runner and the
/// lower bound fails for a reason the test was never about. Upper bounds
/// (the budget, the minimum gap) stay honest under any slowdown; lower
/// bounds have to wait for the work rather than time-box it.
fn run_loop_under_load(
    channels: &[HueAreaChannel],
    budget: u32,
    sink: &RecordingSink,
    enough: impl Fn(&RecordingSink) -> bool + Send,
) {
    let slots = flatten_light_slots(channels);
    let channel_count = channels.len();
    let (tx, rx) = HueColorSender::with_mailbox(channel_count);

    thread::scope(|scope| {
        scope.spawn(move || {
            let deadline = Instant::now() + LOAD_TEST_DEADLINE;
            let mut tick: u8 = 0;
            while Instant::now() < deadline && !enough(sink) {
                tick = tick.wrapping_add(7);
                let level = f32::from(tick) / 255.0;
                tx.try_send_channels(vec![[level; 3]; channel_count], 1.0, HueMotion::Snap);
                thread::sleep(Duration::from_millis(5));
            }
            drop(tx);
        });

        let mut pacer = RequestPacer::new(budget);
        run_http_fallback_loop(sink, &slots, &rx, &mut pacer);
    });
}

/// The pre-fix loop issued one PUT per light per iteration at 20 Hz —
/// ~200 req/s for a ten-light area against a bridge documented to take 10.
/// The budget must hold no matter how many lights the area carries.
#[test]
fn http_fallback_never_exceeds_the_request_budget_in_any_one_second_window() {
    let channels: Vec<HueAreaChannel> = (0..5)
        .map(|c| {
            let ids: Vec<String> = (0..5).map(|l| format!("light-{c}-{l}")).collect();
            channel_with_lights(c, &ids.iter().map(String::as_str).collect::<Vec<_>>())
        })
        .collect();
    assert_eq!(flatten_light_slots(&channels).len(), 25);

    let budget = 10u32;
    let sink = RecordingSink::default();
    // Twelve requests at a ten-per-second ceiling means the window the
    // budget is checked over spans more than a second either way.
    run_loop_under_load(&channels, budget, &sink, |s| s.timestamps().len() >= 12);

    let timestamps = sink.timestamps();
    assert!(
        timestamps.len() >= 8,
        "expected the loop to keep sending, got {} requests",
        timestamps.len()
    );
    assert_within_budget(&timestamps, budget as usize);
}

/// Round-robin, not lowest-index-first: with a permanent firehose every
/// light is always dirty, and a naive scan would starve every light but
/// the first out of the budget.
#[test]
fn http_fallback_spreads_the_budget_across_every_light() {
    let channels = vec![channel_with_lights(0, &["a", "b", "c", "d"])];
    let sink = RecordingSink::default();
    run_loop_under_load(&channels, 40, &sink, |s| {
        let ids = s.light_ids();
        ["a", "b", "c", "d"]
            .iter()
            .all(|want| ids.iter().any(|id| id == want))
    });

    let ids = sink.light_ids();
    for expected in ["a", "b", "c", "d"] {
        assert!(
            ids.iter().any(|id| id == expected),
            "light {expected} never got a slot: {ids:?}"
        );
    }
}

/// A light listed by two channels must not consume two slots per round.
#[test]
fn flatten_light_slots_dedupes_lights_shared_between_channels() {
    let channels = vec![
        channel_with_lights(0, &["a", "b"]),
        channel_with_lights(1, &["b", "c"]),
    ];
    let slots = flatten_light_slots(&channels);
    assert_eq!(
        slots
            .iter()
            .map(|s| s.light_id.as_str())
            .collect::<Vec<_>>(),
        vec!["a", "b", "c"]
    );
    // First channel wins the shared light.
    assert_eq!(slots[1].channel_index, 0);
}

#[test]
fn http_fallback_loop_exits_when_the_color_channel_disconnects() {
    let channels = vec![channel_with_lights(0, &["a"])];
    let slots = flatten_light_slots(&channels);
    let (tx, rx) = HueColorSender::with_mailbox(1);
    drop(tx);

    let sink = RecordingSink::default();
    let mut pacer = RequestPacer::new(10);
    // Would hang forever if disconnect were not an exit condition.
    run_http_fallback_loop(&sink, &slots, &rx, &mut pacer);
    assert!(sink.timestamps().is_empty());
}

/// An area with no addressable lights must still drain the channel, or
/// `stop_hue_stream` would burn its full timeout waiting for shutdown.
#[test]
fn http_fallback_loop_with_no_lights_still_observes_disconnect() {
    let (tx, rx) = HueColorSender::with_mailbox(1);
    drop(tx);
    let sink = RecordingSink::default();
    let mut pacer = RequestPacer::new(10);
    run_http_fallback_loop(&sink, &[], &rx, &mut pacer);
}

/// A request that overruns its slot leaves `next_slot` in the past. Without
/// the `max(now, next_slot)` anchor the loop would fire a catch-up burst and
/// blow the window — the exact failure the per-iteration pace had.
#[test]
fn pacer_does_not_burst_to_catch_up_after_an_overrunning_request() {
    let channels = vec![channel_with_lights(0, &["a", "b", "c"])];
    let sink = RecordingSink {
        latency: Some(Duration::from_millis(120)),
        ..RecordingSink::default()
    };
    // Five requests give four consecutive gaps to inspect, which is more
    // than enough for a catch-up burst to show up in one of them.
    run_loop_under_load(&channels, 20, &sink, |s| s.timestamps().len() >= 5);

    let timestamps = sink.timestamps();
    assert!(
        timestamps.len() >= 3,
        "expected the loop to keep sending, got {} requests",
        timestamps.len()
    );
    assert_within_budget(&timestamps, 20);
    for pair in timestamps.windows(2) {
        let gap = pair[1].saturating_duration_since(pair[0]);
        assert!(
            gap >= Duration::from_millis(110),
            "catch-up burst detected: {gap:?} between consecutive requests"
        );
    }
}

#[test]
fn pacer_widens_on_throttle_and_decays_back_toward_the_floor() {
    let mut pacer = RequestPacer::new(10);
    let floor = pacer.floor;
    assert_eq!(pacer.interval, floor);

    pacer.on_throttle(None);
    assert_eq!(pacer.interval, floor * 2);
    pacer.on_throttle(None);
    assert_eq!(pacer.interval, floor * 4);

    // A bridge-supplied Retry-After wins when it asks for longer.
    pacer.on_throttle(Some(3_000));
    assert_eq!(pacer.interval, Duration::from_millis(3_000));

    // Never past the ceiling, never below the floor.
    for _ in 0..10 {
        pacer.on_throttle(Some(u64::MAX / 2));
    }
    assert_eq!(
        pacer.interval,
        Duration::from_millis(HUE_HTTP_FALLBACK_MAX_INTERVAL_MS)
    );
    for _ in 0..500 {
        pacer.on_success();
    }
    assert_eq!(pacer.interval, floor);
}

/// A 429 must actually slow the loop down. Before the fix every fault was
/// discarded with `let _ =`, so a throttling bridge had no way to reach us.
///
/// Anchored on the pacer's own `floor` rather than a measured `first_gap`:
/// a wall-clock baseline inflates under a loaded runner just like every
/// other gap, but the inflation is proportionally worst on the smallest
/// measurement, so multiplying it out as a threshold chases a moving
/// target (observed CI failure: missed a `* 4` threshold by 1.7ms).
#[test]
fn http_fallback_slows_down_when_the_bridge_throttles() {
    let channels = vec![channel_with_lights(0, &["a", "b"])];
    let throttle_count: u32 = 4;
    let sink = RecordingSink {
        throttle_first_n: std::sync::atomic::AtomicUsize::new(throttle_count as usize),
        ..RecordingSink::default()
    };
    let budget = 100;
    // The gap under inspection is between requests 5 and 6, so six is the
    // smallest run that can carry the assertion.
    run_loop_under_load(&channels, budget, &sink, |s| s.timestamps().len() >= 6);

    let timestamps = sink.timestamps();
    assert!(timestamps.len() >= 6, "got {} requests", timestamps.len());

    let floor = RequestPacer::new(budget).floor;
    let late_gap = timestamps[5].saturating_duration_since(timestamps[4]);
    // 4 throttles double the interval 4 times: floor * 2^4. Require half
    // of that — comfortably above floor-only scheduler noise, comfortably
    // below the fully-widened interval.
    let expected_widened = floor * (1u32 << throttle_count);
    let min_widened_gap = expected_widened / 2;
    assert!(
        late_gap >= min_widened_gap,
        "interval did not widen under throttling: expected at least {min_widened_gap:?} \
         (half of floor {floor:?} * 2^{throttle_count}), got {late_gap:?}"
    );
}
