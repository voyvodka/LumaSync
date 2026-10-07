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
    Box::new(EffectTicker::default())
}

fn blank_frame() -> Arc<CapturedFrame> {
    Arc::new(CapturedFrame::new(1, 1, vec![[0, 0, 0]]))
}

/// Two frames handed out in turn: the worker keeps the last one it was given,
/// so the other is free again by the next tick and is restamped in place —
/// a steady effect step allocates nothing here either.
struct EffectTicker {
    frames: [Arc<CapturedFrame>; 2],
    next: usize,
}

impl Default for EffectTicker {
    fn default() -> Self {
        Self {
            frames: [blank_frame(), blank_frame()],
            next: 0,
        }
    }
}

impl AmbilightFrameSource for EffectTicker {
    fn capture_frame(&mut self) -> Result<Arc<CapturedFrame>, AmbilightCaptureError> {
        let slot = &mut self.frames[self.next];
        self.next ^= 1;
        // A new `seq` every call is what makes the worker run a step.
        match Arc::get_mut(slot) {
            Some(frame) => frame.restamp(),
            // Still held elsewhere (a caller that keeps more than one): a new one.
            None => *slot = blank_frame(),
        }
        Ok(Arc::clone(slot))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_steady_tick_reuses_its_two_frames_with_a_new_seq_each_time() {
        let mut ticker = EffectTicker::default();
        // As the worker does: it keeps only the frame it was last given.
        let mut kept = ticker.capture_frame().unwrap();
        let first = Arc::as_ptr(&kept);
        let mut seqs = vec![kept.seq];
        let mut pointers = vec![first];
        for _ in 0..4 {
            kept = ticker.capture_frame().unwrap();
            seqs.push(kept.seq);
            pointers.push(Arc::as_ptr(&kept));
        }
        assert!(seqs.windows(2).all(|pair| pair[1] > pair[0]), "{seqs:?}");
        assert_eq!(pointers[0], pointers[2]);
        assert_eq!(pointers[1], pointers[3]);
        assert_ne!(pointers[0], pointers[1]);
    }

    #[test]
    fn a_frame_still_held_is_left_alone() {
        let mut ticker = EffectTicker::default();
        let held = ticker.capture_frame().unwrap();
        let seq = held.seq;
        let _other = ticker.capture_frame().unwrap();
        let third = ticker.capture_frame().unwrap();
        assert_eq!(held.seq, seq);
        assert!(!Arc::ptr_eq(&held, &third));
    }
}
