import type { TFunction } from "i18next";

import { customColorsOf, effectSwatch, paletteOf, paletteStops } from "@/features/mode/model/effectSwatch";
import { EFFECT_CATALOGUE, EFFECT_DEFAULTS, EFFECT_IDS, type EffectParam } from "@/shared/contracts/effects";
import { DEFAULT_LIGHTING_SMOOTHING_PRESET, type LightingSmoothingPreset } from "@/shared/contracts/lighting";
import {
  LIGHTING_MODE_KIND,
  normalizeAmbilightPayload,
  normalizeEffectPayload,
  normalizeSolidColorPayload,
  type AmbilightPayload,
  type EffectPayload,
  type LightingModeConfig,
  type SolidColorPayload,
} from "@/shared/contracts/mode";
import {
  SCENE_LIMITS,
  SUGGESTED_SCENE_IDS,
  type SceneKind,
  type StoredScene,
  type SuggestedSceneId,
} from "@/shared/contracts/scenes";
import { kelvinToRgb, rgbToHex } from "@/shared/lib/color";

/** What a scene plays, without its place in the list. */
export type SceneLook = Pick<StoredScene, "kind" | "solid" | "ambilight" | "effect">;

function white(kelvin: number, brightness: number): SceneLook {
  return { kind: LIGHTING_MODE_KIND.SOLID, solid: normalizeSolidColorPayload({ ...kelvinToRgb(kelvin), brightness, kelvin }) };
}

function colour(r: number, g: number, b: number, brightness: number): SceneLook {
  return { kind: LIGHTING_MODE_KIND.SOLID, solid: { r, g, b, brightness } };
}

function effect(payload: Partial<EffectPayload> & Pick<EffectPayload, "id">): SceneLook {
  return {
    kind: LIGHTING_MODE_KIND.EFFECT,
    effect: { speed: EFFECT_DEFAULTS.speed, brightness: EFFECT_DEFAULTS.brightness, ...payload },
  };
}

/** The suggested library. A scene added from it is a copy: changing this later changes no one's list. */
export const SUGGESTED_SCENES = {
  [SUGGESTED_SCENE_IDS.MOVIE]: {
    kind: LIGHTING_MODE_KIND.AMBILIGHT,
    ambilight: { brightness: 0.8, saturation: 1.1, blackBorderDetection: true, lightingSmoothingPreset: "subtle" },
  },
  [SUGGESTED_SCENE_IDS.GAME]: {
    kind: LIGHTING_MODE_KIND.AMBILIGHT,
    ambilight: { brightness: 1, saturation: 1.2, blackBorderDetection: false, lightingSmoothingPreset: "intense" },
  },
  [SUGGESTED_SCENE_IDS.WARM_EVENING]: white(2700, 0.55),
  [SUGGESTED_SCENE_IDS.READING]: white(4000, 0.9),
  [SUGGESTED_SCENE_IDS.FOCUS]: white(5500, 1),
  [SUGGESTED_SCENE_IDS.NIGHT_LIGHT]: colour(255, 110, 20, 0.12),
  [SUGGESTED_SCENE_IDS.SUNSET]: colour(217, 82, 30, 0.85),
  [SUGGESTED_SCENE_IDS.DEEP_BLUE]: colour(40, 70, 255, 0.7),
  [SUGGESTED_SCENE_IDS.FIREPLACE]: effect({ id: EFFECT_IDS.FIREPLACE, speed: 0.5, brightness: 0.8 }),
  [SUGGESTED_SCENE_IDS.CANDLELIGHT]: effect({ id: EFFECT_IDS.CANDLE, speed: 0.4, brightness: 0.6 }),
  [SUGGESTED_SCENE_IDS.AURORA]: effect({ id: EFFECT_IDS.AURORA, speed: 0.35, brightness: 0.8 }),
  [SUGGESTED_SCENE_IDS.OCEAN]: effect({ id: EFFECT_IDS.OCEAN, speed: 0.4, brightness: 0.8 }),
  [SUGGESTED_SCENE_IDS.PARTY]: effect({ id: EFFECT_IDS.PLASMA, palette: "party", speed: 0.75, brightness: 1 }),
  [SUGGESTED_SCENE_IDS.WAKE_UP]: effect({ id: EFFECT_IDS.SUNRISE, durationMinutes: 30, brightness: 1 }),
  [SUGGESTED_SCENE_IDS.DAYLIGHT]: effect({ id: EFFECT_IDS.NATURAL_LIGHT, brightness: 1 }),
} satisfies Record<SuggestedSceneId, SceneLook>;

/** The library's order, as its popover lists it. */
export const SUGGESTED_SCENE_ORDER = Object.values(SUGGESTED_SCENE_IDS) as readonly SuggestedSceneId[];

/** What a fresh install shows, and what an absent `scenes` key reads as. */
export const DEFAULT_SCENE_LIST: readonly SuggestedSceneId[] = [
  SUGGESTED_SCENE_IDS.MOVIE,
  SUGGESTED_SCENE_IDS.GAME,
  SUGGESTED_SCENE_IDS.WARM_EVENING,
  SUGGESTED_SCENE_IDS.READING,
  SUGGESTED_SCENE_IDS.FIREPLACE,
  SUGGESTED_SCENE_IDS.AURORA,
];

const SUGGESTED_ID_VALUES: ReadonlySet<string> = new Set(SUGGESTED_SCENE_ORDER);
const SCENE_KINDS: ReadonlySet<unknown> = new Set<SceneKind>([
  LIGHTING_MODE_KIND.AMBILIGHT,
  LIGHTING_MODE_KIND.SOLID,
  LIGHTING_MODE_KIND.EFFECT,
]);
const EFFECT_ID_VALUES: ReadonlySet<unknown> = new Set(Object.values(EFFECT_IDS));

export function suggestedScene(suggestedId: SuggestedSceneId, id: string): StoredScene {
  return { id, suggestedId, ...structuredClone(SUGGESTED_SCENES[suggestedId]) };
}

function seededScenes(): StoredScene[] {
  return DEFAULT_SCENE_LIST.map((suggestedId) => suggestedScene(suggestedId, `seed-${suggestedId}`));
}

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object";

/**
 * `ShellState.scenes` as a list. Absent (or not a list) is the seeded list; `[]` stays empty. An
 * entry is kept as written — only one without an id, or repeating an earlier id, is left out, since
 * nothing could address it, and so is gone from disk after the next edit.
 */
export function readStoredScenes(stored: unknown): StoredScene[] {
  if (!Array.isArray(stored)) return seededScenes();
  const seen = new Set<string>();
  const scenes: StoredScene[] = [];
  for (const entry of stored) {
    if (!isRecord(entry) || typeof entry.id !== "string" || entry.id === "" || seen.has(entry.id)) continue;
    seen.add(entry.id);
    scenes.push(entry as unknown as StoredScene);
  }
  return scenes;
}

/** Whether this build can play it: a kind and, for an effect, an id it knows. */
export function isSceneAvailable(scene: StoredScene): boolean {
  if (!SCENE_KINDS.has(scene.kind)) return false;
  const payload = scene[scene.kind];
  if (!isRecord(payload)) return false;
  return scene.kind !== LIGHTING_MODE_KIND.EFFECT || EFFECT_ID_VALUES.has((payload as EffectPayload).id);
}

/** The mode a press applies: the scene's kind and its payload; Rust keeps the other kinds' settings. */
export function toModeConfig(scene: StoredScene): LightingModeConfig | null {
  if (!isSceneAvailable(scene)) return null;
  switch (scene.kind) {
    case LIGHTING_MODE_KIND.SOLID:
      return { kind: scene.kind, solid: normalizeSolidColorPayload(scene.solid) };
    case LIGHTING_MODE_KIND.AMBILIGHT:
      return { kind: scene.kind, ambilight: ambilightLook(scene.ambilight) };
    case LIGHTING_MODE_KIND.EFFECT: {
      const { startedAtMs: _started, ...look } = normalizeEffectPayload(scene.effect);
      return { kind: scene.kind, effect: look };
    }
  }
}

/**
 * The smoothing an Ambilight scene plays at — the default when it names none, as `sceneMatches`
 * reads it. Rust reads it from the global preference.
 */
export function sceneSmoothing(scene: StoredScene): LightingSmoothingPreset | undefined {
  if (scene.kind !== LIGHTING_MODE_KIND.AMBILIGHT) return undefined;
  return normalizeAmbilightPayload(scene.ambilight).lightingSmoothingPreset ?? DEFAULT_LIGHTING_SMOOTHING_PRESET;
}

/** Only what an Ambilight look is: the deprecated fields a normalised payload carries stay out. */
function ambilightLook(input: AmbilightPayload | null | undefined, smoothing?: LightingSmoothingPreset): AmbilightPayload {
  const payload = normalizeAmbilightPayload(input);
  const preset = smoothing ?? payload.lightingSmoothingPreset;
  return {
    brightness: payload.brightness,
    saturation: payload.saturation,
    blackBorderDetection: payload.blackBorderDetection,
    ...(preset ? { lightingSmoothingPreset: preset } : {}),
  };
}

/** Slider values land on whole percents; a float that took a round trip is still the same value. */
const near = (a: number | null | undefined, b: number | null | undefined) => Math.abs((a ?? 0) - (b ?? 0)) < 0.005;

function solidMatches(scene: SolidColorPayload, running: SolidColorPayload): boolean {
  if (!near(scene.brightness, running.brightness)) return false;
  // White is its temperature: the r/g/b beside it are only what Rust derives.
  if (scene.kelvin != null) return running.kelvin === scene.kelvin;
  return running.kelvin == null && scene.r === running.r && scene.g === running.g && scene.b === running.b;
}

const PARAM_DEFAULTS = {
  speed: (e: EffectPayload) => e.speed,
  size: (e: EffectPayload) => e.size ?? EFFECT_DEFAULTS.size,
  intensity: (e: EffectPayload) => e.intensity ?? EFFECT_DEFAULTS.intensity,
  direction: (e: EffectPayload) => e.direction ?? EFFECT_DEFAULTS.direction,
  durationMinutes: (e: EffectPayload) => e.durationMinutes ?? EFFECT_DEFAULTS.durationMinutes,
} satisfies Record<EffectParam, (e: EffectPayload) => unknown>;

/** Compared on what the effect uses: a setting it does not declare cannot tell two runs apart. */
function effectMatches(scene: EffectPayload, running: EffectPayload): boolean {
  if (scene.id !== running.id || !near(scene.brightness, running.brightness)) return false;
  const spec = EFFECT_CATALOGUE[scene.id];
  for (const param of spec.params) {
    const a = PARAM_DEFAULTS[param](scene);
    const b = PARAM_DEFAULTS[param](running);
    if (typeof a === "number" && typeof b === "number" ? !near(a, b) : a !== b) return false;
  }
  if (spec.colorSource === "none") return true;
  const palette = paletteOf(scene);
  if (palette !== paletteOf(running)) return false;
  if (palette !== "custom") return true;
  const own = customColorsOf(scene).map(rgbToHex).join();
  return own === customColorsOf(running).map(rgbToHex).join();
}

/** Whether the running mode is this scene — a sunrise's start time aside. */
export function sceneMatches(scene: StoredScene, mode: LightingModeConfig, smoothing: LightingSmoothingPreset): boolean {
  if (!isSceneAvailable(scene) || scene.kind !== mode.kind) return false;
  switch (scene.kind) {
    case LIGHTING_MODE_KIND.SOLID:
      return solidMatches(normalizeSolidColorPayload(scene.solid), normalizeSolidColorPayload(mode.solid ?? undefined));
    case LIGHTING_MODE_KIND.AMBILIGHT: {
      const own = ambilightLook(scene.ambilight);
      const running = normalizeAmbilightPayload(mode.ambilight);
      return (
        near(own.brightness, running.brightness) &&
        near(own.saturation, running.saturation) &&
        own.blackBorderDetection === running.blackBorderDetection &&
        (own.lightingSmoothingPreset ?? DEFAULT_LIGHTING_SMOOTHING_PRESET) === smoothing
      );
    }
    case LIGHTING_MODE_KIND.EFFECT:
      return effectMatches(normalizeEffectPayload(scene.effect), normalizeEffectPayload(mode.effect));
  }
}

/** The running light as a scene to save; Off is none. A sunrise saves without its start. */
export function sceneFromMode(mode: LightingModeConfig, smoothing: LightingSmoothingPreset): SceneLook | null {
  switch (mode.kind) {
    case LIGHTING_MODE_KIND.SOLID:
      return { kind: mode.kind, solid: normalizeSolidColorPayload(mode.solid ?? undefined) };
    case LIGHTING_MODE_KIND.AMBILIGHT:
      return { kind: mode.kind, ambilight: ambilightLook(mode.ambilight, smoothing) };
    case LIGHTING_MODE_KIND.EFFECT: {
      const { startedAtMs: _started, ...look } = normalizeEffectPayload(mode.effect);
      return { kind: mode.kind, effect: look };
    }
    default:
      return null;
  }
}

const rgbCss = ({ r, g, b }: { r: number; g: number; b: number }) => `rgb(${r} ${g} ${b})`;
/**
 * Ambilight follows the screen, so its scenes show one, coloured by how it follows it: a slow,
 * calm response reads warm, a quick one cool.
 */
const SCREEN_SWATCH = {
  subtle: "linear-gradient(135deg, rgb(120 40 90), rgb(220 90 50) 55%, rgb(255 180 80))",
  moderate: "linear-gradient(135deg, rgb(58 96 255), rgb(150 70 230) 50%, rgb(255 140 60))",
  intense: "linear-gradient(135deg, rgb(30 200 255), rgb(90 80 255) 50%, rgb(240 60 200))",
} satisfies Record<LightingSmoothingPreset, string>;

/** A CSS background for the scene's chip: its colour, its effect in its palette, or a screen. */
export function sceneSwatch(scene: StoredScene): string {
  if (!isSceneAvailable(scene)) return "var(--lm-panel-2)";
  switch (scene.kind) {
    case LIGHTING_MODE_KIND.SOLID: {
      const solid = normalizeSolidColorPayload(scene.solid);
      return rgbCss(solid.kelvin != null ? kelvinToRgb(solid.kelvin) : solid);
    }
    case LIGHTING_MODE_KIND.AMBILIGHT:
      return SCREEN_SWATCH[sceneSmoothing(scene) ?? DEFAULT_LIGHTING_SMOOTHING_PRESET];
    case LIGHTING_MODE_KIND.EFFECT: {
      const look = normalizeEffectPayload(scene.effect);
      return effectSwatch(look.id, paletteStops(paletteOf(look), look));
    }
  }
}

/** The user's name, else the library's, else what it plays. */
export function sceneName(scene: StoredScene, t: TFunction): string {
  if (scene.name) return scene.name;
  if (scene.suggestedId && SUGGESTED_ID_VALUES.has(scene.suggestedId)) {
    return t(`lights:scenes.suggested.${scene.suggestedId}`);
  }
  if (!isSceneAvailable(scene)) return t("lights:scenes.unknown");
  switch (scene.kind) {
    case LIGHTING_MODE_KIND.SOLID: {
      const solid = normalizeSolidColorPayload(scene.solid);
      return solid.kelvin != null
        ? t("lights:scenes.whiteName", { kelvin: solid.kelvin })
        : rgbToHex(solid).toUpperCase();
    }
    case LIGHTING_MODE_KIND.AMBILIGHT:
      return t("common:mode.options.ambilight");
    case LIGHTING_MODE_KIND.EFFECT:
      return t(`lights:effect.names.${normalizeEffectPayload(scene.effect).id}`);
  }
}

// ---------------------------------------------------------------------------
// List edits — pure, so a write can replay them on the latest stored list
// ---------------------------------------------------------------------------

/** Appended; the list is left as it was when it is already full. */
export function withScene(scenes: readonly StoredScene[], scene: StoredScene): StoredScene[] {
  return scenes.length >= SCENE_LIMITS.maxScenes ? [...scenes] : [...scenes, scene];
}

export function withoutScene(scenes: readonly StoredScene[], id: string): StoredScene[] {
  return scenes.filter((scene) => scene.id !== id);
}

/** Moved to `to`, the others closing up behind it; a place past either end is the end. */
export function withSceneMovedTo(scenes: readonly StoredScene[], id: string, to: number): StoredScene[] {
  const next = [...scenes];
  const from = next.findIndex((scene) => scene.id === id);
  if (from === -1) return next;
  const [scene] = next.splice(from, 1);
  next.splice(Math.max(0, Math.min(next.length, to)), 0, scene!);
  return next;
}

/** Renamed; a blank name clears it, back to the library's name or what it plays. */
export function withSceneName(scenes: readonly StoredScene[], id: string, name: string): StoredScene[] {
  // By code point, so an emoji at the cut is not split in half.
  const trimmed = Array.from(name.trim()).slice(0, SCENE_LIMITS.nameMaxCodePoints).join("").trim();
  return scenes.map((scene) => {
    if (scene.id !== id) return scene;
    const { name: _previous, ...rest } = scene;
    return trimmed === "" ? rest : { ...rest, name: trimmed };
  });
}
