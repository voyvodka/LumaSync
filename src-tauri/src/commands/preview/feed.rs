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
//! revision current when it was sent, and the twin drops one that does not
//! match what it draws. The layout is the one the running mode uses, so an edit being tested
//! in LED Setup shows as it runs, not as it was saved.
//!
//! A frame is sent only when it differs from the last one, unless something
//! asked for the next one regardless (a subscribe, a new layout): a still
//! picture would otherwise leave a freshly opened twin blank. Modes with no
//! worker (Solid, Off) get their one frame here, from the mode itself.

use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{LazyLock, Mutex};

use serde::Serialize;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Emitter, EventTarget, Manager, Runtime, WebviewWindow};

use super::session::{PreviewSessionState, PREVIEW_NOT_OPEN};
use crate::commands::hue::state_store::{snapshot_hue_output_context, HueRuntimeStateStore};
use crate::commands::led_calibration::LedCalibrationConfig;
use crate::commands::led_output::{scale_brightness, EncoderPlan};
use crate::commands::lighting_mode::{LightingModeKind, LightingRuntimeState, SolidColorPayload};
use crate::commands::shell_state;
use crate::commands::status::CommandStatus;
use crate::events::PREVIEW_TWIN_LAYOUT_EVENT;

const PREVIEW_TWIN_SUBSCRIBED: &str = "PREVIEW_TWIN_SUBSCRIBED";

const TWIN_FRAME_HEADER_BYTES: usize = 16;

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
    /// The Hue lamps in frame order; empty when the mode drives no Hue.
    pub lamps: Vec<TwinLamp>,
}

/// `TwinLamp` in `src/shared/contracts/preview.ts`: where the twin draws one
/// Hue lamp, `(0, 0)` top-left — where it samples the screen when the room map
/// places it, else in a row along the bottom.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TwinLamp {
    /// Entertainment channel.
    pub id: u8,
    pub x: f32,
    pub y: f32,
}

/// The unplaced lamps' row: centred, just above the bottom LEDs.
const LAMP_ROW_Y: f32 = 0.9;
const LAMP_ROW_STEP: f32 = 0.035;

fn twin_lamps(
    channels: &[crate::commands::hue::frame::HueAreaChannel],
    geometry: Option<&crate::models::room_map::RoomGeometry>,
) -> Vec<TwinLamp> {
    let placed =
        crate::commands::lighting_mode::preview::hue_lamp_screen_points(channels, geometry);
    let middle = (channels.len().saturating_sub(1)) as f32 / 2.0;
    channels
        .iter()
        .enumerate()
        .map(|(i, channel)| {
            let (x, y) = placed
                .as_ref()
                .and_then(|points| points.get(i).copied())
                .unwrap_or((0.5 + (i as f32 - middle) * LAMP_ROW_STEP, LAMP_ROW_Y));
            TwinLamp {
                id: channel.channel_id,
                x,
                y,
            }
        })
        .collect()
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

/// A linear 0–1 light level (Hue's wire values) as the twin draws it, encoded
/// from the float: rounding to a byte first leaves the dark end a handful of
/// steps, which the encode stretches into visible bands.
pub fn twin_colour_linear(linear: [f32; 3]) -> [u8; 3] {
    linear.map(|v| (v.clamp(0.0, 1.0).powf(1.0 / 2.2) * 255.0).round() as u8)
}

fn encode_into(bytes: &mut Vec<u8>, seq: u32, revision: u32, leds: &[[u8; 3]], lamps: &[[u8; 3]]) {
    bytes.clear();
    bytes.reserve(TWIN_FRAME_HEADER_BYTES + (leds.len() + lamps.len()) * 3);
    for field in [seq, revision, leds.len() as u32, lamps.len() as u32] {
        bytes.extend_from_slice(&field.to_le_bytes());
    }
    for rgb in leds.iter().chain(lamps) {
        bytes.extend_from_slice(rgb);
    }
}

#[cfg(test)]
fn encode_frame(seq: u32, revision: u32, leds: &[[u8; 3]], lamps: &[[u8; 3]]) -> Vec<u8> {
    let mut bytes = Vec::new();
    encode_into(&mut bytes, seq, revision, leds, lamps);
    bytes
}

#[derive(Default)]
struct FeedInner {
    subscriber: Option<(String, Channel)>,
    layout: Option<TwinLayout>,
    /// The last frame sent, header included but seq zeroed, for the
    /// unchanged-frame check.
    last: Vec<u8>,
    /// Where the next frame is encoded before the check, so an unchanged frame
    /// costs no allocation; it swaps with `last` when one is sent.
    scratch: Vec<u8>,
    seq: u32,
}

/// One per session state; holds the twin's channel and what it was last sent.
#[derive(Default)]
pub struct TwinFeed {
    inner: Mutex<FeedInner>,
    force_next: AtomicBool,
    /// The Hue stream generation the layout's lamps were read from. The stream
    /// reconnects and stops without a mode change, so a frame finds out.
    lamps_from: AtomicU64,
    /// A refresh asked for by a frame and not yet run, so a stale layout asks
    /// once rather than every frame.
    relayout_pending: AtomicBool,
}

impl TwinFeed {
    /// The lamps were read at an older Hue `generation` and no refresh is on
    /// its way yet. True once per change: the frames in between start none.
    fn relayout_due(&self, generation: u64) -> bool {
        generation != self.lamps_from.load(Ordering::SeqCst)
            && !self.relayout_pending.swap(true, Ordering::SeqCst)
    }

    pub(crate) fn subscribe(&self, label: String, channel: Channel) {
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

    pub(super) fn current_layout(&self) -> Option<TwinLayout> {
        self.inner
            .lock()
            .ok()
            .and_then(|inner| inner.layout.clone())
    }

    pub(super) fn has_subscriber(&self) -> bool {
        self.subscriber_label().is_some()
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
        lamps: Vec<TwinLamp>,
    ) -> Option<(TwinLayout, bool)> {
        let mut inner = self.inner.lock().ok()?;
        inner.subscriber.as_ref()?;
        let unchanged = inner.layout.as_ref().is_some_and(|current| {
            current.display_id == display_id && current.leds == leds && current.lamps == lamps
        });
        if unchanged {
            return inner.layout.clone().map(|layout| (layout, false));
        }
        let layout = TwinLayout {
            display_id,
            layout_revision: LAYOUT_REVISION.fetch_add(1, Ordering::SeqCst) + 1,
            leds,
            lamps,
        };
        inner.layout = Some(layout.clone());
        self.force_next.store(true, Ordering::SeqCst);
        Some((layout, true))
    }

    /// Sends the frame unless it repeats the last one. `false` when the channel
    /// is gone, so the caller can drop the subscription.
    pub(crate) fn send(&self, leds: &[[u8; 3]], lamps: &[[u8; 3]]) -> bool {
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
        let FeedInner { scratch, last, .. } = &mut *inner;
        encode_into(scratch, 0, revision, leds, lamps);
        let forced = self.force_next.swap(false, Ordering::SeqCst);
        if !forced && scratch == last {
            return true;
        }
        std::mem::swap(scratch, last);
        inner.seq = inner.seq.wrapping_add(1);
        if inner.seq == 1 {
            log::info!(
                "[preview] first twin frame: {} LEDs, {} lamps, layout revision {revision}",
                leds.len(),
                lamps.len()
            );
        }
        // The channel takes the body by value: the one allocation a sent frame costs.
        let mut bytes = inner.last.clone();
        bytes[..4].copy_from_slice(&inner.seq.to_le_bytes());
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
    if lamps_outdated(app, &session.feed) {
        // Off the worker: the refresh takes the lighting lock, which a
        // transition can hold while it waits for this very worker to stop.
        let app = app.clone();
        tauri::async_runtime::spawn_blocking(move || refresh(&app));
    }
    if !session.feed.send(leds, lamps) {
        log::info!("[preview] the twin's channel closed; its feed stops");
        session.drop_twin_subscriber();
    }
}

/// The Hue stream moved on since the layout read its lamps.
fn lamps_outdated<R: Runtime>(app: &AppHandle<R>, feed: &TwinFeed) -> bool {
    app.try_state::<HueRuntimeStateStore>()
        .is_some_and(|store| feed.relayout_due(store.output_live().generation()))
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

/// One refresh at a time, from the view through the layout it stores: callers
/// on different threads (a subscribe, the transition queue, a retune, the
/// shutdown stop) would otherwise let an older view land after a newer one and
/// take the fresher revision. Taken before the lighting lock, never inside it.
static REFRESH: Mutex<()> = Mutex::new(());

/// After the running mode, its layout or its tuning changed: sends the twin a
/// new layout if it differs, and asks for a fresh frame — from the worker on
/// its next tick, or right here when no worker runs. Takes the lighting lock
/// and then the session's, never the other way round.
pub fn refresh<R: Runtime>(app: &AppHandle<R>) {
    refresh_with(app, None);
}

/// After a Solid retune: the retune sends its colour straight to the outputs
/// and leaves the running mode's copy as it was, so the twin is handed it.
pub fn refresh_after_solid_retune<R: Runtime>(app: &AppHandle<R>, solid: &SolidColorPayload) {
    refresh_with(app, Some(solid));
}

/// `refresh` for an async command: on a blocking thread, since it waits on
/// the lighting lock, which a transition can hold for seconds.
pub(super) async fn refresh_awaited<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || refresh(&app))
        .await
        .map_err(|error| format!("PREVIEW_SESSION_LOCK_FAILED: the twin refresh died: {error}"))
}

fn refresh_with<R: Runtime>(app: &AppHandle<R>, retuned_solid: Option<&SolidColorPayload>) {
    let _one_at_a_time = REFRESH.lock().unwrap_or_else(|e| e.into_inner());
    let Some(session) = app.try_state::<PreviewSessionState>() else {
        return;
    };
    session.feed.relayout_pending.store(false, Ordering::SeqCst);
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
    let still = view.still.map(|mut mode| {
        if let (Some(solid), LightingModeKind::Solid) = (retuned_solid, &mode.kind) {
            mode.solid = Some(solid.clone());
        }
        static_frame(&mode)
    });
    let leds = view
        .layout
        .filter(|layout| layout.total_leds > 1)
        .or_else(|| shell_state::persisted(app).and_then(|state| state.led_calibration()));
    let total = leds.as_ref().map_or(0, |layout| layout.total_leds as usize);
    let hue = app.try_state::<HueRuntimeStateStore>();
    if let Some(store) = &hue {
        session
            .feed
            .lamps_from
            .store(store.output_live().generation(), Ordering::SeqCst);
    }
    // The stream's channels in the order the worker sends their colours.
    let channels = hue
        .filter(|_| view.drives_hue)
        .and_then(|store| snapshot_hue_output_context(store.inner()).ok().flatten())
        .map(|context| context.channels)
        .unwrap_or_default();
    let lamps = twin_lamps(&channels, view.room_geometry.as_ref());
    let lamp_count = lamps.len();

    if let Some((layout, changed)) = session.feed.set_layout(display_id, leds, lamps) {
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
    // A still mode lights its Hue lamps the colour it lights the strip.
    if let Some(colour) = still {
        send_frame(app, &vec![colour; total], &vec![colour; lamp_count]);
    }
}

/// The twin asks for its frames. Only the session's own twin may: any other
/// window, or a twin from a session already closed, is told nothing is open.
/// Async, and the refresh off the main thread: it waits on the lighting lock,
/// which a transition can hold for seconds.
#[tauri::command]
pub async fn subscribe_twin_frames<R: Runtime>(
    app: AppHandle<R>,
    window: WebviewWindow<R>,
    on_frame: Channel,
) -> Result<TwinSubscribeResult, String> {
    let Some(state) = app.try_state::<PreviewSessionState>() else {
        return Ok(not_open());
    };
    if !state.subscribe_twin(window.label(), on_frame)? {
        return Ok(not_open());
    }
    refresh_awaited(&app).await?;
    Ok(TwinSubscribeResult {
        layout: state.feed.current_layout(),
        status: CommandStatus::ok(PREVIEW_TWIN_SUBSCRIBED, "Twin frames subscribed."),
    })
}

fn not_open() -> TwinSubscribeResult {
    TwinSubscribeResult {
        layout: None,
        status: CommandStatus::ok(PREVIEW_NOT_OPEN, "No preview twin is open."),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lamp_channel(channel_id: u8, x: f32, y: f32) -> crate::commands::hue::frame::HueAreaChannel {
        crate::commands::hue::frame::HueAreaChannel {
            channel_id,
            light_ids: vec![format!("light-{channel_id}")],
            screen_region: crate::commands::hue::frame::HueScreenRegion::Center,
            position_x: x,
            position_y: y,
            position_z: Some(0.0),
        }
    }

    /// Without a room map the lamps line up along the bottom, in frame order.
    #[test]
    fn unplaced_lamps_line_up_in_frame_order_along_the_bottom() {
        let lamps = twin_lamps(
            &[lamp_channel(4, -0.8, 0.9), lamp_channel(1, 0.8, 0.9)],
            None,
        );
        assert_eq!(lamps.iter().map(|l| l.id).collect::<Vec<_>>(), vec![4, 1]);
        assert!(lamps.iter().all(|l| l.y == LAMP_ROW_Y));
        assert!(lamps[0].x < 0.5 && lamps[1].x > 0.5);
    }

    /// With a room map each lamp goes where it samples the screen: a lamp left
    /// of the TV draws on the left, one right of it on the right.
    #[test]
    fn placed_lamps_go_where_they_sample() {
        let geometry = crate::models::room_map::RoomGeometry {
            dimensions: crate::models::room_map::RoomDimensions {
                width_meters: 4.0,
                depth_meters: 5.0,
                height_meters: 2.5,
            },
            tv: crate::models::room_map::TvAnchorPlacement {
                x: 1.4,
                y: 0.0,
                width: 1.2,
                height: 0.1,
                locked: None,
                mount_height_meters: None,
            },
            hue_placements: Vec::new(),
        };
        let lamps = twin_lamps(
            &[lamp_channel(0, -0.9, 0.9), lamp_channel(1, 0.9, 0.9)],
            Some(&geometry),
        );
        assert!(lamps[0].x < 0.3, "{lamps:?}");
        assert!(lamps[1].x > 0.7, "{lamps:?}");
        assert!(lamps.iter().all(|l| (0.0..=1.0).contains(&l.y)));
    }

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
    fn a_dark_hue_lamp_keeps_its_steps() {
        // Two linear levels a byte apart at the dark end land on different
        // screen values, and full and none stay full and none.
        let a = twin_colour_linear([0.001, 0.001, 0.001]);
        let b = twin_colour_linear([0.003, 0.003, 0.003]);
        assert_ne!(a, b);
        assert_eq!(twin_colour_linear([1.0, 0.0, 1.0]), [255, 0, 255]);
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
        let (first, changed) = feed.set_layout("d".into(), None, Vec::new()).unwrap();
        assert!(changed);
        let (again, changed) = feed.set_layout("d".into(), None, Vec::new()).unwrap();
        assert!(!changed);
        assert_eq!(again.layout_revision, first.layout_revision);
        let (moved, changed) = feed.set_layout("e".into(), None, Vec::new()).unwrap();
        assert!(changed);
        assert!(moved.layout_revision > first.layout_revision);
    }

    #[test]
    fn a_hue_stream_change_starts_one_relayout_until_it_lands() {
        let feed = TwinFeed::default();
        assert!(!feed.relayout_due(0), "the lamps are current");
        assert!(feed.relayout_due(1));
        assert!(!feed.relayout_due(1), "one is already on its way");

        // What the refresh does: clear the flag, then read the lamps.
        feed.relayout_pending.store(false, Ordering::SeqCst);
        feed.lamps_from.store(1, Ordering::SeqCst);
        assert!(!feed.relayout_due(1));
        assert!(feed.relayout_due(2), "the next change starts another");
    }

    #[test]
    fn nothing_is_kept_without_a_subscriber() {
        let feed = TwinFeed::default();
        assert!(feed.set_layout("d".into(), None, Vec::new()).is_none());
        assert!(feed.send(&[[1, 2, 3]], &[]));
    }
}
