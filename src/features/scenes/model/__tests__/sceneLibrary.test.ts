import type { TFunction } from "i18next";
import { describe, expect, it } from "vitest";

import { SCENE_LIMITS, type StoredScene } from "@/shared/contracts/scenes";
import type { LightingModeConfig } from "@/shared/contracts/mode";

import {
  DEFAULT_SCENE_LIST,
  SUGGESTED_SCENES,
  SUGGESTED_SCENE_ORDER,
  isSceneAvailable,
  readStoredScenes,
  sceneFromMode,
  sceneMatches,
  sceneName,
  sceneSmoothing,
  suggestedScene,
  toModeConfig,
  withScene,
  withSceneMovedTo,
  withSceneName,
  withoutScene,
} from "../sceneLibrary";

const t = ((key: string, opts?: Record<string, unknown>) =>
  opts ? `${key}:${JSON.stringify(opts)}` : key) as unknown as TFunction;

const scene = (id: string, look: Partial<StoredScene> = {}): StoredScene => ({
  id,
  kind: "solid",
  solid: { r: 10, g: 20, b: 30, brightness: 0.5 },
  ...look,
});

describe("readStoredScenes", () => {
  it("reads an absent list as the seeded one, and an empty list as empty", () => {
    expect(readStoredScenes(undefined).map((s) => s.suggestedId)).toEqual(DEFAULT_SCENE_LIST);
    expect(readStoredScenes("nope").map((s) => s.id)).toEqual(DEFAULT_SCENE_LIST.map((id) => `seed-${id}`));
    expect(readStoredScenes([])).toEqual([]);
  });

  it("keeps an entry it cannot play as written, and skips only one it cannot address", () => {
    const future = { id: "f", kind: "music", music: { band: 3 } };
    const read = readStoredScenes([future, { kind: "solid" }, { id: "" }, scene("a"), scene("a", { name: "dup" })]);
    expect(read).toEqual([future, scene("a")]);
    expect(isSceneAvailable(read[0]!)).toBe(false);
    expect(toModeConfig(read[0]!)).toBeNull();
  });

  it("marks an effect this build does not know unavailable, rather than playing the wave", () => {
    const unknown = scene("e", { kind: "effect", solid: undefined, effect: { id: "lava-lamp" as never, speed: 0.5, brightness: 1 } });
    expect(isSceneAvailable(unknown)).toBe(false);
    expect(toModeConfig(unknown)).toBeNull();
  });
});

describe("the suggested library", () => {
  it("plays every scene it suggests", () => {
    for (const id of SUGGESTED_SCENE_ORDER) {
      expect(toModeConfig(suggestedScene(id, id)), id).not.toBeNull();
    }
  });

  it("adds a copy: editing the added scene leaves the library alone", () => {
    const added = suggestedScene("movie", "x");
    added.ambilight!.brightness = 0.1;
    expect(SUGGESTED_SCENES.movie.ambilight.brightness).toBe(0.8);
  });
});

describe("sceneMatches", () => {
  const white = suggestedScene("warmEvening", "w");

  it("reads White by its temperature, not the r/g/b beside it", () => {
    const running: LightingModeConfig = { kind: "solid", solid: { r: 1, g: 2, b: 3, brightness: 0.55, kelvin: 2700 } };
    expect(sceneMatches(white, running, "moderate")).toBe(true);
    expect(sceneMatches(white, { kind: "solid", solid: { ...running.solid!, kelvin: 3000 } }, "moderate")).toBe(false);
    // The same r/g/b as a colour is not the white scene.
    const { kelvin: _k, ...rgb } = white.solid!;
    expect(sceneMatches(white, { kind: "solid", solid: rgb }, "moderate")).toBe(false);
  });

  it("tells a colour scene from White on the same r/g/b", () => {
    const colour = scene("c");
    expect(sceneMatches(colour, { kind: "solid", solid: { ...colour.solid!, kelvin: 4000 } }, "moderate")).toBe(false);
    expect(sceneMatches(colour, { kind: "solid", solid: { ...colour.solid! } }, "moderate")).toBe(true);
  });

  it("holds a brightness that took a round trip through a slider", () => {
    expect(sceneMatches(white, { kind: "solid", solid: { ...white.solid!, brightness: 0.5500001 } }, "moderate")).toBe(true);
    expect(sceneMatches(white, { kind: "solid", solid: { ...white.solid!, brightness: 0.56 } }, "moderate")).toBe(false);
  });

  it("ignores a sunrise's start, and settings the effect does not use", () => {
    const wake = suggestedScene("wakeUp", "s");
    const running: LightingModeConfig = {
      kind: "effect",
      effect: { ...wake.effect!, startedAtMs: 1_700_000_000_000, speed: 0.9, size: 0.2 },
    };
    expect(sceneMatches(wake, running, "moderate")).toBe(true);
    expect(sceneMatches(wake, { kind: "effect", effect: { ...wake.effect!, durationMinutes: 45 } }, "moderate")).toBe(false);
  });

  it("reads an effect's default palette as the palette it plays", () => {
    const fire = suggestedScene("fireplace", "f");
    expect(sceneMatches(fire, { kind: "effect", effect: { ...fire.effect!, palette: "fire" } }, "moderate")).toBe(true);
    expect(sceneMatches(fire, { kind: "effect", effect: { ...fire.effect!, palette: "ice" } }, "moderate")).toBe(false);
  });

  it("counts the smoothing as part of an Ambilight scene", () => {
    const movie = suggestedScene("movie", "m");
    const running: LightingModeConfig = { kind: "ambilight", ambilight: { brightness: 0.8, saturation: 1.1, blackBorderDetection: true } };
    expect(sceneMatches(movie, running, "subtle")).toBe(true);
    expect(sceneMatches(movie, running, "moderate")).toBe(false);
  });

  it("plays an Ambilight scene that names no smoothing at the default, and reads it that way", () => {
    const bare: StoredScene = { id: "a", kind: "ambilight", ambilight: { brightness: 1 } };
    expect(sceneSmoothing(bare)).toBe("moderate");
    expect(sceneMatches(bare, { kind: "ambilight", ambilight: { brightness: 1 } }, "moderate")).toBe(true);
  });

  it("never matches while the lights are off", () => {
    expect(sceneMatches(white, { kind: "off", solid: white.solid }, "moderate")).toBe(false);
  });
});

describe("sceneFromMode", () => {
  it("saves a sunrise without its start, so choosing it starts it over", () => {
    const look = sceneFromMode({ kind: "effect", effect: { id: "sunrise", speed: 0.5, brightness: 1, startedAtMs: 123 } }, "moderate");
    expect(look?.effect).not.toHaveProperty("startedAtMs");
    expect(toModeConfig({ id: "x", ...look! })?.effect).not.toHaveProperty("startedAtMs");
  });

  it("saves Ambilight with the smoothing it runs at, and without the retired fields", () => {
    const look = sceneFromMode({ kind: "ambilight", ambilight: { brightness: 0.7, smoothingAlpha: 0.2 } }, "intense");
    expect(look?.ambilight).toEqual({ brightness: 0.7, saturation: 1, blackBorderDetection: false, lightingSmoothingPreset: "intense" });
  });

  it("saves nothing for Off, and what it saves matches the light it came from", () => {
    expect(sceneFromMode({ kind: "off" }, "moderate")).toBeNull();
    const running: LightingModeConfig = { kind: "effect", effect: { id: "plasma", palette: "party", speed: 0.75, brightness: 1 } };
    expect(sceneMatches({ id: "p", ...sceneFromMode(running, "moderate")! }, running, "moderate")).toBe(true);
  });
});

describe("sceneName", () => {
  it("prefers the user's name, then the library's, then what it plays", () => {
    expect(sceneName({ ...suggestedScene("movie", "m"), name: "Cinema" }, t)).toBe("Cinema");
    expect(sceneName(suggestedScene("movie", "m"), t)).toBe("lights:scenes.suggested.movie");
    expect(sceneName(scene("c", { solid: { r: 255, g: 0, b: 16, brightness: 1 } }), t)).toBe("#FF0010");
    expect(sceneName(scene("w", { solid: { r: 1, g: 1, b: 1, brightness: 1, kelvin: 3000 } }), t)).toBe(
      'lights:scenes.whiteName:{"kelvin":3000}',
    );
    expect(sceneName(scene("u", { kind: "music" as never }), t)).toBe("lights:scenes.unknown");
  });
});

describe("list edits", () => {
  const list = [scene("a"), scene("b"), scene("c")];

  it("moves a scene to a place, the others closing up, and stops at the edges", () => {
    expect(withSceneMovedTo(list, "a", 2).map((s) => s.id)).toEqual(["b", "c", "a"]);
    expect(withSceneMovedTo(list, "c", 0).map((s) => s.id)).toEqual(["c", "a", "b"]);
    expect(withSceneMovedTo(list, "b", -3).map((s) => s.id)).toEqual(["b", "a", "c"]);
    expect(withSceneMovedTo(list, "b", 9).map((s) => s.id)).toEqual(["a", "c", "b"]);
    expect(withSceneMovedTo(list, "zz", 0).map((s) => s.id)).toEqual(["a", "b", "c"]);
  });

  it("stops adding at the limit", () => {
    const full = Array.from({ length: SCENE_LIMITS.maxScenes }, (_, i) => scene(`s${i}`));
    expect(withScene(full, scene("one-more"))).toHaveLength(SCENE_LIMITS.maxScenes);
    expect(withScene(list, scene("d")).map((s) => s.id)).toEqual(["a", "b", "c", "d"]);
  });

  it("renames by code point, and a blank name gives the scene its own name back", () => {
    const long = "😀".repeat(SCENE_LIMITS.nameMaxCodePoints + 5);
    expect(withSceneName(list, "a", `  ${long}  `)[0]!.name).toBe("😀".repeat(SCENE_LIMITS.nameMaxCodePoints));
    const named = withSceneName(list, "a", "Mine");
    expect(named[0]!.name).toBe("Mine");
    expect(withSceneName(named, "a", "   ")[0]).not.toHaveProperty("name");
  });

  it("deletes only the scene named", () => {
    expect(withoutScene(list, "b").map((s) => s.id)).toEqual(["a", "c"]);
  });
});
