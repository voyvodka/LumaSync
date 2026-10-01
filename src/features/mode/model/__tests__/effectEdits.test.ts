import { describe, expect, it } from "vitest";

import { EFFECT_CATALOGUE, EFFECT_ORDER } from "@/shared/contracts/effects";
import type { EffectPayload } from "@/shared/contracts/mode";
import { bestOnStrip, usesParam, withEffect, withPalette } from "../effectEdits";
import { effectSwatch, paletteOf, paletteStops } from "../effectSwatch";

const running: EffectPayload = {
  id: "wave",
  speed: 0.8,
  brightness: 0.4,
  palette: "ocean",
  colors: [{ r: 1, g: 2, b: 3 }],
  direction: "around",
  size: 0.9,
  intensity: 0.1,
  durationMinutes: 45,
};

describe("effect edits", () => {
  // The user's speed, brightness, colours and sunrise length travel; the effect's own shape does not.
  it("starts another effect in its own palette and shape, keeping what is the user's", () => {
    expect(withEffect(running, "candle")).toEqual({
      id: "candle",
      speed: 0.8,
      brightness: 0.4,
      colors: [{ r: 1, g: 2, b: 3 }],
      durationMinutes: 45,
    });
    expect(withEffect(running, "wave")).toBe(running);
  });

  it("keeps at most three custom colours", () => {
    const four = [1, 2, 3, 4].map((n) => ({ r: n, g: n, b: n }));
    expect(withPalette(running, "custom", four).colors).toHaveLength(3);
    expect(withPalette(running, "sunset").colors).toEqual(running.colors);
  });

  it("asks only for what an effect declares", () => {
    expect(usesParam("candle", "intensity")).toBe(true);
    expect(usesParam("candle", "direction")).toBe(false);
    expect(usesParam("wave", "direction")).toBe(true);
    expect(usesParam("sunrise", "durationMinutes")).toBe(true);
    expect(usesParam("naturalLight", "speed")).toBe(false);
  });

  it("marks the effects that turn simpler on a few lamps", () => {
    expect(bestOnStrip("comet")).toBe(true);
    expect(bestOnStrip("candle")).toBe(false);
  });
});

describe("effect swatches", () => {
  it("plays an effect's default palette until one is chosen", () => {
    expect(paletteOf({ id: "fireplace", speed: 0.5, brightness: 1 })).toBe("fire");
    expect(paletteOf({ ...running, palette: "lava" })).toBe("lava");
  });

  it("shows a custom palette in the effect's default colours until the user has their own", () => {
    const breathe: EffectPayload = { id: "breathe", speed: 0.5, brightness: 1 };
    expect(paletteStops("custom", breathe)).toEqual([...(EFFECT_CATALOGUE.breathe.defaultColors ?? [])]);
    expect(paletteStops("custom", { ...breathe, colors: [{ r: 255, g: 0, b: 16 }] })).toEqual(["#ff0010"]);
  });

  it("draws every effect in its colours", () => {
    for (const id of EFFECT_ORDER) {
      const stops = paletteStops(paletteOf({ id, speed: 0.5, brightness: 1 }), { id, speed: 0.5, brightness: 1 });
      const swatch = effectSwatch(id, stops);
      const colours = EFFECT_CATALOGUE[id].swatch ?? stops;
      expect(colours.some((c) => swatch.includes(c)), id).toBe(true);
    }
  });
});
