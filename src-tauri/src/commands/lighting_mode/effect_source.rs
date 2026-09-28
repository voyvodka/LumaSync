//! The Effect mode's frame source: a tick, not a picture. The worker's loop
//! and pacing run on frames, so the effect hands it an empty one per output
//! step; the colours are drawn per light by the pipeline's effect stage
//! (`effects.rs`). docs/architecture/lighting-transaction.md ("Effects").

use std::sync::{Arc, Mutex};

use super::config::{AmbilightPayload, EffectPayload};
use crate::commands::ambilight_capture::{
    AmbilightCaptureError, AmbilightFrameSource, CapturedFrame,
};

/// The payload the pipeline re-reads every step, so a retune changes the
/// effect without a worker rebuild.
pub(crate) type EffectLiveSlot = Arc<Mutex<EffectPayload>>;

/// The settings an effect runs the Ambilight worker with: its brightness, and
/// no smoothing, border detection or saturation — the effect stage draws the
/// colours it means and smooths Hue itself.
pub(crate) fn effect_ambilight(effect: &EffectPayload) -> AmbilightPayload {
    AmbilightPayload {
        brightness: effect.brightness,
        black_border_detection: false,
        smoothing_alpha: Some(1.0),
        saturation: Some(1.0),
        lighting_smoothing_preset: None,
        hue_intensity_preset: None,
    }
}

pub(crate) fn create_effect_frame_source() -> Box<dyn AmbilightFrameSource> {
    Box::new(EffectTicker)
}

struct EffectTicker;

impl AmbilightFrameSource for EffectTicker {
    fn capture_frame(&mut self) -> Result<Arc<CapturedFrame>, AmbilightCaptureError> {
        // A new `seq` every call is what makes the worker run a step.
        Ok(Arc::new(CapturedFrame::new(1, 1, vec![[0, 0, 0]])))
    }
}
