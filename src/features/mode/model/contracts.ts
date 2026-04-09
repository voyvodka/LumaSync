import type { HueRuntimeTarget } from "../../../shared/contracts/hue";

export const LIGHTING_MODE_KIND = {
  OFF: "off",
  AMBILIGHT: "ambilight",
  SOLID: "solid",
} as const;

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
}

export interface LightingModeConfig {
  kind: LightingModeKind;
  solid?: SolidColorPayload;
  ambilight?: AmbilightPayload;
  targets?: HueRuntimeTarget[];
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
  };
}

export function normalizeLightingModeConfig(input?: Partial<LightingModeConfig>): LightingModeConfig {
  const kind = isLightingModeKind(input?.kind) ? input.kind : LIGHTING_MODE_KIND.OFF;
  const normalizedSolid = input?.solid ? normalizeSolidColorPayload(input.solid) : undefined;
  const normalizedAmbilight = input?.ambilight ? normalizeAmbilightPayload(input.ambilight) : undefined;

  if (kind === LIGHTING_MODE_KIND.SOLID) {
    return {
      kind,
      solid: normalizedSolid ?? normalizeSolidColorPayload(),
      ambilight: normalizedAmbilight,
      targets: input?.targets,
    };
  }

  if (kind === LIGHTING_MODE_KIND.AMBILIGHT) {
    return {
      kind,
      ambilight: normalizedAmbilight ?? normalizeAmbilightPayload(),
      solid: normalizedSolid,
      targets: input?.targets,
    };
  }

  return {
    kind: LIGHTING_MODE_KIND.OFF,
    solid: normalizedSolid,
    ambilight: normalizedAmbilight,
    targets: input?.targets,
  };
}

export function resolveDefaultTargets(targets?: HueRuntimeTarget[]): HueRuntimeTarget[] {
  return targets && targets.length > 0 ? targets : ["usb"];
}
