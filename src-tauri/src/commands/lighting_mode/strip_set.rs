//! Which strips the "usb" channel drives: the connected local outputs in connect order, each
//! matched to the saved strip it is and carrying that strip's own setup. The mode is for one of
//! them (`payload_index`, `primary`); an Ambilight run also drives the strips `fan_out` lets beside
//! it.
//! docs/architecture/device-output.md ("Which strips are driven").

use std::net::Ipv4Addr;

use serde_json::Value;

use super::usb_output::UsbOutputPlan;
use crate::commands::led_calibration::LedCalibrationConfig;
use crate::commands::led_output::{
    ColorCorrectionConfig, FirmwareProfile, LedChipType, LedColorOrder,
};
use crate::commands::local_outputs::{DrivenLocal, LocalOutputRegistry};
use crate::commands::shell_state::{decode_strip, PersistedShellState};
use crate::commands::wled_sink::WledSinkConfig;
use crate::models::led_strips::{LedStrip, StripTransport};

/// One strip as the ambilight worker drives it: the output it writes, and what it needs to sample
/// the screen and encode for that output.
#[derive(Clone, Debug)]
pub(super) struct StripSpec {
    /// `None` for a strip the worker samples and sends nowhere: a test pattern with no device
    /// connected, or a layout drawn beside Hue for the preview.
    pub plan: Option<UsbOutputPlan>,
    pub layout: Option<LedCalibrationConfig>,
    pub profile: FirmwareProfile,
    pub chip: LedChipType,
    pub correction: ColorCorrectionConfig,
    /// A strip's own saved colour order, fixed for the run; `None` follows the live setting, as
    /// the strip the mode is for does.
    pub color_order: Option<LedColorOrder>,
}

/// A connected output and the saved strip it is. A port connected with no `ledStrips` row is
/// driven all the same, as it always was.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct DrivenStrip {
    pub output: DrivenLocal,
    pub strip_id: Option<String>,
    /// The saved strip's own setup; `None` for a port no saved strip names.
    pub saved: Option<SavedSetup>,
    /// Every strip is corrected by the one top-level colour correction, clamped as the mode's
    /// own is: a strip's own copy is not read yet (contracts/strips.ts).
    pub correction: ColorCorrectionConfig,
}

/// What a saved strip says about itself, decoded the way the primary strip's readers decode it.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct SavedSetup {
    pub enabled: bool,
    /// `None` when absent or in a shape this build cannot read.
    pub layout: Option<LedCalibrationConfig>,
    pub profile: FirmwareProfile,
    pub chip: LedChipType,
    pub color_order: LedColorOrder,
}

impl SavedSetup {
    fn of(strip: &LedStrip) -> Self {
        let decoded = decode_strip(strip);
        Self {
            enabled: strip.enabled,
            layout: decoded.layout,
            profile: decoded.firmware_profile.unwrap_or_default(),
            chip: decoded.chip_type.unwrap_or_default(),
            color_order: decoded.color_order.unwrap_or_default(),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum LeftOutReason {
    /// Its port or device is not connected, or it names none.
    NotConnected,
    /// An earlier strip in the saved order already takes the same port or device.
    DuplicateTransport,
    /// Connected, beside the strip the mode is for, but switched off.
    Disabled,
    /// Connected beside the mode's strip with no layout of its own, or one this build cannot read.
    NoLayout,
    /// Its layout reads but cannot drive LEDs: one or none, or one `validate` refuses.
    InvalidLayout,
    /// Another kind of output than the mode's strip: one run drives serial or WLED, not both.
    OtherTransport,
}

/// What one run drives beside the strip the mode is for, and what it leaves out and why.
#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct FanOut {
    /// Index into `driven` of the strip the mode's own layout, test pattern and scene are for.
    pub payload: Option<usize>,
    /// Indices of the other strips driven beside it, in connect order.
    pub others: Vec<usize>,
    pub left_out: Vec<LeftOutStrip>,
    /// Connected ports no saved strip names, other than the payload's: not driven, and with no
    /// strip id to record them by.
    pub unsaved: Vec<usize>,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct LeftOutStrip {
    pub strip_id: String,
    pub reason: LeftOutReason,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct StripSet {
    /// Earliest connected first.
    pub driven: Vec<DrivenStrip>,
    pub left_out: Vec<LeftOutStrip>,
    /// The saved strip a setting with no strip named applies to (`primary_strip`), whether or not
    /// it is connected.
    pub primary_saved: Option<String>,
}

impl StripSet {
    /// What the "usb" channel drives: the output of the strip the mode is for (`payload_index`).
    pub fn primary(&self) -> Option<&DrivenLocal> {
        self.payload_index().map(|index| &self.driven[index].output)
    }

    /// Which driven strip the mode is for: the saved primary (`primary_strip`, the first enabled
    /// one) when it is connected, else the earliest connected — so a setup whose primary is
    /// unplugged still lights the strip that is there, as it always has. `None` with nothing
    /// driven.
    pub fn payload_index(&self) -> Option<usize> {
        let primary_saved = self.primary_saved.as_deref();
        if self.driven.is_empty() {
            return None;
        }
        primary_saved
            .and_then(|id| {
                self.driven
                    .iter()
                    .position(|strip| strip.strip_id.as_deref() == Some(id))
            })
            .or(Some(0))
    }

    /// Who is driven beside the payload strip. The payload keeps every rule it has today — its
    /// layout comes from the mode, enabled or not — and each other strip must be saved, enabled,
    /// laid out with more than one LED and the same kind of output as the payload's, checked in
    /// that order.
    pub fn fan_out(&self) -> FanOut {
        let Some(payload) = self.payload_index() else {
            return FanOut::default();
        };
        let payload_is_serial = matches!(self.driven[payload].output, DrivenLocal::Serial(_));
        let mut fan = FanOut {
            payload: Some(payload),
            ..FanOut::default()
        };
        for (index, strip) in self.driven.iter().enumerate() {
            if index == payload {
                continue;
            }
            let (Some(id), Some(setup)) = (&strip.strip_id, &strip.saved) else {
                fan.unsaved.push(index);
                continue;
            };
            let reason = if !setup.enabled {
                Some(LeftOutReason::Disabled)
            } else if let Some(layout) = &setup.layout {
                if layout.total_leds <= 1 || layout.validate().is_err() {
                    Some(LeftOutReason::InvalidLayout)
                } else if matches!(strip.output, DrivenLocal::Serial(_)) != payload_is_serial {
                    Some(LeftOutReason::OtherTransport)
                } else {
                    None
                }
            } else {
                Some(LeftOutReason::NoLayout)
            };
            match reason {
                Some(reason) => fan.left_out.push(LeftOutStrip {
                    strip_id: id.clone(),
                    reason,
                }),
                None => fan.others.push(index),
            }
        }
        fan
    }

    /// The set a run with `plan` drives: this one when its primary is that plan, else the plan on
    /// its own with no saved strip behind it — what a caller that names the output itself (a stop,
    /// a test calling the transition directly) has always meant. Empty with no plan.
    pub fn for_plan(&self, plan: Option<&UsbOutputPlan>) -> StripSet {
        let Some(plan) = plan else {
            return StripSet::default();
        };
        let same = match (self.primary(), plan) {
            (Some(DrivenLocal::Serial(port)), UsbOutputPlan::Serial(planned)) => port == planned,
            (Some(DrivenLocal::Wled(config)), UsbOutputPlan::Wled(planned)) => config == planned,
            _ => false,
        };
        if same {
            return self.clone();
        }
        let output = match plan {
            UsbOutputPlan::Serial(port) => DrivenLocal::Serial(port.clone()),
            UsbOutputPlan::Wled(config) => DrivenLocal::Wled(*config),
        };
        StripSet {
            driven: vec![DrivenStrip {
                output,
                strip_id: None,
                saved: None,
                correction: ColorCorrectionConfig::default(),
            }],
            left_out: Vec::new(),
            primary_saved: None,
        }
    }

    /// `apply_mode_change`'s three channel arguments.
    pub fn plan_args(&self) -> (bool, Option<&str>, Option<WledSinkConfig>) {
        match self.primary() {
            Some(DrivenLocal::Serial(port)) => (true, Some(port.as_str()), None),
            Some(DrivenLocal::Wled(config)) => (false, None, Some(*config)),
            None => (false, None, None),
        }
    }

    /// One line for the log: each driven output with its strip, then each strip left out and why.
    pub fn summary(&self) -> String {
        let driven: Vec<String> = self
            .driven
            .iter()
            .map(|strip| {
                let output = match &strip.output {
                    DrivenLocal::Serial(port) => format!("serial:{port}"),
                    DrivenLocal::Wled(config) => format!("wled:{}", config.ip),
                };
                format!(
                    "{output}->{}",
                    strip.strip_id.as_deref().unwrap_or("unsaved")
                )
            })
            .collect();
        let left_out: Vec<String> = self
            .left_out
            .iter()
            .map(|strip| format!("{}:{:?}", strip.strip_id, strip.reason))
            .collect();
        // What the fan-out would drive, logged ahead of it so a report shows the plan it will take.
        let fan = self.fan_out();
        let fan_left: Vec<String> = fan
            .left_out
            .iter()
            .map(|strip| format!("{}:{:?}", strip.strip_id, strip.reason))
            .collect();
        format!(
            "driven=[{}] left_out=[{}] fan_out=payload:{:?} others:{:?} unsaved:{:?} beside=[{}]",
            driven.join(", "),
            left_out.join(", "),
            fan.payload,
            fan.others,
            fan.unsaved,
            fan_left.join(", ")
        )
    }
}

/// The strips a mode apply plans with: the registry's connected outputs matched to the saved
/// strips. Refuses on a poisoned registry rather than plan from facts a panicking writer may have
/// left half-written.
pub(crate) fn strips_from(
    registry: &LocalOutputRegistry,
    saved: Option<&PersistedShellState>,
) -> Result<StripSet, String> {
    let connected = registry.connected_outputs_checked()?;
    let strips = saved.map(PersistedShellState::strips).unwrap_or_default();
    let mut set = resolve_strips(&strips, connected);
    if let Some(correction) = saved.and_then(PersistedShellState::color_correction) {
        for strip in &mut set.driven {
            strip.correction = correction.clone();
        }
    }
    Ok(set)
}

fn wled_ip(sink: &Value) -> Option<Ipv4Addr> {
    sink.get("ip")?.as_str()?.parse().ok()
}

fn same_transport(transport: &StripTransport, output: &DrivenLocal) -> bool {
    match (transport, output) {
        (StripTransport::Serial { port_name }, DrivenLocal::Serial(port)) => port_name == port,
        // By address alone, as binding the same device again keeps its place (`wled_bound`),
        // whatever port or LED count the saved sink carries.
        (StripTransport::Wled { sink }, DrivenLocal::Wled(config)) => {
            wled_ip(sink) == Some(config.ip)
        }
        _ => false,
    }
}

/// `connected` in connect order (`LocalOutputRegistry::connected_outputs`), `saved` in the order
/// the file holds them. Every connected output is driven; a saved strip that matches none is left
/// out. Whether a strip is enabled or has a layout decides only `fan_out`.
pub(crate) fn resolve_strips(saved: &[LedStrip], connected: Vec<DrivenLocal>) -> StripSet {
    let mut matched: Vec<Option<&LedStrip>> = vec![None; connected.len()];
    let mut left_out = Vec::new();
    for strip in saved {
        let at = strip.transport.as_ref().and_then(|transport| {
            connected
                .iter()
                .position(|output| same_transport(transport, output))
        });
        let reason = match at {
            None => LeftOutReason::NotConnected,
            Some(index) if matched[index].is_some() => LeftOutReason::DuplicateTransport,
            Some(index) => {
                matched[index] = Some(strip);
                continue;
            }
        };
        left_out.push(LeftOutStrip {
            strip_id: strip.id.clone(),
            reason,
        });
    }
    let driven = connected
        .into_iter()
        .zip(matched)
        .map(|(output, strip)| DrivenStrip {
            output,
            strip_id: strip.map(|strip| strip.id.clone()),
            saved: strip.map(SavedSetup::of),
            correction: ColorCorrectionConfig::default(),
        })
        .collect();
    StripSet {
        driven,
        left_out,
        // `primary_strip`'s rule: the first enabled strip in the saved order.
        primary_saved: saved
            .iter()
            .find(|strip| strip.enabled)
            .map(|strip| strip.id.clone()),
    }
}
