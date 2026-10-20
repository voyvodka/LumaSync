import { describe, expect, it } from "vitest";

import { SOLID_KELVIN_RANGE } from "@/shared/contracts/mode";
import { kelvinToRgb } from "../color";
import golden from "./kelvinWhite.golden.json";

// Also read by `a_white_matches_the_shared_fixture` in lighting_mode/effect_tests.rs.
describe("kelvinToRgb — shared fixture", () => {
  it("holds White to the range Rust clamps it to", () => {
    expect([SOLID_KELVIN_RANGE.min, SOLID_KELVIN_RANGE.max]).toEqual(golden.range);
  });

  it("gives the white Rust resolves a White solid to", () => {
    for (const [kelvin, [r, g, b]] of golden.cases as [number, [number, number, number]][]) {
      expect(kelvinToRgb(kelvin), `${kelvin} K`).toEqual({ r, g, b });
    }
  });
});
