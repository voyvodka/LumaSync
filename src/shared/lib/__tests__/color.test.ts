import { describe, expect, it } from "vitest";

import { normalizeHex, parseHex, rgbToHex } from "../color";

describe("rgbToHex", () => {
  it("formats a triplet as lowercase `#rrggbb`", () => {
    expect(rgbToHex({ r: 255, g: 176, b: 32 })).toBe("#ffb020");
    expect(rgbToHex({ r: 168, g: 173, b: 76 })).toBe("#a8ad4c");
  });

  it("zero-pads single-digit channels", () => {
    expect(rgbToHex({ r: 0, g: 0, b: 0 })).toBe("#000000");
    expect(rgbToHex({ r: 1, g: 2, b: 3 })).toBe("#010203");
  });

  // Solid panel, Lights subtitle and the control popup used to floor, so
  // 127.6 read as `7f`; the compact hero did no rounding and printed `7f.8…`.
  it("rounds fractional channels to the nearest integer", () => {
    expect(rgbToHex({ r: 127.6, g: 127.5, b: 127.4 })).toBe("#80807f");
    expect(rgbToHex({ r: 254.6, g: 0.4, b: 0.5 })).toBe("#ff0001");
  });

  it("clamps channels to 0..255", () => {
    expect(rgbToHex({ r: -3, g: 300, b: 256 })).toBe("#00ffff");
  });

  it("treats a non-finite channel as 0 rather than printing NaN", () => {
    expect(rgbToHex({ r: Number.NaN, g: Number.POSITIVE_INFINITY, b: 10 })).toBe("#00000a");
  });
});

describe("parseHex", () => {
  it("accepts six digits with or without `#`, in either case, with surrounding space", () => {
    const amber = { r: 255, g: 176, b: 32 };
    expect(parseHex("#ffb020")).toEqual(amber);
    expect(parseHex("FFB020")).toEqual(amber);
    expect(parseHex("  #FfB020 ")).toEqual(amber);
  });

  it("rejects short form, wrong lengths and non-hex digits", () => {
    for (const bad of ["#abc", "abc", "#ffb02", "#ffb0200", "##ffb020", "#ffb02g", ""]) {
      expect(parseHex(bad)).toBeNull();
    }
  });

  it("round-trips every channel value through rgbToHex", () => {
    for (let v = 0; v <= 255; v++) {
      const rgb = { r: v, g: 255 - v, b: (v * 7) % 256 };
      expect(parseHex(rgbToHex(rgb))).toEqual(rgb);
    }
  });
});

describe("normalizeHex", () => {
  it("returns the canonical lowercase `#rrggbb`", () => {
    expect(normalizeHex("A8AD4C")).toBe("#a8ad4c");
    expect(normalizeHex(" #A8AD4C ")).toBe("#a8ad4c");
  });

  it("returns null for anything parseHex rejects", () => {
    expect(normalizeHex("#abc")).toBeNull();
    expect(normalizeHex("zzzzzz")).toBeNull();
  });
});
