import type { HueIntensityPreset, HueRuntimeTarget } from "@/shared/contracts/hue";
import type { LightingModeStatusCode, LightingSmoothingPreset } from "@/shared/contracts/lighting";
import type { CommandStatusOf } from "@/shared/contracts/status";
import type { DisplayId } from "@/shared/contracts/display";
import type { LedCalibrationConfig } from "@/shared/contracts/calibration";
import type { RoomGeometry } from "@/shared/contracts/roomMap";
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

export interface LightingModeConfig {
  kind: LightingModeKind;
  solid?: SolidColorPayload | null;
  ambilight?: AmbilightPayload | null;
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
   * Applied to USB output only — Hue sink is not affected.
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
 * Tauri event channel emitted whenever the active lighting mode changes
 * (mode flip, solid color update, ambilight start/stop). Lets preview
 * surfaces — and any window other than the one that issued the change —
 * reconcile their mode view without polling `get_lighting_mode_status`.
 */
export const LIGHTING_MODE_CHANGED_EVENT = "lighting://mode-changed";

/** Payload broadcast on {@link LIGHTING_MODE_CHANGED_EVENT}. */
export interface LightingModeChangedPayload {
  /** The lighting mode configuration now in effect. */
  config: LightingModeConfig;
  /** Whether lighting is actively driving sinks (false when `kind === "off"` / stopped). */
  active: boolean;
}

/** `set_lighting_mode`, `stop_lighting` and `get_lighting_mode_status`. */
export interface LightingModeCommandResult {
  active: boolean;
  mode: LightingModeConfig;
  status: CommandStatusOf<LightingModeStatusCode>;
  /** Non-fatal: the stream started but part of the WLED strip will not track.
   * Rides alongside a success status rather than replacing it. */
  wledAdvisory: WledLiveFrameAdvisory | null;
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
      targets: input?.targets,
      displayId: normalizedDisplayId,
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
