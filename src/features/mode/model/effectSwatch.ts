import {
  EFFECT_CATALOGUE,
  PALETTE_IDS,
  PALETTES,
  type BuiltinPaletteId,
  type EffectId,
  type PaletteId,
} from "@/shared/contracts/effects";
import type { EffectColor, EffectPayload } from "@/shared/contracts/mode";

const hex2 = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");

export function colorToHex({ r, g, b }: EffectColor): string {
  return `#${hex2(r)}${hex2(g)}${hex2(b)}`;
}

export function hexToColor(hex: string): EffectColor {
  const value = hex.replace("#", "");
  const byte = (i: number) => Number.parseInt(value.slice(i, i + 2), 16) || 0;
  return { r: byte(0), g: byte(2), b: byte(4) };
}

/** The palette an effect plays, as `custom` or a built-in: its own choice, else its default. */
export function paletteOf(effect: EffectPayload): PaletteId {
  return effect.palette ?? EFFECT_CATALOGUE[effect.id].defaultPalette;
}

/** The custom colours an effect would play: its own, else the effect's defaults, else amber. */
export function customColorsOf(effect: EffectPayload): EffectColor[] {
  if (effect.colors?.length) return effect.colors;
  const defaults = EFFECT_CATALOGUE[effect.id].defaultColors ?? EFFECT_CATALOGUE.breathe.defaultColors ?? [];
  return defaults.map(hexToColor);
}

/** A palette's stops as hex, for a swatch; `custom` reads the effect's colours. */
export function paletteStops(palette: PaletteId, effect: EffectPayload): string[] {
  if (palette === PALETTE_IDS.CUSTOM) return customColorsOf(effect).map(colorToHex);
  return [...PALETTES[palette as BuiltinPaletteId].stops];
}

function linear(stops: readonly string[], angle = 90): string {
  if (stops.length === 1) return stops[0] ?? "transparent";
  return `linear-gradient(${angle}deg, ${stops.join(", ")})`;
}

/** A circle's fill for the palette strip. */
export function paletteSwatch(palette: PaletteId, effect: EffectPayload): string {
  return linear(paletteStops(palette, effect), 135);
}

/**
 * A still picture of an effect in its palette: the shape it moves in, drawn once. The gallery
 * shows these at rest; nothing on it animates.
 */
export function effectSwatch(id: EffectId, stops: readonly string[]): string {
  const spec = EFFECT_CATALOGUE[id];
  const colours = spec.colorSource === "none" && spec.swatch ? spec.swatch : stops;
  const first = colours[0] ?? "transparent";
  const last = colours[colours.length - 1] ?? first;
  const middle = colours[Math.floor(colours.length / 2)] ?? first;
  switch (id) {
    case "cycle":
      return `linear-gradient(90deg, ${first}, ${middle})`;
    case "breathe":
      return `radial-gradient(circle at 50% 65%, ${middle} 0%, ${first} 38%, transparent 78%)`;
    case "candle":
      return `radial-gradient(ellipse 14% 62% at 50% 88%, ${middle} 0%, ${first} 55%, transparent 100%), radial-gradient(ellipse 40% 90% at 50% 100%, ${first}, transparent 70%)`;
    case "fireplace":
    case "sunrise":
      return linear(colours, 0);
    case "drift":
      return `radial-gradient(circle at 25% 35%, ${first}, transparent 55%), radial-gradient(circle at 75% 65%, ${last}, transparent 60%), ${middle}`;
    case "twinkle":
      return `radial-gradient(circle at 20% 30%, ${first} 0 3px, transparent 4px), radial-gradient(circle at 65% 55%, ${middle} 0 3px, transparent 4px), radial-gradient(circle at 85% 25%, ${last} 0 2px, transparent 3px), radial-gradient(circle at 40% 75%, ${last} 0 2px, transparent 3px), transparent`;
    case "comet":
      return `linear-gradient(90deg, transparent 10%, ${first} 70%, ${middle} 88%, transparent 92%)`;
    case "scanner":
      return `radial-gradient(ellipse 22% 60% at 55% 50%, ${middle}, transparent)`;
    case "chase":
      return `repeating-linear-gradient(90deg, ${first} 0 12%, transparent 12% 24%, ${last} 24% 36%, transparent 36% 48%)`;
    case "aurora":
      return `linear-gradient(180deg, transparent 5%, ${first} 45%, ${last} 70%, transparent 95%)`;
    default:
      return linear(colours);
  }
}
