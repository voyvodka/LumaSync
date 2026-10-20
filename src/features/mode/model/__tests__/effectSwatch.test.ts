import { describe, expect, it } from "vitest";

import { EFFECT_CATALOGUE, EFFECT_ORDER, PALETTES, type BuiltinPaletteId } from "@/shared/contracts/effects";

import { effectSwatch } from "../effectSwatch";

const PALETTE_EFFECTS = EFFECT_ORDER.filter((id) => EFFECT_CATALOGUE[id].colorSource === "palette");

describe("effectSwatch", () => {
  // A palette colours an effect's picture; it must never turn it into another effect's.
  it("keeps every effect's picture its own in any palette", () => {
    for (const palette of Object.keys(PALETTES) as BuiltinPaletteId[]) {
      const pictures = PALETTE_EFFECTS.map((id) => effectSwatch(id, PALETTES[palette].stops));
      expect(new Set(pictures).size, palette).toBe(pictures.length);
    }
  });

  it("changes only colour with the palette: the same effect keeps its shape", () => {
    const shape = (css: string) => css.replace(/#[0-9a-f]{6}/gi, "C");
    for (const id of PALETTE_EFFECTS) {
      expect(shape(effectSwatch(id, PALETTES.lava.stops)), id).toBe(
        shape(effectSwatch(id, PALETTES.ocean.stops.slice(0, PALETTES.lava.stops.length))),
      );
    }
  });
});
