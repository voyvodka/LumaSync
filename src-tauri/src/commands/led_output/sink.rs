//! `SerialSink`: the `LedSink` the ambilight worker drives for a serial strip.

#[cfg(test)]
use super::correction::GammaLuts;
use super::correction::{ColorCorrectionConfig, EncoderPlan};
use super::encode::encode_packet_for_output;
use super::serial::LedOutputBridge;
use super::wire::{FirmwareProfile, LedChipType, LedColorOrder};

// ---------------------------------------------------------------------------
// SerialSink — `LedSink` implementation backed by `LedOutputBridge`
//
// Wire format is preserved exactly unless the user explicitly changes the
// Firmware Profile setting. Never change the wire format silently.
// ---------------------------------------------------------------------------

/// A `LedSink` implementation that encodes frames and writes them to a serial
/// port via `LedOutputBridge`. Supports both LumaSync v1 and Adalight profiles,
/// and WS2812B (3-byte) or SK6812 RGBW (4-byte) chip encodings.
///
/// Used as the production USB output sink in the ambilight worker (v1.4+).
/// The ambilight worker holds a concrete `SerialSink` and calls `set_brightness`
/// each iteration so the live-brightness atomic stays in sync without circular
/// module dependencies.
pub struct SerialSink {
    bridge: LedOutputBridge,
    port_name: Option<String>,
    brightness: f32,
    profile: FirmwareProfile,
    // Corrections never change under a running sink — a new config restarts
    // the worker, which builds a new sink — so the plan is built exactly once.
    // Only its colour order is patched live, via `set_color_order`.
    plan: EncoderPlan,
    chip_type: LedChipType,
}

impl SerialSink {
    /// Create a sink using the default LumaSync v1 profile, default corrections,
    /// and default chip type (WS2812B GRB).
    ///
    /// Used by tests only — `#[cfg(test)]` keeps it out of the production binary.
    /// Production code uses `with_chip_type` to pass explicit settings.
    #[cfg(test)]
    pub fn new(bridge: LedOutputBridge, port_name: Option<String>, brightness: f32) -> Self {
        Self {
            bridge,
            port_name,
            brightness,
            profile: FirmwareProfile::default(),
            plan: EncoderPlan::default(),
            chip_type: LedChipType::default(),
        }
    }

    /// Create a sink with an explicit firmware profile, colour correction config,
    /// and chip type.
    pub fn with_chip_type(
        bridge: LedOutputBridge,
        port_name: Option<String>,
        brightness: f32,
        profile: FirmwareProfile,
        corrections: ColorCorrectionConfig,
        chip_type: LedChipType,
    ) -> Self {
        Self {
            bridge,
            port_name,
            brightness,
            profile,
            plan: EncoderPlan::new(&corrections),
            chip_type,
        }
    }

    /// Update brightness without stopping the sink.
    ///
    /// Called by the ambilight worker each iteration to keep the sink in sync
    /// with the live `AmbilightLiveSettings` atomic.
    pub fn set_brightness(&mut self, brightness: f32) {
        self.brightness = brightness.clamp(0.0, 1.0);
    }

    /// Retune the colour order in place, next to `set_brightness`.
    pub fn set_color_order(&mut self, order: LedColorOrder) {
        self.plan.set_color_order(order);
    }

    #[cfg(test)]
    pub(super) fn plan_luts_ptr(&self) -> *const GammaLuts {
        self.plan.luts_ptr()
    }
}

impl crate::commands::led_sink::LedSink for SerialSink {
    fn start(&mut self) -> Result<(), String> {
        Ok(())
    }

    fn send_frame(&mut self, colors: &[[u8; 3]]) -> Result<(), String> {
        let Some(port) = self.port_name.as_deref() else {
            return Ok(());
        };

        let packet = encode_packet_for_output(
            self.profile,
            self.chip_type,
            self.brightness,
            colors,
            &self.plan,
        );

        self.bridge
            .send_packet_to_port(port, &packet)
            .map_err(|e| e.as_reason())
    }

    fn stop(&mut self) -> Result<(), String> {
        // Do NOT call `disconnect_session` here — reopening the port toggles
        // DTR and resets the MCU. See docs/architecture/device-output.md (DTR reset).
        let _ = self.port_name.as_deref();
        Ok(())
    }
}
