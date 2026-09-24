//! The "usb" channel: which sink carries the strip (serial or WLED), the
//! worker's handle on it, and the one-shot Solid write.

use super::config::{LightingModeConfig, SolidColorPayload};
use crate::commands::led_output::{
    encode_packet_for_output, ColorCorrectionConfig, EncoderPlan, FirmwareProfile, LedChipType,
    LedColorOrder, LedOutputBridge, SerialSink,
};
use crate::commands::led_sink::LedSink;
use crate::commands::wled_sink::{CorrectedWledSink, WledSinkConfig};

/// Worker-side handle for the resolved `UsbOutputPlan` — dispatches to
/// whichever concrete sink is active. `SerialSink` keeps applying colour
/// correction + brightness inside its own `send_frame` (wire header owns
/// brightness); `CorrectedWledSink` does the equivalent host-side since
/// DDP/WARLS have no brightness field.
pub(super) enum ActiveUsbSink {
    Serial(SerialSink),
    Wled(CorrectedWledSink),
}

impl ActiveUsbSink {
    pub(super) fn start(&mut self) -> Result<(), String> {
        match self {
            Self::Serial(s) => s.start(),
            Self::Wled(s) => s.start(),
        }
    }

    pub(super) fn set_brightness(&mut self, brightness: f32) {
        match self {
            Self::Serial(s) => s.set_brightness(brightness),
            Self::Wled(s) => s.set_brightness(brightness),
        }
    }

    /// WLED owns its colour order on the device, so only serial reorders.
    pub(super) fn set_color_order(&mut self, order: LedColorOrder) {
        match self {
            Self::Serial(s) => s.set_color_order(order),
            Self::Wled(_) => {}
        }
    }

    pub(super) fn send_frame(&mut self, colors: &[[u8; 3]]) -> Result<(), String> {
        match self {
            Self::Serial(s) => s.send_frame(colors),
            Self::Wled(s) => s.send_frame(colors),
        }
    }

    pub(super) fn stop(&mut self) -> Result<(), String> {
        match self {
            Self::Serial(s) => s.stop(),
            Self::Wled(s) => s.stop(),
        }
    }
}

/// Resolved output for the "usb" channel — serial and WLED are alternate
/// transports for the same logical LED-strip output, not separate targets
/// (see docs/architecture/device-output.md). Whichever sink `ActiveSinkRegistry` currently
/// holds wins; `None` falls back to `SerialConnectionState`.
#[derive(Clone, Debug)]
pub(super) enum UsbOutputPlan {
    Serial(String),
    Wled(WledSinkConfig),
}

/// A solid frame's destination on the "usb" channel and how that strip wants
/// it encoded — taken from the mode when it starts, so a colour retune can
/// repaint the strip without the runtime lock.
#[derive(Clone)]
pub(crate) struct SolidUsbOutput {
    bridge: LedOutputBridge,
    plan: UsbOutputPlan,
    pub(super) corrections: ColorCorrectionConfig,
    profile: FirmwareProfile,
    chip: LedChipType,
    color_order: LedColorOrder,
    pub(super) led_count: usize,
}

impl SolidUsbOutput {
    pub(super) fn for_mode(
        bridge: &LedOutputBridge,
        plan: UsbOutputPlan,
        mode: &LightingModeConfig,
    ) -> Self {
        Self {
            bridge: bridge.clone(),
            plan,
            corrections: mode.color_correction.clone().unwrap_or_default(),
            profile: mode.firmware_profile.unwrap_or_default(),
            chip: mode.chip_type.unwrap_or_default(),
            color_order: mode.color_order.unwrap_or_default(),
            // Must paint EVERY LED, not just LED #0 (historical bug: a
            // 1-element slice left 58/59 LEDs dark). Falls back to a
            // 1-LED frame when no calibration is on record yet.
            led_count: mode
                .led_calibration
                .as_ref()
                .map(|cal| cal.total_leds as usize)
                .filter(|n| *n > 0)
                .unwrap_or(1),
        }
    }

    pub(super) fn send(&self, payload: &SolidColorPayload) -> Result<(), String> {
        let triplets: Vec<[u8; 3]> = vec![[payload.r, payload.g, payload.b]; self.led_count];
        // WLED has no on-wire brightness field, so `CorrectedWledSink`
        // scales it into the RGB values host-side; the serial path
        // keeps encoding brightness into the packet header as before.
        match &self.plan {
            UsbOutputPlan::Serial(port_name) => {
                let packet = encode_packet_for_output(
                    self.profile,
                    self.chip,
                    payload.brightness,
                    &triplets,
                    &EncoderPlan::new(&self.corrections).with_color_order(self.color_order),
                );
                self.bridge
                    .send_packet_to_port_and_wait(port_name, &packet)
                    .map_err(|error| error.as_reason())
            }
            UsbOutputPlan::Wled(cfg) => {
                let mut sink = CorrectedWledSink::new(cfg.build(), self.corrections.clone());
                sink.set_brightness(payload.brightness);
                let result = sink.start().and_then(|_| sink.send_frame(&triplets));
                let _ = sink.stop();
                result
            }
        }
    }
}
