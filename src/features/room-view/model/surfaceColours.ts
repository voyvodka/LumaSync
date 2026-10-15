// The room's surfaces as colours: what the 3D room draws the floor and walls in, and the discs the
// room settings offer them by. One table, so a swatch is the colour the room turns. No three.js
// here: the plan's settings read it from the main bundle.
import type { FloorFinish, WallColor } from "@/shared/contracts/roomMap";

const OAK_PLANKS = [0xa88c74, 0xa3876e, 0xac9079, 0xa0846b] as const;

/** Planks for the woods (`herringbone` laid in its zigzag, the rest in long rows), square slabs and
 *  their grout for the tiles and concrete (`alternate` every other one, as a checkerboard), one even
 *  weave for carpet (`size` 0). */
export const FLOOR_PALETTE = {
  oak: { planks: OAK_PLANKS, gap: 0x4a3426 },
  walnut: { planks: [0x6f4c34, 0x684730, 0x744f37, 0x63432e], gap: 0x2e2018 },
  ash: { planks: [0xd2bc9c, 0xcbb595, 0xd6c1a2, 0xc8b190], gap: 0x8a7860 },
  herringbone: { planks: [0x9c7a58, 0x93724f, 0xa58361, 0x8c6b4a], gap: 0x3f2c1e, herringbone: true },
  tileLight: { slab: 0xd8d3cb, gap: 0x9d968c, size: 0.6 },
  tileDark: { slab: 0x3d3f43, gap: 0x232428, size: 0.6 },
  checker: { slab: 0xe2ded6, alternate: 0x2c2d31, gap: 0x77736c, size: 0.4 },
  terracotta: { slab: 0xa95f3f, gap: 0x6e4a3a, size: 0.3 },
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
  navy: { wall: 0x34405a, cap: 0x535e76 },
  forest: { wall: 0x42564a, cap: 0x617468 },
  blush: { wall: 0xd6b5aa, cap: 0xe8d0c8 },
  ochre: { wall: 0xc4a05e, cap: 0xdabd85 },
} as const satisfies Record<WallColor, unknown>;

const css = (n: number) => `#${n.toString(16).padStart(6, "0")}`;

/** The disc a floor is offered by, drawn in its own pattern: rows of planks, a zigzag, a grid of
 *  slabs, a checkerboard, or one even colour. A CSS `background`. */
export function floorSwatchCss(finish: FloorFinish): string {
  const look: FloorLook = FLOOR_PALETTE[finish];
  if ("planks" in look) {
    const [a, b] = [css(look.planks[0]), css(look.planks[2])];
    return look.herringbone
      ? `repeating-linear-gradient(45deg, ${a} 0 3px, ${b} 3px 6px)`
      : `repeating-linear-gradient(0deg, ${a} 0 4px, ${css(look.gap)} 4px 5px, ${b} 5px 9px, ${css(look.gap)} 9px 10px)`;
  }
  if (look.alternate !== undefined) {
    return `repeating-conic-gradient(${css(look.slab)} 0 25%, ${css(look.alternate)} 0 50%) 0 0 / 8px 8px`;
  }
  if (look.size === 0) return css(look.slab);
  const cell = Math.round(6 + look.size * 4);
  const grout = css(look.gap);
  return `linear-gradient(${grout} 1px, transparent 1px) 0 0 / ${cell}px ${cell}px, linear-gradient(90deg, ${grout} 1px, transparent 1px) 0 0 / ${cell}px ${cell}px, ${css(look.slab)}`;
}

/** One floor's look, as the drawing reads it. */
export type FloorLook =
  | { planks: readonly [number, number, number, number]; gap: number; herringbone?: boolean }
  | { slab: number; gap: number; size: number; alternate?: number };

export function wallSwatchCss(paint: WallColor): string {
  return css(WALL_PALETTE[paint].wall);
}
