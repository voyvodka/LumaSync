/**
 * Scenes: whole looks the user keeps under the mode strip, one press each. Frontend-only — stored
 * in `ShellState.scenes`, which Rust carries through without reading; applying one is an ordinary
 * `apply_outputs` with the scene's mode.
 */

import type { AmbilightPayload, EffectPayload, LightingModeKind, SolidColorPayload } from "./mode";

/** The suggested library's scenes; also the `lights:scenes.suggested.*` name keys. */
export const SUGGESTED_SCENE_IDS = {
  MOVIE: "movie",
  GAME: "game",
  WARM_EVENING: "warmEvening",
  READING: "reading",
  FOCUS: "focus",
  NIGHT_LIGHT: "nightLight",
  SUNSET: "sunset",
  DEEP_BLUE: "deepBlue",
  FIREPLACE: "fireplace",
  CANDLELIGHT: "candlelight",
  AURORA: "aurora",
  OCEAN: "ocean",
  PARTY: "party",
  WAKE_UP: "wakeUp",
  DAYLIGHT: "daylight",
} as const;

export type SuggestedSceneId = (typeof SUGGESTED_SCENE_IDS)[keyof typeof SUGGESTED_SCENE_IDS];

/** A scene is a running look; Off is not one. */
export type SceneKind = Exclude<LightingModeKind, "off">;

/**
 * One entry of `ShellState.scenes`, flat like `LightingModeConfig`: only the payload of its `kind`
 * is set. Read leniently and kept as written — a kind or effect a newer build saved stays in the
 * list, shown unavailable, and is never rewritten into something this build knows. `scenes` stays
 * a list: a later shape needs a new key, since this build leaves a non-list unedited.
 */
export interface StoredScene {
  /** A uuid; the seeded list uses `seed-<suggestedId>`. */
  id: string;
  /** Set when it came from the library; its localised name shows until the user renames it. */
  suggestedId?: SuggestedSceneId;
  /** The user's name, trimmed and at most `SCENE_LIMITS.nameMaxCodePoints`. */
  name?: string;
  kind: SceneKind;
  solid?: SolidColorPayload;
  /** Its `lightingSmoothingPreset` is the scene's smoothing, saved to the global preference on apply. */
  ambilight?: AmbilightPayload;
  /** Never carries `startedAtMs`: a sunrise scene starts over each time it is chosen. */
  effect?: EffectPayload;
}

export const SCENE_LIMITS = {
  maxScenes: 24,
  nameMaxCodePoints: 40,
} as const;
