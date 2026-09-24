//! LED wire-protocol encoding (LumaSync v1 / Adalight, WS2812B / SK6812) and
//! the serial-backed `LedSink` that writes the resulting packets over USB.
//!
//! This file is the façade; the code lives in the submodules below and the
//! paths the rest of the crate uses are re-exported here.
//!
//! - `wire` — framing profile, chip type, colour order, pixel layout
//! - `correction` — correction settings, the gamma/Kelvin/saturation stages
//!   and `EncoderPlan`
//! - `encode` — the packet encoders
//! - `serial` — the coded error, the writer thread, the sender and the bridge
//! - `sink` — `SerialSink`

mod correction;
mod encode;
mod serial;
mod sink;
mod wire;

pub use correction::{
    apply_color_correction_rgb, apply_saturation_to_pixel, scale_brightness, ColorCorrectionConfig,
    EncoderPlan,
};
pub use encode::encode_packet_for_output;
pub use serial::LedOutputBridge;
pub use sink::SerialSink;
pub use wire::{FirmwareProfile, LedChipType, LedColorOrder, WirePixelLayout};

#[cfg(test)]
pub(crate) use correction::gamma_lut_builds_on_this_thread;
#[cfg(test)]
pub(crate) use serial::{LedOutputError, LedPacketSender};

#[cfg(test)]
mod test_support;

#[cfg(test)]
mod correction_tests;

#[cfg(test)]
mod encode_tests;

#[cfg(test)]
mod serial_tests;

#[cfg(test)]
mod sink_tests;

/// Review item 27 folded three saturation copies, three brightness copies and
/// a per-pixel Kelvin into `EncoderPlan`. These hold every strip-side output to
/// the code it replaced, copied here verbatim, byte for byte.
#[cfg(test)]
mod colour_pipeline_equivalence;
