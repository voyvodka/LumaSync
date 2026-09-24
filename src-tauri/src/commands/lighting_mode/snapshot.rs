//! What the lighting backend runs, as one value every window can hold. Readers
//! take it from this cell and never from the runtime lock, which a transition
//! holds for seconds. See docs/architecture/lighting-transaction.md.

use std::collections::BTreeSet;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use log::warn;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, Runtime};

use super::{LightingModeConfig, LightingModeKind, LightingRuntimeState};

/// `LIGHTING_EVENTS.RUNTIME_CHANGED` in `src/shared/contracts/lightingRuntime.ts`.
/// Defined in `crate::events`; re-exported here since this is the emit site.
pub use crate::events::LIGHTING_RUNTIME_CHANGED_EVENT;

/// A drag retunes at up to 20 Hz; the windows only need to follow it at half that.
pub(crate) const RETUNE_PUBLISH_INTERVAL: Duration = Duration::from_millis(100);

/// Declared in the frontend's stable order: `Ord` is what keeps a
/// `BTreeSet<OutputTarget>` iterating `usb, hue`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OutputTarget {
    Usb,
    Hue,
}

/// A selection of outputs: deduped and ordered by construction.
pub(crate) type OutputTargets = BTreeSet<OutputTarget>;

impl OutputTarget {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Usb => "usb",
            Self::Hue => "hue",
        }
    }

    pub(crate) fn parse(value: &str) -> Option<Self> {
        match value {
            "usb" => Some(Self::Usb),
            "hue" => Some(Self::Hue),
            _ => None,
        }
    }
}

/// Deduped, in the frontend's stable `usb, hue` order.
pub(crate) fn normalize_targets(
    targets: impl IntoIterator<Item = OutputTarget>,
) -> Vec<OutputTarget> {
    targets
        .into_iter()
        .collect::<OutputTargets>()
        .into_iter()
        .collect()
}

/// Parses a wire selection. An unknown name is an error naming it, never a
/// target silently dropped: a selection that lost its only real output would
/// start a capture worker that drives nothing.
pub(crate) fn parse_targets<S: AsRef<str>>(
    targets: impl IntoIterator<Item = S>,
) -> Result<OutputTargets, String> {
    targets
        .into_iter()
        .map(|name| {
            let name = name.as_ref();
            OutputTarget::parse(name).ok_or_else(|| format!("unknown output target \"{name}\""))
        })
        .collect()
}

/// `HUE_LEFT_OUT_REASON` in `src/shared/contracts/lighting.ts`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum HueLeftOutReason {
    Unreachable,
    Auth,
    Config,
    Busy,
    BusyGaveUp,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum LightingPhase {
    #[default]
    Idle,
    StartingHue,
    Applying,
    Stopping,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum BootHueRetryState {
    Waiting,
    GaveUp,
}

/// `LightingRuntimeSnapshot` in `src/shared/contracts/lightingRuntime.ts`.
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LightingRuntimeSnapshot {
    pub revision: u64,
    pub mode: LightingModeConfig,
    pub active: bool,
    pub active_targets: Vec<OutputTarget>,
    pub selected_targets: Vec<OutputTarget>,
    pub phase: LightingPhase,
    pub request_id: Option<u64>,
    pub hue_held_out_reason: Option<HueLeftOutReason>,
    pub boot_hue_retry: Option<BootHueRetryState>,
}

impl LightingRuntimeSnapshot {
    /// Records `mode` as what runs. `hue_live` is whether the Hue output slot
    /// holds a stream; `hue_unconfirmed` keeps a stream whose stop did not
    /// confirm listed, since the bridge may still count it as its streamer.
    pub(crate) fn set_running(
        &mut self,
        mode: &LightingModeConfig,
        hue_live: bool,
        hue_unconfirmed: bool,
    ) {
        let mut driven = Vec::new();
        if mode.kind != LightingModeKind::Off {
            let targets = mode.targets.as_deref().unwrap_or_default();
            // Absent or empty targets mean USB-required (legacy D-10).
            if targets.is_empty() || targets.iter().any(|t| t == "usb") {
                driven.push(OutputTarget::Usb);
            }
            if hue_live && targets.iter().any(|t| t == "hue") {
                driven.push(OutputTarget::Hue);
            }
        }
        if hue_unconfirmed {
            driven.push(OutputTarget::Hue);
        }
        self.active_targets = normalize_targets(driven);
        self.active = mode.kind != LightingModeKind::Off;
        self.mode = mode.clone();
    }
}

/// Where a published snapshot goes. The app emits it to every window; a test
/// records it.
pub trait SnapshotSink: Send + Sync {
    fn emit_snapshot(&self, snapshot: &LightingRuntimeSnapshot);
}

impl<R: Runtime> SnapshotSink for AppHandle<R> {
    fn emit_snapshot(&self, snapshot: &LightingRuntimeSnapshot) {
        if let Err(error) = self.emit(LIGHTING_RUNTIME_CHANGED_EVENT, snapshot) {
            warn!(
                "[lighting-runtime] could not announce revision {}: {error}",
                snapshot.revision
            );
        }
    }
}

#[derive(Default)]
struct CellState {
    snapshot: LightingRuntimeSnapshot,
    last_coalesced_emit: Option<Instant>,
    trailing_scheduled: bool,
}

/// The one snapshot. The revision moves under a small mutex, so every
/// publish gets a distinct, increasing one; the emit happens after the mutex is
/// released, so two publishers can deliver out of order and a listener keeps
/// the higher revision.
#[derive(Default)]
pub struct LightingSnapshotCell {
    state: Mutex<CellState>,
}

impl LightingSnapshotCell {
    fn lock(&self) -> MutexGuard<'_, CellState> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub fn read(&self) -> LightingRuntimeSnapshot {
        self.lock().snapshot.clone()
    }

    pub fn publish(
        &self,
        sink: &dyn SnapshotSink,
        change: impl FnOnce(&mut LightingRuntimeSnapshot),
    ) -> LightingRuntimeSnapshot {
        let published = {
            let mut state = self.lock();
            change(&mut state.snapshot);
            state.snapshot.revision += 1;
            state.snapshot.clone()
        };
        sink.emit_snapshot(&published);
        published
    }

    /// For retunes: the change lands at once, but at most one emit per
    /// `RETUNE_PUBLISH_INTERVAL`, with a trailing one so the last value is
    /// always announced.
    pub fn publish_coalesced(
        self: &Arc<Self>,
        sink: Arc<dyn SnapshotSink>,
        change: impl FnOnce(&mut LightingRuntimeSnapshot),
    ) {
        enum Next {
            Emit(Box<LightingRuntimeSnapshot>),
            Trail(Duration),
            Nothing,
        }
        let next = {
            let mut state = self.lock();
            change(&mut state.snapshot);
            let now = Instant::now();
            match state.last_coalesced_emit {
                // A trailing emit already pending carries this change too, even
                // once its window has passed and it has not flushed yet.
                _ if state.trailing_scheduled => Next::Nothing,
                Some(last) if now.duration_since(last) < RETUNE_PUBLISH_INTERVAL => {
                    state.trailing_scheduled = true;
                    Next::Trail(RETUNE_PUBLISH_INTERVAL - now.duration_since(last))
                }
                _ => {
                    state.last_coalesced_emit = Some(now);
                    state.snapshot.revision += 1;
                    Next::Emit(Box::new(state.snapshot.clone()))
                }
            }
        };
        match next {
            Next::Emit(snapshot) => sink.emit_snapshot(&snapshot),
            Next::Trail(wait) => {
                let cell = Arc::clone(self);
                let spawned = std::thread::Builder::new()
                    .name("lumasync-snapshot-trail".into())
                    .spawn(move || {
                        std::thread::sleep(wait);
                        cell.flush_trailing(sink.as_ref());
                    });
                if let Err(error) = spawned {
                    warn!("[lighting-runtime] trailing publish not scheduled: {error}");
                    self.lock().trailing_scheduled = false;
                }
            }
            Next::Nothing => {}
        }
    }

    fn flush_trailing(&self, sink: &dyn SnapshotSink) {
        let published = {
            let mut state = self.lock();
            state.trailing_scheduled = false;
            state.last_coalesced_emit = Some(Instant::now());
            state.snapshot.revision += 1;
            state.snapshot.clone()
        };
        sink.emit_snapshot(&published);
    }
}

/// Publishes `mode` as the running mode, reading the Hue output slot and the
/// unconfirmed-stop flag itself. Every command that changes the running mode
/// calls it after releasing the runtime lock.
pub(crate) fn publish_running<R: Runtime>(
    app: &AppHandle<R>,
    mode: &LightingModeConfig,
) -> Option<LightingRuntimeSnapshot> {
    let state = app.try_state::<LightingRuntimeState>()?;
    let hue_live =
        super::hue_driver::hue_output_for(app).is_some_and(|live| live.current().is_some());
    let hue_unconfirmed = state.outputs.hue_stop_unconfirmed();
    Some(state.snapshot.publish(app, |snapshot| {
        snapshot.set_running(mode, hue_live, hue_unconfirmed)
    }))
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use super::*;

    #[derive(Default)]
    pub(crate) struct Recorder {
        pub(crate) seen: Mutex<Vec<(std::thread::ThreadId, u64)>>,
    }

    impl SnapshotSink for Recorder {
        fn emit_snapshot(&self, snapshot: &LightingRuntimeSnapshot) {
            self.seen
                .lock()
                .unwrap()
                .push((std::thread::current().id(), snapshot.revision));
        }
    }

    #[test]
    fn revisions_strictly_increase_across_two_publishing_threads() {
        const PER_THREAD: usize = 500;
        let cell = Arc::new(LightingSnapshotCell::default());
        let recorder = Arc::new(Recorder::default());
        let returned = Arc::new(Mutex::new(Vec::new()));
        let threads: Vec<_> = (0..2)
            .map(|_| {
                let cell = Arc::clone(&cell);
                let recorder = Arc::clone(&recorder);
                let returned = Arc::clone(&returned);
                std::thread::spawn(move || {
                    let mut last = 0;
                    for _ in 0..PER_THREAD {
                        let published = cell.publish(recorder.as_ref(), |s| s.active = !s.active);
                        assert!(
                            published.revision > last,
                            "a thread saw its revision go back"
                        );
                        last = published.revision;
                        returned.lock().unwrap().push(published.revision);
                    }
                })
            })
            .collect();
        for thread in threads {
            thread.join().unwrap();
        }

        let seen = recorder.seen.lock().unwrap();
        let revisions: HashSet<u64> = seen.iter().map(|(_, r)| *r).collect();
        assert_eq!(
            revisions.len(),
            2 * PER_THREAD,
            "two publishes shared a revision"
        );
        assert_eq!(revisions, (1..=2 * PER_THREAD as u64).collect());
        assert_eq!(cell.read().revision, 2 * PER_THREAD as u64);
        for thread in seen.iter().map(|(t, _)| *t).collect::<HashSet<_>>() {
            let own: Vec<u64> = seen
                .iter()
                .filter(|(t, _)| *t == thread)
                .map(|(_, r)| *r)
                .collect();
            assert!(
                own.windows(2).all(|w| w[0] < w[1]),
                "one thread emitted out of order"
            );
        }
    }

    struct Counter(AtomicUsize, Mutex<Option<LightingRuntimeSnapshot>>);

    impl SnapshotSink for Counter {
        fn emit_snapshot(&self, snapshot: &LightingRuntimeSnapshot) {
            self.0.fetch_add(1, Ordering::SeqCst);
            self.1.lock().unwrap().replace(snapshot.clone());
        }
    }

    #[test]
    fn a_retune_burst_is_announced_at_ten_hertz_and_ends_on_the_last_value() {
        let cell = Arc::new(LightingSnapshotCell::default());
        let sink = Arc::new(Counter(AtomicUsize::new(0), Mutex::new(None)));
        let started = Instant::now();
        for step in 0..40u8 {
            cell.publish_coalesced(sink.clone(), |s| {
                s.mode.solid = Some(super::super::SolidColorPayload {
                    r: step,
                    g: 0,
                    b: 0,
                    brightness: 1.0,
                })
            });
            std::thread::sleep(Duration::from_millis(5));
        }
        let burst = started.elapsed();
        std::thread::sleep(RETUNE_PUBLISH_INTERVAL * 2);

        let emitted = sink.0.load(Ordering::SeqCst);
        // One per interval over the burst, the first at once and one trailing.
        let ceiling = (burst.as_millis() / RETUNE_PUBLISH_INTERVAL.as_millis()) as usize + 2;
        assert!(emitted >= 2, "only {emitted} emits for a {burst:?} burst");
        assert!(
            emitted <= ceiling,
            "{emitted} emits for a {burst:?} burst (ceiling {ceiling})"
        );
        let last = sink.1.lock().unwrap().clone().unwrap();
        assert_eq!(
            last.mode.solid.map(|s| s.r),
            Some(39),
            "the last value was never announced"
        );
        assert_eq!(last.revision, cell.read().revision);
    }

    #[test]
    fn running_targets_follow_the_mode_and_the_hue_slot() {
        let mut snapshot = LightingRuntimeSnapshot::default();
        let mode = LightingModeConfig {
            kind: LightingModeKind::Ambilight,
            targets: Some(vec!["usb".into(), "hue".into()]),
            ..Default::default()
        };
        snapshot.set_running(&mode, false, false);
        assert_eq!(snapshot.active_targets, vec![OutputTarget::Usb]);
        snapshot.set_running(&mode, true, false);
        assert_eq!(
            snapshot.active_targets,
            vec![OutputTarget::Usb, OutputTarget::Hue]
        );
        snapshot.set_running(&LightingModeConfig::default(), true, true);
        assert_eq!(snapshot.active_targets, vec![OutputTarget::Hue]);
        assert!(!snapshot.active);
    }
}
