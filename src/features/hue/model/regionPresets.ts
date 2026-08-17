// The Devices panel's coarse placements. Each is a position because the runtime
// samples positions and re-derives the region label — a region is an output.

export const HUE_REGION_PRESETS = ["left", "right", "top", "bottom", "center"] as const;

export type HueRegionPreset = (typeof HUE_REGION_PRESETS)[number];

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

/** Wide enough to absorb the float noise a zone-relative round-trip adds,
 *  narrow enough that a deliberate nudge in the room map reads as custom. */
const PRESET_EPSILON = 0.005;

/** Which preset a position sits on, or `null` for none. The `null` is the whole
 *  point: Rust's classifier always answers with one of the five, so a row that
 *  asked it could never say the position is the user's own. */
export function matchRegionPreset(x: number, y: number): HueRegionPreset | null {
  for (const preset of HUE_REGION_PRESETS) {
    const target = HUE_REGION_PRESET_POSITIONS[preset];
    if (
      Math.abs(x - target.x) <= PRESET_EPSILON &&
      Math.abs(y - target.y) <= PRESET_EPSILON
    ) {
      return preset;
    }
  }
  return null;
}

/** True when the position still equals the one the bridge reported, i.e. nothing
 *  local has moved this channel. Drives the outlined-vs-filled pill. */
export function isBridgePosition(
  x: number,
  y: number,
  bridgeX: number,
  bridgeY: number,
): boolean {
  return Math.abs(x - bridgeX) <= PRESET_EPSILON && Math.abs(y - bridgeY) <= PRESET_EPSILON;
}
