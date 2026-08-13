//! Frame-rate and queue-health telemetry surfaced to the frontend — the USB
//! worker's rolling window plus a point-in-time read of Hue runtime health.

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::State;

use super::hue_stream_lifecycle::{acquire_hue_runtime, HueRuntimeStateStore};

const TELEMETRY_WINDOW: Duration = Duration::from_secs(1);

/// Slot-overwrite pressure band, derived from `RuntimeTelemetryWindow`'s
/// overwrite ratio for the last flush window.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TelemetryQueueHealth {
    Healthy,
    Warning,
    Critical,
}

/// USB output health for the last flushed telemetry window — the
/// `get_runtime_telemetry` command's `usb` field.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeTelemetrySnapshot {
    pub capture_fps: f32,
    pub send_fps: f32,
    pub queue_health: TelemetryQueueHealth,
    /// EWMA of capture+send cost in milliseconds. 0.0 before the first frame.
    pub frame_latency_ms: f32,
    /// The serial link **materially degrades** the effect (`link_max_fps < 30`)
    /// — NOT merely "at capacity". `SerialSendBudget::exceeds_link_budget` is
    /// the separate, stricter predicate that drives the send-interval clamp; it
    /// is true even for a 60-LED strip still running ~59 fps, which is why this
    /// user-facing flag deliberately does not track it.
    pub link_constrained: bool,
    /// Frames per second the serial link can physically carry for this strip.
    /// **0.0 means "no serial link in play"** (Hue-only, or before the first
    /// worker start), NOT "zero fps" — render it as absent, never as `0 fps`.
    pub link_max_fps: f32,
    /// Reason of the worker's most recent failed `capture_frame()`, sticky for
    /// the worker's lifetime. A start failure never lands here — it is
    /// `AMBILIGHT_MODE_START_FAILED`'s `details` and the worker never began.
    pub last_capture_error_code: Option<String>,
    /// Age of that failure in seconds at flush time. Each new failure resets
    /// it, so a small value means capture is failing *now*; a growing one
    /// means it recovered. Reading the code without this is how a display
    /// unplugged an hour ago looks identical to one unplugged a second ago.
    pub last_capture_error_at_secs: Option<u64>,
}

impl Default for RuntimeTelemetrySnapshot {
    fn default() -> Self {
        Self {
            capture_fps: 0.0,
            send_fps: 0.0,
            queue_health: TelemetryQueueHealth::Healthy,
            frame_latency_ms: 0.0,
            link_constrained: false,
            link_max_fps: 0.0,
            last_capture_error_code: None,
            last_capture_error_at_secs: None,
        }
    }
}

/// Tauri-managed holder for the shared USB telemetry snapshot.
#[derive(Default)]
pub struct RuntimeTelemetryState {
    snapshot: Arc<Mutex<RuntimeTelemetrySnapshot>>,
}

impl RuntimeTelemetryState {
    /// Clone the `Arc` handle the ambilight worker writes into and the
    /// `get_runtime_telemetry` command reads from.
    pub fn shared_snapshot(&self) -> SharedRuntimeTelemetry {
        Arc::clone(&self.snapshot)
    }
}

pub type SharedRuntimeTelemetry = Arc<Mutex<RuntimeTelemetrySnapshot>>;

/// Point-in-time Hue runtime health — the `get_runtime_telemetry` command's
/// `hue` field, `None` when Hue has never been active this session.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HueTelemetrySnapshot {
    pub state: String,
    pub uptime_secs: Option<u64>,
    pub packet_rate: f32,
    pub last_error_code: Option<String>,
    pub last_error_at_secs: Option<u64>,
    pub total_reconnects: u32,
    pub successful_reconnects: u32,
    pub failed_reconnects: u32,
    pub dtls_active: bool,
    pub dtls_cipher: Option<String>,
    pub dtls_connected_at_secs: Option<u64>,
}

/// Combined telemetry payload returned by the `get_runtime_telemetry` command.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FullTelemetrySnapshot {
    pub usb: RuntimeTelemetrySnapshot,
    pub hue: Option<HueTelemetrySnapshot>,
}

/// Collect Hue runtime health metrics from HueRuntimeStateStore.
/// Returns None if Hue has never been active in this session.
pub fn collect_hue_telemetry(hue_state: &HueRuntimeStateStore) -> Option<HueTelemetrySnapshot> {
    let arc = hue_state.runtime_arc();
    let mut owner = acquire_hue_runtime(&arc);

    // Only return telemetry if Hue has been active at some point.
    let state_str = format!("{:?}", owner.state);
    let is_active = owner.active_stream.is_some()
        || owner.stream_started_at.is_some()
        || owner.session_reconnect_total > 0;

    if !is_active {
        return None;
    }

    let now = Instant::now();

    let uptime_secs = owner
        .stream_started_at
        .map(|started| now.saturating_duration_since(started).as_secs());

    // Calculate packet rate from atomic counter.
    let current_count = owner
        .packet_send_count
        .load(std::sync::atomic::Ordering::Relaxed);
    let packet_rate = if let Some(sampled_at) = owner.packet_rate_sampled_at {
        let elapsed = now
            .saturating_duration_since(sampled_at)
            .as_secs_f32()
            .max(0.1);
        let delta = current_count.saturating_sub(owner.packet_rate_last_count);
        // Update sampling window.
        owner.packet_rate_sampled_at = Some(now);
        owner.packet_rate_last_count = current_count;
        round_two_decimals(delta as f32 / elapsed)
    } else {
        0.0
    };

    let last_error_at_secs = owner
        .last_error_at
        .map(|err_at| now.saturating_duration_since(err_at).as_secs());

    let dtls_connected_at_secs = owner
        .dtls_connected_at
        .map(|connected| now.saturating_duration_since(connected).as_secs());

    let uses_dtls = owner.active_stream.as_ref().is_some_and(|s| s.uses_dtls);

    Some(HueTelemetrySnapshot {
        state: state_str,
        uptime_secs,
        packet_rate,
        last_error_code: owner.last_error_code.clone(),
        last_error_at_secs,
        total_reconnects: owner.session_reconnect_total,
        successful_reconnects: owner.session_reconnect_success,
        failed_reconnects: owner
            .session_reconnect_total
            .saturating_sub(owner.session_reconnect_success),
        dtls_active: uses_dtls,
        dtls_cipher: owner.dtls_cipher.clone(),
        dtls_connected_at_secs,
    })
}

pub fn read_runtime_telemetry(
    snapshot: &SharedRuntimeTelemetry,
) -> Result<RuntimeTelemetrySnapshot, String> {
    snapshot
        .lock()
        .map(|value| value.clone())
        .map_err(|error| format!("RUNTIME_TELEMETRY_STATE_LOCK_FAILED: {error}"))
}

/// Replace the shared snapshot with `next`. Called by
/// `RuntimeTelemetryWindow::flush_if_due` once per window.
pub fn write_runtime_telemetry(
    snapshot: &SharedRuntimeTelemetry,
    next: RuntimeTelemetrySnapshot,
) -> Result<(), String> {
    let mut state = snapshot
        .lock()
        .map_err(|error| format!("RUNTIME_TELEMETRY_STATE_LOCK_FAILED: {error}"))?;
    *state = next;
    Ok(())
}

#[tauri::command]
pub fn get_runtime_telemetry(
    telemetry_state: State<'_, RuntimeTelemetryState>,
    hue_state: State<'_, HueRuntimeStateStore>,
) -> Result<FullTelemetrySnapshot, String> {
    let usb = read_runtime_telemetry(&telemetry_state.shared_snapshot())?;
    let hue = collect_hue_telemetry(&hue_state);
    Ok(FullTelemetrySnapshot { usb, hue })
}

/// Accumulates per-frame counters for one `TELEMETRY_WINDOW` and flushes them
/// into the shared snapshot as capture/send fps once the window elapses.
pub struct RuntimeTelemetryWindow {
    started_at: Instant,
    capture_count: u32,
    send_count: u32,
    slot_overwrite_count: u32,
    /// Last observed frame latency (capture+send EWMA cost) in ms. Updated
    /// every frame via `record_latency`; surfaces on the next window flush.
    latest_latency_ms: f32,
    /// Serial link budget, fixed for the worker's lifetime. Survives each
    /// flush — unlike the counters, it is a property of the strip, not the
    /// window.
    link_constrained: bool,
    link_max_fps: f32,
    /// Last capture failure, sticky across flushes like the link budget: a
    /// counter reset would erase the only evidence of an ongoing outage.
    last_capture_error: Option<(String, Instant)>,
}

impl RuntimeTelemetryWindow {
    pub fn new(started_at: Instant) -> Self {
        Self {
            started_at,
            capture_count: 0,
            send_count: 0,
            slot_overwrite_count: 0,
            latest_latency_ms: 0.0,
            link_constrained: false,
            link_max_fps: 0.0,
            last_capture_error: None,
        }
    }

    /// Record the resolved serial budget. Left unset on the Hue-only path,
    /// where there is no serial link to constrain the frame rate.
    pub fn set_link_budget(&mut self, link_max_fps: f32, link_constrained: bool) {
        self.link_max_fps = link_max_fps.max(0.0);
        self.link_constrained = link_constrained;
    }

    pub fn record_capture(&mut self) {
        self.capture_count = self.capture_count.saturating_add(1);
    }

    pub fn record_send(&mut self) {
        self.send_count = self.send_count.saturating_add(1);
    }

    pub fn record_slot_overwrite(&mut self) {
        self.slot_overwrite_count = self.slot_overwrite_count.saturating_add(1);
    }

    /// Record the latest capture+send EWMA cost, surfaced on the next flush.
    pub fn record_latency(&mut self, ms: f32) {
        self.latest_latency_ms = ms.max(0.0);
    }

    /// Stamp a failed `capture_frame()`. A sustained outage calls this every
    /// loop iteration, so the reason is only cloned when it actually changes;
    /// the timestamp always moves, because its whole job is to say "still".
    pub fn record_capture_error(&mut self, reason: &str, now: Instant) {
        match &mut self.last_capture_error {
            Some((code, at)) if code == reason => *at = now,
            slot => *slot = Some((reason.to_string(), now)),
        }
    }

    /// Publish accumulated counters to `snapshot` and reset the window, but
    /// only once `TELEMETRY_WINDOW` has elapsed since the last flush.
    pub fn flush_if_due(
        &mut self,
        now: Instant,
        snapshot: &SharedRuntimeTelemetry,
    ) -> Result<(), String> {
        let elapsed = now.saturating_duration_since(self.started_at);
        if elapsed < TELEMETRY_WINDOW {
            return Ok(());
        }

        let elapsed_secs = elapsed.as_secs_f32().max(1.0);
        let overwrite_ratio = if self.capture_count == 0 {
            0.0
        } else {
            self.slot_overwrite_count as f32 / self.capture_count as f32
        };

        let (last_capture_error_code, last_capture_error_at_secs) = match &self.last_capture_error {
            Some((code, at)) => (
                Some(code.clone()),
                Some(now.saturating_duration_since(*at).as_secs()),
            ),
            None => (None, None),
        };

        write_runtime_telemetry(
            snapshot,
            RuntimeTelemetrySnapshot {
                capture_fps: round_two_decimals(self.capture_count as f32 / elapsed_secs),
                send_fps: round_two_decimals(self.send_count as f32 / elapsed_secs),
                queue_health: queue_health_from_ratio(overwrite_ratio),
                frame_latency_ms: round_two_decimals(self.latest_latency_ms),
                link_constrained: self.link_constrained,
                link_max_fps: round_two_decimals(self.link_max_fps),
                last_capture_error_code,
                last_capture_error_at_secs,
            },
        )?;

        self.started_at = now;
        self.capture_count = 0;
        self.send_count = 0;
        self.slot_overwrite_count = 0;

        Ok(())
    }
}

fn queue_health_from_ratio(ratio: f32) -> TelemetryQueueHealth {
    if ratio >= 0.5 {
        TelemetryQueueHealth::Critical
    } else if ratio >= 0.2 {
        TelemetryQueueHealth::Warning
    } else {
        TelemetryQueueHealth::Healthy
    }
}

fn round_two_decimals(value: f32) -> f32 {
    (value * 100.0).round() / 100.0
}

#[cfg(test)]
mod tests {
    use super::{
        queue_health_from_ratio, read_runtime_telemetry, RuntimeTelemetrySnapshot,
        RuntimeTelemetryWindow, SharedRuntimeTelemetry, TelemetryQueueHealth,
    };
    use std::sync::{Arc, Mutex};
    use std::thread;
    use std::time::{Duration, Instant};

    fn shared() -> SharedRuntimeTelemetry {
        Arc::new(Mutex::new(RuntimeTelemetrySnapshot::default()))
    }

    #[test]
    fn runtime_telemetry_snapshot_defaults_all_required_fields() {
        let snapshot = RuntimeTelemetrySnapshot::default();
        assert_eq!(snapshot.capture_fps, 0.0);
        assert_eq!(snapshot.send_fps, 0.0);
        assert_eq!(snapshot.queue_health, TelemetryQueueHealth::Healthy);
        assert_eq!(snapshot.frame_latency_ms, 0.0);
        // A consumer that ignores both link fields must see today's behaviour.
        assert!(!snapshot.link_constrained);
        assert_eq!(snapshot.link_max_fps, 0.0);
        assert!(snapshot.last_capture_error_code.is_none());
        assert!(snapshot.last_capture_error_at_secs.is_none());
    }

    #[test]
    fn link_budget_defaults_to_absent_when_never_set() {
        // The Hue-only path never calls `set_link_budget` — there is no serial
        // link to constrain, so the flush must not claim one is degraded.
        let metrics = shared();
        let base = Instant::now();
        let mut window = RuntimeTelemetryWindow::new(base);
        window.record_capture();

        window
            .flush_if_due(base + Duration::from_secs(1), &metrics)
            .expect("flush should succeed");

        let snapshot = read_runtime_telemetry(&metrics).expect("snapshot should be readable");
        assert!(!snapshot.link_constrained);
        assert_eq!(snapshot.link_max_fps, 0.0);
    }

    #[test]
    fn link_budget_survives_window_resets() {
        // The counters reset each flush; the link budget is a property of the
        // strip and must persist for the worker's lifetime.
        let metrics = shared();
        let base = Instant::now();
        let mut window = RuntimeTelemetryWindow::new(base);
        window.set_link_budget(19.012, true);

        window.record_capture();
        window
            .flush_if_due(base + Duration::from_secs(1), &metrics)
            .expect("first flush should succeed");
        let first = read_runtime_telemetry(&metrics).expect("snapshot should be readable");
        assert!(first.link_constrained);
        assert_eq!(first.link_max_fps, 19.01);

        window.record_capture();
        window
            .flush_if_due(base + Duration::from_secs(2), &metrics)
            .expect("second flush should succeed");
        let second = read_runtime_telemetry(&metrics).expect("snapshot should be readable");
        assert!(second.link_constrained);
        assert_eq!(second.link_max_fps, 19.01);
    }

    #[test]
    fn link_max_fps_never_serializes_negative() {
        let mut window = RuntimeTelemetryWindow::new(Instant::now());
        window.set_link_budget(-5.0, false);
        assert_eq!(window.link_max_fps, 0.0);
    }

    #[test]
    fn link_fields_serialize_as_camel_case() {
        let json = serde_json::to_string(&RuntimeTelemetrySnapshot::default())
            .expect("snapshot should serialize");
        assert!(json.contains("\"linkConstrained\":false"), "got: {json}");
        assert!(json.contains("\"linkMaxFps\":0.0"), "got: {json}");
    }

    #[test]
    fn telemetry_window_flushes_stable_snapshot_metrics() {
        let metrics = shared();
        let base = Instant::now();
        let mut window = RuntimeTelemetryWindow::new(base);

        for _ in 0..60 {
            window.record_capture();
        }
        for _ in 0..30 {
            window.record_send();
        }
        for _ in 0..6 {
            window.record_slot_overwrite();
        }
        window.record_latency(12.345);

        window
            .flush_if_due(base + Duration::from_secs(1), &metrics)
            .expect("flush should succeed");

        let snapshot = read_runtime_telemetry(&metrics).expect("snapshot should be readable");
        assert_eq!(snapshot.capture_fps, 60.0);
        assert_eq!(snapshot.send_fps, 30.0);
        assert_eq!(snapshot.queue_health, TelemetryQueueHealth::Healthy);
        assert_eq!(snapshot.frame_latency_ms, 12.35);
    }

    #[test]
    fn capture_error_survives_window_resets_and_ages() {
        // A display unplugged mid-stream keeps failing; the counters reset each
        // flush, so a per-window field would erase the only evidence of it.
        let metrics = shared();
        let base = Instant::now();
        let mut window = RuntimeTelemetryWindow::new(base);

        window.record_capture_error("AMBILIGHT_CAPTURE_MONITOR_NOT_FOUND", base);
        window
            .flush_if_due(base + Duration::from_secs(1), &metrics)
            .expect("first flush should succeed");
        let first = read_runtime_telemetry(&metrics).expect("snapshot should be readable");
        assert_eq!(
            first.last_capture_error_code.as_deref(),
            Some("AMBILIGHT_CAPTURE_MONITOR_NOT_FOUND")
        );
        assert_eq!(first.last_capture_error_at_secs, Some(1));

        window
            .flush_if_due(base + Duration::from_secs(9), &metrics)
            .expect("second flush should succeed");
        let second = read_runtime_telemetry(&metrics).expect("snapshot should be readable");
        assert_eq!(
            second.last_capture_error_code.as_deref(),
            Some("AMBILIGHT_CAPTURE_MONITOR_NOT_FOUND")
        );
        // Age grows once the failures stop — that is how a consumer tells a
        // recovered worker from one still failing right now.
        assert_eq!(second.last_capture_error_at_secs, Some(9));
    }

    #[test]
    fn repeated_identical_failures_keep_the_age_at_zero() {
        let metrics = shared();
        let base = Instant::now();
        let mut window = RuntimeTelemetryWindow::new(base);

        window.record_capture_error("AMBILIGHT_CAPTURE_FRAME_UNAVAILABLE", base);
        window.record_capture_error(
            "AMBILIGHT_CAPTURE_FRAME_UNAVAILABLE",
            base + Duration::from_secs(4),
        );
        window
            .flush_if_due(base + Duration::from_secs(4), &metrics)
            .expect("flush should succeed");

        let snapshot = read_runtime_telemetry(&metrics).expect("snapshot should be readable");
        assert_eq!(snapshot.last_capture_error_at_secs, Some(0));
    }

    #[test]
    fn a_new_reason_replaces_the_previous_one() {
        let metrics = shared();
        let base = Instant::now();
        let mut window = RuntimeTelemetryWindow::new(base);

        window.record_capture_error("AMBILIGHT_CAPTURE_FRAME_UNAVAILABLE", base);
        window.record_capture_error(
            "AMBILIGHT_CAPTURE_MONITOR_NOT_FOUND",
            base + Duration::from_secs(1),
        );
        window
            .flush_if_due(base + Duration::from_secs(1), &metrics)
            .expect("flush should succeed");

        let snapshot = read_runtime_telemetry(&metrics).expect("snapshot should be readable");
        assert_eq!(
            snapshot.last_capture_error_code.as_deref(),
            Some("AMBILIGHT_CAPTURE_MONITOR_NOT_FOUND")
        );
        assert_eq!(snapshot.last_capture_error_at_secs, Some(0));
    }

    #[test]
    fn a_healthy_worker_reports_no_capture_error() {
        let metrics = shared();
        let base = Instant::now();
        let mut window = RuntimeTelemetryWindow::new(base);
        window.record_capture();

        window
            .flush_if_due(base + Duration::from_secs(1), &metrics)
            .expect("flush should succeed");

        let snapshot = read_runtime_telemetry(&metrics).expect("snapshot should be readable");
        assert!(snapshot.last_capture_error_code.is_none());
        assert!(snapshot.last_capture_error_at_secs.is_none());
    }

    #[test]
    fn capture_error_fields_serialize_as_camel_case() {
        let json = serde_json::to_string(&RuntimeTelemetrySnapshot::default())
            .expect("snapshot should serialize");
        assert!(
            json.contains("\"lastCaptureErrorCode\":null"),
            "got: {json}"
        );
        assert!(
            json.contains("\"lastCaptureErrorAtSecs\":null"),
            "got: {json}"
        );
    }

    #[test]
    fn queue_health_maps_to_latest_slot_pressure_bands() {
        assert_eq!(queue_health_from_ratio(0.0), TelemetryQueueHealth::Healthy);
        assert_eq!(queue_health_from_ratio(0.25), TelemetryQueueHealth::Warning);
        assert_eq!(queue_health_from_ratio(0.7), TelemetryQueueHealth::Critical);
    }

    #[test]
    fn lock_failures_return_coded_runtime_telemetry_error() {
        let poisoned = shared();
        let clone = Arc::clone(&poisoned);

        let _ = thread::spawn(move || {
            let _guard = clone.lock().expect("lock should succeed before poisoning");
            panic!("poison runtime telemetry lock");
        })
        .join();

        let err =
            read_runtime_telemetry(&poisoned).expect_err("poisoned lock should return coded error");
        assert!(err.starts_with("RUNTIME_TELEMETRY_STATE_LOCK_FAILED:"));
    }
}
