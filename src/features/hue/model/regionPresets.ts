// The coarse placements the retired Devices region overrides mapped onto. Kept
// only for the schemaVersion 5 → 6 fold, which turns each stored region string
// into the position it always meant; nothing in the UI reads these.

export type HueRegionPreset = "left" | "right" | "top" | "bottom" | "center";

/** Full-magnitude on purpose: `left` should mean the far left, not the nearest
 *  point Rust would still classify as left. `y` is depth, +1 being the TV wall,
 *  which is why `top`/`bottom` are labelled Near/Far in the UI. */
export const HUE_REGION_PRESET_POSITIONS: Record<
  HueRegionPreset,
  { readonly x: number; readonly y: number }
> = {
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
  top: { x: 0, y: 1 },
  bottom: { x: 0, y: -1 },
  center: { x: 0, y: 0 },
};
