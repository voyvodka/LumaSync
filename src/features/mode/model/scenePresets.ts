/**
 * Shared scene preset catalog used by both the full Lights page and the
 * compact tray layout. Each preset is a "mood tile" with a CSS gradient
 * background plus the single representative color the app actually drives.
 *
 * Clicking a tile switches the active mode to SOLID with the preset's RGB.
 * Brightness defaults to `preset.brightness` when the user wasn't already
 * in SOLID mode; if they were, their current brightness is preserved so
 * manual adjustments survive a scene click.
 */

export interface ScenePreset {
  id: string;
  labelKey: string;
  /** CSS `background` value applied to the tile thumbnail. */
  gradient: string;
  r: number;
  g: number;
  b: number;
  /** Default brightness used when entering SOLID mode from a non-SOLID state. */
  brightness: number;
}

export const SCENE_PRESETS: readonly ScenePreset[] = [
  {
    id: "movie",
    labelKey: "general.compact.scenes.movie",
    gradient: "linear-gradient(135deg,#2a1235,#6a1c50,#d9521e,#ffb030)",
    r: 217, g: 82, b: 30,
    brightness: 0.85,
  },
  {
    id: "game",
    labelKey: "general.compact.scenes.game",
    gradient: "linear-gradient(135deg,#0a1838,#1e4878,#66b4ff,#a8e0ff)",
    r: 102, g: 180, b: 255,
    brightness: 0.9,
  },
  {
    id: "music",
    labelKey: "general.compact.scenes.music",
    gradient: "linear-gradient(135deg,#1a0a22,#3e1858,#a03878,#ff6a88)",
    r: 255, g: 106, b: 136,
    brightness: 0.9,
  },
  {
    id: "chill",
    labelKey: "general.compact.scenes.chill",
    gradient: "linear-gradient(135deg,#1a1305,#4e3010,#d9821e,#ffc860)",
    r: 255, g: 200, b: 96,
    brightness: 0.75,
  },
  {
    id: "read",
    labelKey: "general.compact.scenes.read",
    gradient: "linear-gradient(135deg,#0a1a0a,#1e4428,#4cad70,#a8e0b4)",
    r: 76, g: 173, b: 112,
    brightness: 0.75,
  },
] as const;

/** Returns the preset whose RGB matches the supplied color, if any. */
export function findMatchingScenePreset(
  color: { r: number; g: number; b: number } | null | undefined,
): ScenePreset | undefined {
  if (!color) return undefined;
  return SCENE_PRESETS.find(
    (preset) => preset.r === color.r && preset.g === color.g && preset.b === color.b,
  );
}
