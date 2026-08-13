import { describe, it, expect } from "vitest";
import { getZoneColor, TYPE_DOT_COLOR, ZONE_TOKENS } from "../zoneColor";

describe("getZoneColor", () => {
  it("hands out the palette in order for the first six zones", () => {
    const colors = ZONE_TOKENS.map((_, i) => getZoneColor({}, i));
    expect(colors).toEqual(ZONE_TOKENS);
  });

  it("cycles the palette rather than running out", () => {
    expect(getZoneColor({}, ZONE_TOKENS.length)).toBe(ZONE_TOKENS[0]);
    expect(getZoneColor({}, ZONE_TOKENS.length + 2)).toBe(ZONE_TOKENS[2]);
  });

  it("lets an explicit borderColor override the palette slot", () => {
    expect(getZoneColor({ borderColor: "#ff0055" }, 0)).toBe("#ff0055");
    expect(getZoneColor({ borderColor: "#ff0055" }, 3)).toBe("#ff0055");
  });

  it("falls back to the palette when borderColor is absent or empty", () => {
    expect(getZoneColor({ borderColor: undefined }, 1)).toBe(ZONE_TOKENS[1]);
    expect(getZoneColor({ borderColor: "" }, 1)).toBe(ZONE_TOKENS[1]);
  });
});

describe("TYPE_DOT_COLOR", () => {
  it("resolves every row type to a design token, never a raw colour", () => {
    for (const value of Object.values(TYPE_DOT_COLOR)) {
      expect(value).toMatch(/^var\(--lm-[a-z0-9-]+\)$/);
    }
  });

  it("covers all five row types", () => {
    expect(Object.keys(TYPE_DOT_COLOR).sort()).toEqual([
      "furniture",
      "hue",
      "image",
      "tv",
      "usb",
    ]);
  });
});
