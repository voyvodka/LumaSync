//! Backend safety nets for a request that arrives without what the user saved:
//! calibration, ambilight settings and output stamps, read from the persisted
//! shell state. Caller-wins throughout.

use log::info;
use tauri::{AppHandle, Runtime};

use super::config::{LightingModeConfig, LightingModeKind};
use crate::commands::shell_state::{self, PersistedShellState};

/// The persisted shell state, for the hydrators below. Resolution rules for
/// the calibration, applied in `set_lighting_mode` before `apply_mode_change`:
///
/// 1. If the incoming payload already carries a calibration with
///    `total_leds > 1`, keep it — caller-wins.
/// 2. Otherwise take the persisted `ledCalibration` — the user's saved setup,
///    which the frontend `savedCalibrationRef` should have stamped but
///    evidently does not on every code path.
/// 3. If both are absent, leave `None` so the existing legacy 1-LED
///    fallback inside `apply_mode_change` keeps the v1.3 firmware
///    compat path unchanged.
pub(super) fn read_persisted_shell_state<R: Runtime>(
    app: &AppHandle<R>,
) -> Option<PersistedShellState> {
    shell_state::persisted(app)
}

/// Every payload hydrator, run by both mode entry points (`set_lighting_mode`
/// and `apply_and_broadcast`). One function so neither can run a subset: when
/// `set_lighting_mode` skipped the output stamps, an unstamped LED-control-popup
/// click restarted a running SK6812 worker onto the WS2812B encoder. `load`
/// is the shell-state reader, injected so the chain is testable without an
/// `AppHandle`; it is only called when a field is actually missing.
pub(super) fn hydrate_mode_payload(
    payload: &mut LightingModeConfig,
    load: &dyn Fn() -> Option<PersistedShellState>,
) {
    maybe_hydrate_led_calibration(payload, load);
    maybe_hydrate_ambilight_settings(payload, load);
    maybe_hydrate_output_stamps(payload, load);
}

/// Apply backend-side calibration fallback to an incoming
/// `LightingModeConfig`. When the frontend payload is missing
/// `led_calibration` or carries a degenerate `total_leds <= 1`, we read
/// the persisted shell-state and inject the user's saved calibration so
/// the Solid + Ambilight encoders can size USB packets correctly.
///
/// This function is the **only** safety net for frontend payload drops
/// (a v1.5 hardware-repro bug where every Solid frame and every
/// ambilight worker iteration was emitting a 1-LED packet despite the
/// user having a 59-LED calibration on disk). Callers that already
/// own a fully-hydrated payload pay no observable cost — the function
/// short-circuits on the `total_leds > 1` check before touching disk.
pub(super) fn maybe_hydrate_led_calibration(
    payload: &mut LightingModeConfig,
    load: &dyn Fn() -> Option<PersistedShellState>,
) {
    let payload_total_leds = payload
        .led_calibration
        .as_ref()
        .map(|cal| cal.total_leds)
        .unwrap_or(0);

    if payload_total_leds > 1 {
        return;
    }

    if let Some(persisted) = load().and_then(|state| state.led_calibration()) {
        if persisted.total_leds > 1 {
            info!(
                "[set_lighting_mode] led_calibration fallback engaged — payload_total_leds={payload_total_leds} disk_total_leds={} (frontend payload missing or degenerate; using persisted shell-state)",
                persisted.total_leds
            );
            payload.led_calibration = Some(persisted);
            return;
        }
    }

    // No usable calibration anywhere. Log so the live diagnostic stream
    // makes the legacy 1-LED fallback path obvious in the terminal.
    if payload_total_leds <= 1 {
        info!(
            "[set_lighting_mode] led_calibration unavailable — payload_total_leds={payload_total_leds} disk_total_leds=0 (legacy 1-LED frame will be emitted)"
        );
    }
}

/// Apply backend-side ambilight-settings fallback to an incoming
/// `LightingModeConfig` (v1.5 H1 fix — bug H1). Triggers ONLY when
/// `kind == Ambilight` and the payload's `ambilight` field is entirely
/// absent — frontend is source of truth for present-but-default values
/// (a deliberate slider commit at saturation 1.0 must round-trip
/// untouched). This narrow trigger keeps the safety net from masking
/// frontend bugs that would otherwise be visible.
///
/// The frontend `withAmbilightSettings` hydrator already stamps the
/// persisted payload onto every dispatch via `savedAmbilightRef`; this
/// helper is the matching backend recovery path so a single missed
/// frontend stamp (e.g. a future code path that bypasses the hydrator
/// chain) doesn't strip the user's settings down to backend defaults.
fn maybe_hydrate_ambilight_settings(
    payload: &mut LightingModeConfig,
    load: &dyn Fn() -> Option<PersistedShellState>,
) {
    if payload.kind != LightingModeKind::Ambilight {
        return;
    }
    if payload.ambilight.is_some() {
        // Caller-wins: frontend is source of truth for any
        // present-but-default value. Do NOT compare to defaults here.
        return;
    }
    if let Some(persisted) = load().and_then(|state| state.ambilight()) {
        info!(
            "[set_lighting_mode] ambilight settings fallback engaged — payload.ambilight=None disk.ambilight=Some (frontend payload missing; using persisted shell-state)"
        );
        payload.ambilight = Some(persisted);
    }
}

/// Fill any output stamp the caller left unset from the persisted shell state
/// (caller-wins: a stamp already on the payload is never overwritten). The main
/// window stamps them (`withColorCorrectionAndFirmwareProfile`); the LED control
/// popup does not, and server-built configs have no payload to inherit from.
///
/// Without this a synthetic test drives an SK6812 RGBW strip through the
/// WS2812B encoder and an Adalight controller through the LumaSync v1 header,
/// and drops the user's colour correction entirely — so the test lights
/// nothing, or the wrong colours, on exactly the hardware it exists to verify.
fn maybe_hydrate_output_stamps(
    payload: &mut LightingModeConfig,
    load: &dyn Fn() -> Option<PersistedShellState>,
) {
    if payload.color_correction.is_some()
        && payload.firmware_profile.is_some()
        && payload.chip_type.is_some()
        && payload.color_order.is_some()
    {
        return;
    }
    let Some(state) = load() else {
        return;
    };
    if payload.color_correction.is_none() {
        payload.color_correction = state.color_correction();
    }
    if payload.firmware_profile.is_none() {
        payload.firmware_profile = state.firmware_profile();
    }
    if payload.chip_type.is_none() {
        payload.chip_type = state.chip_type();
    }
    if payload.color_order.is_none() {
        payload.color_order = state.color_order();
    }
    info!(
        "[preview] output stamps hydrated — correction={} profile={:?} chip={:?} order={:?}",
        payload.color_correction.is_some(),
        payload.firmware_profile,
        payload.chip_type,
        payload.color_order,
    );
}
