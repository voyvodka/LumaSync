import type { HueIntensityPreset, HueRuntimeTarget } from "@/shared/contracts/hue";
import type { LightingModeStatusCode, LightingSmoothingPreset } from "@/shared/contracts/lighting";
import type { CommandStatusOf } from "@/shared/contracts/status";
import type { DisplayId } from "@/shared/contracts/display";
import type { LedCalibrationConfig } from "@/shared/contracts/calibration";
import type { RoomGeometry } from "@/shared/contracts/roomMap";
import {
  EFFECT_DEFAULTS,
  EFFECT_DIRECTIONS,
  EFFECT_IDS,
  EFFECT_RANGES,
  PALETTE_IDS,
  type EffectDirection,
  type EffectId,
  type PaletteId,
} from "@/shared/contracts/effects";
import {
  DEFAULT_COLOR_CORRECTION,
  FIRMWARE_PROFILE,
  GAMMA_RANGE,
  KELVIN_RANGE_K,
  SATURATION_RANGE,
  type ColorCorrectionConfig,
  type FirmwareProfile,
  LED_CHIP_TYPE,
  LED_COLOR_ORDER,
  type LedChipType,
  type LedColorOrder,
  type WledLiveFrameAdvisory,
} from "@/shared/contracts/device";

export const LIGHTING_MODE_KIND = {
  OFF: "off",
  AMBILIGHT: "ambilight",
  SOLID: "solid",
  /** A drawn animation, run by the Ambilight worker from a synthetic source instead of capture. */
  EFFECT: "effect",
} as const;

export type LightingModeKind = (typeof LIGHTING_MODE_KIND)[keyof typeof LIGHTING_MODE_KIND];

/** A mode that lights something: every kind but Off. */
export type LitModeKind = Exclude<LightingModeKind, "off">;

/** `ShellState.lastLitKind` as stored; absent or unknown is Ambilight, the mode a fresh install is for. */
export function resolveLitModeKind(stored: unknown): LitModeKind {
  return stored === LIGHTING_MODE_KIND.SOLID || stored === LIGHTING_MODE_KIND.EFFECT ? stored : LIGHTING_MODE_KIND.AMBILIGHT;
}

export interface SolidColorPayload {
  r: number;
  g: number;
  b: number;
  brightness: number;
  /** Solid's White tab: a colour temperature, 2000–6500 K. Present ⇒ Rust derives r/g/b from it. */
  kelvin?: number | null;
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
  smoothingAlpha?: number | null;
  /** Luminance-preserving saturation factor. Range [0.5, 2.0]. 1.0 = identity. Default 1.0. */
  saturation?: number | null;
  /**
   * Unified smoothing preset (v1.4). Drives the EWMA coefficient for
   * both the USB strip and the Hue branch of the ambilight pump in a
   * single user-facing control. Takes priority over the deprecated
   * `smoothingAlpha` slider and `hueIntensityPreset` on the Rust side.
   */
  lightingSmoothingPreset?: LightingSmoothingPreset | null;
  /**
   * @deprecated Use `lightingSmoothingPreset`. Kept so pre-v1.4 persisted
   * payloads keep deserialising on the Rust side. Will be removed in
   * v1.5 once the backend compat shim is retired.
   */
  hueIntensityPreset?: HueIntensityPreset | null;
}

export interface EffectColor {
  r: number;
  g: number;
  b: number;
}

/**
 * Flat optional fields rather than a tagged union: Rust reads `lightingMode` at launch, and one
 * unknown shape in a union would fail the whole read; each field here fails soft on its own.
 */
export interface EffectPayload {
  id: EffectId;
  /** 0..1, mapped per effect onto a loop period on a log scale; not hertz: a breath and a wave lap differ. */
  speed: number;
  brightness: number;
  /** Absent ⇒ the effect's `defaultPalette`; `custom` plays `colors`. */
  palette?: PaletteId | null;
  /** 1..3 colours for the `custom` palette; kept while a built-in plays, so switching back restores them. */
  colors?: EffectColor[] | null;
  direction?: EffectDirection | null;
  size?: number | null;
  intensity?: number | null;
  durationMinutes?: number | null;
  /** When a sunrise began (Unix ms), stamped by Rust and saved, so a relaunch carries it on. */
  startedAtMs?: number | null;
}

export const DEFAULT_EFFECT: Readonly<EffectPayload> = {
  id: EFFECT_IDS.WAVE,
  speed: EFFECT_DEFAULTS.speed,
  brightness: EFFECT_DEFAULTS.brightness,
};

export interface LightingModeConfig {
  kind: LightingModeKind;
  solid?: SolidColorPayload | null;
  ambilight?: AmbilightPayload | null;
  effect?: EffectPayload | null;
  targets?: HueRuntimeTarget[] | null;
  /**
   * Display the ambilight worker should sample from.
   * Absent ⇒ backend falls back to the OS primary display so existing
   * single-monitor behaviour is unchanged. Matched platform-side against the
   * stable `DisplayInfo.id` form returned by `list_displays`; a missing or
   * unplugged display id reverts to primary instead of failing the command.
   */
  displayId?: DisplayId | null;
  /**
   * Per-channel color correction. Absent ⇒ backend uses
   * ColorCorrectionConfig defaults (gamma 2.2 / 6500 K / saturation 1.0).
   * Applied to every output: the strip's encoder and the Hue sender alike.
   */
  colorCorrection?: ColorCorrectionConfig | null;
  /**
   * Firmware encoding profile. Absent ⇒ backend defaults to
   * LumaSyncV1. User-visible setting only — never switched silently.
   */
  firmwareProfile?: FirmwareProfile | null;
  /**
   * LED chip type. Absent ⇒ `ws2812b-grb`. Changes bytes-per-pixel.
   */
  chipType?: LedChipType | null;
  /**
   * Host-side colour-order correction for the serial sink, relative to the
   * firmware's own order. Absent ⇒ Rust reads `ledColorOrder` off disk, then
   * falls back to `"rgb"`. WLED ignores it.
   */
  colorOrder?: LedColorOrder;
  /**
   * Per-LED calibration payload (v1.4 USB per-LED sampling anchor).
   * The Rust worker uses `totalLeds` to size every emitted USB packet
   * (Solid + Ambilight encoders both consume it). Absent ⇒ backend
   * falls back to a single-zone 1-LED frame so legacy / pre-calibration
   * setups keep emitting *something* on the strip. Stamped by Rust when a
   * mode is applied, from the persisted shell `ledCalibration` key — never persisted *inside* `LightingModeConfig`
   * itself, which is why `normalizeLightingModeConfig` deliberately does
   * not round-trip this field.
   */
  ledCalibration?: LedCalibrationConfig | null;
  /**
   * Room-aware sampling input (P3). Absent ⇒ no TV anchor, and the worker runs
   * exactly as before. Like `ledCalibration`, it is stamped onto outgoing
   * payloads from the persisted room map and must never be persisted inside
   * `LightingModeConfig` — `normalizeLightingModeConfig` deliberately does not
   * round-trip it, or a stale geometry would outlive the room map it came from.
   */
  roomGeometry?: RoomGeometry;
}

/**
 * What one mode apply under the lighting transaction answers
 * (`apply_config_blocking` in Rust). No command returns it whole — the
 * transaction hands on its `status` as `ApplyOutputsOutcome.applyStatus` — but
 * the dev mock's transaction is built on it.
 */
export interface LightingModeCommandResult {
  active: boolean;
  mode: LightingModeConfig;
  status: CommandStatusOf<LightingModeStatusCode>;
  /** Non-fatal: the stream started but part of the WLED strip will not track.
   * Rides alongside a success status rather than replacing it. */
  wledAdvisory: WledLiveFrameAdvisory | null;
}

const LIGHTING_MODE_KIND_VALUES: ReadonlySet<unknown> = new Set(Object.values(LIGHTING_MODE_KIND));

/** Derived from the table, so a new kind cannot be read as Off by a forgotten check. */
export function isLightingModeKind(value: unknown): value is LightingModeKind {
  return LIGHTING_MODE_KIND_VALUES.has(value);
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

/**
 * The colour Solid shows before the user has picked one — every surface, and
 * what Rust applies when a Solid config carries no colour. The compact window
 * once defaulted to a warm white the other surfaces did not.
 */
export const DEFAULT_SOLID_COLOR: Readonly<SolidColorPayload> = { r: 255, g: 255, b: 255, brightness: 1 };

/** Solid's White tab. `solid_kelvin_range` in `config.rs`. */
export const SOLID_KELVIN_RANGE = { min: 2000, max: 6500 } as const;

export function normalizeSolidColorPayload(input?: Partial<SolidColorPayload>): SolidColorPayload {
  return {
    r: clampInt(input?.r, 0, 255, DEFAULT_SOLID_COLOR.r),
    g: clampInt(input?.g, 0, 255, DEFAULT_SOLID_COLOR.g),
    b: clampInt(input?.b, 0, 255, DEFAULT_SOLID_COLOR.b),
    brightness: clampFloat(input?.brightness, 0, 1, DEFAULT_SOLID_COLOR.brightness),
    // Rust drops a kelvin that is not a number and rounds the rest; so does this.
    ...(typeof input?.kelvin === "number" && Number.isFinite(input.kelvin)
      ? { kelvin: Math.max(SOLID_KELVIN_RANGE.min, Math.min(SOLID_KELVIN_RANGE.max, Math.round(input.kelvin))) }
      : {}),
  };
}

function normalizeLightingSmoothingPreset(
  value: unknown,
): LightingSmoothingPreset | undefined {
  return value === "subtle" || value === "moderate" || value === "intense"
    ? value
    : undefined;
}

export function normalizeAmbilightPayload(input?: Partial<AmbilightPayload> | null): AmbilightPayload {
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

const EFFECT_ID_VALUES: ReadonlySet<string> = new Set(Object.values(EFFECT_IDS));
const PALETTE_ID_VALUES: ReadonlySet<string> = new Set(Object.values(PALETTE_IDS));
const DIRECTION_VALUES: ReadonlySet<string> = new Set(Object.values(EFFECT_DIRECTIONS));

/** The three v1 ids, read as what they became; `config.rs` maps them the same way. */
const V1_EFFECTS: Readonly<Record<string, { id: EffectId; palette: PaletteId }>> = {
  rainbow: { id: EFFECT_IDS.WAVE, palette: PALETTE_IDS.RAINBOW },
  cycle: { id: EFFECT_IDS.CYCLE, palette: PALETTE_IDS.RAINBOW },
  breathe: { id: EFFECT_IDS.BREATHE, palette: PALETTE_IDS.CUSTOM },
};

/** v1's breath colour, and what a v1 breath without one had. */
const V1_BREATHE_COLOR: Readonly<EffectColor> = { r: 255, g: 176, b: 32 };

function normalizeEffectColor(value: unknown): EffectColor | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const { r, g, b } = value as Partial<EffectColor>;
  return { r: clampInt(r, 0, 255, 255), g: clampInt(g, 0, 255, 255), b: clampInt(b, 0, 255, 255) };
}

type EffectPayloadInput = Partial<Omit<EffectPayload, "id">> & { id?: string; color?: EffectColor | null };

/**
 * Clamped into range; unknown ids and fields fall back one by one, as Rust reads them. A v1
 * payload (`rainbow` / `cycle` / `breathe` + `color`) reads as its v2 equivalent.
 */
export function normalizeEffectPayload(input?: EffectPayloadInput | null): EffectPayload {
  const v1 = typeof input?.id === "string" ? V1_EFFECTS[input.id] : undefined;
  const id: EffectId =
    v1?.id ??
    (typeof input?.id === "string" && EFFECT_ID_VALUES.has(input.id) ? (input.id as EffectId) : DEFAULT_EFFECT.id);
  const palette =
    typeof input?.palette === "string" && PALETTE_ID_VALUES.has(input.palette)
      ? (input.palette as PaletteId)
      : v1?.palette;
  const [minColors, maxColors] = EFFECT_RANGES.colors;
  let colors = Array.isArray(input?.colors)
    ? input.colors.map(normalizeEffectColor).filter((c): c is EffectColor => c !== undefined).slice(0, maxColors)
    : undefined;
  if (input?.id === "breathe" && !colors?.length) {
    colors = [normalizeEffectColor(input.color) ?? { ...V1_BREATHE_COLOR }];
  }
  const direction =
    typeof input?.direction === "string" && DIRECTION_VALUES.has(input.direction)
      ? (input.direction as EffectDirection)
      : undefined;
  const [minMinutes, maxMinutes] = EFFECT_RANGES.durationMinutes;
  return {
    id,
    speed: clampFloat(input?.speed, 0, 1, DEFAULT_EFFECT.speed),
    brightness: clampFloat(input?.brightness, 0, 1, DEFAULT_EFFECT.brightness),
    ...(palette ? { palette } : {}),
    ...(colors && colors.length >= minColors ? { colors } : {}),
    ...(direction ? { direction } : {}),
    ...(input?.size != null ? { size: clampFloat(input.size, 0, 1, EFFECT_DEFAULTS.size) } : {}),
    ...(input?.intensity != null ? { intensity: clampFloat(input.intensity, 0, 1, EFFECT_DEFAULTS.intensity) } : {}),
    ...(input?.durationMinutes != null
      ? { durationMinutes: clampInt(input.durationMinutes, minMinutes, maxMinutes, EFFECT_DEFAULTS.durationMinutes) }
      : {}),
    ...(id === EFFECT_IDS.SUNRISE && typeof input?.startedAtMs === "number" && Number.isFinite(input.startedAtMs) && input.startedAtMs > 0
      ? { startedAtMs: input.startedAtMs }
      : {}),
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

function normalizeChipType(value: unknown): LedChipType | undefined {
  return value === LED_CHIP_TYPE.WS2812B_GRB || value === LED_CHIP_TYPE.SK6812_RGBW
    ? value
    : undefined;
}

const LED_COLOR_ORDER_VALUES: ReadonlySet<string> = new Set(Object.values(LED_COLOR_ORDER));

/** Absent and unknown both come back `undefined`, never the default: an
 * invented `"rgb"` would win caller-wins hydration over the saved order, and an
 * unknown string would fail the whole payload's deserialisation in Rust. */
export function normalizeColorOrder(value: unknown): LedColorOrder | undefined {
  return typeof value === "string" && LED_COLOR_ORDER_VALUES.has(value)
    ? (value as LedColorOrder)
    : undefined;
}

export function normalizeLightingModeConfig(input?: Partial<LightingModeConfig>): LightingModeConfig {
  const kind = isLightingModeKind(input?.kind) ? input.kind : LIGHTING_MODE_KIND.OFF;
  const normalizedSolid = input?.solid ? normalizeSolidColorPayload(input.solid) : undefined;
  const normalizedAmbilight = input?.ambilight ? normalizeAmbilightPayload(input.ambilight) : undefined;
  const normalizedEffect = input?.effect ? normalizeEffectPayload(input.effect) : undefined;
  const normalizedDisplayId = normalizeDisplayId(input?.displayId);
  const normalizedColorCorrection = normalizeColorCorrection(input?.colorCorrection);
  const normalizedFirmwareProfile = normalizeFirmwareProfile(input?.firmwareProfile);
  const normalizedChipType = normalizeChipType(input?.chipType);
  const normalizedColorOrder = normalizeColorOrder(input?.colorOrder);

  if (kind === LIGHTING_MODE_KIND.SOLID) {
    return {
      kind,
      solid: normalizedSolid ?? normalizeSolidColorPayload(),
      ambilight: normalizedAmbilight,
      effect: normalizedEffect,
      targets: input?.targets,
      displayId: normalizedDisplayId,
      colorCorrection: normalizedColorCorrection,
      firmwareProfile: normalizedFirmwareProfile,
      chipType: normalizedChipType,
      colorOrder: normalizedColorOrder,
    };
  }

  if (kind === LIGHTING_MODE_KIND.EFFECT) {
    return {
      kind,
      effect: normalizedEffect ?? normalizeEffectPayload(),
      solid: normalizedSolid,
      ambilight: normalizedAmbilight,
      targets: input?.targets,
      colorCorrection: normalizedColorCorrection,
      firmwareProfile: normalizedFirmwareProfile,
      chipType: normalizedChipType,
      colorOrder: normalizedColorOrder,
    };
  }

  if (kind === LIGHTING_MODE_KIND.AMBILIGHT) {
    return {
      kind,
      ambilight: normalizedAmbilight ?? normalizeAmbilightPayload(),
      solid: normalizedSolid,
      effect: normalizedEffect,
      targets: input?.targets,
      displayId: normalizedDisplayId,
      colorCorrection: normalizedColorCorrection,
      firmwareProfile: normalizedFirmwareProfile,
      chipType: normalizedChipType,
      colorOrder: normalizedColorOrder,
    };
  }

  return {
    kind: LIGHTING_MODE_KIND.OFF,
    solid: normalizedSolid,
    ambilight: normalizedAmbilight,
    effect: normalizedEffect,
    targets: input?.targets,
    displayId: normalizedDisplayId,
    colorCorrection: normalizedColorCorrection,
    firmwareProfile: normalizedFirmwareProfile,
    chipType: normalizedChipType,
    colorOrder: normalizedColorOrder,
  };
}

/** Output sink a fresh install starts on. */
export const DEFAULT_OUTPUT_TARGETS: HueRuntimeTarget[] = ["usb"];

/** Each output target's place in a normalised list. A new target fails to compile until it has one. */
const OUTPUT_TARGET_RANK = { usb: 0, hue: 1 } satisfies Record<HueRuntimeTarget, number>;

/** Every output target, in the stable order the UI lists them and a normalised list keeps. */
export const OUTPUT_TARGETS: readonly HueRuntimeTarget[] = (
  Object.keys(OUTPUT_TARGET_RANK) as HueRuntimeTarget[]
).sort((a, b) => OUTPUT_TARGET_RANK[a] - OUTPUT_TARGET_RANK[b]);

function isOutputTarget(value: unknown): value is HueRuntimeTarget {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(OUTPUT_TARGET_RANK, value);
}

/** Coerce a persisted output-target list into a deduped set in `OUTPUT_TARGETS` order. */
export function normalizeOutputTargets(value: unknown): HueRuntimeTarget[] {
  // First-install case (`undefined` / non-array shape from the persisted
  // store): fall back to DEFAULT_OUTPUT_TARGETS so a fresh user lands on a
  // sensible primary output. An EXPLICIT empty array means the user (or the
  // unsupported-USB auto-fallback) has cleared targets — respect that and
  // return `[]`. The previous unconditional DEFAULT fallback re-added the
  // very target we had just removed and stranded the auto-deselect path.
  if (!Array.isArray(value)) return [...DEFAULT_OUTPUT_TARGETS];
  const targetSet = new Set(value.filter(isOutputTarget));
  return OUTPUT_TARGETS.filter((t) => targetSet.has(t));
}
