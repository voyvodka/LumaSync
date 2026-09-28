import {
  EFFECT_CATALOGUE,
  EFFECT_DEFAULTS,
  EFFECT_RANGES,
  PALETTE_IDS,
  type EffectId,
  type EffectParam,
  type PaletteId,
} from "@/shared/contracts/effects";
import type { EffectColor, EffectPayload } from "@/shared/contracts/mode";

/**
 * Another effect picked: it starts in its own palette and shape, and keeps what belongs to the
 * user rather than to an effect — speed, brightness, their own colours and a sunrise's length.
 */
export function withEffect(current: EffectPayload, id: EffectId): EffectPayload {
  if (id === current.id) return current;
  return {
    id,
    speed: current.speed,
    brightness: current.brightness,
    ...(current.colors?.length ? { colors: current.colors } : {}),
    ...(current.durationMinutes != null ? { durationMinutes: current.durationMinutes } : {}),
  };
}

export function withPalette(current: EffectPayload, palette: PaletteId, colors?: EffectColor[]): EffectPayload {
  return {
    ...current,
    palette,
    ...(palette === PALETTE_IDS.CUSTOM && colors ? { colors: colors.slice(0, EFFECT_RANGES.colors[1]) } : {}),
  };
}

export function usesParam(id: EffectId, param: EffectParam): boolean {
  return EFFECT_CATALOGUE[id].params.includes(param);
}

export function takesPalette(id: EffectId): boolean {
  return EFFECT_CATALOGUE[id].colorSource === "palette";
}

/** The value a slider shows for a parameter the payload may not carry yet. */
export function paramValue(effect: EffectPayload, param: "size" | "intensity" | "durationMinutes"): number {
  return effect[param] ?? EFFECT_DEFAULTS[param];
}

/** An effect that turns into something simpler on a few room lamps (a comet hops lamp to lamp). */
export function bestOnStrip(id: EffectId): boolean {
  return EFFECT_CATALOGUE[id].sparse !== "native";
}
