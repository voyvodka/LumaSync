use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::State;

use super::hue_stream_lifecycle::{acquire_hue_runtime, HueRuntimeStateStore};

const TELEMETRY_WINDOW: Duration = Duration::from_secs(1);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TelemetryQueueHealth {
    Healthy,
    Warning,
    Critical,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeTelemetrySnapshot {
    pub capture_fps: f32,
    pub send_fps: f32,
    pub queue_health: TelemetryQueueHealth,
}

impl Default for RuntimeTelemetrySnapshot {
    fn default() -> Self {
        Self {
            capture_fps: 0.0,
            send_fps: 0.0,
            queue_health: TelemetryQueueHealth::Healthy,
        }
    }
}

#[derive(Default)]
pub struct RuntimeTelemetryState {
    snapshot: Arc<Mutex<RuntimeTelemetrySnapshot>>,
}

impl RuntimeTelemetryState {
    pub fn shared_snapshot(&self) -> SharedRuntimeTelemetry {
        Arc::clone(&self.snapshot)
    }
}

pub type SharedRuntimeTelemetry = Arc<Mutex<RuntimeTelemetrySnapshot>>;

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
    let mut owner = acquire_hue_runtime(&*arc);

    // Only return telemetry if Hue has been active at some point.
    let state_str = format!("{:?}", owner.state);
    let is_active = owner.active_stream.is_some()
        || owner.stream_started_at.is_some()
        || owner.session_reconnect_total > 0;

    if !is_active {
        return None;
    }

    let now = Instant::now();

    let uptime_secs = owner.stream_started_at.map(|started| {
        now.saturating_duration_since(started).as_secs()
    });

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

    let last_error_at_secs = owner.last_error_at.map(|err_at| {
        now.saturating_duration_since(err_at).as_secs()
    });

    let dtls_connected_at_secs = owner.dtls_connected_at.map(|connected| {
        now.saturating_duration_since(connected).as_secs()
    });

    let uses_dtls = owner
        .active_stream
        .as_ref()
        .map_or(false, |s| s.uses_dtls);

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

pub struct RuntimeTelemetryWindow {
    started_at: Instant,
    capture_count: u32,
    send_count: u32,
    slot_overwrite_count: u32,
}

impl RuntimeTelemetryWindow {
    pub fn new(started_at: Instant) -> Self {
        Self {
            started_at,
            capture_count: 0,
            send_count: 0,
            slot_overwrite_count: 0,
        }
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

        write_runtime_telemetry(
            snapshot,
            RuntimeTelemetrySnapshot {
                capture_fps: round_two_decimals(self.capture_count as f32 / elapsed_secs),
                send_fps: round_two_decimals(self.send_count as f32 / elapsed_secs),
                queue_health: queue_health_from_ratio(overwrite_ratio),
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

        window
            .flush_if_due(base + Duration::from_secs(1), &metrics)
            .expect("flush should succeed");

        let snapshot = read_runtime_telemetry(&metrics).expect("snapshot should be readable");
        assert_eq!(snapshot.capture_fps, 60.0);
        assert_eq!(snapshot.send_fps, 30.0);
        assert_eq!(snapshot.queue_health, TelemetryQueueHealth::Healthy);
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
