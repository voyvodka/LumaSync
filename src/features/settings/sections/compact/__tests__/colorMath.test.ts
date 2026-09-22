import { describe, it, expect } from "vitest";
import { HERO_LIGHT_TILE_THRESHOLD, perceivedLuminance } from "../colorMath";

describe("perceivedLuminance", () => {
  it("returns 0 for black and 1 for white", () => {
    expect(perceivedLuminance({ r: 0, g: 0, b: 0 })).toBe(0);
    expect(perceivedLuminance({ r: 255, g: 255, b: 255 })).toBeCloseTo(1);
  });

  it("weights green far above blue, per Rec. 709", () => {
    const green = perceivedLuminance({ r: 0, g: 255, b: 0 });
    const blue = perceivedLuminance({ r: 0, g: 0, b: 255 });
    const red = perceivedLuminance({ r: 255, g: 0, b: 0 });

    expect(green).toBeGreaterThan(red);
    expect(red).toBeGreaterThan(blue);
    expect(green).toBeCloseTo(0.7152);
  });
});

describe("HERO_LIGHT_TILE_THRESHOLD", () => {
  // The threshold decides black-vs-white label text on the compact hero tile,
  // so these cases are the ones a contrast regression would show up in first.
  it("treats white, yellow, green and the brand amber as light tiles", () => {
    for (const rgb of [
      { r: 255, g: 255, b: 255 },
      { r: 255, g: 255, b: 0 },
      { r: 0, g: 255, b: 0 },
      { r: 255, g: 176, b: 32 }, // --lm-amber
    ]) {
      expect(perceivedLuminance(rgb)).toBeGreaterThan(HERO_LIGHT_TILE_THRESHOLD);
    }
  });

  it("treats black and saturated red or blue as dark tiles", () => {
    for (const rgb of [
      { r: 0, g: 0, b: 0 },
      { r: 255, g: 0, b: 0 },
      { r: 0, g: 0, b: 255 },
    ]) {
      expect(perceivedLuminance(rgb)).toBeLessThanOrEqual(HERO_LIGHT_TILE_THRESHOLD);
    }
  });
});
