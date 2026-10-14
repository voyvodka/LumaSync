//! The "usb" channel: which sink carries the strip (serial or WLED), the
//! worker's handle on it, the Solid write, and the hold that keeps a Solid
//! colour lit on a WLED device.

use std::sync::{Arc, Condvar, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

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
/// (see docs/architecture/device-output.md). What `LocalOutputRegistry::driven` names.
#[derive(Clone, Debug, PartialEq)]
pub(super) enum UsbOutputPlan {
    Serial(String),
    Wled(WledSinkConfig),
}

impl From<crate::commands::local_outputs::DrivenLocal> for UsbOutputPlan {
    fn from(driven: crate::commands::local_outputs::DrivenLocal) -> Self {
        use crate::commands::local_outputs::DrivenLocal;
        match driven {
            DrivenLocal::Serial(port) => Self::Serial(port),
            DrivenLocal::Wled(config) => Self::Wled(config),
        }
    }
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
    hold: Option<SolidHoldHandle>,
}

impl SolidUsbOutput {
    /// The running hold a retune must update, so the colour it resends is the new one.
    pub(super) fn with_hold(mut self, hold: Option<SolidHoldHandle>) -> Self {
        self.hold = hold;
        self
    }

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
            hold: None,
        }
    }

    /// Every LED black, encoded the way this strip reads a frame. Black at full
    /// brightness rather than a zero brightness byte: a firmware may treat
    /// brightness 0 as "unchanged", never a black pixel as anything but off.
    pub(super) fn blank(&self) -> Result<(), String> {
        self.send(&SolidColorPayload {
            r: 0,
            g: 0,
            b: 0,
            brightness: 1.0,
            kelvin: None,
        })
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
                // A cached session can be dead after an unplug and replug: its write fails and the
                // sender drops it, so one more try opens the port afresh. Once, and only for this
                // one-shot write — retrying the worker's per-frame sends would turn an unplug
                // into a loop of DTR resets.
                match self.bridge.send_packet_to_port_and_wait(port_name, &packet) {
                    Err(error)
                        if matches!(
                            error.code,
                            "LED_OUTPUT_WRITE_FAILED" | "LED_OUTPUT_FLUSH_FAILED"
                        ) =>
                    {
                        log::warn!(
                            "[solid] write on {port_name} failed ({}); reopening once",
                            error.as_reason()
                        );
                        self.bridge.send_packet_to_port_and_wait(port_name, &packet)
                    }
                    other => other,
                }
                .map_err(|error| error.as_reason())
            }
            UsbOutputPlan::Wled(cfg) => {
                // Published before this write: the hold sends under the same lock, so a
                // resend can never land after it carrying the old colour.
                if let Some(hold) = &self.hold {
                    hold.publish(payload);
                }
                let mut sink = CorrectedWledSink::new(cfg.build(), self.corrections.clone());
                sink.set_brightness(payload.brightness);
                let result = sink.start().and_then(|_| sink.send_frame(&triplets));
                let _ = sink.stop();
                result
            }
        }
    }
}

/// How often a held Solid frame goes to a WLED device again. WLED leaves
/// realtime mode once no frame has arrived within its timeout — 2 s on DRGB
/// (`REALTIME_TIMEOUT_SEC`), the device's own setting on DDP — and returns to
/// its own effect, so a single frame kept a Solid colour for about 2 s.
/// 500 ms leaves room for lost datagrams on Wi-Fi.
const SOLID_HOLD_INTERVAL: Duration = Duration::from_millis(500);

struct HoldState {
    payload: SolidColorPayload,
    stopped: bool,
}

type HoldCell = Arc<(Mutex<HoldState>, Condvar)>;

/// The colour a running hold resends; a retune publishes to it.
#[derive(Clone)]
pub(crate) struct SolidHoldHandle(HoldCell);

impl SolidHoldHandle {
    pub(super) fn publish(&self, payload: &SolidColorPayload) {
        let (lock, _) = &*self.0;
        lock.lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .payload = payload.clone();
    }
}

/// Keeps a Solid colour lit on a WLED device by resending it inside the
/// device's realtime timeout. A serial strip holds its frame on its own and
/// never gets one. Dropping it stops and joins the thread, so no resend lands
/// after what the next mode writes — Off's black frame above all, which a late
/// resend would light again (an off WLED device still shows realtime frames).
pub(crate) struct SolidHold {
    cell: HoldCell,
    thread: Option<JoinHandle<()>>,
}

impl SolidHold {
    pub(super) fn start(
        cfg: &WledSinkConfig,
        corrections: ColorCorrectionConfig,
        led_count: usize,
        payload: &SolidColorPayload,
    ) -> Result<Self, String> {
        Self::start_every(cfg, corrections, led_count, payload, SOLID_HOLD_INTERVAL)
    }

    pub(super) fn start_every(
        cfg: &WledSinkConfig,
        corrections: ColorCorrectionConfig,
        led_count: usize,
        payload: &SolidColorPayload,
        interval: Duration,
    ) -> Result<Self, String> {
        let mut sink = CorrectedWledSink::new(cfg.build(), corrections);
        sink.start()?;
        let cell: HoldCell = Arc::new((
            Mutex::new(HoldState {
                payload: payload.clone(),
                stopped: false,
            }),
            Condvar::new(),
        ));
        let thread_cell = Arc::clone(&cell);
        let thread = std::thread::Builder::new()
            .name("solid-hold".into())
            .spawn(move || {
                let (lock, wake) = &*thread_cell;
                let mut frame = vec![[0u8; 3]; led_count];
                let mut failing = false;
                loop {
                    let guard = lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
                    let (guard, _) = wake
                        .wait_timeout_while(guard, interval, |state| !state.stopped)
                        .unwrap_or_else(|poisoned| poisoned.into_inner());
                    if guard.stopped {
                        break;
                    }
                    let held = &guard.payload;
                    frame.fill([held.r, held.g, held.b]);
                    sink.set_brightness(held.brightness);
                    match sink.send_frame(&frame) {
                        Ok(()) if failing => {
                            failing = false;
                            log::info!("[solid-hold] resending again");
                        }
                        Err(reason) if !failing => {
                            failing = true;
                            log::warn!("[solid-hold] resend failed — {reason}");
                        }
                        _ => {}
                    }
                }
                let _ = sink.stop();
            })
            .map_err(|error| format!("solid hold thread did not start: {error}"))?;
        Ok(Self {
            cell,
            thread: Some(thread),
        })
    }

    pub(super) fn handle(&self) -> SolidHoldHandle {
        SolidHoldHandle(Arc::clone(&self.cell))
    }
}

impl Drop for SolidHold {
    fn drop(&mut self) {
        let (lock, wake) = &*self.cell;
        lock.lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .stopped = true;
        wake.notify_all();
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}
