//! The Off/Solid/Ambilight transition and the mode commands that drive it:
//! `apply_mode_change` under the runtime lock, the turn queue the async
//! commands wait in, and the `lighting://mode-changed` broadcast.

use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};

use log::{info, warn};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Runtime, State};

use super::config::{
    frame_led_count_for, normalize_mode_config, wled_frame_advisory, LightingModeCommandResult,
    LightingModeConfig, LightingModeKind, SolidColorPayload,
};
use super::config_check;
use super::hydrate::{hydrate_mode_payload, read_persisted_shell_state};
use super::live::{retune_ambilight_live, AmbilightLiveSettings, RoomGeometryLive};
use super::pacing::{capture_interval_for, SerialSendBudget};
use super::preview::{build_edge_emitter, build_preview_emit_context, EdgeSignalEmitter};
use super::runtime::{AmbilightCaptureRequest, LightingRuntimeOwner, LightingRuntimeState};
use super::snapshot;
use super::usb_output::{SolidUsbOutput, UsbOutputPlan};
use super::worker::{start_ambilight_worker, WorkerPacing};
use super::SOLID_OUTPUT_ATTEMPTS;
use crate::commands::device_connection::{ActiveSinkRegistry, SerialConnectionState};
use crate::commands::hue::state_store::{
    apply_hue_color_with_context, HueOutputLive, HueRuntimeStateStore,
};
use crate::commands::led_output::apply_color_correction_rgb;
use crate::commands::led_preview::{emit_preview_state_changed, LedTwinState};
use crate::commands::runtime_telemetry::{
    RuntimeTelemetrySnapshot, RuntimeTelemetryState, SharedRuntimeTelemetry,
};
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

/// Records the newly active serial port, releasing the previous port's
/// cached session first if it differs. Same-port overwrites (a mode
/// restart on the port already in use) are left untouched — that is the
/// DTR invariant `stop_previous` also protects, see
/// docs/architecture/device-output.md (DTR reset). Only a genuine port
/// *switch* should release a handle, so an abandoned port can be opened by
/// another app (e.g. the Arduino IDE) instead of staying locked until
/// LumaSync quits.
pub(super) fn set_active_port(owner: &mut LightingRuntimeOwner, new_port: String) {
    if owner.active_port.as_deref() != Some(new_port.as_str()) {
        if let Some(old_port) = owner.active_port.take() {
            owner.output_bridge.disconnect_session(&old_port);
        }
    }
    owner.active_port = Some(new_port);
}

pub(super) fn stop_previous(
    owner: &mut LightingRuntimeOwner,
    trace: &mut Option<&mut Vec<&'static str>>,
) {
    push_trace(trace, "stop_previous");
    let t0 = std::time::Instant::now();
    owner.ambilight_live = None;
    owner.room_geometry_live = None;
    let had_worker = owner.worker.is_some();
    if let Some(worker) = owner.worker.take() {
        worker.stop();
    }
    // Do NOT close the cached serial port handle here — reopening the port
    // toggles DTR and resets the MCU before the packet lands. See
    // docs/architecture/device-output.md (DTR reset).
    // `active_port` is deliberately kept: it is the only record of which port
    // holds a cached session, and `set_active_port` needs it after this stop
    // to release that port when the next mode switches to a different one.
    let total_ms = t0.elapsed().as_millis();
    info!(
        "[stop_previous] completed in {total_ms}ms had_worker={had_worker} last_port={:?} (cached serial session preserved to avoid DTR-reset cycle)",
        owner.active_port
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
    edge_signal_emitter: Option<EdgeSignalEmitter>,
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
        edge_signal_emitter,
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
    // Snapshot of `ActiveSinkRegistry::active_wled_config()`. `Some` means a
    // WLED device is the most recently connected "usb"-channel sink and
    // takes priority over `connected_port` for this mode change.
    wled_sink: Option<WledSinkConfig>,
    hue_output: Option<Arc<HueOutputLive>>,
    telemetry_snapshot: Option<SharedRuntimeTelemetry>,
    edge_signal_emitter: Option<EdgeSignalEmitter>,
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
        "[apply_mode_change] kind={:?} led_calibration_total_leds={} targets={:?}",
        normalized_next.kind,
        normalized_next
            .led_calibration
            .as_ref()
            .map(|c| c.total_leds as i32)
            .unwrap_or(-1),
        normalized_next.targets,
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
    // v1.6 LED Preview — a synthetic test request bypasses the device/Hue
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
    if normalized_next.kind == LightingModeKind::Ambilight
        && owner.active_mode.kind == LightingModeKind::Ambilight
        && owner.worker.is_some()
        && normalized_next.targets == owner.active_mode.targets
        && normalized_next.display_id == owner.active_mode.display_id
        && normalized_next.led_calibration == owner.active_mode.led_calibration
        && normalized_next.color_correction == owner.active_mode.color_correction
        && normalized_next.firmware_profile == owner.active_mode.firmware_profile
        && normalized_next.chip_type == owner.active_mode.chip_type
        && preview_retune
    {
        if let Some(live) = &owner.ambilight_live {
            let cfg = normalized_next
                .ambilight
                .as_ref()
                .cloned()
                .unwrap_or_default();
            retune_ambilight_live(live, &cfg);
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
            return make_result(
                owner.active_mode.clone(),
                command_status(
                    "AMBILIGHT_MODE_UPDATED",
                    "Ambilight settings updated in running worker.",
                    None,
                ),
            );
        }
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
            let payload = normalized_next.solid.clone().unwrap_or(SolidColorPayload {
                r: 255,
                g: 255,
                b: 255,
                brightness: 1.0,
            });

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

                if let UsbOutputPlan::Serial(port_name) = &plan {
                    set_active_port(owner, port_name.clone());
                }
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
        LightingModeKind::Ambilight => {
            push_trace(&mut trace, "start_ambilight");

            // v1.6 LED Preview — consume any pending synthetic-test request.
            let test_pattern = owner.preview.pending_test_pattern.take();

            let ambilight_cfg = normalized_next
                .ambilight
                .as_ref()
                .cloned()
                .unwrap_or_default();
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

            let strip_plan = usb_plan.as_ref().filter(|_| needs_usb);
            let strip_budget_ms = match strip_plan {
                Some(UsbOutputPlan::Serial(_)) => Some(
                    SerialSendBudget::for_strip(
                        frame_led_count_for(&normalized_next),
                        normalized_next.firmware_profile.unwrap_or_default(),
                        normalized_next.chip_type.unwrap_or_default(),
                    )
                    .wire_ms,
                ),
                _ => None,
            };
            let capture_interval = capture_interval_for(strip_plan, strip_budget_ms);
            let frame_source = {
                let req = AmbilightCaptureRequest {
                    display_id: normalized_next.display_id.clone(),
                    led_calibration: normalized_next.led_calibration.clone(),
                    test_pattern: test_pattern.clone(),
                    pattern_phase: Some(Arc::clone(&owner.preview.pattern_phase)),
                    pattern_live: pattern_live.clone(),
                    frame_interval: capture_interval,
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
                            command_status(
                                "AMBILIGHT_MODE_START_FAILED",
                                "Ambilight runtime could not start.",
                                Some(reason.as_reason()),
                            ),
                        );
                    }
                }
            };

            // Resolve the sink for the worker: only pass one if USB is a required target
            let usb_plan_for_worker: Option<UsbOutputPlan> = if needs_usb {
                match usb_plan.clone() {
                    Some(plan) => Some(plan),
                    // v1.6 LED Preview: a synthetic test runs preview-only (no
                    // USB sink) when no device is connected — no gate.
                    None if is_test => None,
                    None => {
                        owner.active_mode = LightingModeConfig::default();
                        return make_result(
                            owner.active_mode.clone(),
                            command_status(
                                "AMBILIGHT_MODE_START_FAILED",
                                "Ambilight runtime could not start.",
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
            let preview_ctx = build_preview_emit_context(
                is_test,
                test_pattern.as_ref(),
                owner.preview.preview_gate.clone(),
                normalized_next.display_id.clone(),
            );
            let room_geometry_live = RoomGeometryLive::new(normalized_next.room_geometry.clone());

            match start_ambilight_worker(
                owner.output_bridge.clone(),
                usb_plan_for_worker,
                normalized_next.led_calibration.clone(),
                Arc::clone(&live_settings),
                frame_source,
                telemetry_snapshot
                    .unwrap_or_else(|| Arc::new(Mutex::new(RuntimeTelemetrySnapshot::default()))),
                hue_output,
                edge_signal_emitter,
                corrections,
                profile,
                chip,
                preview_ctx,
                Arc::clone(&room_geometry_live),
                WorkerPacing::live(capture_interval),
            ) {
                Ok(worker) => {
                    owner.worker = Some(worker);
                    owner.ambilight_live = Some(live_settings);
                    owner.room_geometry_live = Some(room_geometry_live);
                    owner.active_mode = normalized_next;
                    owner.preview.active_test_pattern = test_pattern;
                    owner.preview.pattern_live = pattern_live;
                    if let Some(p) = serial_port {
                        set_active_port(owner, p.to_string());
                    }
                    make_result(
                        owner.active_mode.clone(),
                        command_status(
                            "AMBILIGHT_MODE_STARTED",
                            "Ambilight runtime started with frame output pipeline.",
                            None,
                        ),
                    )
                }
                Err(reason) => {
                    owner.active_mode = LightingModeConfig::default();
                    make_result(
                        owner.active_mode.clone(),
                        command_status(
                            "AMBILIGHT_MODE_START_FAILED",
                            "Ambilight runtime could not start.",
                            Some(reason),
                        ),
                    )
                }
            }
        }
    }
}

/// Apply a full `LightingModeConfig` from the frontend: hydrates missing
/// calibration, ambilight settings and output stamps (colour correction,
/// firmware profile, chip type) from persisted shell-state, then starts,
/// reconfigures, or stops the worker to match the requested mode. Broadcasts
/// `LIGHTING_MODE_CHANGED_EVENT` and the preview snapshot on every call.
#[tauri::command]
pub async fn set_lighting_mode<R: Runtime>(
    app: AppHandle<R>,
    payload: LightingModeConfig,
) -> Result<LightingModeCommandResult, String> {
    run_mode_transition(app, move |app| set_lighting_mode_blocking(app, payload)).await
}

pub(super) fn set_lighting_mode_blocking<R: Runtime>(
    app: &AppHandle<R>,
    payload: LightingModeConfig,
) -> Result<LightingModeCommandResult, String> {
    app.state::<LightingRuntimeState>().tuning.close_blocking();
    let hue_output = app.state::<HueRuntimeStateStore>().output_live();
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
    let connection_state = app.state::<SerialConnectionState>();
    let sink_registry = app.state::<ActiveSinkRegistry>();
    let telemetry_state = app.state::<RuntimeTelemetryState>();
    let led_twin_state = app.state::<LedTwinState>();
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
    hydrate_mode_payload(&mut payload, &|| read_persisted_shell_state(app));

    let connection_snapshot = connection_state
        .last_status
        .lock()
        .map(|status| status.clone())
        .map_err(|error| format!("LIGHTING_CONNECTION_STATE_LOCK_FAILED: {error}"))?;

    let lock_t = std::time::Instant::now();
    let mut owner = runtime_state
        .runtime
        .lock()
        .map_err(|error| format!("LIGHTING_RUNTIME_STATE_LOCK_FAILED: {error}"))?;
    let lock_ms = lock_t.elapsed().as_millis();
    if lock_ms > 10 {
        info!("[set_lighting_mode] runtime lock waited {lock_ms}ms");
    }

    let hue_output = Some(hue_output);

    // v1.6 LED Preview — clear any stale synthetic-test request, wire the
    // shared gate so a twin opened mid-run starts receiving without a worker
    // restart, and send the edge-signal to every active twin overlay.
    owner.preview.pending_test_pattern = None;
    owner.preview.preview_gate = Some(led_twin_state.preview_active());
    // v1.6 LED Preview — record whether a synthetic test was running
    // BEFORE apply_mode_change clears it, so a live mode change that
    // supersedes the test can drop the captured prior mode below.
    let superseded_test = owner.preview.active_test_pattern.is_some();
    let edge_emitter = Some(build_edge_emitter(app));
    let wled_sink = sink_registry.active_wled_config();

    owner.hue_gate_waived = waive_hue_gate;
    let result = apply_mode_change(
        &mut owner,
        payload,
        connection_snapshot.connected,
        connection_snapshot.port_name.as_deref(),
        wled_sink,
        hue_output,
        Some(telemetry_state.shared_snapshot()),
        edge_emitter,
        None,
    );
    owner.hue_gate_waived = false;
    // Release the runtime lock before broadcasting so a re-entrant
    // mode-change listener cannot deadlock on it.
    drop(owner);
    let _ = app.emit(
        LIGHTING_MODE_CHANGED_EVENT,
        LightingModeChangedPayload {
            config: result.mode.clone(),
            active: result.active,
        },
    );
    // v1.6 LED Preview — a live mode change supersedes any active synthetic
    // test (apply_mode_change just cleared it). Drop the captured prior mode
    // so a late/racing Stop cannot revive the pre-test mode over the user's
    // new selection.
    if superseded_test {
        let _ = led_twin_state.take_prior_mode();
    }
    // The control popup + twin overlays derive `testActive` / `source`
    // SOLELY from preview://state-changed, so broadcast the refreshed
    // preview snapshot on every mode change — not just on test start/stop.
    emit_preview_state_changed(app);
    info!(
        "[set_lighting_mode] completed in {}ms",
        t_cmd.elapsed().as_millis()
    );
    Ok(result)
}

/// Force the lighting mode to `Off`, stopping any running worker.
#[tauri::command]
pub async fn stop_lighting<R: Runtime>(
    app: AppHandle<R>,
) -> Result<LightingModeCommandResult, String> {
    run_mode_transition(app, |app| stop_lighting_blocking(app)).await
}

/// Body of `stop_lighting`. Also used on the app shutdown path, so it resolves
/// `LedTwinState` best-effort via the `AppHandle` rather than requiring it as a
/// managed-state argument. The shutdown path calls it directly, outside the
/// transition queue: quit must never wait behind a queued mode change, and
/// the runtime lock still serialises it against the one in flight.
pub fn stop_lighting_blocking<R: Runtime>(
    app: &AppHandle<R>,
) -> Result<LightingModeCommandResult, String> {
    let runtime_state = app.state::<LightingRuntimeState>();
    runtime_state.tuning.close_blocking();
    let (result, superseded_test) = {
        let mut owner = runtime_state
            .runtime
            .lock()
            .map_err(|error| format!("LIGHTING_RUNTIME_STATE_LOCK_FAILED: {error}"))?;
        // v1.6 LED Preview — capture whether a synthetic test was running
        // BEFORE apply_mode_change clears it.
        let superseded_test = owner.preview.active_test_pattern.is_some();
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
        (result, superseded_test)
    };
    let _ = app.emit(
        LIGHTING_MODE_CHANGED_EVENT,
        LightingModeChangedPayload {
            config: result.mode.clone(),
            active: result.active,
        },
    );
    snapshot::publish_running(app, &result.mode);
    // v1.6 LED Preview — stopping all lighting supersedes any active test;
    // drop the captured prior mode so a late Stop cannot revive it. This
    // command is also called from the shutdown path, so resolve the twin
    // state best-effort via the AppHandle rather than a State<'_, _> arg.
    if superseded_test {
        if let Some(twin_state) = app.try_state::<LedTwinState>() {
            let _ = twin_state.take_prior_mode();
        }
    }
    // Keep the control popup + twin overlays in sync — they derive
    // `testActive` / `source` solely from preview://state-changed.
    emit_preview_state_changed(app);
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
    let wled = app
        .try_state::<ActiveSinkRegistry>()
        .and_then(|registry| registry.active_wled_config());
    let serial_port = app.try_state::<SerialConnectionState>().and_then(|state| {
        let status = state.last_status.lock().ok()?;
        status.port_name.clone().filter(|_| status.connected)
    });
    // The precedence `apply_mode_change` plans the channel with.
    let plan = match (wled, serial_port) {
        (Some(cfg), _) => UsbOutputPlan::Wled(cfg),
        (None, Some(port)) => UsbOutputPlan::Serial(port),
        (None, None) => return None,
    };
    let bridge = app
        .state::<LightingRuntimeState>()
        .runtime
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .output_bridge
        .clone();
    let output = SolidUsbOutput::for_mode(&bridge, plan.clone(), ended);
    let black_frame = output.blank();
    match &black_frame {
        Ok(()) => info!(
            "[lighting-off] strip blanked — sink={plan:?} led_count={}",
            output.led_count
        ),
        Err(reason) => warn!("[lighting-off] black frame FAILED — sink={plan:?} reason={reason}"),
    }
    Some(UsbOff {
        black_frame,
        wled: match plan {
            UsbOutputPlan::Wled(cfg) => Some(cfg),
            UsbOutputPlan::Serial(_) => None,
        },
    })
}

/// Read-only snapshot of the current lighting mode, for the frontend to
/// reconcile against on load without triggering a mode change.
///
/// Sync, so it runs on the main thread: it reads the published snapshot and
/// never the runtime lock, which a transition holds for seconds.
#[tauri::command]
pub fn get_lighting_mode_status(
    runtime_state: State<'_, LightingRuntimeState>,
) -> Result<LightingModeCommandResult, String> {
    Ok(make_result(
        runtime_state.snapshot.read().mode,
        command_status(
            "LIGHTING_MODE_STATUS_OK",
            "Lighting mode status read successfully.",
            None,
        ),
    ))
}

/// `LIGHTING_EVENTS.MODE_CHANGED` in `src/shared/contracts/mode.ts`. Broadcast
/// app-wide whenever the active lighting mode changes, so preview surfaces
/// (and any window other than the issuer) reconcile. Defined in
/// `crate::events`; re-exported here since this is the emit site.
pub use crate::events::LIGHTING_MODE_CHANGED_EVENT;

/// Payload for `LIGHTING_MODE_CHANGED_EVENT` — the new mode and whether it
/// is active, broadcast to every window (not just the command's caller).
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LightingModeChangedPayload {
    pub config: LightingModeConfig,
    pub active: bool,
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
