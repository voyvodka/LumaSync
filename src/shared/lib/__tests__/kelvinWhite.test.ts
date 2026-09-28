import { describe, expect, it } from "vitest";

import { kelvinToRgb } from "../color";
import golden from "./kelvinWhite.golden.json";

// Also read by `a_white_matches_the_shared_fixture` in lighting_mode/effect_tests.rs.
describe("kelvinToRgb — shared fixture", () => {
  it("gives the white Rust resolves a White solid to", () => {
    for (const [kelvin, [r, g, b]] of golden.cases as [number, [number, number, number]][]) {
      expect(kelvinToRgb(kelvin), `${kelvin} K`).toEqual({ r, g, b });
    }
  });
});
