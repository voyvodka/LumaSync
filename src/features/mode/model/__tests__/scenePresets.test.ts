import { describe, expect, it } from "vitest";

import { SCENE_PRESETS, findMatchingScenePreset } from "../scenePresets";

describe("SCENE_PRESETS catalog", () => {
  it("ships the 5 mood tiles the Compact + Lights UIs expect", () => {
    expect(SCENE_PRESETS.map((p) => p.id)).toEqual([
      "movie",
      "game",
      "music",
      "chill",
      "read",
    ]);
  });

  it("keeps every preset's RGB inside the 0–255 serial packet range", () => {
    for (const preset of SCENE_PRESETS) {
      expect(preset.r).toBeGreaterThanOrEqual(0);
      expect(preset.r).toBeLessThanOrEqual(255);
      expect(preset.g).toBeGreaterThanOrEqual(0);
      expect(preset.g).toBeLessThanOrEqual(255);
      expect(preset.b).toBeGreaterThanOrEqual(0);
      expect(preset.b).toBeLessThanOrEqual(255);
    }
  });

  it("keeps every preset brightness inside the [0,1] range used by the mode API", () => {
    for (const preset of SCENE_PRESETS) {
      expect(preset.brightness).toBeGreaterThan(0);
      expect(preset.brightness).toBeLessThanOrEqual(1);
    }
  });

  it("gives every preset a unique id (so React list keys and matching logic stay stable)", () => {
    const ids = SCENE_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("gives every preset a gradient string so tile thumbnails never render blank", () => {
    for (const preset of SCENE_PRESETS) {
      expect(preset.gradient).toMatch(/^linear-gradient\(/);
    }
  });
});

describe("findMatchingScenePreset", () => {
  it("returns undefined for null, undefined, or a color not in the catalog", () => {
    expect(findMatchingScenePreset(null)).toBeUndefined();
    expect(findMatchingScenePreset(undefined)).toBeUndefined();
    expect(findMatchingScenePreset({ r: 1, g: 2, b: 3 })).toBeUndefined();
  });

  it("matches each catalogued preset by exact RGB", () => {
    for (const preset of SCENE_PRESETS) {
      const match = findMatchingScenePreset({ r: preset.r, g: preset.g, b: preset.b });
      expect(match?.id).toBe(preset.id);
    }
  });

  it("returns undefined when any channel differs by one (no fuzzy match)", () => {
    const first = SCENE_PRESETS[0];
    expect(
      findMatchingScenePreset({ r: first.r + 1, g: first.g, b: first.b }),
    ).toBeUndefined();
  });
});
