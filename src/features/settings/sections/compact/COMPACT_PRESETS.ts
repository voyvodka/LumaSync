/**
 * Static color presets shown in compact mode.
 * Tapping a preset switches to SOLID mode with the chosen color
 * (current brightness preserved).
 *
 * `labelKey` is resolved against `general.compact.presetNames.*` in the
 * common namespace, so labels stay in sync with the active i18n locale.
 */

export interface CompactPreset {
  id: string;
  labelKey: string;
  r: number;
  g: number;
  b: number;
}

export const COMPACT_PRESETS: readonly CompactPreset[] = [
  { id: "warm-white", labelKey: "general.compact.presetNames.warmWhite", r: 255, g: 220, b: 180 },
  { id: "cool-white", labelKey: "general.compact.presetNames.coolWhite", r: 200, g: 220, b: 255 },
  { id: "red",        labelKey: "general.compact.presetNames.red",       r: 255, g: 40,  b: 40  },
  { id: "green",      labelKey: "general.compact.presetNames.green",     r: 40,  g: 220, b: 80  },
  { id: "blue",       labelKey: "general.compact.presetNames.blue",      r: 40,  g: 90,  b: 255 },
  { id: "purple",     labelKey: "general.compact.presetNames.purple",    r: 180, g: 60,  b: 220 },
] as const;
