//! What the twin draws, and how it gets there.
//!
//! The twin subscribes with a `Channel` (`subscribe_twin_frames`) and receives
//! raw frames: a 16-byte little-endian header — seq, layout revision, LED
//! count, lamp count, each a u32 — then packed RGB for every LED and every Hue
//! lamp. Mirrors `TWIN_FRAME` in `src/shared/contracts/preview.ts`; the byte
//! layout is pinned by `twinFrame.golden.json`, which both sides read.
//!
//! The layout travels apart from the frames (`preview://twin-layout`, and the
//! subscribe result), with a revision that only ever grows: a frame names the
//! revision it was cut for, and the twin drops one that does not match what it
//! draws. The layout is the one the running mode uses, so an edit being tested
//! in LED Setup shows as it runs, not as it was saved.
//!
//! A frame is sent only when it differs from the last one, unless something
//! asked for the next one regardless (a subscribe, a new layout): a still
//! picture would otherwise leave a freshly opened twin blank. Modes with no
//! worker (Solid, Off) get their one frame here, from the mode itself.

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{LazyLock, Mutex};

use serde::Serialize;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Emitter, EventTarget, Manager, Runtime, State, WebviewWindow};

use super::session::{PreviewSessionState, PREVIEW_NOT_OPEN};
use crate::commands::led_calibration::LedCalibrationConfig;
use crate::commands::led_output::{scale_brightness, EncoderPlan};
use crate::commands::lighting_mode::{LightingModeKind, LightingRuntimeState};
use crate::commands::shell_state;
use crate::commands::status::CommandStatus;
use crate::events::PREVIEW_TWIN_LAYOUT_EVENT;

const PREVIEW_TWIN_SUBSCRIBED: &str = "PREVIEW_TWIN_SUBSCRIBED";

pub const TWIN_FRAME_HEADER_BYTES: usize = 16;

/// Never reset, not even between sessions: a frame left over from an earlier
/// session must not match a new layout by sharing its number.
static LAYOUT_REVISION: AtomicU32 = AtomicU32::new(0);

/// `TwinLayout` in `src/shared/contracts/preview.ts`.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TwinLayout {
    pub display_id: String,
    pub layout_revision: u32,
    /// `None` when no strip is set up: the twin then draws no LEDs.
    pub leds: Option<LedCalibrationConfig>,
}

/// `TwinSubscribeResult` in `src/shared/contracts/preview.ts`.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TwinSubscribeResult {
    pub layout: Option<TwinLayout>,
    pub status: CommandStatus,
}

/// The LED's light as an sRGB screen would need to show it. The wire value is
/// what the PWM gets, so the light it makes is linear in it, while a screen's
/// light is its value to the 2.2: drawing the wire value would show every
/// colour darker and more saturated than the strip. The 2.2 is the screen's,
/// not the strip's — the user's LED gamma is already in the wire value.
static SCREEN_ENCODE: LazyLock<[u8; 256]> = LazyLock::new(|| {
    std::array::from_fn(|i| ((i as f32 / 255.0).powf(1.0 / 2.2) * 255.0).round() as u8)
});

/// A wire value (corrected, brightness applied) as the twin draws it.
pub fn twin_colour(wire: [u8; 3]) -> [u8; 3] {
    wire.map(|v| SCREEN_ENCODE[v as usize])
}

pub fn encode_frame(seq: u32, revision: u32, leds: &[[u8; 3]], lamps: &[[u8; 3]]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(TWIN_FRAME_HEADER_BYTES + (leds.len() + lamps.len()) * 3);
    for field in [seq, revision, leds.len() as u32, lamps.len() as u32] {
        bytes.extend_from_slice(&field.to_le_bytes());
    }
    for rgb in leds.iter().chain(lamps) {
        bytes.extend_from_slice(rgb);
    }
    bytes
}

#[derive(Default)]
struct FeedInner {
    subscriber: Option<(String, Channel)>,
    layout: Option<TwinLayout>,
    /// The last frame sent, header included but seq zeroed, for the
    /// unchanged-frame check.
    last: Vec<u8>,
    seq: u32,
}

/// One per session state; holds the twin's channel and what it was last sent.
#[derive(Default)]
pub struct TwinFeed {
    inner: Mutex<FeedInner>,
    force_next: AtomicBool,
}

impl TwinFeed {
    pub(super) fn subscribe(&self, label: String, channel: Channel) {
        if let Ok(mut inner) = self.inner.lock() {
            *inner = FeedInner {
                subscriber: Some((label, channel)),
                ..FeedInner::default()
            };
        }
        self.force_next.store(true, Ordering::SeqCst);
    }

    pub(super) fn clear(&self) {
        if let Ok(mut inner) = self.inner.lock() {
            *inner = FeedInner::default();
        }
    }

    #[cfg(test)]
    pub(super) fn layout_for_test(&self) -> Option<TwinLayout> {
        self.inner
            .lock()
            .ok()
            .and_then(|inner| inner.layout.clone())
    }

    fn subscriber_label(&self) -> Option<String> {
        self.inner
            .lock()
            .ok()
            .and_then(|inner| inner.subscriber.as_ref().map(|(label, _)| label.clone()))
    }

    /// Stores `leds` as the layout, bumping the revision only when it changed.
    /// `None` without a subscriber.
    fn set_layout(
        &self,
        display_id: String,
        leds: Option<LedCalibrationConfig>,
    ) -> Option<(TwinLayout, bool)> {
        let mut inner = self.inner.lock().ok()?;
        inner.subscriber.as_ref()?;
        let unchanged = inner
            .layout
            .as_ref()
            .is_some_and(|current| current.display_id == display_id && current.leds == leds);
        if unchanged {
            return inner.layout.clone().map(|layout| (layout, false));
        }
        let layout = TwinLayout {
            display_id,
            layout_revision: LAYOUT_REVISION.fetch_add(1, Ordering::SeqCst) + 1,
            leds,
        };
        inner.layout = Some(layout.clone());
        self.force_next.store(true, Ordering::SeqCst);
        Some((layout, true))
    }

    /// Sends the frame unless it repeats the last one. `false` when the channel
    /// is gone, so the caller can drop the subscription.
    fn send(&self, leds: &[[u8; 3]], lamps: &[[u8; 3]]) -> bool {
        let Ok(mut inner) = self.inner.lock() else {
            return true;
        };
        if inner.subscriber.is_none() {
            return true;
        }
        let revision = inner
            .layout
            .as_ref()
            .map_or(0, |layout| layout.layout_revision);
        let unseq = encode_frame(0, revision, leds, lamps);
        let forced = self.force_next.swap(false, Ordering::SeqCst);
        if !forced && unseq == inner.last {
            return true;
        }
        inner.seq = inner.seq.wrapping_add(1);
        let mut bytes = unseq.clone();
        bytes[..4].copy_from_slice(&inner.seq.to_le_bytes());
        inner.last = unseq;
        let Some((_, channel)) = inner.subscriber.as_ref() else {
            return true;
        };
        channel.send(InvokeResponseBody::Raw(bytes)).is_ok()
    }
}

/// Hands a frame from the worker to the twin. Called at most once per
/// `TWIN_FRAME_INTERVAL` and only while `twin_open` is set.
pub fn send_frame<R: Runtime>(app: &AppHandle<R>, leds: &[[u8; 3]], lamps: &[[u8; 3]]) {
    let Some(session) = app.try_state::<PreviewSessionState>() else {
        return;
    };
    if !session.feed.send(leds, lamps) {
        log::info!("[preview] the twin's channel closed; its feed stops");
        session.drop_twin_subscriber();
    }
}

/// The frame a mode with no worker shows: Solid's colour on every LED, black
/// for Off and for a mode whose worker did not start.
fn static_frame(mode: &crate::commands::lighting_mode::LightingModeConfig) -> [u8; 3] {
    match (&mode.kind, &mode.solid) {
        (LightingModeKind::Solid, Some(solid)) => {
            let plan = EncoderPlan::new(&mode.color_correction.clone().unwrap_or_default());
            twin_colour(scale_brightness(
                plan.correct([solid.r, solid.g, solid.b]),
                solid.brightness,
            ))
        }
        _ => [0, 0, 0],
    }
}

/// After the running mode, its layout or its tuning changed: sends the twin a
/// new layout if it differs, and asks for a fresh frame — from the worker on
/// its next tick, or right here when no worker runs. Takes the lighting lock
/// and then the session's, never the other way round.
pub fn refresh<R: Runtime>(app: &AppHandle<R>) {
    let Some(session) = app.try_state::<PreviewSessionState>() else {
        return;
    };
    if !session.twin_open().load(Ordering::Relaxed) {
        return;
    }
    let Some(display_id) = session.display_id() else {
        return;
    };
    let Some(runtime) = app.try_state::<LightingRuntimeState>() else {
        return;
    };
    let view = runtime.twin_view();
    let still = view.still.as_ref().map(static_frame);
    let leds = view
        .layout
        .filter(|layout| layout.total_leds > 1)
        .or_else(|| shell_state::persisted(app).and_then(|state| state.led_calibration()));
    let total = leds.as_ref().map_or(0, |layout| layout.total_leds as usize);

    if let Some((layout, changed)) = session.feed.set_layout(display_id, leds) {
        if changed {
            if let Some(label) = session.feed.subscriber_label() {
                let _ = app.emit_to(
                    EventTarget::webview_window(label.as_str()),
                    PREVIEW_TWIN_LAYOUT_EVENT,
                    &layout,
                );
            }
        }
    }
    session.feed.force_next.store(true, Ordering::SeqCst);
    if let Some(colour) = still {
        send_frame(app, &vec![colour; total], &[]);
    }
}

/// The twin asks for its frames. Only the session's own twin may: any other
/// window, or a twin from a session already closed, is told nothing is open.
#[tauri::command]
pub fn subscribe_twin_frames<R: Runtime>(
    app: AppHandle<R>,
    window: WebviewWindow<R>,
    state: State<'_, PreviewSessionState>,
    on_frame: Channel,
) -> Result<TwinSubscribeResult, String> {
    if state.twin_label().as_deref() != Some(window.label()) {
        return Ok(TwinSubscribeResult {
            layout: None,
            status: CommandStatus::ok(PREVIEW_NOT_OPEN, "No preview twin is open."),
        });
    }
    state.feed.subscribe(window.label().to_string(), on_frame);
    state.twin_open().store(true, Ordering::SeqCst);
    refresh(&app);
    let layout = state
        .feed
        .inner
        .lock()
        .ok()
        .and_then(|inner| inner.layout.clone());
    Ok(TwinSubscribeResult {
        layout,
        status: CommandStatus::ok(PREVIEW_TWIN_SUBSCRIBED, "Twin frames subscribed."),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Golden {
        seq: u32,
        layout_revision: u32,
        leds: Vec<[u8; 3]>,
        lamps: Vec<[u8; 3]>,
        hex: String,
    }

    /// The same file the TS decoder test reads: if either side moves a field,
    /// one of the two fails.
    #[test]
    fn the_frame_bytes_match_the_shared_golden_fixture() {
        let golden: Golden = serde_json::from_str(include_str!(
            "../../../../src/features/preview/__tests__/twinFrame.golden.json"
        ))
        .expect("golden fixture parses");
        let bytes = encode_frame(
            golden.seq,
            golden.layout_revision,
            &golden.leds,
            &golden.lamps,
        );
        let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
        assert_eq!(hex, golden.hex);
    }

    #[test]
    fn the_twin_shows_the_light_not_the_pwm_byte() {
        // Gamma 2.2 sends mid grey as 56; the strip makes about a fifth of full
        // light, which a screen shows at 128 again.
        let wire = EncoderPlan::default().correct([128, 128, 128]);
        assert_eq!(wire, [56, 56, 56]);
        assert_eq!(twin_colour(wire), [128, 128, 128]);
        assert_eq!(twin_colour([0, 0, 0]), [0, 0, 0]);
        assert_eq!(twin_colour([255, 255, 255]), [255, 255, 255]);
    }

    /// Solid has no worker, so its frame comes from the mode: the colour as the
    /// strip makes it, dimmed by the mode's brightness; Off is black.
    #[test]
    fn a_still_mode_draws_its_own_colour() {
        use crate::commands::lighting_mode::{LightingModeConfig, SolidColorPayload};
        let solid = LightingModeConfig {
            kind: LightingModeKind::Solid,
            solid: Some(SolidColorPayload {
                r: 255,
                g: 0,
                b: 128,
                brightness: 1.0,
                kelvin: None,
            }),
            ..LightingModeConfig::default()
        };
        assert_eq!(static_frame(&solid), [255, 0, 128]);
        let dimmed = LightingModeConfig {
            solid: Some(SolidColorPayload {
                brightness: 0.25,
                ..solid.solid.clone().unwrap()
            }),
            ..solid
        };
        let [r, _, _] = static_frame(&dimmed);
        assert!(
            r > 255 / 4 && r < 255,
            "a quarter of the light looks brighter than a quarter: {r}"
        );
        assert_eq!(static_frame(&LightingModeConfig::default()), [0, 0, 0]);
    }

    fn feed_with_subscriber() -> (TwinFeed, std::sync::Arc<Mutex<Vec<Vec<u8>>>>) {
        let received = std::sync::Arc::new(Mutex::new(Vec::new()));
        let sink = std::sync::Arc::clone(&received);
        let channel = Channel::new(move |body| {
            if let InvokeResponseBody::Raw(bytes) = body {
                sink.lock().unwrap().push(bytes);
            }
            Ok(())
        });
        let feed = TwinFeed::default();
        feed.subscribe("led-twin-overlay-1".into(), channel);
        (feed, received)
    }

    #[test]
    fn an_unchanged_frame_is_sent_once_unless_one_is_asked_for() {
        let (feed, received) = feed_with_subscriber();
        let leds = [[10, 20, 30]; 4];
        assert!(feed.send(&leds, &[]));
        assert!(feed.send(&leds, &[]));
        assert_eq!(received.lock().unwrap().len(), 1, "a repeat is not resent");

        feed.force_next.store(true, Ordering::SeqCst);
        assert!(feed.send(&leds, &[]));
        assert_eq!(received.lock().unwrap().len(), 2, "a forced frame goes out");

        assert!(feed.send(&[[0, 0, 0]; 4], &[]));
        let frames = received.lock().unwrap();
        assert_eq!(frames.len(), 3);
        let seqs: Vec<u32> = frames
            .iter()
            .map(|f| u32::from_le_bytes(f[..4].try_into().unwrap()))
            .collect();
        assert_eq!(seqs, vec![1, 2, 3]);
    }

    #[test]
    fn a_new_layout_takes_a_new_revision_and_the_same_one_does_not() {
        let (feed, _) = feed_with_subscriber();
        let (first, changed) = feed.set_layout("d".into(), None).unwrap();
        assert!(changed);
        let (again, changed) = feed.set_layout("d".into(), None).unwrap();
        assert!(!changed);
        assert_eq!(again.layout_revision, first.layout_revision);
        let (moved, changed) = feed.set_layout("e".into(), None).unwrap();
        assert!(changed);
        assert!(moved.layout_revision > first.layout_revision);
    }

    #[test]
    fn nothing_is_kept_without_a_subscriber() {
        let feed = TwinFeed::default();
        assert!(feed.set_layout("d".into(), None).is_none());
        assert!(feed.send(&[[1, 2, 3]], &[]));
    }
}
