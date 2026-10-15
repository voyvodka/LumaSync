//! The Off/Solid/Ambilight transition and the mode commands that drive it:
//! `apply_mode_change` under the runtime lock, the turn queue the async
//! commands wait in.

use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};

use log::{info, warn};
use tauri::{AppHandle, Manager, Runtime};

use super::config::{
    frame_led_count_for, normalize_mode_config, wled_frame_advisory, LightingModeCommandResult,
    LightingModeConfig, LightingModeKind, DEFAULT_EFFECT, DEFAULT_SOLID,
};
use super::config_check;
use super::effect_source::worker_ambilight;
use super::effects::EffectDraw;
use super::hydrate::hydrate_mode_payload;
use super::live::{retune_ambilight_live, AmbilightLiveSettings, RoomGeometryLive};
use super::pacing::{capture_interval_for, SerialSendBudget, StripRate};
use super::preview::{build_preview_emit_context, build_twin_sink, TwinFrameSink};
use super::runtime::{AmbilightCaptureRequest, LightingRuntimeOwner, LightingRuntimeState};
use super::snapshot;
use super::strip_set::{strips_from, StripSpec};
use super::usb_output::{ActiveStrip, SolidHold, SolidUsbOutput, UsbOutputPlan};
use super::worker::{start_ambilight_worker, WorkerPacing};
use super::SOLID_OUTPUT_ATTEMPTS;
use crate::commands::hue::state_store::{apply_hue_color_with_context, HueOutputLive};
use crate::commands::led_output::apply_color_correction_rgb;
use crate::commands::local_outputs::{DrivenLocal, LocalOutputRegistry};
use crate::commands::preview::PreviewSessionState;
use crate::commands::runtime_telemetry::{RuntimeTelemetryState, SharedRuntimeTelemetry};
use crate::commands::shell_state;
use crate::commands::status::CommandStatus;
use crate::commands::test_pattern::TestPatternLive;
use crate::commands::wled_sink::WledSinkConfig;

pub(super) fn command_status(code: &str, message: &str, details: Option<String>) -> CommandStatus {
    CommandStatus {
        code: code.to_string(),
        message: message.to_string(),
        details,
    }
}

fn make_result(mode: LightingModeConfig, status: CommandStatus) -> LightingModeCommandResult {
    LightingModeCommandResult {
        active: mode.kind != LightingModeKind::Off,
        mode,
        status,
        wled_advisory: None,
    }
}

fn push_trace(trace: &mut Option<&mut Vec<&'static str>>, step: &'static str) {
    if let Some(events) = trace.as_mut() {
        events.push(step);
    }
}

/// What was running before this apply: the mode, the output it wrote to, and every strip it drove.
pub(super) struct Outgoing {
    pub(super) mode: LightingModeConfig,
    pub(super) plan: Option<UsbOutputPlan>,
    pub(super) strips: Vec<ActiveStrip>,
}

/// The strips an Ambilight run drives beside the mode's own, from the set the apply planned with:
/// Ambilight on a serial strip only, and never for a test pattern, a preview scene or a latency
/// run, which are the mode's strip's alone. An effect draws its first strip only until the engine
/// draws per strip, and a WLED device beside another is left for when it can be switched off.
fn planned_extras(
    owner: &LightingRuntimeOwner,
    next: &LightingModeConfig,
    plan: Option<&UsbOutputPlan>,
    is_test: bool,
) -> Vec<(StripSpec, ActiveStrip)> {
    let fans_out = next.kind == LightingModeKind::Ambilight
        && !is_test
        && owner.preview.scene.is_none()
        && owner.preview.latency_sink.is_none()
        && matches!(plan, Some(UsbOutputPlan::Serial(_)));
    if !fans_out {
        return Vec::new();
    }
    let set = owner.strips.for_plan(plan);
    let fan = set.fan_out();
    fan.others
        .iter()
        .filter_map(|&index| {
            let strip = &set.driven[index];
            let setup = strip.saved.as_ref()?;
            let DrivenLocal::Serial(port) = &strip.output else {
                return None;
            };
            let plan = UsbOutputPlan::Serial(port.clone());
            let layout = setup.layout.clone()?;
            let record = ActiveStrip {
                plan: plan.clone(),
                led_count: usize::from(layout.total_leds),
                layout: Some(layout.clone()),
                profile: setup.profile,
                chip: setup.chip,
                color_order: setup.color_order,
                correction: strip.correction.clone(),
            };
            let spec = StripSpec {
                plan: Some(plan),
                layout: Some(layout),
                profile: setup.profile,
                chip: setup.chip,
                correction: strip.correction.clone(),
                color_order: Some(setup.color_order),
            };
            Some((spec, record))
        })
        .collect()
}

/// Records the serial ports a run now holds, releasing every previous port it no longer uses
/// first. A port that stays — a mode restart on the ports already in use — is left untouched:
/// that is the DTR invariant `stop_previous` also protects, see docs/architecture/device-output.md
/// (DTR reset). Only a genuine switch releases a handle, so an abandoned port can be opened by
/// another app (e.g. the Arduino IDE) instead of staying locked until LumaSync quits.
///
/// A released port the outgoing run was lighting is painted black first, through the session
/// still cached: after the release a black frame would reopen the port, and the reopen resets the
/// board. Each strip is blanked with its own record, the length and encoding it ran with; the
/// outgoing mode is the fallback for a run recorded without one. The writes run under the runtime
/// lock, each bounded by the serial write timeout, and each duration is logged so a slow
/// controller shows up in the log.
pub(super) fn set_active_ports(
    owner: &mut LightingRuntimeOwner,
    new_ports: Vec<String>,
    outgoing: &Outgoing,
) {
    for old_port in std::mem::take(&mut owner.active_ports) {
        if new_ports.contains(&old_port) {
            continue;
        }
        blank_if_lit(owner, &old_port, outgoing, "release");
        owner.output_bridge.disconnect_session(&old_port);
    }
    owner.active_ports = new_ports;
}

/// Paints `port` black through its cached session when the outgoing run lit it, from that strip's
/// own record, or the outgoing mode's for a run recorded without one.
fn blank_if_lit(owner: &LightingRuntimeOwner, port: &str, outgoing: &Outgoing, why: &str) {
    let plan = UsbOutputPlan::Serial(port.to_string());
    let output = match outgoing.strips.iter().find(|strip| strip.plan == plan) {
        Some(strip) => Some(SolidUsbOutput::for_strip(&owner.output_bridge, strip)),
        None => (outgoing.plan.as_ref() == Some(&plan))
            .then(|| SolidUsbOutput::for_mode(&owner.output_bridge, plan.clone(), &outgoing.mode)),
    };
    if let Some(output) = output {
        let started = std::time::Instant::now();
        match output.blank() {
            Ok(()) => info!(
                "[set_active_ports] {port} blanked on {why} in {}ms led_count={}",
                started.elapsed().as_millis(),
                output.led_count
            ),
            Err(reason) => warn!("[set_active_ports] {port} kept its last frame: {reason}"),
        }
    }
}

/// A worker kind's start, as a literal per kind so the contract verifier finds each code.
fn worker_started(kind: LightingModeKind) -> CommandStatus {
    match kind {
        LightingModeKind::Effect => command_status(
            "EFFECT_MODE_STARTED",
            "Effect runtime started with frame output pipeline.",
            None,
        ),
        _ => command_status(
            "AMBILIGHT_MODE_STARTED",
            "Ambilight runtime started with frame output pipeline.",
            None,
        ),
    }
}

fn worker_start_failed(kind: LightingModeKind, details: Option<String>) -> CommandStatus {
    match kind {
        LightingModeKind::Effect => command_status(
            "EFFECT_MODE_START_FAILED",
            "Effect runtime could not start.",
            details,
        ),
        _ => command_status(
            "AMBILIGHT_MODE_START_FAILED",
            "Ambilight runtime could not start.",
            details,
        ),
    }
}

pub(super) fn stop_previous(
    owner: &mut LightingRuntimeOwner,
    trace: &mut Option<&mut Vec<&'static str>>,
) {
    push_trace(trace, "stop_previous");
    let t0 = std::time::Instant::now();
    // First: whatever the next mode writes must not be followed by a resend.
    owner.solid_hold = None;
    owner.preview.scene_worker = false;
    owner.preview.latency_worker = false;
    owner.ambilight_live = None;
    owner.room_geometry_live = None;
    owner.effect_live = None;
    let had_worker = owner.worker.is_some();
    if let Some(worker) = owner.worker.take() {
        worker.stop();
    }
    // Do NOT close the cached serial port handle here — reopening the port
    // toggles DTR and resets the MCU before the packet lands. See
    // docs/architecture/device-output.md (DTR reset).
    // `active_ports` is deliberately kept: it is the only record of which ports
    // hold a cached session, and `set_active_ports` needs it after this stop
    // to release those the next mode no longer uses.
    let total_ms = t0.elapsed().as_millis();
    info!(
        "[stop_previous] completed in {total_ms}ms had_worker={had_worker} last_ports={:?} (cached serial sessions preserved to avoid DTR-reset cycle)",
        owner.active_ports
    );
}

// Central state machine transition. 9-arg signature is retained to avoid
// disturbing the many existing call sites (several of which live in
// lib-tests that carry other outstanding compilation issues). Bundling
// these into a struct is tracked as a follow-up refactor rather than part
// of the clippy cleanup pass.
/// Wraps the mode change so the WLED length advisory is derived once, from the
/// mode that actually took effect. Attaching it per success branch would mean
/// every future branch has to remember to, and the ones that refuse a change
/// must not carry it at all.
#[allow(clippy::too_many_arguments)]
pub(super) fn apply_mode_change(
    owner: &mut LightingRuntimeOwner,
    next_mode: LightingModeConfig,
    device_connected: bool,
    connected_port: Option<&str>,
    wled_sink: Option<WledSinkConfig>,
    hue_output: Option<Arc<HueOutputLive>>,
    telemetry_snapshot: Option<SharedRuntimeTelemetry>,
    twin_sink: Option<TwinFrameSink>,
    trace: Option<&mut Vec<&'static str>>,
) -> LightingModeCommandResult {
    let mut result = apply_mode_change_inner(
        owner,
        next_mode,
        device_connected,
        connected_port,
        wled_sink,
        hue_output,
        telemetry_snapshot,
        twin_sink,
        trace,
    );
    result.wled_advisory = wled_frame_advisory(&result.mode, wled_sink.as_ref());
    result
}

#[allow(clippy::too_many_arguments)]
fn apply_mode_change_inner(
    owner: &mut LightingRuntimeOwner,
    next_mode: LightingModeConfig,
    device_connected: bool,
    connected_port: Option<&str>,
    // Snapshot of `LocalOutputRegistry::wled_config()`. `Some` means a
    // WLED device is the most recently connected "usb"-channel sink and
    // takes priority over `connected_port` for this mode change.
    wled_sink: Option<WledSinkConfig>,
    hue_output: Option<Arc<HueOutputLive>>,
    telemetry_snapshot: Option<SharedRuntimeTelemetry>,
    twin_sink: Option<TwinFrameSink>,
    trace: Option<&mut Vec<&'static str>>,
) -> LightingModeCommandResult {
    let normalized_next = normalize_mode_config(next_mode);

    // Universal calibration diagnostic — dump the led_calibration shape
    // visible to apply_mode_change for both Solid and Ambilight. The
    // frontend hydration path ought to stamp this, but a v1.5 hardware
    // bug surfaced as `led_count=1` on the wire despite a 59-LED
    // calibration sitting on disk. Logging here makes the live drag
    // session show whether the payload is actually carrying the
    // calibration into apply_mode_change or whether something between
    // frontend and the runtime is dropping it.
    info!(
        "[apply_mode_change] kind={:?} led_calibration_total_leds={} targets={:?} strips {}",
        normalized_next.kind,
        normalized_next
            .led_calibration
            .as_ref()
            .map(|c| c.total_leds as i32)
            .unwrap_or(-1),
        normalized_next.targets,
        owner.strips.summary(),
    );

    // Checked under the runtime lock, which the quit's own stop also takes: a
    // start ordered after that stop is refused here, before `stop_previous`,
    // and one ordered before it is stopped by it. Off still runs.
    if normalized_next.kind != LightingModeKind::Off && owner.closing.load(Ordering::SeqCst) {
        warn!("[apply_mode_change] refused — the app is shutting down");
        return make_result(
            owner.active_mode.clone(),
            command_status(
                "LIGHTING_MODE_SHUTTING_DOWN",
                "The app is shutting down; the lighting mode was not changed.",
                None,
            ),
        );
    }

    // Refused before anything is read off it or torn down, like the gates below.
    if normalized_next.kind != LightingModeKind::Off {
        if let Err(reason) = config_check::check_mode_config(&normalized_next) {
            warn!("[apply_mode_change] refused — {reason}");
            return make_result(
                owner.active_mode.clone(),
                command_status(
                    "LIGHTING_MODE_INVALID_CONFIG",
                    "The lighting settings are not valid; the lighting mode was not changed.",
                    Some(reason),
                ),
            );
        }
    }

    // Derive target flags from the requested targets list.
    // Empty/None targets = legacy behavior: USB is required (backward compat).
    let requested_targets = normalized_next.targets.clone().unwrap_or_default();
    let needs_usb = requested_targets.is_empty() || requested_targets.iter().any(|t| t == "usb");
    let needs_hue = requested_targets.iter().any(|t| t == "hue");
    // The caller hands over the Hue runtime's live slot whatever the targets.
    // A worker given it while not targeting Hue would sample and send Hue every
    // frame, and follow the stream into every reconnect — so only a mode that
    // names Hue gets it. See docs/architecture/hue.md.
    let hue_output = hue_output.filter(|_| needs_hue);
    let hue_context = hue_output.as_ref().and_then(|live| live.current());
    // A synthetic test request (the LED preview) bypasses the device/Hue
    // gates so it can run preview-only (twin + edge stream) with no sink.
    let is_test = owner.preview.pending_test_pattern.is_some();

    // Resolve the "usb" channel once. A registered WLED sink takes priority
    // over the serial-connection snapshot (see `UsbOutputPlan`). A serial plan
    // needs a port that is connected now: a name alone was never admitted by
    // `connect_serial_port`, and opening it would bypass the allowlist.
    // See docs/architecture/device-output.md.
    let serial_port = connected_port.filter(|_| device_connected);
    let usb_plan: Option<UsbOutputPlan> = match wled_sink {
        Some(cfg) => Some(UsbOutputPlan::Wled(cfg)),
        None => serial_port.map(|p| UsbOutputPlan::Serial(p.to_string())),
    };
    let usb_available = usb_plan.is_some();

    // USB gate: only applies when USB is a required target.
    if normalized_next.kind != LightingModeKind::Off && needs_usb && !usb_available && !is_test {
        log::warn!(
            "[apply_mode_change] gated DEVICE_NOT_CONNECTED — kind={:?} requested_targets={:?} device_connected={device_connected}",
            normalized_next.kind, requested_targets,
        );
        return make_result(
            owner.active_mode.clone(),
            command_status(
                "DEVICE_NOT_CONNECTED",
                "Cannot apply lighting mode while device is disconnected.",
                Some("Connect a supported serial controller before changing mode.".to_string()),
            ),
        );
    }

    // Hue gate: when Hue target requested, Hue output context must be available.
    if normalized_next.kind != LightingModeKind::Off
        && needs_hue
        && hue_context.is_none()
        && !is_test
        && !owner.hue_gate_waived
    {
        return make_result(
            owner.active_mode.clone(),
            command_status(
                "HUE_NOT_READY",
                "Hue streaming is not available. Ensure bridge is paired and entertainment area is selected.",
                Some("HUE_RUNTIME_GATE_FAILED".to_string()),
            ),
        );
    }

    let mut trace = trace;

    // A running test retunes in place too: its pattern and speed sit in a cell the
    // frame source re-reads each frame, so only the frame geometry forces a rebuild.
    // Without it every colour commit was a full worker teardown.
    let preview_retune = match (
        owner.preview.pending_test_pattern.as_ref(),
        owner.preview.active_test_pattern.as_ref(),
    ) {
        (None, None) => true,
        (Some(next), Some(current)) => {
            owner.preview.pattern_live.is_some() && next.display_aspect == current.display_aspect
        }
        // Live→test needs a synthetic source built; test→live needs the real one back.
        _ => false,
    };

    // Fast path: ambilight already running and only settings changed (brightness,
    // black border detection, smoothing alpha) — update live atomics in-place
    // without stopping the worker or recreating SCStream.
    // NOTE: led_calibration, color_correction, firmware_profile and chip_type all force a worker
    // restart — each is read only when the encoder is built, so retuning atomics ignores them.
    // room_geometry deliberately does NOT: the worker re-reads it from `room_geometry_live`, so
    // it is written into that cell below instead — adding it here would restart per drag commit.
    // color_order does NOT either: the worker re-reads it from `ambilight_live` every frame, and a
    // restart would re-open capture for what is a byte shuffle.
    // The output the next worker would write to; a retune keeps the running one only when it matches.
    let next_usb_plan = usb_plan.clone().filter(|_| needs_usb);
    // The strips the next run would drive beside the mode's; a retune keeps the running worker
    // only when they are the ones it was asked for, in the same order.
    let next_extras = planned_extras(owner, &normalized_next, next_usb_plan.as_ref(), is_test);
    let worker_kind = matches!(
        normalized_next.kind,
        LightingModeKind::Ambilight | LightingModeKind::Effect
    );
    if worker_kind
        && normalized_next.kind == owner.active_mode.kind
        && owner.worker.is_some()
        && next_usb_plan == owner.active_usb_plan
        && next_extras
            .iter()
            .map(|(_, record)| record)
            .eq(owner.requested_extras.iter())
        && normalized_next.targets == owner.active_mode.targets
        && normalized_next.display_id == owner.active_mode.display_id
        && normalized_next.led_calibration == owner.active_mode.led_calibration
        && normalized_next.color_correction == owner.active_mode.color_correction
        && normalized_next.firmware_profile == owner.active_mode.firmware_profile
        && normalized_next.chip_type == owner.active_mode.chip_type
        && preview_retune
        && owner.preview.scene.is_some() == owner.preview.scene_worker
        && owner.preview.latency_sink.is_some() == owner.preview.latency_worker
    {
        if let Some(live) = &owner.ambilight_live {
            let effect = normalized_next.effect.clone();
            let cfg = worker_ambilight(effect.as_ref(), normalized_next.ambilight.as_ref());
            retune_ambilight_live(live, &cfg);
            if let (Some(effect), Some(slot)) = (effect, owner.effect_live.as_ref()) {
                *slot.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = effect;
            }
            // Unconditional: the atomic is the worker's only copy, so it must
            // follow every apply, including one that returns to the default.
            live.store_color_order(normalized_next.color_order.unwrap_or_default());
            if normalized_next.room_geometry != owner.active_mode.room_geometry {
                if let Some(cell) = &owner.room_geometry_live {
                    log::info!(
                        "[ambilight-live-update] room geometry {}",
                        if normalized_next.room_geometry.is_some() {
                            "updated"
                        } else {
                            "cleared"
                        }
                    );
                    cell.publish(normalized_next.room_geometry.clone());
                }
            }
            owner.active_mode = normalized_next;
            if let Some(next) = owner.preview.pending_test_pattern.take() {
                if let Some(slot) = owner.preview.pattern_live.as_ref() {
                    let mut cell = slot.lock().unwrap_or_else(|err| err.into_inner());
                    *cell = TestPatternLive::from_config(&next);
                }
                owner.preview.active_test_pattern = Some(next);
            }
            let status = if owner.active_mode.kind == LightingModeKind::Effect {
                command_status(
                    "EFFECT_MODE_UPDATED",
                    "Effect settings updated in running worker.",
                    None,
                )
            } else {
                command_status(
                    "AMBILIGHT_MODE_UPDATED",
                    "Ambilight settings updated in running worker.",
                    None,
                )
            };
            return make_result(owner.active_mode.clone(), status);
        }
    }

    let outgoing = Outgoing {
        mode: owner.active_mode.clone(),
        plan: owner.active_usb_plan.take(),
        strips: std::mem::take(&mut owner.active_strips),
    };
    owner.requested_extras.clear();
    // Kept past the stop for the Off that may follow, which paints each of them black. Every run
    // leaves its own record, an empty one when it drove no strip, so an Off never blanks — and
    // reopens — ports an earlier run held; an Off after an Off keeps the one before.
    if outgoing.mode.kind != LightingModeKind::Off {
        owner.ended_run = outgoing.strips.clone();
    }
    stop_previous(owner, &mut trace);

    match normalized_next.kind {
        LightingModeKind::Off => {
            owner.active_mode = LightingModeConfig::default();
            owner.preview.active_test_pattern = None;
            owner.preview.pattern_live = None;
            make_result(
                owner.active_mode.clone(),
                command_status("LIGHTING_MODE_STOPPED", "Lighting runtime stopped.", None),
            )
        }
        LightingModeKind::Solid => {
            push_trace(&mut trace, "start_solid");
            let payload = normalized_next.solid.clone().unwrap_or(DEFAULT_SOLID);

            // USB solid output (only if USB target requested and a sink -- serial
            // or WLED -- is available)
            if needs_usb {
                let Some(plan) = usb_plan.clone() else {
                    owner.active_mode = LightingModeConfig::default();
                    return make_result(
                        owner.active_mode.clone(),
                        command_status(
                            "SOLID_MODE_APPLY_FAILED",
                            "Solid mode payload could not be applied.",
                            Some("LED_OUTPUT_PORT_UNAVAILABLE".to_string()),
                        ),
                    );
                };

                SOLID_OUTPUT_ATTEMPTS.fetch_add(1, Ordering::SeqCst);

                log::info!(
                    "[apply_mode_change] solid led_calibration={}",
                    normalized_next
                        .led_calibration
                        .as_ref()
                        .map(|c| format!("Some(total_leds={})", c.total_leds))
                        .unwrap_or_else(|| "None".to_string())
                );
                let output =
                    SolidUsbOutput::for_mode(&owner.output_bridge, plan.clone(), &normalized_next);
                let solid_led_count = output.led_count;

                // Diagnostic: dump the post-correction RGB triplet that
                // actually goes onto the wire. Useful when investigating
                // "LED #0 is dark even though I picked a bright colour" —
                // exposes brightness clamps, gamma surprises, kelvin tints,
                // and saturation math without firing up a USB sniffer.
                let (corrected_r, corrected_g, corrected_b) = apply_color_correction_rgb(
                    (payload.r, payload.g, payload.b),
                    &output.corrections,
                );
                let brightness_byte = (payload.brightness.clamp(0.0, 1.0) * 255.0).floor() as u8;

                if let Err(reason) = output.send(&payload) {
                    warn!(
                        "[apply_mode_change] solid USB send FAILED — sink={plan:?} led_count={solid_led_count} reason={reason}"
                    );
                    owner.active_mode = LightingModeConfig::default();
                    return make_result(
                        owner.active_mode.clone(),
                        command_status(
                            "SOLID_MODE_APPLY_FAILED",
                            "Solid mode payload could not be applied.",
                            Some(reason),
                        ),
                    );
                }

                info!(
                    "[apply_mode_change] solid USB frame sent — sink={plan:?} led_count={solid_led_count} brightness_byte={brightness_byte} input=({}, {}, {}) corrected=({corrected_r}, {corrected_g}, {corrected_b})",
                    payload.r,
                    payload.g,
                    payload.b,
                );

                if let UsbOutputPlan::Wled(cfg) = &plan {
                    match SolidHold::start(
                        cfg,
                        output.corrections.clone(),
                        solid_led_count,
                        &payload,
                    ) {
                        Ok(hold) => owner.solid_hold = Some(hold),
                        Err(reason) => warn!(
                            "[apply_mode_change] solid colour on WLED is not held past its realtime timeout — {reason}"
                        ),
                    }
                }
                // Solid writes the mode's strip alone: a strip the run before drove beside it is
                // blanked and let go here, rather than left on its last frame.
                if let UsbOutputPlan::Serial(port_name) = &plan {
                    set_active_ports(owner, vec![port_name.clone()], &outgoing);
                }
                owner.active_strips = vec![ActiveStrip::of_mode(plan.clone(), &normalized_next)];
                owner.held_strips.clear();
                owner.active_usb_plan = Some(plan);
            }

            // Hue solid output (if hue target requested and context available)
            let mut hue_skip_reason: Option<String> = None;
            if needs_hue {
                match hue_context.as_ref() {
                    Some(context) => {
                        let hue_corrections =
                            normalized_next.color_correction.clone().unwrap_or_default();
                        let (hr, hg, hb) = apply_color_correction_rgb(
                            (payload.r, payload.g, payload.b),
                            &hue_corrections,
                        );
                        if let Err(reason) =
                            apply_hue_color_with_context(context, hr, hg, hb, payload.brightness)
                        {
                            warn!("[apply_mode_change] solid Hue send SKIPPED — reason={reason}");
                            hue_skip_reason = Some(reason);
                        }
                    }
                    None => {
                        // Only reachable on the preview/test path and a settings
                        // refresh during a reconnect; the Hue gate above
                        // rejects a missing context for every other real mode.
                        warn!("[apply_mode_change] solid Hue send SKIPPED — no output context");
                        hue_skip_reason = Some("HUE_OUTPUT_CONTEXT_MISSING".to_string());
                    }
                }
            }

            owner.active_mode = normalized_next;
            owner.preview.active_test_pattern = None;
            owner.preview.pattern_live = None;
            let status = match hue_skip_reason {
                Some(reason) => command_status(
                    "SOLID_MODE_HUE_OUTPUT_SKIPPED",
                    "Solid mode applied, but the Hue output was skipped.",
                    Some(reason),
                ),
                None => command_status(
                    "SOLID_MODE_APPLIED",
                    "Solid mode applied successfully.",
                    None,
                ),
            };
            make_result(owner.active_mode.clone(), status)
        }
        LightingModeKind::Ambilight | LightingModeKind::Effect => {
            push_trace(&mut trace, "start_ambilight");
            let worker_kind = normalized_next.kind;
            // An effect draws its frames; nothing is captured.
            let effect = (normalized_next.kind == LightingModeKind::Effect)
                .then(|| normalized_next.effect.clone().unwrap_or(DEFAULT_EFFECT));
            let effect_live = effect.clone().map(|effect| Arc::new(Mutex::new(effect)));

            // Consume any pending synthetic-test request from the LED preview.
            let test_pattern = if effect.is_some() {
                None
            } else {
                owner.preview.pending_test_pattern.take()
            };

            let ambilight_cfg =
                worker_ambilight(effect.as_ref(), normalized_next.ambilight.as_ref());
            let live_settings = AmbilightLiveSettings::new(
                ambilight_cfg.brightness,
                ambilight_cfg.black_border_detection,
                ambilight_cfg.smoothing_alpha.unwrap_or(0.35),
                ambilight_cfg.saturation.unwrap_or(1.0),
            );
            // Seed the Hue branch alpha from the intensity preset when set.
            // `update` below is the only path that honors the preset, so
            // re-apply it immediately so the first frame after start already
            // uses the user's chosen response curve.
            live_settings.update(
                ambilight_cfg.brightness,
                ambilight_cfg.black_border_detection,
                ambilight_cfg.smoothing_alpha.unwrap_or(0.35),
                ambilight_cfg.saturation.unwrap_or(1.0),
                ambilight_cfg
                    .lighting_smoothing_preset
                    .or(ambilight_cfg.hue_intensity_preset),
            );
            live_settings.store_color_order(normalized_next.color_order.unwrap_or_default());

            info!("[apply_mode_change] starting ambilight — needs_usb={needs_usb} needs_hue={needs_hue} hue_output={}", hue_context.is_some());

            // Fresh per worker: the old cell belongs to the source being torn
            // down, and handing it on would let a stale write reach it.
            let pattern_live = test_pattern
                .as_ref()
                .map(|cfg| Arc::new(Mutex::new(TestPatternLive::from_config(cfg))));

            let strip_rates: Vec<StripRate> = match usb_plan.as_ref().filter(|_| needs_usb) {
                Some(UsbOutputPlan::Serial(_)) => vec![StripRate::Wire {
                    wire_ms: SerialSendBudget::for_strip(
                        frame_led_count_for(&normalized_next),
                        normalized_next.firmware_profile.unwrap_or_default(),
                        normalized_next.chip_type.unwrap_or_default(),
                    )
                    .wire_ms,
                }],
                Some(UsbOutputPlan::Wled(_)) => vec![StripRate::Unpaced],
                None => Vec::new(),
            };
            let strip_rates: Vec<StripRate> = strip_rates
                .into_iter()
                .chain(next_extras.iter().map(|(_, record)| {
                    StripRate::Wire {
                        wire_ms: SerialSendBudget::for_strip(
                            u16::try_from(record.led_count).unwrap_or(u16::MAX),
                            record.profile,
                            record.chip,
                        )
                        .wire_ms,
                    }
                }))
                .collect();
            let capture_interval = capture_interval_for(&strip_rates);
            let frame_source = {
                let req = AmbilightCaptureRequest {
                    display_id: normalized_next.display_id.clone(),
                    led_calibration: normalized_next.led_calibration.clone(),
                    test_pattern: test_pattern.clone(),
                    pattern_phase: Some(Arc::clone(&owner.preview.pattern_phase)),
                    pattern_live: pattern_live.clone(),
                    frame_interval: capture_interval,
                    effect: effect_live.clone(),
                };
                match (owner.frame_source_factory)(req) {
                    Ok(source) => {
                        info!("[apply_mode_change] frame_source created OK");
                        source
                    }
                    Err(reason) => {
                        warn!(
                            "[apply_mode_change] frame_source FAILED: {}",
                            reason.as_reason()
                        );
                        owner.active_mode = LightingModeConfig::default();
                        return make_result(
                            owner.active_mode.clone(),
                            worker_start_failed(worker_kind, Some(reason.as_reason())),
                        );
                    }
                }
            };

            // Resolve the sink for the worker: only pass one if USB is a required target
            let usb_plan_for_worker: Option<UsbOutputPlan> = if needs_usb {
                match usb_plan.clone() {
                    Some(plan) => Some(plan),
                    // A synthetic test runs preview-only (no
                    // USB sink) when no device is connected — no gate.
                    None if is_test => None,
                    None => {
                        owner.active_mode = LightingModeConfig::default();
                        return make_result(
                            owner.active_mode.clone(),
                            worker_start_failed(
                                worker_kind,
                                Some("LED_OUTPUT_PORT_UNAVAILABLE".to_string()),
                            ),
                        );
                    }
                }
            } else {
                None
            };

            let corrections = normalized_next.color_correction.clone().unwrap_or_default();
            let profile = normalized_next.firmware_profile.unwrap_or_default();
            let chip = normalized_next.chip_type.unwrap_or_default();
            let preview_ctx = build_preview_emit_context(owner.preview.preview_gate.clone());
            let room_geometry_live = RoomGeometryLive::new(normalized_next.room_geometry.clone());

            // The mode's strip first — the one the "usb" channel drives, or a layout sampled for
            // the preview with no output — then every strip driven beside it.
            let mut strips = vec![StripSpec {
                plan: usb_plan_for_worker.clone(),
                layout: normalized_next.led_calibration.clone(),
                profile,
                chip,
                correction: corrections,
                color_order: None,
            }];
            let (extra_specs, extra_records): (Vec<StripSpec>, Vec<ActiveStrip>) =
                next_extras.into_iter().unzip();
            strips.extend(extra_specs);
            match start_ambilight_worker(
                owner.output_bridge.clone(),
                strips,
                Arc::clone(&live_settings),
                frame_source,
                telemetry_snapshot.unwrap_or_default(),
                hue_output,
                twin_sink,
                preview_ctx,
                Arc::clone(&room_geometry_live),
                match &effect_live {
                    Some(live) => WorkerPacing::drawn(
                        capture_interval,
                        EffectDraw {
                            live: Arc::clone(live),
                            clock: Arc::clone(&owner.effect_clock),
                        },
                    ),
                    // A test pattern paints its frames too.
                    None => WorkerPacing {
                        synthetic: is_test,
                        preview_scene: owner.preview.scene.is_some(),
                        latency: owner.preview.latency_sink.clone(),
                        ..WorkerPacing::live(capture_interval)
                    },
                },
            ) {
                Ok(worker) => {
                    owner.worker = Some(worker);
                    owner.ambilight_live = Some(live_settings);
                    owner.room_geometry_live = Some(room_geometry_live);
                    owner.effect_live = effect_live;
                    owner.active_mode = normalized_next;
                    owner.preview.active_test_pattern = test_pattern;
                    owner.preview.pattern_live = pattern_live;
                    owner.preview.scene_worker = owner.preview.scene.is_some();
                    owner.preview.latency_worker = owner.preview.latency_sink.is_some();
                    // What runs is what started: a strip beside the mode's that would not open is
                    // neither held nor recorded.
                    let started: Vec<&ActiveStrip> = extra_records
                        .iter()
                        .enumerate()
                        .filter(|(index, _)| {
                            owner
                                .worker
                                .as_ref()
                                .is_some_and(|w| w.started.contains(&(index + 1)))
                        })
                        .map(|(_, record)| record)
                        .collect();
                    if let Some(UsbOutputPlan::Serial(port)) = &usb_plan_for_worker {
                        let mut ports = vec![port.clone()];
                        ports.extend(started.iter().filter_map(|strip| match &strip.plan {
                            UsbOutputPlan::Serial(port) => Some(port.clone()),
                            UsbOutputPlan::Wled(_) => None,
                        }));
                        // A run on the mode's strip alone by its kind — an effect, a test pattern,
                        // a scene, a latency run — paints the strips beside it black but keeps
                        // their sessions: the Ambilight it hands back to finds them warm, instead
                        // of a reopen that resets each board and waits out its settle.
                        let alone_by_kind = owner.active_mode.kind == LightingModeKind::Effect
                            || owner.preview.active_test_pattern.is_some()
                            || owner.preview.scene_worker
                            || owner.preview.latency_worker;
                        let mut held_strips = Vec::new();
                        if alone_by_kind {
                            let kept: Vec<String> = owner
                                .active_ports
                                .iter()
                                .filter(|held| !ports.contains(held))
                                .cloned()
                                .collect();
                            for held in &kept {
                                blank_if_lit(owner, held, &outgoing, "hand-over");
                                // Its record goes with it, so an unplug or a later release blanks
                                // it at its own length rather than the mode's.
                                let plan = UsbOutputPlan::Serial(held.clone());
                                if let Some(record) = outgoing
                                    .strips
                                    .iter()
                                    .chain(owner.held_strips.iter())
                                    .find(|strip| strip.plan == plan)
                                {
                                    held_strips.push(record.clone());
                                }
                            }
                            ports.extend(kept);
                        }
                        set_active_ports(owner, ports, &outgoing);
                        owner.held_strips = held_strips;
                    }
                    let mut active_strips: Vec<ActiveStrip> = usb_plan_for_worker
                        .clone()
                        .map(|plan| ActiveStrip::of_mode(plan, &owner.active_mode))
                        .into_iter()
                        .collect();
                    active_strips.extend(started.into_iter().cloned());
                    owner.active_strips = active_strips;
                    owner.requested_extras = extra_records;
                    owner.active_usb_plan = usb_plan_for_worker;
                    make_result(owner.active_mode.clone(), worker_started(worker_kind))
                }
                Err(reason) => {
                    owner.active_mode = LightingModeConfig::default();
                    make_result(
                        owner.active_mode.clone(),
                        worker_start_failed(worker_kind, Some(reason)),
                    )
                }
            }
        }
    }
}

/// A bare mode apply in the transition queue, with no output reconciling or
/// saving. Tests only: every production caller goes through the lighting
/// transaction (docs/architecture/lighting-transaction.md).
#[cfg(test)]
pub(crate) async fn set_lighting_mode<R: Runtime>(
    app: AppHandle<R>,
    payload: LightingModeConfig,
) -> Result<LightingModeCommandResult, String> {
    run_mode_transition(app, move |app| set_lighting_mode_blocking(app, payload)).await
}

#[cfg(test)]
pub(super) fn set_lighting_mode_blocking<R: Runtime>(
    app: &AppHandle<R>,
    payload: LightingModeConfig,
) -> Result<LightingModeCommandResult, String> {
    app.state::<LightingRuntimeState>().tuning.close_blocking();
    let hue_output = app
        .state::<crate::commands::hue::state_store::HueRuntimeStateStore>()
        .output_live();
    let result = apply_config_blocking(app, payload, hue_output, false)?;
    snapshot::publish_running(app, &result.mode);
    Ok(result)
}

/// The body of a mode apply: hydrate, apply under the runtime lock, broadcast.
/// `hue_output` is the slot a worker naming Hue follows. Shared by
/// `set_lighting_mode` and the lighting transaction. `waive_hue_gate` is the
/// settings refresh's, for a mode already running on Hue while its stream
/// reconnects.
pub(crate) fn apply_config_blocking<R: Runtime>(
    app: &AppHandle<R>,
    mut payload: LightingModeConfig,
    hue_output: Arc<HueOutputLive>,
    waive_hue_gate: bool,
) -> Result<LightingModeCommandResult, String> {
    let runtime_state = app.state::<LightingRuntimeState>();
    let local_outputs = app.state::<LocalOutputRegistry>();
    let telemetry_state = app.state::<RuntimeTelemetryState>();
    let preview_session = app.state::<PreviewSessionState>();
    let t_cmd = std::time::Instant::now();
    let incoming_total_leds = payload
        .led_calibration
        .as_ref()
        .map(|cal| cal.total_leds)
        .unwrap_or(0);
    info!(
        "[set_lighting_mode] invoked kind={:?} payload_led_calibration_total_leds={incoming_total_leds}",
        payload.kind
    );

    // Backend-side calibration safety net (v1.5 hardware repro fix).
    //
    // Frontend hydrators (`withLedCalibration` in App.tsx) stamp the
    // persisted calibration onto every outgoing payload, but a v1.5
    // regression on real hardware showed that some code paths still
    // arrive here without it (live observed: `led_count=1` despite a
    // 59-LED calibration sitting on disk). Rather than chasing every
    // frontend hydration site, reload the persisted shell-state when
    // the payload arrives without a usable calibration and reuse the
    // saved value. The frontend remains the source of truth; this is a
    // pure recovery path that fires only when the payload is missing
    // or carries `total_leds <= 1`.
    //
    // Backend-side ambilight settings safety net (v1.5 H1 fix).
    //
    // Frontend `withAmbilightSettings` (App.tsx) stamps the persisted
    // ambilight payload onto every outgoing dispatch via
    // `savedAmbilightRef`, but a missed-stamp regression would otherwise
    // strip the user's saturation / blackBorderDetection / smoothing
    // preset down to backend defaults. The trigger is narrow — only when
    // `kind == Ambilight` AND `payload.ambilight` is entirely absent —
    // because the frontend is source of truth for present-but-default
    // values (a deliberate slider commit at saturation 1.0 must round-
    // trip without backend interference).
    //
    // Output stamps (colour correction, firmware profile, chip type) follow
    // the same caller-wins rule; the LED control popup sends none of them.
    // One read of the saved state serves the hydration and the strips the apply plans with.
    let persisted = shell_state::persisted(app);
    hydrate_mode_payload(&mut payload, &|| persisted.clone());

    let strips = strips_from(&local_outputs, persisted.as_ref())?;

    let lock_t = std::time::Instant::now();
    let mut owner = runtime_state.lock_owner()?;
    let lock_ms = lock_t.elapsed().as_millis();
    if lock_ms > 10 {
        info!("[set_lighting_mode] runtime lock waited {lock_ms}ms");
    }

    let hue_output = Some(hue_output);

    // The LED preview: clear any stale synthetic-test request, and wire the
    // session's gate so a twin opened mid-run starts receiving without a
    // worker restart.
    owner.preview.pending_test_pattern = None;
    owner.preview.preview_gate = Some(preview_session.twin_open());
    // Read BEFORE apply_mode_change clears it: a live mode change that
    // supersedes a test drops the mode the test would restore.
    let superseded_test = owner.preview.active_test_pattern.is_some();
    // Before the apply, which reads it: the user's choice ends the scene and
    // is not undone, so its worker is a plain one.
    let superseded_scene = owner.preview.scene.take().is_some();
    if superseded_scene {
        owner.preview.session_prior = None;
        owner.preview.latency_sink = None;
    }
    let twin_sink = Some(build_twin_sink(app));
    let (device_connected, connected_port, wled_sink) = strips.plan_args();
    owner.strips = strips.clone();

    owner.hue_gate_waived = waive_hue_gate;
    let result = apply_mode_change(
        &mut owner,
        payload,
        device_connected,
        connected_port,
        wled_sink,
        hue_output,
        Some(telemetry_state.shared_snapshot()),
        twin_sink,
        None,
    );
    owner.hue_gate_waived = false;
    // In the same critical section as the change itself, so a late or racing
    // Stop cannot revive the pre-test mode over the user's new selection.
    if superseded_test {
        owner.preview.test_prior = None;
    }
    // Release the runtime lock before broadcasting so a re-entrant
    // listener cannot deadlock on it.
    drop(owner);
    note_applied_mode(app, &result.mode);
    if superseded_scene {
        crate::commands::preview::scene_superseded(app);
    }
    info!(
        "[set_lighting_mode] completed in {}ms",
        t_cmd.elapsed().as_millis()
    );
    Ok(result)
}

/// `stop_lighting_blocking` in the transition queue. Tests only, like
/// `set_lighting_mode`.
#[cfg(test)]
pub(crate) async fn stop_lighting<R: Runtime>(
    app: AppHandle<R>,
) -> Result<LightingModeCommandResult, String> {
    run_mode_transition(app, |app| stop_lighting_blocking(app)).await
}

/// Force the lighting mode to `Off`, stopping any running worker. Used by the
/// lighting transaction and on the app shutdown path. The shutdown path calls it directly, outside the
/// transition queue: quit must never wait behind a queued mode change, and
/// the runtime lock still serialises it against the one in flight.
pub fn stop_lighting_blocking<R: Runtime>(
    app: &AppHandle<R>,
) -> Result<LightingModeCommandResult, String> {
    let runtime_state = app.state::<LightingRuntimeState>();
    runtime_state.tuning.close_blocking();
    let result = {
        let mut owner = runtime_state.lock_owner()?;
        // Capture whether a synthetic test was running
        // BEFORE apply_mode_change clears it.
        let superseded_test = owner.preview.active_test_pattern.is_some();
        let superseded_scene = owner.preview.scene.take().is_some();
        owner.preview.session_prior = None;
        owner.preview.latency_sink = None;
        let result = apply_mode_change(
            &mut owner,
            LightingModeConfig::default(),
            true,
            None,
            None,
            None,
            None,
            None,
            None,
        );
        // Stopping all lighting supersedes any active test; dropped under the
        // same lock so a late Stop cannot revive the pre-test mode.
        if superseded_test {
            owner.preview.test_prior = None;
        }
        (result, superseded_scene)
    };
    let (result, superseded_scene) = result;
    note_applied_mode(app, &result.mode);
    snapshot::publish_running(app, &result.mode);
    if superseded_scene {
        crate::commands::preview::scene_superseded(app);
    }
    Ok(result)
}

/// What a user's Off did to the "usb" channel it found driven.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct UsbOff {
    /// `Err` leaves the strip holding the last frame it was sent.
    pub(crate) black_frame: Result<(), String>,
    /// A WLED device, to be switched off as well: black alone lasts only until
    /// it leaves realtime mode and goes back to its own effect.
    pub(crate) wled: Option<WledSinkConfig>,
}

/// Paint the strip the ended mode drove black. Stopping a mode only stops
/// writing, and a strip holds the last frame it was sent — a Solid colour
/// indefinitely. Must run after the mode has stopped, so no worker frame can
/// follow the black one. `None` when the mode did not drive the channel or no
/// sink is there to reach. docs/architecture/device-output.md ("Off").
pub(crate) fn blank_usb_after_off<R: Runtime>(
    app: &AppHandle<R>,
    ended: &LightingModeConfig,
) -> Option<UsbOff> {
    let targets = ended.targets.clone().unwrap_or_default();
    let drove_usb = ended.kind != LightingModeKind::Off
        && (targets.is_empty() || targets.iter().any(|target| target == "usb"));
    if !drove_usb {
        return None;
    }
    // Every strip the run drove, each with its own record; taken, so a second Off paints nothing.
    let ran: Vec<ActiveStrip> = app
        .try_state::<LightingRuntimeState>()
        .map(|state| std::mem::take(&mut state.lock_owner_recovered().ended_run))
        .unwrap_or_default();
    // Every run leaves its record, so none means the run drove no strip: painting the registry's
    // strip here would reopen a port no run holds, and the reopen resets its board.
    let (first, beside) = ran.split_first()?;
    for strip in beside {
        blank_recorded(app, strip);
    }
    Some(blank_recorded(app, first))
}

/// Paints `port` black with the layout of the mode that last drove it: a strip let go of while lit
/// holds its last frame as an Off would have left it. Run after the mode stopped driving it.
pub(crate) fn blank_serial_port<R: Runtime>(
    app: &AppHandle<R>,
    port: &str,
    ended: &LightingModeConfig,
) -> Result<(), String> {
    let plan = UsbOutputPlan::Serial(port.to_string());
    match recorded_strip(app, &plan) {
        Some(strip) => blank_recorded(app, &strip).black_frame,
        None => blank_plan(app, plan, ended).black_frame,
    }
}

/// Paints a WLED device black with the layout of the mode that last drove it, before it is switched
/// off: switched off alone, a device still in realtime mode shows its last frame until that times out.
pub(crate) fn blank_wled<R: Runtime>(
    app: &AppHandle<R>,
    config: crate::commands::wled_sink::WledSinkConfig,
    ended: &LightingModeConfig,
) -> Result<(), String> {
    let plan = UsbOutputPlan::Wled(config);
    match recorded_strip(app, &plan) {
        Some(strip) => blank_recorded(app, &strip).black_frame,
        None => blank_plan(app, plan, ended).black_frame,
    }
}

/// The record of the strip on `plan` in the run now going, a port it keeps warm, else the run that
/// went last.
fn recorded_strip<R: Runtime>(app: &AppHandle<R>, plan: &UsbOutputPlan) -> Option<ActiveStrip> {
    let state = app.try_state::<LightingRuntimeState>()?;
    let owner = state.lock_owner_recovered();
    owner
        .active_strips
        .iter()
        .chain(owner.held_strips.iter())
        .chain(owner.ended_run.iter())
        .find(|strip| &strip.plan == plan)
        .cloned()
}

fn blank_recorded<R: Runtime>(app: &AppHandle<R>, strip: &ActiveStrip) -> UsbOff {
    let bridge = app
        .state::<LightingRuntimeState>()
        .lock_owner_recovered()
        .output_bridge
        .clone();
    finish_blank(
        SolidUsbOutput::for_strip(&bridge, strip),
        strip.plan.clone(),
    )
}

fn blank_plan<R: Runtime>(
    app: &AppHandle<R>,
    plan: UsbOutputPlan,
    ended: &LightingModeConfig,
) -> UsbOff {
    let bridge = app
        .state::<LightingRuntimeState>()
        .lock_owner_recovered()
        .output_bridge
        .clone();
    finish_blank(SolidUsbOutput::for_mode(&bridge, plan.clone(), ended), plan)
}

fn finish_blank(output: SolidUsbOutput, plan: UsbOutputPlan) -> UsbOff {
    let black_frame = output.blank();
    match &black_frame {
        Ok(()) => info!(
            "[lighting-off] strip blanked — sink={plan:?} led_count={}",
            output.led_count
        ),
        Err(reason) => warn!("[lighting-off] black frame FAILED — sink={plan:?} reason={reason}"),
    }
    UsbOff {
        black_frame,
        wled: match plan {
            UsbOutputPlan::Wled(cfg) => Some(cfg),
            UsbOutputPlan::Serial(_) => None,
        },
    }
}

/// Test hook called wherever a mode is applied, after the runtime lock is
/// released, so tests can see which modes ran and in what order.
#[cfg(test)]
pub(crate) struct AppliedModeProbe(pub(crate) Box<dyn Fn(&LightingModeConfig) + Send + Sync>);

pub(super) fn note_applied_mode<R: Runtime>(app: &AppHandle<R>, mode: &LightingModeConfig) {
    #[cfg(test)]
    if let Some(probe) = app.try_state::<AppliedModeProbe>() {
        (probe.0)(mode);
    }
    #[cfg(not(test))]
    let _ = mode;
    // Every apply passes here with the runtime lock released, which is the
    // order the feed takes its locks in.
    crate::commands::preview::feed::refresh(app);
}

/// `Err` prefix when the blocking half of a mode command dies before answering.
const LIGHTING_TRANSITION_WORKER_FAILED: &str = "LIGHTING_TRANSITION_WORKER_FAILED";

/// Runs a mode command's blocking body off the main thread, one command at a
/// time and in arrival order. The body joins workers, opens capture and waits
/// out serial settles, which froze the UI for seconds as a sync command. The
/// queue replaces the ordering the main thread used to give for free: a fair
/// async mutex, because a std one wakes queued drag commits in any order and
/// the last value could lose. See docs/architecture/capture-and-pipeline.md.
pub(super) async fn run_mode_transition<R, T, F>(app: AppHandle<R>, body: F) -> Result<T, String>
where
    R: Runtime,
    T: Send + 'static,
    F: FnOnce(&AppHandle<R>) -> Result<T, String> + Send + 'static,
{
    let state = app.state::<LightingRuntimeState>();
    let _turn = state.transitions.lock().await;
    let worker_app = app.clone();
    tauri::async_runtime::spawn_blocking(move || body(&worker_app))
        .await
        .unwrap_or_else(|error| Err(format!("{LIGHTING_TRANSITION_WORKER_FAILED}: {error}")))
}
