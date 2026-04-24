import type { HueIntensityPreset, HueRuntimeTarget } from "../../../shared/contracts/hue";
import type { LightingSmoothingPreset } from "../../../shared/contracts/lighting";
import type { DisplayId } from "../../../shared/contracts/display";
import {
  DEFAULT_COLOR_CORRECTION,
  FIRMWARE_PROFILE,
  GAMMA_RANGE,
  KELVIN_RANGE_K,
  SATURATION_RANGE,
  type ColorCorrectionConfig,
  type FirmwareProfile,
} from "../../../shared/contracts/device";

export const LIGHTING_MODE_KIND = {
  OFF: "off",
  AMBILIGHT: "ambilight",
  SOLID: "solid",
} as const;

/** Tauri event channel name for live edge-signal previews emitted by the ambilight worker. */
export const EDGE_SIGNAL_EVENT = "ambilight://edge-signal";

/**
 * Number of RGB samples the Rust worker emits per edge in every `EdgeSignalPayload`.
 * Mirrors the `EDGE_SIGNAL_SAMPLES_PER_EDGE` constant in `lighting_mode.rs` and lets
 * consumers validate the invariant (`payload.top.length === EDGE_SIGNAL_SAMPLES_PER_EDGE`).
 */
export const EDGE_SIGNAL_SAMPLES_PER_EDGE = 16;

/** Live edge-preview payload emitted by the Rust ambilight worker.
 * Each edge array contains `EDGE_SIGNAL_SAMPLES_PER_EDGE` RGB triplets. */
export interface EdgeSignalPayload {
  top: Array<[number, number, number]>;
  bottom: Array<[number, number, number]>;
  left: Array<[number, number, number]>;
  right: Array<[number, number, number]>;
}

export type LightingModeKind = (typeof LIGHTING_MODE_KIND)[keyof typeof LIGHTING_MODE_KIND];

export interface SolidColorPayload {
  r: number;
  g: number;
  b: number;
  brightness: number;
}

export interface AmbilightPayload {
  brightness: number;
  blackBorderDetection?: boolean;
  /**
   * @deprecated Use `lightingSmoothingPreset`. Kept so pre-v1.4 persisted
   * payloads keep deserialising. The Rust worker reads this only as a
   * fallback when `lightingSmoothingPreset` is absent.
   * Range [0.05, 1.0]. 1.0 = instant; lower = smoother. Default 0.35.
   */
  smoothingAlpha?: number;
  /** Luminance-preserving saturation factor. Range [0.5, 2.0]. 1.0 = identity. Default 1.0. */
  saturation?: number;
  /**
   * Unified smoothing preset (v1.4). Drives the EWMA coefficient for
   * both the USB strip and the Hue branch of the ambilight pump in a
   * single user-facing control. Takes priority over the deprecated
   * `smoothingAlpha` slider and `hueIntensityPreset` on the Rust side.
   */
  lightingSmoothingPreset?: LightingSmoothingPreset;
  /**
   * @deprecated Use `lightingSmoothingPreset`. Kept so pre-v1.4 persisted
   * payloads keep deserialising on the Rust side. Will be removed in
   * v1.5 once the backend compat shim is retired.
   */
  hueIntensityPreset?: HueIntensityPreset;
}

export interface LightingModeConfig {
  kind: LightingModeKind;
  solid?: SolidColorPayload;
  ambilight?: AmbilightPayload;
  targets?: HueRuntimeTarget[];
  /**
   * Display the ambilight worker should sample from (v1.4 Platform GAP 2).
   * Absent ⇒ backend falls back to the OS primary display so existing
   * single-monitor behaviour is unchanged. Matched platform-side against the
   * stable `DisplayInfo.id` form returned by `list_displays`; a missing or
   * unplugged display id reverts to primary instead of failing the command.
   */
  displayId?: DisplayId;
  /**
   * Per-channel color correction (v1.4 G4). Absent ⇒ backend uses
   * ColorCorrectionConfig defaults (gamma 2.2 / 6500 K / saturation 1.0).
   * Applied to USB output only — Hue sink is not affected.
   */
  colorCorrection?: ColorCorrectionConfig;
  /**
   * Firmware encoding profile (v1.4 G11). Absent ⇒ backend defaults to
   * LumaSyncV1. User-visible setting only — never switched silently.
   */
  firmwareProfile?: FirmwareProfile;
}

export function isLightingModeKind(value: unknown): value is LightingModeKind {
  return value === LIGHTING_MODE_KIND.OFF
    || value === LIGHTING_MODE_KIND.AMBILIGHT
    || value === LIGHTING_MODE_KIND.SOLID;
}

function toFiniteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  return Math.max(min, Math.min(max, Math.floor(toFiniteNumber(value, fallback))));
}

function clampFloat(value: unknown, min: number, max: number, fallback: number): number {
  return Math.max(min, Math.min(max, toFiniteNumber(value, fallback)));
}

export function normalizeSolidColorPayload(input?: Partial<SolidColorPayload>): SolidColorPayload {
  return {
    r: clampInt(input?.r, 0, 255, 255),
    g: clampInt(input?.g, 0, 255, 255),
    b: clampInt(input?.b, 0, 255, 255),
    brightness: clampFloat(input?.brightness, 0, 1, 1),
  };
}

function normalizeLightingSmoothingPreset(
  value: unknown,
): LightingSmoothingPreset | undefined {
  return value === "subtle" || value === "moderate" || value === "intense"
    ? value
    : undefined;
}

export function normalizeAmbilightPayload(input?: Partial<AmbilightPayload>): AmbilightPayload {
  // Resolve the preset from either the new or the deprecated field so
  // legacy persisted payloads continue to survive normalization without
  // losing the user's selection.
  const preset =
    normalizeLightingSmoothingPreset(input?.lightingSmoothingPreset) ??
    normalizeLightingSmoothingPreset(input?.hueIntensityPreset);
  return {
    brightness: clampFloat(input?.brightness, 0, 1, 1),
    blackBorderDetection: input?.blackBorderDetection ?? false,
    smoothingAlpha: clampFloat(input?.smoothingAlpha, 0.05, 1, 0.35),
    saturation: clampFloat(input?.saturation, 0.5, 2, 1),
    lightingSmoothingPreset: preset,
  };
}

function normalizeDisplayId(value: unknown): DisplayId | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeColorCorrection(
  value: unknown,
): ColorCorrectionConfig | undefined {
  if (!value || typeof value !== "object") return undefined;
  const input = value as Partial<ColorCorrectionConfig>;
  return {
    gammaR: clampFloat(input.gammaR, GAMMA_RANGE.min, GAMMA_RANGE.max, DEFAULT_COLOR_CORRECTION.gammaR),
    gammaG: clampFloat(input.gammaG, GAMMA_RANGE.min, GAMMA_RANGE.max, DEFAULT_COLOR_CORRECTION.gammaG),
    gammaB: clampFloat(input.gammaB, GAMMA_RANGE.min, GAMMA_RANGE.max, DEFAULT_COLOR_CORRECTION.gammaB),
    kelvin: clampInt(input.kelvin, KELVIN_RANGE_K.min, KELVIN_RANGE_K.max, DEFAULT_COLOR_CORRECTION.kelvin),
    saturation: clampFloat(input.saturation, SATURATION_RANGE.min, SATURATION_RANGE.max, DEFAULT_COLOR_CORRECTION.saturation),
  };
}

function normalizeFirmwareProfile(value: unknown): FirmwareProfile | undefined {
  return value === FIRMWARE_PROFILE.LUMASYNC_V1 || value === FIRMWARE_PROFILE.ADALIGHT
    ? value
    : undefined;
}

export function normalizeLightingModeConfig(input?: Partial<LightingModeConfig>): LightingModeConfig {
  const kind = isLightingModeKind(input?.kind) ? input.kind : LIGHTING_MODE_KIND.OFF;
  const normalizedSolid = input?.solid ? normalizeSolidColorPayload(input.solid) : undefined;
  const normalizedAmbilight = input?.ambilight ? normalizeAmbilightPayload(input.ambilight) : undefined;
  const normalizedDisplayId = normalizeDisplayId(input?.displayId);
  const normalizedColorCorrection = normalizeColorCorrection(input?.colorCorrection);
  const normalizedFirmwareProfile = normalizeFirmwareProfile(input?.firmwareProfile);

  if (kind === LIGHTING_MODE_KIND.SOLID) {
    return {
      kind,
      solid: normalizedSolid ?? normalizeSolidColorPayload(),
      ambilight: normalizedAmbilight,
      targets: input?.targets,
      displayId: normalizedDisplayId,
      colorCorrection: normalizedColorCorrection,
      firmwareProfile: normalizedFirmwareProfile,
    };
  }

  if (kind === LIGHTING_MODE_KIND.AMBILIGHT) {
    return {
      kind,
      ambilight: normalizedAmbilight ?? normalizeAmbilightPayload(),
      solid: normalizedSolid,
      targets: input?.targets,
      displayId: normalizedDisplayId,
      colorCorrection: normalizedColorCorrection,
      firmwareProfile: normalizedFirmwareProfile,
    };
  }

  return {
    kind: LIGHTING_MODE_KIND.OFF,
    solid: normalizedSolid,
    ambilight: normalizedAmbilight,
    targets: input?.targets,
    displayId: normalizedDisplayId,
    colorCorrection: normalizedColorCorrection,
    firmwareProfile: normalizedFirmwareProfile,
  };
}

export function resolveDefaultTargets(targets?: HueRuntimeTarget[]): HueRuntimeTarget[] {
  return targets && targets.length > 0 ? targets : ["usb"];
}
