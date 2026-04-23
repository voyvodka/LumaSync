import type { HueRuntimeTarget } from "../../../shared/contracts/hue";
import type { DisplayId } from "../../../shared/contracts/display";

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
  /** EWMA alpha for color smoothing. Range [0.05, 1.0]. 1.0 = instant; lower = smoother. Default 0.35. */
  smoothingAlpha?: number;
  /** Luminance-preserving saturation factor. Range [0.5, 2.0]. 1.0 = identity. Default 1.0. */
  saturation?: number;
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

export function normalizeAmbilightPayload(input?: Partial<AmbilightPayload>): AmbilightPayload {
  return {
    brightness: clampFloat(input?.brightness, 0, 1, 1),
    blackBorderDetection: input?.blackBorderDetection ?? false,
    smoothingAlpha: clampFloat(input?.smoothingAlpha, 0.05, 1, 0.35),
    saturation: clampFloat(input?.saturation, 0.5, 2, 1),
  };
}

function normalizeDisplayId(value: unknown): DisplayId | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function normalizeLightingModeConfig(input?: Partial<LightingModeConfig>): LightingModeConfig {
  const kind = isLightingModeKind(input?.kind) ? input.kind : LIGHTING_MODE_KIND.OFF;
  const normalizedSolid = input?.solid ? normalizeSolidColorPayload(input.solid) : undefined;
  const normalizedAmbilight = input?.ambilight ? normalizeAmbilightPayload(input.ambilight) : undefined;
  const normalizedDisplayId = normalizeDisplayId(input?.displayId);

  if (kind === LIGHTING_MODE_KIND.SOLID) {
    return {
      kind,
      solid: normalizedSolid ?? normalizeSolidColorPayload(),
      ambilight: normalizedAmbilight,
      targets: input?.targets,
      displayId: normalizedDisplayId,
    };
  }

  if (kind === LIGHTING_MODE_KIND.AMBILIGHT) {
    return {
      kind,
      ambilight: normalizedAmbilight ?? normalizeAmbilightPayload(),
      solid: normalizedSolid,
      targets: input?.targets,
      displayId: normalizedDisplayId,
    };
  }

  return {
    kind: LIGHTING_MODE_KIND.OFF,
    solid: normalizedSolid,
    ambilight: normalizedAmbilight,
    targets: input?.targets,
    displayId: normalizedDisplayId,
  };
}

export function resolveDefaultTargets(targets?: HueRuntimeTarget[]): HueRuntimeTarget[] {
  return targets && targets.length > 0 ? targets : ["usb"];
}
