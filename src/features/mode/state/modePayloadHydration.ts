/**
 * Pure hydration layer for outgoing `set_lighting_mode` payloads.
 *
 * Every field here is cached in a ref by `useModeRuntimeConfig` so the drag
 * path never pays a synchronous `shellStore` round-trip. Taking the cache as
 * an explicit snapshot keeps these functions pure and unit-testable.
 */

import type { LedCalibrationConfig } from "@/features/calibration/model/contracts";
import type { ColorCorrectionConfig, FirmwareProfile, LedChipType } from "@/shared/contracts/device";
import type { HueIntensityPreset } from "@/shared/contracts/hue";

import {
  LIGHTING_MODE_KIND,
  type AmbilightPayload,
  type LightingModeConfig,
} from "../model/contracts";

/** The runtime-config cache, read once per dispatch. */
export interface ModeRuntimeConfigSnapshot {
  selectedDisplayId: string | undefined;
  lightingSmoothingPreset: HueIntensityPreset;
  colorCorrection: ColorCorrectionConfig | undefined;
  firmwareProfile: FirmwareProfile | undefined;
  chipType: LedChipType | undefined;
  savedCalibration: LedCalibrationConfig | undefined;
  savedAmbilight: AmbilightPayload | undefined;
}

/**
 * Inject the persisted capture-source display id into an outgoing
 * LightingModeConfig payload (v1.4 Platform GAP 2). The ambilight
 * worker uses this id to bind its SCStream / windows-capture session
 * to the selected monitor; an absent or unknown id falls back to the
 * OS primary on the backend, so we only stamp the field when it is
 * actually set.
 */
export function withSelectedDisplayId(
  mode: LightingModeConfig,
  snapshot: ModeRuntimeConfigSnapshot,
): LightingModeConfig {
  const id = snapshot.selectedDisplayId;
  if (!id || id.length === 0) return mode;
  return { ...mode, displayId: id };
}

/**
 * Stamp the unified lighting smoothing preset onto the ambilight payload
 * of an outgoing LightingModeConfig (v1.4 unification). Only ambilight
 * runs use the preset — solid / off payloads pass through untouched. The
 * preset is a property of `AmbilightPayload` today so this helper mirrors
 * the shape the Rust `set_lighting_mode` handler expects; it drives both
 * the USB and the Hue EWMA coefficients on the worker.
 */
export function withAmbilightLightingSmoothingPreset(
  mode: LightingModeConfig,
  snapshot: ModeRuntimeConfigSnapshot,
): LightingModeConfig {
  if (mode.kind !== LIGHTING_MODE_KIND.AMBILIGHT) return mode;
  const preset = snapshot.lightingSmoothingPreset;
  const base: AmbilightPayload = mode.ambilight ?? { brightness: 1 };
  const nextAmbilight: AmbilightPayload = {
    ...base,
    lightingSmoothingPreset: preset,
  };
  return { ...mode, ambilight: nextAmbilight };
}

/**
 * Stamp color correction and firmware profile onto any outgoing
 * LightingModeConfig. Both fields are top-level (not nested inside ambilight)
 * so they apply to all modes (ambilight, solid, off). Absent refs leave the
 * fields undefined — the Rust backend applies its own defaults via
 * #[serde(default)] so no runtime error occurs.
 */
export function withColorCorrectionAndFirmwareProfile(
  mode: LightingModeConfig,
  snapshot: ModeRuntimeConfigSnapshot,
): LightingModeConfig {
  return {
    ...mode,
    colorCorrection: snapshot.colorCorrection,
    firmwareProfile: snapshot.firmwareProfile,
    chipType: snapshot.chipType,
  };
}

/**
 * Stamp the persisted ambilight settings onto an outgoing
 * LightingModeConfig payload (v1.5 H1 fix — bug H1).
 *
 * The bootstrap path dispatches the correctly-restored payload, but
 * subsequent same-tick effects (color-correction / firmware-profile
 * / Hue-intensity hot-reload, USB hot-plug delta-start) read
 * `lightingMode` from a stale React closure. Without a ref-backed
 * hydrator those re-dispatches strip the user's persisted
 * saturation / blackBorderDetection / smoothing-preset values.
 *
 * Behaviour:
 *  - Only fires when `mode.kind === AMBILIGHT` (off / solid pass
 *    through untouched — those modes don't carry ambilight).
 *  - Caller-wins: if the caller already supplied an explicit
 *    non-default ambilight payload (e.g. an in-flight slider commit
 *    from `LightsSection`), we keep it.
 *  - Stamps from the snapshot's persisted ambilight only when the caller
 *    payload is undefined or matches the fresh-default shape
 *    (saturation 1.0, blackBorderDetection false, smoothing absent).
 *  - Brightness is treated as a real value: a freshly-defaulted
 *    `{ brightness: 1 }` payload is still considered "fresh"
 *    because every other knob is at default.
 */
export function withAmbilightSettings(
  mode: LightingModeConfig,
  snapshot: ModeRuntimeConfigSnapshot,
): LightingModeConfig {
  if (mode.kind !== LIGHTING_MODE_KIND.AMBILIGHT) return mode;
  const persisted = snapshot.savedAmbilight;
  if (!persisted) return mode;
  const incoming = mode.ambilight;
  // Caller-wins: anything that looks like an explicit user
  // commit (non-default saturation / blackBorderDetection /
  // smoothing preset) is kept. We only stamp when the caller's
  // payload is absent or carries a fresh-default shape.
  const isFreshDefault =
    !incoming ||
    ((incoming.saturation === undefined || incoming.saturation === 1) &&
      (incoming.blackBorderDetection === undefined ||
        incoming.blackBorderDetection === false) &&
      incoming.lightingSmoothingPreset === undefined &&
      (incoming.smoothingAlpha === undefined || incoming.smoothingAlpha === 0.35));
  if (!isFreshDefault) return mode;
  // Stamp persisted values, but preserve any explicit brightness
  // the caller supplied — brightness is a top-level slider that
  // can legitimately be 1.0 in the persisted state too.
  const merged: AmbilightPayload = {
    ...persisted,
    brightness:
      incoming?.brightness !== undefined ? incoming.brightness : persisted.brightness,
  };
  return { ...mode, ambilight: merged };
}

/**
 * Stamp the persisted LED calibration onto an outgoing
 * LightingModeConfig payload. The Rust backend uses
 * `ledCalibration.totalLeds` to size every emitted USB frame for both
 * Solid and Ambilight modes; without this stamp the backend falls
 * back to a 1-LED slice and only LED #0 reflects strip output.
 *
 * Behaviour:
 *  - If the caller already provided `ledCalibration` on the incoming
 *    mode, we keep that explicit value (caller-wins so test patterns
 *    or future overrides are not clobbered).
 *  - Otherwise we stamp the snapshot's calibration if present.
 *  - When the user has never run calibration it is `undefined`,
 *    so the field stays absent and the backend keeps its existing
 *    legacy 1-LED fallback (no regression).
 */
export function withLedCalibration(
  mode: LightingModeConfig,
  snapshot: ModeRuntimeConfigSnapshot,
): LightingModeConfig {
  if (mode.ledCalibration) return mode;
  const calibration = snapshot.savedCalibration;
  if (!calibration) return mode;
  return { ...mode, ledCalibration: calibration };
}

/**
 * Compose display id + Hue intensity preset + color correction + firmware profile
 * + LED calibration in a single helper so every call site stays short. Ordering
 * is load-bearing: `withAmbilightSettings` and
 * `withAmbilightLightingSmoothingPreset` both write `mode.ambilight`, so the
 * settings stamp must run first or the preset is overwritten.
 */
export function hydrateModePayload(
  mode: LightingModeConfig,
  snapshot: ModeRuntimeConfigSnapshot,
): LightingModeConfig {
  return withColorCorrectionAndFirmwareProfile(
    withAmbilightLightingSmoothingPreset(
      withLedCalibration(
        withAmbilightSettings(withSelectedDisplayId(mode, snapshot), snapshot),
        snapshot,
      ),
      snapshot,
    ),
    snapshot,
  );
}

/**
 * Stable, key-sorted JSON serialisation of a `LightingModeConfig`. The
 * earlier `JSON.stringify(hydrated)` signature was *content* equal across
 * identical re-fires but *string* unequal whenever the spread chain in
 * `hydrateModePayload` produced a different key insertion order — typical
 * for hot-reload paths that re-stamp `colorCorrection` / `firmwareProfile`
 * after the ambilight worker is already live. Two payloads with the same
 * semantic content but a different key order therefore slipped past the
 * idempotent dedup, reached the Rust handler, and any field whose Rust-side
 * `==` check failed (targets, displayId, led_calibration, color_correction,
 * firmware_profile — see `apply_mode_change` fast-path gate) caused a full
 * worker tear-down + restart instead of an in-place atomic update.
 *
 * Replacing the signature with a canonical, recursively key-sorted form
 * makes the dedup ref behave like deep-equality without paying for a deep
 * compare on every dispatch.
 */
export function canonicalLightingModeSignature(value: unknown): string {
  return JSON.stringify(value, (_key, val) => {
    if (val && typeof val === "object" && !Array.isArray(val)) {
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(val).sort()) {
        const v = (val as Record<string, unknown>)[k];
        if (v !== undefined) sorted[k] = v;
      }
      return sorted;
    }
    return val;
  });
}
