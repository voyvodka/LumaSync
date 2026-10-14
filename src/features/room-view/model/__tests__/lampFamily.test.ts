import { describe, expect, it } from "vitest";

import { channelLampFamily, lampFamily } from "../lampFamily";

describe("lampFamily", () => {
  it("groups the bridge's archetypes by shape", () => {
    expect(lampFamily("hue_play")).toBe("playBar");
    expect(lampFamily("floor_shade")).toBe("floorLamp");
    expect(lampFamily("pendant_round")).toBe("pendant");
    expect(lampFamily("hue_go")).toBe("portable");
  });

  it("draws a word it does not know, or none, as a bulb", () => {
    expect(lampFamily("sultan_bulb")).toBe("bulb");
    expect(lampFamily("something_new")).toBe("bulb");
    expect(lampFamily(null)).toBe("bulb");
  });

  it("takes a channel's shape from the first light that names a fixture", () => {
    expect(channelLampFamily(["a", "b"], { a: "sultan_bulb", b: "hue_play" })).toBe("playBar");
    expect(channelLampFamily(["a"], {})).toBe("bulb");
  });
});
