import { describe, expect, it } from "vitest";

import { colourName } from "../colourName";

describe("colourName", () => {
  it.each([
    [255, 0, 16, "red"],
    [255, 140, 0, "orange"],
    [0, 200, 80, "green"],
    [0, 128, 128, "teal"],
    [30, 80, 255, "blue"],
    [160, 32, 240, "purple"],
    [255, 105, 180, "pink"],
    [255, 255, 255, "white"],
    [255, 244, 229, "white"],
    [90, 90, 96, "grey"],
  ] as const)("calls %i,%i,%i %s", (r, g, b, name) => {
    expect(colourName(r, g, b)).toBe(name);
  });
});
