//! HueStream binary frame builder, channel data model, and colour conversions.
//!
//! Pure (no I/O) helpers carved out of the original `hue_stream_lifecycle.rs`
//! when it was split up. Behaviour and on-the-wire layout are preserved
//! exactly — every constant, frame layout, and rgb→xy coefficient matches the
//! pre-refactor implementation byte-for-byte.

use std::collections::HashMap;
use std::sync::mpsc::{RecvError, RecvTimeoutError, TryRecvError};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use super::sender::HueLightMetadata;

// ---------------------------------------------------------------------------
// HueStream binary protocol constants (v2.0, API version 1.0)
// ---------------------------------------------------------------------------

/// "HueStream" magic bytes.
pub(super) const HUESTREAM_MAGIC: &[u8; 9] = b"HueStream";
/// Protocol version: major=2, minor=0.
pub(super) const HUESTREAM_VERSION_MAJOR: u8 = 0x02;
pub(super) const HUESTREAM_VERSION_MINOR: u8 = 0x00;
/// Sequence number — 0x00 for non-sequenced mode (simplest).
pub(super) const HUESTREAM_SEQUENCE: u8 = 0x00;
/// Reserved bytes (2 bytes, must be 0x00).
pub(super) const HUESTREAM_RESERVED: [u8; 2] = [0x00, 0x00];
/// Color space: 0x00 = RGB, 0x01 = XY+Brightness.
pub(super) const HUESTREAM_COLOR_SPACE_RGB: u8 = 0x00;

// ---------------------------------------------------------------------------
// Channel data model
// ---------------------------------------------------------------------------

/// The screen region a Hue entertainment channel should receive colour from.
/// Derived from the channel's 3D position as reported by the bridge.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum HueScreenRegion {
    Top,
    Bottom,
    Left,
    Right,
    Center,
}

impl HueScreenRegion {
    pub fn as_str(&self) -> &'static str {
        match self {
            HueScreenRegion::Top => "top",
            HueScreenRegion::Bottom => "bottom",
            HueScreenRegion::Left => "left",
            HueScreenRegion::Right => "right",
            HueScreenRegion::Center => "center",
        }
    }
}

/// A single resolved Hue entertainment channel: the lights it controls and
/// the screen region those lights should mirror.
#[derive(Clone, Debug)]
pub struct HueAreaChannel {
    /// Entertainment channel ID (0-based index used in HueStream frames).
    pub channel_id: u8,
    /// CLIP v2 light resource IDs belonging to this channel.
    pub light_ids: Vec<String>,
    /// Screen region derived from the channel's x/y position (or overridden by user).
    pub screen_region: HueScreenRegion,
    /// Raw position X reported by the bridge (-1 left ... +1 right).
    pub position_x: f32,
    /// Raw position Y reported by the bridge (-1 bottom ... +1 top).
    pub position_y: f32,
    /// Height (-1 floor ... +1 ceiling). `None` when the bridge sent no `z` —
    /// never defaulted to 0, which would read as a real height of mid-room.
    /// Read only by room-aware sampling (`commands::room_affinity`), which runs
    /// while a TV anchor exists; region, topology and the legacy path ignore it.
    pub position_z: Option<f32>,
}

/// Serialisable summary of a single Hue entertainment channel for the UI.
#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct HueAreaChannelInfo {
    /// Our ordinal, and the key every locally persisted override is stored
    /// under. Coincides with `channel_id` only on a contiguous area — never
    /// substitute one for the other, and never send this to the bridge.
    pub index: usize,
    /// The bridge's identity, and the byte written into the HueStream frame.
    pub channel_id: u8,
    pub light_ids: Vec<String>,
    pub position_x: f32,
    pub position_y: f32,
    pub position_z: Option<f32>,
    pub light_count: usize,
    /// Auto-detected screen region ("left", "right", "top", "bottom", "center").
    pub auto_region: String,
}

// ---------------------------------------------------------------------------
// Background sender channel update payload + handle
// ---------------------------------------------------------------------------

/// One channel's colour on the wire's scale, 0–1 per component, before
/// brightness. Kept in `f32` up to the frame so the 16-bit wire is used.
pub(crate) type HueRgb = [f32; 3];

/// How the sender takes a new target (docs/architecture/hue.md, "The sender
/// eases between targets").
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum HueMotion {
    /// Ambilight: glide from what the lamps show towards the target.
    Ease,
    /// Solid colour and test patterns: show it as it is.
    Snap,
}

#[derive(Debug)]
pub(crate) struct HueColorUpdate {
    /// Per-channel colours in channel order (one entry per `HueAreaChannel`).
    pub(crate) channel_colors: Vec<HueRgb>,
    pub(crate) brightness: f32,
    pub(crate) motion: HueMotion,
}

#[cfg(test)]
impl HueColorUpdate {
    /// The colours rounded to 8 bits, for tests written against `u8` input.
    pub(crate) fn rgb8(&self) -> Vec<(u8, u8, u8)> {
        self.channel_colors
            .iter()
            .map(|c| {
                let [r, g, b] = c.map(|v| (v * 255.0).round().clamp(0.0, 255.0) as u8);
                (r, g, b)
            })
            .collect()
    }
}

/// Newest-wins handoff from the frame producers to one sender thread. The
/// bounded queue it replaced dropped the *newest* frame when full, so with
/// capture running faster than the 50 ms send floor the sender streamed a
/// frame that was already stale; a put here replaces whatever the sender has
/// not taken yet.
#[derive(Debug)]
pub(crate) struct HueFrameMailbox {
    state: Mutex<HueFrameMailboxState>,
    ready: Condvar,
}

#[derive(Debug)]
struct HueFrameMailboxState {
    latest: Option<HueColorUpdate>,
    closed: bool,
}

impl HueFrameMailbox {
    fn lock(&self) -> MutexGuard<'_, HueFrameMailboxState> {
        self.state.lock().unwrap_or_else(|err| err.into_inner())
    }

    fn put(&self, update: HueColorUpdate) {
        let replaced = self.lock().latest.replace(update);
        self.ready.notify_one();
        drop(replaced);
    }

    fn close(&self) {
        self.lock().closed = true;
        self.ready.notify_all();
    }
}

/// Producer end, shared by every `HueColorSender` clone through its `Arc`.
/// Dropping the last one closes the mailbox, and that is what ends the sender
/// thread: see "The sender exits only when every handle is gone" in
/// docs/architecture/hue.md.
#[derive(Debug)]
pub(crate) enum HueFrameTx {
    Mailbox(Arc<HueFrameMailbox>),
    /// Every frame, in order, for tests that compare whole sequences.
    #[cfg(test)]
    Recording(std::sync::mpsc::Sender<HueColorUpdate>),
}

impl HueFrameTx {
    fn put(&self, update: HueColorUpdate) {
        match self {
            Self::Mailbox(mailbox) => mailbox.put(update),
            #[cfg(test)]
            Self::Recording(tx) => {
                let _ = tx.send(update);
            }
        }
    }
}

impl Drop for HueFrameTx {
    fn drop(&mut self) {
        match self {
            Self::Mailbox(mailbox) => mailbox.close(),
            #[cfg(test)]
            Self::Recording(_) => {}
        }
    }
}

/// Consumer end, owned by the sender thread. Shaped like the `mpsc` receiver
/// it replaced: a frame put before the last handle dropped is still handed
/// out before `Disconnected`.
#[derive(Debug)]
pub(crate) struct HueFrameRx {
    mailbox: Arc<HueFrameMailbox>,
}

impl HueFrameRx {
    pub(crate) fn recv_timeout(
        &self,
        timeout: Duration,
    ) -> Result<HueColorUpdate, RecvTimeoutError> {
        let deadline = Instant::now() + timeout;
        let mut state = self.mailbox.lock();
        loop {
            if let Some(update) = state.latest.take() {
                return Ok(update);
            }
            if state.closed {
                return Err(RecvTimeoutError::Disconnected);
            }
            let now = Instant::now();
            if now >= deadline {
                return Err(RecvTimeoutError::Timeout);
            }
            state = self
                .mailbox
                .ready
                .wait_timeout(state, deadline - now)
                .unwrap_or_else(|err| err.into_inner())
                .0;
        }
    }

    pub(crate) fn recv(&self) -> Result<HueColorUpdate, RecvError> {
        let mut state = self.mailbox.lock();
        loop {
            if let Some(update) = state.latest.take() {
                return Ok(update);
            }
            if state.closed {
                return Err(RecvError);
            }
            state = self
                .mailbox
                .ready
                .wait(state)
                .unwrap_or_else(|err| err.into_inner());
        }
    }

    pub(crate) fn try_recv(&self) -> Result<HueColorUpdate, TryRecvError> {
        let mut state = self.mailbox.lock();
        match state.latest.take() {
            Some(update) => Ok(update),
            None if state.closed => Err(TryRecvError::Disconnected),
            None => Err(TryRecvError::Empty),
        }
    }

    /// Every producer handle is gone. Leaves a pending frame where it is.
    pub(crate) fn is_closed(&self) -> bool {
        self.mailbox.lock().closed
    }
}

/// Lightweight, cloneable handle to the background Hue color sender thread.
/// Cloning only increments an Arc refcount -- cheap. When every clone drops,
/// the mailbox closes and the background thread exits on its own.
#[derive(Clone, Debug)]
pub struct HueColorSender {
    pub(crate) tx: Arc<HueFrameTx>,
    /// Number of channels; used by `try_send` to broadcast a solid colour.
    pub(crate) channel_count: usize,
}

impl HueColorSender {
    /// A sender on a fresh mailbox, and the sender thread's end of it.
    pub(crate) fn with_mailbox(channel_count: usize) -> (Self, HueFrameRx) {
        let mailbox = Arc::new(HueFrameMailbox {
            state: Mutex::new(HueFrameMailboxState {
                latest: None,
                closed: false,
            }),
            ready: Condvar::new(),
        });
        (
            Self {
                tx: Arc::new(HueFrameTx::Mailbox(Arc::clone(&mailbox))),
                channel_count,
            },
            HueFrameRx { mailbox },
        )
    }

    /// A sender that keeps every frame, in order, for tests that compare whole
    /// sequences rather than what a sender thread would pick up.
    #[cfg(test)]
    pub(crate) fn recording(
        channel_count: usize,
    ) -> (Self, std::sync::mpsc::Receiver<HueColorUpdate>) {
        let (tx, rx) = std::sync::mpsc::channel();
        (
            Self {
                tx: Arc::new(HueFrameTx::Recording(tx)),
                channel_count,
            },
            rx,
        )
    }

    /// Broadcast the same colour to every channel. Used by the solid-colour
    /// path. Never blocks; a frame the sender has not taken yet is replaced.
    pub fn try_send(&self, r: u8, g: u8, b: u8, brightness: f32) {
        let rgb = [r, g, b].map(|v| f32::from(v) / 255.0);
        let channel_colors = vec![rgb; self.channel_count.max(1)];
        self.tx.put(HueColorUpdate {
            channel_colors,
            brightness,
            motion: HueMotion::Snap,
        });
    }

    /// Send individual colours per channel. `colors` must be indexed the same
    /// way as the `HueAreaChannel` list used when the sender was spawned.
    pub(crate) fn try_send_channels(
        &self,
        colors: Vec<HueRgb>,
        brightness: f32,
        motion: HueMotion,
    ) {
        if colors.is_empty() {
            return;
        }
        self.tx.put(HueColorUpdate {
            channel_colors: colors,
            brightness,
            motion,
        });
    }
}

// ---------------------------------------------------------------------------
// HueStream binary frame builder
// ---------------------------------------------------------------------------

/// Build a HueStream v2 binary frame for the entertainment API.
///
/// Frame layout (header = 16 bytes):
///   Bytes  0..8:  "HueStream" (9 bytes magic)
///   Byte   9:     API version major (0x02)
///   Byte  10:     API version minor (0x00)
///   Byte  11:     Sequence number (0x00 = non-sequenced)
///   Bytes 12..13: Reserved (0x00, 0x00)
///   Byte  14:     Color space (0x00 = RGB)
///   Byte  15:     Reserved (0x00)
///
/// Per light entry (7 bytes each):
///   Byte   0:     Channel ID (uint8)
///   Bytes 1..2:   Red   (uint16 BE, 0..65535)
///   Bytes 3..4:   Green (uint16 BE, 0..65535)
///   Bytes 5..6:   Blue  (uint16 BE, 0..65535)
///
/// Between the header and channel entries there is a 36-byte field containing
/// the entertainment_configuration resource UUID (ASCII string, e.g.
/// "1a8d99cc-967b-44f2-9202-43f976c0fa6b"). This field is mandatory per the
/// Hue Entertainment API v2.0 specification — the bridge uses it to route the
/// frame to the correct entertainment area when multiple sessions could be
/// active. Without it the bridge cannot parse the channel data and ignores
/// the frame entirely.
#[cfg(test)]
pub(crate) fn build_huestream_frame(
    area_id: &str,
    channels: &[HueAreaChannel],
    channel_colors: &[(u8, u8, u8)],
    brightness: f32,
    light_metadata: &HashMap<String, HueLightMetadata>,
) -> Vec<u8> {
    let mut colors: Vec<HueRgb> = channel_colors
        .iter()
        .map(|&(r, g, b)| [r, g, b].map(|v| f32::from(v) / 255.0))
        .collect();
    clip_channels_to_gamut(channels, &mut colors, light_metadata);
    let mut frame = Vec::new();
    encode_huestream_frame(area_id, channels, &colors, brightness, &mut frame);
    frame
}

/// Per-bulb gamut triangle clip, in place. The sender runs it once per new
/// target rather than per packet: an eased step between two in-gamut colours
/// stays in gamut, the triangle being convex.
///
/// We resolve the channel's gamut from the first bulb in `light_ids` (a Hue
/// entertainment channel's bulbs are typically the same archetype; mixed-gamut
/// zones are rare and a per-channel min-gamut strategy is deferred to v2
/// alongside the zone authoring surface). Cache misses + `HueGamutType::Other`
/// are pass-through, preserving v1.4 behaviour for unknown bulbs.
pub(crate) fn clip_channels_to_gamut(
    channels: &[HueAreaChannel],
    colors: &mut [HueRgb],
    light_metadata: &HashMap<String, HueLightMetadata>,
) {
    for (channel, color) in channels.iter().zip(colors.iter_mut()) {
        let gamut = channel
            .light_ids
            .first()
            .and_then(|id| light_metadata.get(id))
            .map(|meta| meta.gamut_type)
            .unwrap_or(HueGamutType::Other);
        if matches!(gamut, HueGamutType::Other) || *color == [0.0; 3] {
            continue;
        }
        // Bug H2: preserve the input's own luminance through the clip
        // instead of a hard-coded 1.0. See docs/architecture/hue.md.
        let [r, g, b] = color.map(|v| f64::from(v.clamp(0.0, 1.0)));
        let (xy_x, xy_y, big_y) = linear_rgb_to_xy(r, g, b);
        let clipped = clip_xy_to_gamut((xy_x, xy_y), gamut);
        if (clipped.0 - xy_x).abs() > 1e-9 || (clipped.1 - xy_y).abs() > 1e-9 {
            let (cr, cg, cb) = xy_to_linear_rgb(clipped.0, clipped.1, big_y);
            color.copy_from_slice(&[cr as f32, cg as f32, cb as f32]);
        }
    }
}

/// One HueStream packet into `frame` (cleared first, so a sender can reuse
/// the buffer). Colours are taken as they are: clip them first.
pub(crate) fn encode_huestream_frame(
    area_id: &str,
    channels: &[HueAreaChannel],
    channel_colors: &[HueRgb],
    brightness: f32,
    frame: &mut Vec<u8>,
) {
    const UUID_LEN: usize = 36;
    let header_len = 16;
    let entry_len = 7;
    frame.clear();
    frame.reserve(header_len + UUID_LEN + channels.len() * entry_len);

    // Header
    frame.extend_from_slice(HUESTREAM_MAGIC);
    frame.push(HUESTREAM_VERSION_MAJOR);
    frame.push(HUESTREAM_VERSION_MINOR);
    frame.push(HUESTREAM_SEQUENCE);
    frame.extend_from_slice(&HUESTREAM_RESERVED);
    frame.push(HUESTREAM_COLOR_SPACE_RGB);
    frame.push(0x00); // reserved

    // Entertainment configuration UUID (36 ASCII bytes), required by spec.
    // Pad or truncate defensively to always emit exactly UUID_LEN bytes so
    // channel offsets are deterministic even if the stored ID is malformed.
    let id_bytes = area_id.as_bytes();
    if id_bytes.len() >= UUID_LEN {
        frame.extend_from_slice(&id_bytes[..UUID_LEN]);
    } else {
        frame.extend_from_slice(id_bytes);
        frame.extend(std::iter::repeat_n(0u8, UUID_LEN - id_bytes.len()));
    }

    let brightness_clamped = brightness.clamp(0.0, 1.0);

    for (i, channel) in channels.iter().enumerate() {
        let [r, g, b] = channel_colors.get(i).copied().unwrap_or([0.0; 3]);
        // Scale to 16-bit and apply brightness
        let wire = |c: f32| (c.clamp(0.0, 1.0) * brightness_clamped * 65535.0) as u16;

        frame.push(channel.channel_id);
        frame.extend_from_slice(&wire(r).to_be_bytes());
        frame.extend_from_slice(&wire(g).to_be_bytes());
        frame.extend_from_slice(&wire(b).to_be_bytes());
    }
}

// ---------------------------------------------------------------------------
// Colour-space conversions
// ---------------------------------------------------------------------------

/// CIE 1931 chromaticity of a **linear-light** RGB triple (0–1 per component)
/// through Hue's wide-gamut RGB → XYZ matrix. No transfer function: every
/// colour reaching the Hue sender was already decoded by the pipeline's gamma
/// stage, and applying the sRGB EOTF here too linearised it twice — see "Where
/// a Hue colour is gamma-encoded and where it is linear" in
/// docs/architecture/hue.md.
///
/// Returns `(x, y, big_y)`: `(x, y)` is the chromaticity, bridge-ready for a
/// CLIP v2 `color.xy`; `big_y` is the luminance, fed back through
/// [`xy_to_linear_rgb`] to preserve it across a gamut clip (Bug H2 — see
/// docs/architecture/hue.md).
pub(crate) fn linear_rgb_to_xy(red: f64, green: f64, blue: f64) -> (f64, f64, f64) {
    let x = red * 0.664_511 + green * 0.154_324 + blue * 0.162_028;
    let y = red * 0.283_881 + green * 0.668_433 + blue * 0.047_685;
    let z = red * 0.000_088 + green * 0.072_31 + blue * 0.986_039;
    let sum = x + y + z;

    if sum <= f64::EPSILON {
        // D65 white-point fallback for true black input — matches the
        // pre-Bug-H2 behaviour. `big_y` is reported as 0.0 so callers
        // who thread it into the inverse transform produce black.
        return (0.3127, 0.3290, 0.0);
    }

    (x / sum, y / sum, y)
}

/// Inverse of [`linear_rgb_to_xy`]: the linear-light RGB triple (0–1 per
/// component) with chromaticity `(x, y)` and luminance `target_y`. Clamps
/// each component to `[0, 1]` rather than renormalising (Bug H2 — see
/// docs/architecture/hue.md) — some chromaticities land outside the RGB cube
/// even after the upstream gamut clip, and clamping is the correct response to
/// that, not a redo.
pub(crate) fn xy_to_linear_rgb(x: f64, y: f64, target_y: f64) -> (f64, f64, f64) {
    // Treat negative or near-zero target luminance as "true black". This
    // keeps the EPSILON guard (the channel is unrenderable) but moves it
    // to the *target* luminance — never the input chromaticity's `y` —
    // so we no longer drop a bulb to (0, 0, 0) when `clip_xy_to_gamut`'s
    // segment endpoint clamp produces a chromaticity with a sub-EPSILON
    // y-coordinate yet a perfectly valid target luminance.
    if target_y <= f64::EPSILON {
        return (0.0, 0.0, 0.0);
    }
    // Guard against degenerate chromaticity (y == 0) — divide-by-zero
    // protection. We treat it as unrenderable rather than fabricate a
    // colour, matching pre-fix behaviour for that pathological branch.
    if y <= f64::EPSILON {
        return (0.0, 0.0, 0.0);
    }

    let big_y = target_y;
    let big_x = (big_y / y) * x;
    let big_z = (big_y / y) * (1.0 - x - y);

    // Hue-published inverse of the linear-RGB → XYZ matrix used by
    // `linear_rgb_to_xy`. Coefficients sourced from the same Philips developer
    // documentation, accurate to 6 decimals.
    let r = big_x * 1.656_492 + big_y * -0.354_851 + big_z * -0.255_038;
    let g = big_x * -0.707_196 + big_y * 1.655_397 + big_z * 0.036_152;
    let b = big_x * 0.051_713 + big_y * -0.121_364 + big_z * 1.011_530;

    // Bug H2: do NOT renormalise so the largest channel saturates —
    // that path strips the input luminance and lets the brightness
    // scalar applied downstream apply on top of an artificially dim
    // sample. Instead clamp each channel into [0, 1] independently.
    // Out-of-gamut chromaticities are the caller's problem to project
    // (see `clip_xy_to_gamut`).
    (r.clamp(0.0, 1.0), g.clamp(0.0, 1.0), b.clamp(0.0, 1.0))
}

// CIE xy vertices per Hue gamut (A/B/C, `Other` pass-through); see
// docs/architecture/hue.md for why we clip host-side.
use super::sender::HueGamutType;

/// CIE xy gamut triangle as `[red, green, blue]` vertices.
pub(super) const GAMUT_A: [(f64, f64); 3] = [(0.704, 0.296), (0.2151, 0.7106), (0.138, 0.080)];
pub(super) const GAMUT_B: [(f64, f64); 3] = [(0.675, 0.322), (0.4091, 0.518), (0.167, 0.040)];
pub(super) const GAMUT_C: [(f64, f64); 3] = [(0.692, 0.308), (0.170, 0.700), (0.153, 0.048)];

fn gamut_vertices(gamut: HueGamutType) -> Option<[(f64, f64); 3]> {
    match gamut {
        HueGamutType::A => Some(GAMUT_A),
        HueGamutType::B => Some(GAMUT_B),
        HueGamutType::C => Some(GAMUT_C),
        HueGamutType::Other => None,
    }
}

/// Cross-product sign for the 2D point `p` against the directed edge
/// `a → b`. Strictly positive ⇒ left of edge, strictly negative ⇒
/// right of edge, exact zero ⇒ on the line.
fn cross_sign(p: (f64, f64), a: (f64, f64), b: (f64, f64)) -> f64 {
    (b.0 - a.0) * (p.1 - a.1) - (b.1 - a.1) * (p.0 - a.0)
}

/// Test whether `p` lies inside (or on) the triangle `abc`.
fn point_in_triangle(p: (f64, f64), a: (f64, f64), b: (f64, f64), c: (f64, f64)) -> bool {
    // Use a small epsilon so points on the triangle's edges (within
    // floating-point rounding) are treated as inside. Without this the
    // post-projection clamp can produce a point that fails the
    // strictly-greater check on its own boundary.
    const EPS: f64 = 1e-9;
    let d1 = cross_sign(p, a, b);
    let d2 = cross_sign(p, b, c);
    let d3 = cross_sign(p, c, a);
    let has_neg = d1 < -EPS || d2 < -EPS || d3 < -EPS;
    let has_pos = d1 > EPS || d2 > EPS || d3 > EPS;
    !(has_neg && has_pos)
}

/// Project the point `p` onto the line segment `a → b` and return the
/// closest point that still lies on the segment.
fn closest_point_on_segment(p: (f64, f64), a: (f64, f64), b: (f64, f64)) -> (f64, f64) {
    let ab = (b.0 - a.0, b.1 - a.1);
    let ap = (p.0 - a.0, p.1 - a.1);
    let denom = ab.0 * ab.0 + ab.1 * ab.1;
    if denom <= f64::EPSILON {
        return a;
    }
    let t = ((ap.0 * ab.0 + ap.1 * ab.1) / denom).clamp(0.0, 1.0);
    (a.0 + t * ab.0, a.1 + t * ab.1)
}

fn distance_squared(p: (f64, f64), q: (f64, f64)) -> f64 {
    let dx = p.0 - q.0;
    let dy = p.1 - q.1;
    dx * dx + dy * dy
}

/// Clip a CIE xy chromaticity into the gamut triangle of the supplied
/// bulb gamut. If the point is already inside (or on an edge of) the
/// triangle it is returned unchanged. Otherwise the closest point on
/// any of the three edges is selected — this is the projection rule
/// Hue's official documentation prescribes and the same one Hyperion
/// uses today.
///
/// `HueGamutType::Other` (unknown / fallback) returns the input
/// unchanged so that bulbs we cannot identify do not get colours
/// silently distorted.
pub fn clip_xy_to_gamut(xy: (f64, f64), gamut: HueGamutType) -> (f64, f64) {
    let Some(vertices) = gamut_vertices(gamut) else {
        return xy;
    };
    let [r, g, b] = vertices;
    if point_in_triangle(xy, r, g, b) {
        return xy;
    }
    // Project onto each edge and pick whichever projection is closest.
    let candidates = [
        closest_point_on_segment(xy, r, g),
        closest_point_on_segment(xy, g, b),
        closest_point_on_segment(xy, b, r),
    ];
    let mut best = candidates[0];
    let mut best_dist = distance_squared(xy, best);
    for cand in &candidates[1..] {
        let d = distance_squared(xy, *cand);
        if d < best_dist {
            best = *cand;
            best_dist = d;
        }
    }
    best
}

// ---------------------------------------------------------------------------
// Channel position → screen region mapping + UI projection helpers
// ---------------------------------------------------------------------------

/// Map a Hue channel's 2D position (x: -1 left ... +1 right, y: -1 bottom ... +1 top)
/// to the screen region whose colour that channel should display.
pub(crate) fn channel_position_to_screen_region(x: f32, y: f32) -> HueScreenRegion {
    let abs_x = x.abs();
    let abs_y = y.abs();
    if abs_x >= abs_y {
        if x < -0.3 {
            HueScreenRegion::Left
        } else if x > 0.3 {
            HueScreenRegion::Right
        } else {
            HueScreenRegion::Center
        }
    } else if y > 0.3 {
        HueScreenRegion::Top
    } else if y < -0.3 {
        HueScreenRegion::Bottom
    } else {
        HueScreenRegion::Center
    }
}

// Zone-relative positions are an authoring concept resolved in
// `room_map::hue_zone` (`world_pos_from_zone_relative`); the frame path reads
// only the world coordinates stored on a placement.

pub(crate) fn channels_to_info(channels: &[HueAreaChannel]) -> Vec<HueAreaChannelInfo> {
    channels
        .iter()
        .enumerate()
        .map(|(index, ch)| HueAreaChannelInfo {
            index,
            channel_id: ch.channel_id,
            light_ids: ch.light_ids.clone(),
            position_x: ch.position_x,
            position_y: ch.position_y,
            position_z: ch.position_z,
            light_count: ch.light_ids.len(),
            auto_region: ch.screen_region.as_str().to_string(),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Item 16: the bounded queue dropped the newest frame when full. A sender
    /// thread that has not taken a frame yet must find the latest one.
    #[test]
    fn a_frame_not_yet_taken_is_replaced_by_the_newer_one() {
        let (sender, rx) = HueColorSender::with_mailbox(1);
        for r in 1..=3 {
            sender.try_send(r, 0, 0, 1.0);
        }
        assert_eq!(rx.try_recv().expect("a frame").rgb8(), vec![(3, 0, 0)]);
        assert!(matches!(rx.try_recv(), Err(TryRecvError::Empty)));
    }

    #[test]
    fn the_mailbox_closes_only_once_every_sender_handle_is_gone() {
        let (sender, rx) = HueColorSender::with_mailbox(1);
        let clone = sender.clone();
        sender.try_send(9, 0, 0, 1.0);
        drop(sender);
        assert!(!rx.is_closed());

        drop(clone);
        assert!(rx.is_closed());
        assert_eq!(
            rx.recv_timeout(Duration::ZERO)
                .expect("a frame put before the close is still handed out")
                .rgb8(),
            vec![(9, 0, 0)]
        );
        assert!(matches!(
            rx.recv_timeout(Duration::from_millis(10)),
            Err(RecvTimeoutError::Disconnected)
        ));
        assert!(rx.recv().is_err());
    }

    #[test]
    fn channels_to_info_keeps_the_bridge_id_apart_from_the_ordinal() {
        // Gapped on purpose. A contiguous area makes the two coincide, so a
        // fixture built from one passes whether or not the id is carried at
        // all — which is how the ordinal reached the bridge unnoticed.
        let channels: Vec<HueAreaChannel> = [0u8, 2, 5]
            .iter()
            .map(|id| HueAreaChannel {
                channel_id: *id,
                light_ids: vec![format!("light-{id}")],
                screen_region: HueScreenRegion::Left,
                position_x: 0.0,
                position_y: 0.0,
                position_z: None,
            })
            .collect();

        let info = channels_to_info(&channels);

        assert_eq!(
            info.iter().map(|c| c.index).collect::<Vec<_>>(),
            vec![0, 1, 2]
        );
        assert_eq!(
            info.iter().map(|c| c.channel_id).collect::<Vec<_>>(),
            vec![0, 2, 5]
        );
        assert_eq!(info[2].light_ids, vec!["light-5".to_string()]);
        assert_eq!(info[2].light_count, 1);
    }

    #[test]
    fn build_huestream_frame_produces_correct_header_and_channels() {
        let channels = vec![
            HueAreaChannel {
                channel_id: 0,
                light_ids: vec!["l1".to_string()],
                screen_region: HueScreenRegion::Left,
                position_x: -0.8,
                position_y: 0.0,
                position_z: None,
            },
            HueAreaChannel {
                channel_id: 1,
                light_ids: vec!["l2".to_string()],
                screen_region: HueScreenRegion::Right,
                position_x: 0.8,
                position_y: 0.0,
                position_z: None,
            },
        ];
        let colors = vec![(255, 0, 0), (0, 255, 0)];
        let area_id = "1a8d99cc-967b-44f2-9202-43f976c0fa6b";
        let frame = build_huestream_frame(area_id, &channels, &colors, 1.0, &HashMap::new());

        // Header: 9 magic + 1 major + 1 minor + 1 seq + 2 reserved + 1 color_space + 1 reserved = 16
        assert_eq!(&frame[0..9], b"HueStream");
        assert_eq!(frame[9], 0x02); // major
        assert_eq!(frame[10], 0x00); // minor
        assert_eq!(frame[11], 0x00); // sequence
        assert_eq!(frame[12], 0x00); // reserved
        assert_eq!(frame[13], 0x00); // reserved
        assert_eq!(frame[14], 0x00); // color space RGB
        assert_eq!(frame[15], 0x00); // reserved

        // Entertainment configuration UUID (bytes 16..52, 36 bytes ASCII)
        assert_eq!(&frame[16..52], area_id.as_bytes());

        // Channel 0: id=0, R=65535, G=0, B=0  (starts at byte 52)
        assert_eq!(frame[52], 0); // channel_id
        assert_eq!(frame[53..55], 0xFFFFu16.to_be_bytes()); // R
        assert_eq!(frame[55..57], 0x0000u16.to_be_bytes()); // G
        assert_eq!(frame[57..59], 0x0000u16.to_be_bytes()); // B

        // Channel 1: id=1, R=0, G=65535, B=0  (starts at byte 59)
        assert_eq!(frame[59], 1); // channel_id
        assert_eq!(frame[60..62], 0x0000u16.to_be_bytes()); // R
        assert_eq!(frame[62..64], 0xFFFFu16.to_be_bytes()); // G
        assert_eq!(frame[64..66], 0x0000u16.to_be_bytes()); // B

        // Total: 16 header + 36 UUID + 2*7 channels = 66
        assert_eq!(frame.len(), 66);
    }

    #[test]
    fn build_huestream_frame_applies_brightness() {
        let channels = vec![HueAreaChannel {
            channel_id: 0,
            light_ids: vec!["l1".to_string()],
            screen_region: HueScreenRegion::Center,
            position_x: 0.0,
            position_y: 0.0,
            position_z: None,
        }];
        let colors = vec![(255, 255, 255)];
        let frame = build_huestream_frame(
            "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
            &channels,
            &colors,
            0.5,
            &HashMap::new(),
        );

        // Channel starts at byte 52 (16 header + 36 UUID). At 50% brightness, 255 -> ~32767.
        let r = u16::from_be_bytes([frame[53], frame[54]]);
        let g = u16::from_be_bytes([frame[55], frame[56]]);
        let b = u16::from_be_bytes([frame[57], frame[58]]);
        assert!(r > 32000 && r < 33000, "R={r} should be ~32767");
        assert!(g > 32000 && g < 33000, "G={g} should be ~32767");
        assert!(b > 32000 && b < 33000, "B={b} should be ~32767");
    }

    // -----------------------------------------------------------------------
    // Per-bulb gamut triangle clipping
    // -----------------------------------------------------------------------

    #[test]
    fn clip_xy_to_gamut_passes_through_when_point_is_inside_triangle() {
        // For each gamut take the centroid of its triangle — guaranteed
        // interior — and verify clip is a no-op. (D65 sits outside Hue
        // gamut B, so a per-gamut interior probe is the correct target.)
        for (gamut, vertices) in [
            (HueGamutType::A, GAMUT_A),
            (HueGamutType::B, GAMUT_B),
            (HueGamutType::C, GAMUT_C),
        ] {
            let inside = (
                (vertices[0].0 + vertices[1].0 + vertices[2].0) / 3.0,
                (vertices[0].1 + vertices[1].1 + vertices[2].1) / 3.0,
            );
            assert!(
                point_in_triangle(inside, vertices[0], vertices[1], vertices[2]),
                "centroid must be inside its own triangle"
            );
            let clipped = clip_xy_to_gamut(inside, gamut);
            assert!(
                (clipped.0 - inside.0).abs() < 1e-9,
                "gamut {:?}: expected x pass-through, got {:?}",
                gamut,
                clipped
            );
            assert!(
                (clipped.1 - inside.1).abs() < 1e-9,
                "gamut {:?}: expected y pass-through, got {:?}",
                gamut,
                clipped
            );
        }
    }

    #[test]
    fn clip_xy_to_gamut_other_is_identity() {
        let xy = (0.0, 0.0); // far outside any triangle
        let out = clip_xy_to_gamut(xy, HueGamutType::Other);
        assert_eq!(out, xy);
    }

    #[test]
    fn clip_xy_to_gamut_projects_out_of_triangle_blue_onto_gamut_b_edge() {
        // CIE xy ≈ (0.10, 0.02) — outside gamut B (whose blue corner is
        // 0.167, 0.040). Expect the result to land near gamut B's blue
        // corner / blue-red edge, not at the center.
        let xy = (0.10, 0.02);
        let clipped = clip_xy_to_gamut(xy, HueGamutType::B);
        assert_ne!(clipped, xy, "out-of-gamut point must be projected");
        let dist_to_blue = distance_squared(clipped, GAMUT_B[2]).sqrt();
        assert!(
            dist_to_blue < 0.10,
            "clipped point {:?} should be close to gamut B blue corner {:?}; dist={dist_to_blue}",
            clipped,
            GAMUT_B[2]
        );
        // And the clipped point must lie inside the gamut B triangle.
        assert!(
            point_in_triangle(clipped, GAMUT_B[0], GAMUT_B[1], GAMUT_B[2]),
            "clipped {:?} should be inside gamut B",
            clipped
        );
    }

    #[test]
    fn clip_xy_to_gamut_returns_distinct_results_for_a_b_c_on_extreme_point() {
        // A point well outside every gamut should land on a different
        // edge for each gamut (their triangles differ).
        let xy = (1.0, 1.0);
        let on_a = clip_xy_to_gamut(xy, HueGamutType::A);
        let on_b = clip_xy_to_gamut(xy, HueGamutType::B);
        let on_c = clip_xy_to_gamut(xy, HueGamutType::C);
        assert!(
            on_a != on_b || on_b != on_c,
            "expected at least one differing projection across A/B/C, got A={on_a:?} B={on_b:?} C={on_c:?}"
        );
        assert!(point_in_triangle(on_a, GAMUT_A[0], GAMUT_A[1], GAMUT_A[2]));
        assert!(point_in_triangle(on_b, GAMUT_B[0], GAMUT_B[1], GAMUT_B[2]));
        assert!(point_in_triangle(on_c, GAMUT_C[0], GAMUT_C[1], GAMUT_C[2]));
    }

    #[test]
    fn closest_point_on_segment_clamps_outside_projections_to_endpoints() {
        let a = (0.0, 0.0);
        let b = (1.0, 0.0);
        // Far past `b` along the segment direction — must clamp to `b`.
        let p = (5.0, 0.0);
        let q = closest_point_on_segment(p, a, b);
        assert!((q.0 - 1.0).abs() < 1e-9 && q.1.abs() < 1e-9);
        // Far before `a` — must clamp to `a`.
        let r = closest_point_on_segment((-5.0, 0.0), a, b);
        assert!(r.0.abs() < 1e-9 && r.1.abs() < 1e-9);
    }

    // -----------------------------------------------------------------------
    // Hot-path per-bulb gamut clip
    // -----------------------------------------------------------------------

    #[test]
    fn build_huestream_frame_clips_per_light_to_gamut_b() {
        // A single channel with one light id; metadata cache marks it as
        // gamut B. We send saturated cyan (0, 255, 255) — its CIE xy
        // (≈ 0.151, 0.343) sits outside gamut B's green-blue edge
        // (gamut B vertices: R(0.675,0.322), G(0.4091,0.518),
        // B(0.167,0.040)). The frame builder must project that
        // chromaticity onto gamut B and the resulting RGB triplet must
        // therefore differ from the pristine path that bypasses the
        // clip.
        let channels = vec![HueAreaChannel {
            channel_id: 0,
            light_ids: vec!["light-cyan".to_string()],
            screen_region: HueScreenRegion::Center,
            position_x: 0.0,
            position_y: 0.0,
            position_z: None,
        }];
        let colors = vec![(0u8, 255u8, 255u8)];
        let area = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

        // Reference path: empty metadata cache → no clip, pristine RGB.
        let frame_unclipped = build_huestream_frame(area, &channels, &colors, 1.0, &HashMap::new());

        // Gamut B path: metadata cache pins the bulb to gamut B → clip
        // engaged.
        let mut meta = HashMap::new();
        meta.insert(
            "light-cyan".to_string(),
            HueLightMetadata {
                light_id: "light-cyan".to_string(),
                archetype: Some("hue_v1".to_string()),
                gamut_type: HueGamutType::B,
            },
        );
        let frame_clipped = build_huestream_frame(area, &channels, &colors, 1.0, &meta);

        // Channel data starts at byte 52 (16 header + 36 UUID). Each
        // channel entry is 7 bytes: id + RR + GG + BB.
        let entry_offset = 52;
        let unclipped_r = u16::from_be_bytes([
            frame_unclipped[entry_offset + 1],
            frame_unclipped[entry_offset + 2],
        ]);
        let unclipped_g = u16::from_be_bytes([
            frame_unclipped[entry_offset + 3],
            frame_unclipped[entry_offset + 4],
        ]);
        let unclipped_b = u16::from_be_bytes([
            frame_unclipped[entry_offset + 5],
            frame_unclipped[entry_offset + 6],
        ]);
        let clipped_r = u16::from_be_bytes([
            frame_clipped[entry_offset + 1],
            frame_clipped[entry_offset + 2],
        ]);
        let clipped_g = u16::from_be_bytes([
            frame_clipped[entry_offset + 3],
            frame_clipped[entry_offset + 4],
        ]);
        let clipped_b = u16::from_be_bytes([
            frame_clipped[entry_offset + 5],
            frame_clipped[entry_offset + 6],
        ]);

        // Pristine cyan: zero red, max green, max blue.
        assert_eq!(unclipped_r, 0x0000, "unclipped red must be zero");
        assert_eq!(unclipped_g, 0xFFFF, "unclipped green must be max");
        assert_eq!(unclipped_b, 0xFFFF, "unclipped blue must be max");

        // Clipped frame must differ from the pristine path. Specifically
        // gamut B's edge is reached by *adding* red (the only direction
        // back into the triangle from cyan's chromaticity); the clip
        // must therefore raise red above zero.
        assert!(
            clipped_r > 0,
            "clip onto gamut B edge must introduce some red (got {clipped_r})"
        );
        assert_ne!(
            (clipped_r, clipped_g, clipped_b),
            (unclipped_r, unclipped_g, unclipped_b),
            "clipped frame must differ from pristine pass-through"
        );
    }

    #[test]
    fn build_huestream_frame_skips_clip_for_other_gamut() {
        // A bulb with gamut_type = Other must be passed through verbatim
        // — graceful degradation for bridges that don't expose the gamut
        // field or unknown future archetypes.
        let channels = vec![HueAreaChannel {
            channel_id: 0,
            light_ids: vec!["light-other".to_string()],
            screen_region: HueScreenRegion::Center,
            position_x: 0.0,
            position_y: 0.0,
            position_z: None,
        }];
        let colors = vec![(0u8, 0u8, 255u8)];
        let area = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

        let mut meta = HashMap::new();
        meta.insert(
            "light-other".to_string(),
            HueLightMetadata {
                light_id: "light-other".to_string(),
                archetype: None,
                gamut_type: HueGamutType::Other,
            },
        );
        let frame_other = build_huestream_frame(area, &channels, &colors, 1.0, &meta);
        let frame_empty = build_huestream_frame(area, &channels, &colors, 1.0, &HashMap::new());
        // Identical: Other gamut → pass-through, same as cache miss.
        assert_eq!(frame_other, frame_empty);
    }

    #[test]
    fn xy_to_linear_rgb_on_gamut_c_red_corner_recovers_red_dominant_triplet() {
        // Gamut C red corner (0.692, 0.308) at the luminance of full red
        // through the forward matrix (0.283881) must come back as a
        // near-saturated red with next to no green or blue — the inverse
        // matrix has to match `linear_rgb_to_xy`.
        let (r, g, b) = xy_to_linear_rgb(0.692, 0.308, 0.283_881);
        assert!(r > 0.9, "expected near-saturated red, got r={r}");
        assert!(g < 0.05 && b < 0.05, "expected red-dominant, got ({r}, {g}, {b})");
    }

    // -----------------------------------------------------------------------
    // Bug H2 regression — gamut-clip luminance preservation
    // -----------------------------------------------------------------------

    /// Pure unit test on the inverse transform: `xy_to_linear_rgb` must
    /// return a triplet whose recovered Y (via `linear_rgb_to_xy`) is within
    /// 5% of the requested `target_y`. This guards against a regression to
    /// the pre-fix "max-channel saturate" normalisation, which silently
    /// stripped luminance information from the round-trip.
    ///
    /// 5% tolerance = u8 quantisation of the triplet.
    #[test]
    fn xy_to_linear_rgb_preserves_target_luminance() {
        // Probe several chromaticities at moderate luminance so we
        // exercise both forward and inverse transforms without bumping
        // into 0-clamp or 255-saturation.
        let probes = [
            // Gamut C red corner @ y=0.20
            (0.692f64, 0.308f64, 0.20f64),
            // Mid-range orange-ish chromaticity @ y=0.30
            (0.50, 0.40, 0.30),
            // Near-white @ y=0.50
            (0.33, 0.33, 0.50),
        ];
        for (x, y, target_y) in probes {
            let (r, g, b) = xy_to_linear_rgb(x, y, target_y);
            let [r, g, b] = [r, g, b].map(|c| (c * 255.0).round() / 255.0);
            let (_, _, recovered_y) = linear_rgb_to_xy(r, g, b);
            let rel_err = (recovered_y - target_y).abs() / target_y.max(f64::EPSILON);
            assert!(
                rel_err < 0.05,
                "xy=({x}, {y}) target_y={target_y} → rgb=({r}, {g}, {b}) recovered_y={recovered_y} rel_err={rel_err}"
            );
        }
    }

    /// Bug H2: a saturated cyan input clipped to gamut B used to lose
    /// more than 70% of its luminance because `xy_to_rgb` collapsed Y
    /// to 1.0 and then the "max channel saturates" normaliser shrank
    /// the linear-RGB triplet. After the fix the clipped frame's
    /// luminance proxy (R+G+B in u16 space) must stay within 70% of
    /// the unclipped pristine path.
    ///
    /// The chromaticity-preserving clip should change *hue* (cyan →
    /// teal-ish, leaning towards gamut B's nearest edge), but it should
    /// not silently dim the bulb — that was the user-visible Bug H2
    /// stutter / off-flash.
    #[test]
    fn build_huestream_frame_preserves_luminance_within_gamut_b_after_clip() {
        // Saturated cyan-ish input at full chroma but ~86% green/blue —
        // chosen so the input clearly lives outside gamut B's
        // green-blue edge while still producing a non-trivial CIE Y
        // (cyan @ 0,255,255 is the "obvious" probe but we want to
        // exercise both axes the bug touched).
        let channels = vec![HueAreaChannel {
            channel_id: 0,
            light_ids: vec!["light-cyan".to_string()],
            screen_region: HueScreenRegion::Center,
            position_x: 0.0,
            position_y: 0.0,
            position_z: None,
        }];
        let colors = vec![(0u8, 220u8, 220u8)];
        let area = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

        let frame_unclipped = build_huestream_frame(area, &channels, &colors, 1.0, &HashMap::new());

        let mut meta = HashMap::new();
        meta.insert(
            "light-cyan".to_string(),
            HueLightMetadata {
                light_id: "light-cyan".to_string(),
                archetype: Some("hue_v1".to_string()),
                gamut_type: HueGamutType::B,
            },
        );
        let frame_clipped = build_huestream_frame(area, &channels, &colors, 1.0, &meta);

        let entry = 52usize;
        let lum = |frame: &[u8]| -> u32 {
            let r = u16::from_be_bytes([frame[entry + 1], frame[entry + 2]]) as u32;
            let g = u16::from_be_bytes([frame[entry + 3], frame[entry + 4]]) as u32;
            let b = u16::from_be_bytes([frame[entry + 5], frame[entry + 6]]) as u32;
            r + g + b
        };

        let unclipped_lum = lum(&frame_unclipped);
        let clipped_lum = lum(&frame_clipped);

        // 70% retention floor. Pre-fix this test would emit roughly
        // 30-40% of the unclipped sum because the max-channel
        // saturate path collapsed luminance.
        let ratio = clipped_lum as f64 / unclipped_lum as f64;
        assert!(
            ratio >= 0.70,
            "clip-induced luminance loss too high: clipped_lum={clipped_lum}, unclipped_lum={unclipped_lum}, ratio={ratio:.3} (Bug H2 regression?)"
        );
    }

    /// Bug H2: the `y <= EPSILON` early-return in `xy_to_rgb` used to
    /// fire on edge-case projections from `clip_xy_to_gamut`'s segment
    /// endpoint clamp, dropping a bulb to (0, 0, 0) for one tick before
    /// snapping back the next tick — the user-visible stutter.
    ///
    /// Sweep a saturated probe across multiple frame builds with
    /// metadata pinned to gamut B and assert no all-zero RGB tuple is
    /// emitted in the channel slot. A single zero would have caught the
    /// pre-fix bug.
    #[test]
    fn build_huestream_frame_never_emits_zero_between_two_nonzero_targets() {
        let channels = vec![HueAreaChannel {
            channel_id: 0,
            light_ids: vec!["light-edge".to_string()],
            screen_region: HueScreenRegion::Center,
            position_x: 0.0,
            position_y: 0.0,
            position_z: None,
        }];
        let mut meta = HashMap::new();
        meta.insert(
            "light-edge".to_string(),
            HueLightMetadata {
                light_id: "light-edge".to_string(),
                archetype: Some("hue_v1".to_string()),
                gamut_type: HueGamutType::B,
            },
        );
        let area = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

        // Probe a sweep of saturated colours all of which sit outside
        // gamut B and therefore exercise the clip → xy_to_rgb path
        // that the bug lived on. None of these should produce a black
        // frame.
        let probes: &[(u8, u8, u8)] = &[
            (0, 255, 255),  // cyan (canonical Bug H2 case)
            (0, 220, 220),  // moderately saturated cyan
            (0, 255, 200),  // green-cyan
            (0, 200, 255),  // blue-cyan
            (50, 255, 255), // slightly de-saturated cyan
            (0, 255, 100),  // bright green leaning teal
        ];

        for (r, g, b) in probes {
            let frame = build_huestream_frame(area, &channels, &[(*r, *g, *b)], 1.0, &meta);
            let entry = 52usize;
            let r16 = u16::from_be_bytes([frame[entry + 1], frame[entry + 2]]);
            let g16 = u16::from_be_bytes([frame[entry + 3], frame[entry + 4]]);
            let b16 = u16::from_be_bytes([frame[entry + 5], frame[entry + 6]]);
            assert!(
                !(r16 == 0 && g16 == 0 && b16 == 0),
                "input ({r}, {g}, {b}) emitted all-zero frame after gamut B clip — Bug H2 stutter regression"
            );
        }
    }
}
