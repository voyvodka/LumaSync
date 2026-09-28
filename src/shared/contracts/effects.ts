/**
 * The effect catalogue: which effects exist, what each one uses, and the built-in palettes.
 * `effectCatalogue.json` is the one source; Rust reads the same file (`effect_catalogue.rs`),
 * so an effect's parameters and a palette's stops cannot drift between the two sides.
 */

import catalogue from "./effectCatalogue.json";

/** `EffectId` in `commands/lighting_mode/config.rs`; an id Rust does not know reads as the wave. */
export const EFFECT_IDS = {
  WAVE: "wave",
  CYCLE: "cycle",
  BREATHE: "breathe",
  CANDLE: "candle",
  FIREPLACE: "fireplace",
  DRIFT: "drift",
  GRADIENT: "gradient",
  OCEAN: "ocean",
  AURORA: "aurora",
  TWINKLE: "twinkle",
  COMET: "comet",
  SCANNER: "scanner",
  CHASE: "chase",
  PLASMA: "plasma",
  SUNRISE: "sunrise",
  NATURAL_LIGHT: "naturalLight",
} as const;

export type EffectId = (typeof EFFECT_IDS)[keyof typeof EFFECT_IDS];

/** `PaletteId` in `config.rs`. `custom` plays the payload's own `colors`. */
export const PALETTE_IDS = {
  RAINBOW: "rainbow",
  SUNSET: "sunset",
  OCEAN: "ocean",
  FOREST: "forest",
  LAVA: "lava",
  AURORA: "aurora",
  PASTEL: "pastel",
  WARM: "warm",
  ICE: "ice",
  PARTY: "party",
  FIRE: "fire",
  CUSTOM: "custom",
} as const;

export type PaletteId = (typeof PALETTE_IDS)[keyof typeof PALETTE_IDS];
export type BuiltinPaletteId = Exclude<PaletteId, "custom">;

/** `EffectDirection` in `config.rs`: where a field effect travels, in room terms. */
export const EFFECT_DIRECTIONS = {
  LEFT_TO_RIGHT: "leftToRight",
  RIGHT_TO_LEFT: "rightToLeft",
  BOTTOM_TO_TOP: "bottomToTop",
  TOP_TO_BOTTOM: "topToBottom",
  OUTWARD: "outward",
  AROUND: "around",
} as const;

export type EffectDirection = (typeof EFFECT_DIRECTIONS)[keyof typeof EFFECT_DIRECTIONS];

export type EffectParam = "speed" | "size" | "intensity" | "direction" | "durationMinutes";
export type EffectFamily = "wholeRoom" | "field" | "stochastic" | "travelling" | "timed";
/**
 * How an effect behaves on a handful of lights (a Hue area): `native` looks as meant, `drift`
 * softens into a slow drift, `pulse` into sparse pulses, `hop` travels light to light.
 */
export type EffectSparse = "native" | "drift" | "pulse" | "hop";

export interface EffectSpec {
  family: EffectFamily;
  params: readonly EffectParam[];
  /** `none`: the effect draws its own colours (sunrise, natural light). */
  colorSource: "palette" | "none";
  defaultPalette: PaletteId;
  /** `#rrggbb`; the colours a `custom` default palette starts with. */
  defaultColors?: readonly string[];
  /** `#rrggbb`; what the gallery shows for an effect that draws its own colours. */
  swatch?: readonly string[];
  sparse: EffectSparse;
}

export interface PaletteSpec {
  /** A palette whose last stop runs back into its first; others play there and back. */
  wrap: boolean;
  /** `#rrggbb`, blended in OKLab. */
  stops: readonly string[];
}

export const EFFECT_CATALOGUE = catalogue.effects as Readonly<Record<EffectId, EffectSpec>>;
export const PALETTES = catalogue.palettes as Readonly<Record<BuiltinPaletteId, PaletteSpec>>;
export const EFFECT_DEFAULTS = catalogue.defaults as Readonly<{
  speed: number;
  brightness: number;
  size: number;
  intensity: number;
  direction: EffectDirection;
  durationMinutes: number;
}>;
export const EFFECT_RANGES = catalogue.ranges as unknown as Readonly<{
  durationMinutes: readonly [number, number];
  colors: readonly [number, number];
}>;

export const EFFECT_ORDER = Object.values(EFFECT_IDS) as readonly EffectId[];
export const PALETTE_ORDER = Object.values(PALETTE_IDS) as readonly PaletteId[];
