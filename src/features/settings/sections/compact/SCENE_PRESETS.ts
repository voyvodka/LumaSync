/**
 * Scene presets shown in compact mode (UI Mockup Rev 07 — `10-compact.html`).
 *
 * Each preset is a "mood tile" with a CSS gradient background and a single
 * representative color that the app actually drives. Tapping a tile switches
 * the active mode to SOLID with that color (current brightness preserved).
 *
 * Future Phase 3.5 may extend each entry with `{ brightness, saturation,
 * smoothing }` overrides for ambilight-mode scene presets, once those
 * controls land in the AmbilightPayload contract. For now the gradient is
 * purely visual and clicks behave like the legacy color presets did.
 */

export interface ScenePreset {
  id: string;
  labelKey: string;
  /** CSS background applied to the tile thumbnail. */
  gradient: string;
  /** Single color the SOLID mode jumps to when the tile is clicked. */
  r: number;
  g: number;
  b: number;
}

export const SCENE_PRESETS: readonly ScenePreset[] = [
  {
    id: "movie",
    labelKey: "general.compact.scenes.movie",
    gradient: "linear-gradient(135deg,#2a1235,#6a1c50,#d9521e,#ffb030)",
    r: 217, g: 82, b: 30,
  },
  {
    id: "game",
    labelKey: "general.compact.scenes.game",
    gradient: "linear-gradient(135deg,#0a1838,#1e4878,#66b4ff,#a8e0ff)",
    r: 102, g: 180, b: 255,
  },
  {
    id: "music",
    labelKey: "general.compact.scenes.music",
    gradient: "linear-gradient(135deg,#1a0a22,#3e1858,#a03878,#ff6a88)",
    r: 255, g: 106, b: 136,
  },
  {
    id: "chill",
    labelKey: "general.compact.scenes.chill",
    gradient: "linear-gradient(135deg,#1a1305,#4e3010,#d9821e,#ffc860)",
    r: 217, g: 130, b: 30,
  },
  {
    id: "read",
    labelKey: "general.compact.scenes.read",
    gradient: "linear-gradient(135deg,#0a1a0a,#1e4428,#4cad70,#a8e0b4)",
    r: 168, g: 224, b: 180,
  },
] as const;
