// The room's surfaces as colours: what the 3D room draws the floor and walls in, and the discs the
// room settings offer them by. One table, so a swatch is the colour the room turns. No three.js
// here: the plan's settings read it from the main bundle.
import type { FloorFinish, WallColor } from "@/shared/contracts/roomMap";

const OAK_PLANKS = [0xa88c74, 0xa3876e, 0xac9079, 0xa0846b] as const;

/** Planks for the woods, square slabs and their grout for the tiles and concrete, one even weave
 *  for carpet (`size` 0). */
export const FLOOR_PALETTE = {
  oak: { planks: OAK_PLANKS, gap: 0x4a3426 },
  walnut: { planks: [0x6f4c34, 0x684730, 0x744f37, 0x63432e], gap: 0x2e2018 },
  ash: { planks: [0xd2bc9c, 0xcbb595, 0xd6c1a2, 0xc8b190], gap: 0x8a7860 },
  tileLight: { slab: 0xd8d3cb, gap: 0x9d968c, size: 0.6 },
  tileDark: { slab: 0x3d3f43, gap: 0x232428, size: 0.6 },
  concrete: { slab: 0x98968f, gap: 0x7a7872, size: 1.2 },
  carpet: { slab: 0x857e74, gap: 0x857e74, size: 0 },
} as const satisfies Record<FloorFinish, unknown>;

/** The walls' paints, each with the lighter cap a cut wall shows on top. */
export const WALL_PALETTE = {
  warmWhite: { wall: 0xe4ddd2, cap: 0xf4f0ea },
  coolWhite: { wall: 0xdde1e4, cap: 0xeef1f3 },
  greige: { wall: 0xc8beb1, cap: 0xe0d8ce },
  sage: { wall: 0xa7b19d, cap: 0xc6cdbe },
  clay: { wall: 0xc49a80, cap: 0xdcbaa5 },
  charcoal: { wall: 0x4b4d52, cap: 0x6a6c71 },
} as const satisfies Record<WallColor, unknown>;

const css = (n: number) => `#${n.toString(16).padStart(6, "0")}`;

export function floorSwatchCss(finish: FloorFinish): string {
  const look = FLOOR_PALETTE[finish];
  return css("slab" in look ? look.slab : look.planks[0]);
}

export function wallSwatchCss(paint: WallColor): string {
  return css(WALL_PALETTE[paint].wall);
}
