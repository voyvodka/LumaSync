//! Which strips the "usb" channel drives: the connected local outputs in connect order, each
//! matched to the saved strip it is. The worker still drives only the first of them (`primary`),
//! as the single-output runtime always has; the rest are resolved for the fan-out to come.
//! docs/architecture/device-output.md ("Which strips are driven").

use std::net::Ipv4Addr;

use serde_json::Value;

use super::usb_output::UsbOutputPlan;
use crate::commands::led_calibration::LedCalibrationConfig;
use crate::commands::led_output::{ColorCorrectionConfig, FirmwareProfile, LedChipType};
use crate::commands::local_outputs::{DrivenLocal, LocalOutputRegistry};
use crate::commands::shell_state::PersistedShellState;
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
}

/// A connected output and the saved strip it is. A port connected with no `ledStrips` row is
/// driven all the same, as it always was.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct DrivenStrip {
    pub output: DrivenLocal,
    pub strip_id: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum LeftOutReason {
    /// Its port or device is not connected, or it names none.
    NotConnected,
    /// An earlier strip in the saved order already takes the same port or device.
    DuplicateTransport,
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
}

impl StripSet {
    /// What the "usb" channel drives until the worker fans out: the earliest connected output.
    pub fn primary(&self) -> Option<&DrivenLocal> {
        self.driven.first().map(|strip| &strip.output)
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
        format!(
            "driven=[{}] left_out=[{}]",
            driven.join(", "),
            left_out.join(", ")
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
    Ok(resolve_strips(&strips, connected))
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
/// out. Whether a strip is enabled or has a layout does not decide anything yet.
pub(crate) fn resolve_strips(saved: &[LedStrip], connected: Vec<DrivenLocal>) -> StripSet {
    let mut matched: Vec<Option<String>> = vec![None; connected.len()];
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
                matched[index] = Some(strip.id.clone());
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
        .map(|(output, strip_id)| DrivenStrip { output, strip_id })
        .collect();
    StripSet { driven, left_out }
}
