//! Settings a running worker re-reads instead of restarting: the ambilight
//! atomics and the room-geometry cell.

use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, AtomicU8, Ordering};
use std::sync::{Arc, Mutex};

use super::config::AmbilightPayload;
use crate::commands::hue_intensity::LightingSmoothingPreset;
use crate::commands::led_output::LedColorOrder;
use crate::models::room_map::RoomGeometry;

/// Live-tunable settings shared between the owner and the running ambilight worker.
///
/// Updated in-place when the user changes ambilight settings (brightness, black
/// border detection) while the mode is already active, so the worker never
/// needs to be stopped/restarted just for a setting tweak. This prevents
/// the macOS SCStream rapid stop/recreate cycle that causes crashes.
pub(crate) struct AmbilightLiveSettings {
    /// Brightness as f32 bit pattern stored in an AtomicU32.
    brightness: AtomicU32,
    black_border_detection: AtomicBool,
    /// Unified EWMA smoothing alpha as f32 bit pattern. Range [0.05, 1.0].
    /// Drives both USB and Hue output sinks — single source of truth.
    /// Populated from `LightingSmoothingPreset.coefficient()` when a preset
    /// is set; falls back to the raw `smoothing_alpha` slider value.
    smoothing_alpha: AtomicU32,
    /// Saturation factor as f32 bit pattern. Range [0.5, 2.0]. 1.0 = identity.
    saturation: AtomicU32,
    /// `LedColorOrder as u8`. Set from every apply, running or starting.
    color_order: AtomicU8,
}

impl AmbilightLiveSettings {
    pub(super) fn new(
        brightness: f32,
        black_border_detection: bool,
        smoothing_alpha: f32,
        saturation: f32,
    ) -> Arc<Self> {
        let clamped_alpha = smoothing_alpha.clamp(0.05, 1.0);
        Arc::new(Self {
            brightness: AtomicU32::new(brightness.to_bits()),
            black_border_detection: AtomicBool::new(black_border_detection),
            smoothing_alpha: AtomicU32::new(clamped_alpha.to_bits()),
            saturation: AtomicU32::new(saturation.clamp(0.5, 2.0).to_bits()),
            color_order: AtomicU8::new(LedColorOrder::Rgb as u8),
        })
    }

    pub(super) fn read_color_order(&self) -> LedColorOrder {
        LedColorOrder::from_u8(self.color_order.load(Ordering::Relaxed))
    }

    pub(super) fn store_color_order(&self, order: LedColorOrder) {
        self.color_order.store(order as u8, Ordering::Relaxed);
    }

    pub(super) fn read_brightness(&self) -> f32 {
        f32::from_bits(self.brightness.load(Ordering::Relaxed))
    }

    pub(super) fn read_black_border_detection(&self) -> bool {
        self.black_border_detection.load(Ordering::Relaxed)
    }

    pub(super) fn read_smoothing_alpha(&self) -> f32 {
        f32::from_bits(self.smoothing_alpha.load(Ordering::Relaxed))
    }

    pub(super) fn read_saturation(&self) -> f32 {
        f32::from_bits(self.saturation.load(Ordering::Relaxed))
    }

    pub(super) fn update(
        &self,
        brightness: f32,
        black_border_detection: bool,
        smoothing_alpha: f32,
        saturation: f32,
        smoothing_preset: Option<LightingSmoothingPreset>,
    ) {
        // Resolve unified alpha: preset takes priority over raw slider value.
        // Both USB and Hue sinks read `smoothing_alpha` — single source.
        let resolved_alpha = match smoothing_preset {
            Some(preset) => preset.coefficient(),
            None => smoothing_alpha.clamp(0.05, 1.0),
        };
        self.brightness
            .store(brightness.to_bits(), Ordering::Relaxed);
        self.black_border_detection
            .store(black_border_detection, Ordering::Relaxed);
        self.smoothing_alpha
            .store(resolved_alpha.clamp(0.05, 1.0).to_bits(), Ordering::Relaxed);
        self.saturation
            .store(saturation.clamp(0.5, 2.0).to_bits(), Ordering::Relaxed);
    }
}

/// Writes an Ambilight payload into a running worker's atomics. Shared by the
/// `apply_mode_change` fast path and `retune_lighting`.
pub(super) fn retune_ambilight_live(live: &AmbilightLiveSettings, cfg: &AmbilightPayload) {
    // None-preservation: when the incoming payload omits saturation
    // or smoothing_alpha (e.g. brightness-only slider tweak from the
    // frontend), keep the currently running atomic value instead of
    // resetting to defaults. The previous unwrap_or(1.0)/(0.35) path
    // silently clobbered user-tuned values on every brightness move.
    let next_smoothing_alpha = cfg
        .smoothing_alpha
        .unwrap_or_else(|| live.read_smoothing_alpha());
    let next_saturation = cfg.saturation.unwrap_or_else(|| live.read_saturation());
    log::info!(
        "[ambilight-live-update] brightness={:.3} smoothing={:.3} saturation={:.3} black_border={} preset={:?}",
        cfg.brightness,
        next_smoothing_alpha,
        next_saturation,
        cfg.black_border_detection,
        cfg.lighting_smoothing_preset.or(cfg.hue_intensity_preset),
    );
    live.update(
        cfg.brightness,
        cfg.black_border_detection,
        next_smoothing_alpha,
        next_saturation,
        cfg.lighting_smoothing_preset.or(cfg.hue_intensity_preset),
    );
}

/// Room geometry shared with the running ambilight worker, so a room-map drag
/// retunes Hue sampling in place — same role as `TestPatternLive`. The worker
/// reads `generation` once per frame and takes the lock only when it moved.
/// The generation is also stored under the lock, and that copy is the one the
/// worker records as seen: a relaxed load can run ahead of the data, and a
/// stale read then retries next frame instead of being marked current.
pub(super) struct RoomGeometryLive {
    generation: AtomicU64,
    slot: Mutex<(u64, Option<RoomGeometry>)>,
}

impl RoomGeometryLive {
    pub(super) fn new(geometry: Option<RoomGeometry>) -> Arc<Self> {
        Arc::new(Self {
            generation: AtomicU64::new(0),
            slot: Mutex::new((0, geometry)),
        })
    }

    pub(super) fn publish(&self, geometry: Option<RoomGeometry>) {
        let mut slot = self.slot.lock().unwrap_or_else(|err| err.into_inner());
        let next = slot.0.wrapping_add(1);
        slot.0 = next;
        slot.1 = geometry;
        self.generation.store(next, Ordering::Relaxed);
    }

    pub(super) fn generation(&self) -> u64 {
        self.generation.load(Ordering::Relaxed)
    }

    pub(super) fn snapshot(&self) -> (u64, Option<RoomGeometry>) {
        let slot = self.slot.lock().unwrap_or_else(|err| err.into_inner());
        (slot.0, slot.1.clone())
    }
}
