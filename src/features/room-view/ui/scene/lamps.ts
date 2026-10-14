// A Hue light in the room, drawn as its fixture: a static body (pole, base, canopy, bar) merged with
// the furniture, and the lit part — the shade, the bar's back, the strip — as the lamp's instance in
// the one bulb mesh, so a live colour later recolours an instance instead of rebuilding the room.
import type { LampFamily } from "../../model/lampFamily";
import type { ScenePoint } from "../../model/roomSpace";
import { PALETTE } from "./palette";
import { block, type Part, rod } from "./parts";

/** The lit part: where it sits and its radii (an ellipsoid). */
export interface LampGlow {
  at: ScenePoint;
  radii: [number, number, number];
}

export interface LampFixture {
  body: Part[];
  glow: LampGlow;
}

const CANOPY = 0xefe9df;
const BAR = 0x1d1e21;
const BULB_RADIUS = 0.055;

/** The fixture for one light at `at`, standing on a surface at `surface` (the floor or the top of
 *  the piece under it), in a room `ceiling` high. The light's own point stays where the bridge or
 *  the map put it; the body is drawn around it. */
export function lampFixture(family: LampFamily, at: ScenePoint, surface: number, ceiling: number): LampFixture {
  const { x, z } = at;
  const y = Math.max(at.y, surface + 0.05);
  switch (family) {
    case "playBar": {
      // A Play bar stands about 25 cm tall on its foot; one placed higher hangs on the wall.
      const half = 0.125;
      const bottom = Math.max(surface, y - half);
      const standing = bottom - surface < 0.03;
      const body = [block(0.045, half * 2, 0.04, x, bottom, z, BAR, 0.008)];
      if (standing) body.push(block(0.07, 0.012, 0.06, x, surface, z, BAR, 0.004));
      return { body, glow: { at: { x, y: bottom + half, z }, radii: [0.024, half * 0.9, 0.024] } };
    }
    case "lightstrip":
      return { body: [], glow: { at: { x, y, z }, radii: [0.32, 0.012, 0.012] } };
    case "tube":
      return { body: [], glow: { at: { x, y, z }, radii: [0.3, 0.02, 0.02] } };
    case "floorLamp": {
      const shadeY = Math.max(y, 0.6);
      return {
        body: [
          rod(0.15, 0.16, 0.02, x, 0, z, PALETTE.metal, 24),
          rod(0.012, 0.012, Math.max(shadeY - 0.12, 0.05), x, 0.02, z, PALETTE.metal, 8),
        ],
        glow: { at: { x, y: shadeY, z }, radii: [0.17, 0.13, 0.17] },
      };
    }
    case "signe": {
      const height = 1.45;
      return {
        body: [rod(0.12, 0.13, 0.015, x, surface, z, PALETTE.metal, 20), block(0.03, height, 0.03, x, surface + 0.015, z, BAR, 0.006)],
        glow: { at: { x, y: surface + 0.015 + height / 2, z }, radii: [0.022, height * 0.47, 0.022] },
      };
    }
    case "tableLamp": {
      const shadeY = Math.max(y, surface + 0.28);
      return {
        body: [rod(0.055, 0.075, Math.max(shadeY - surface - 0.1, 0.05), x, surface, z, CANOPY, 16)],
        glow: { at: { x, y: shadeY, z }, radii: [0.13, 0.1, 0.13] },
      };
    }
    case "pendant": {
      const shadeY = Math.min(y, ceiling - 0.3);
      return {
        body: [
          rod(0.004, 0.004, Math.max(ceiling - shadeY - 0.06, 0.02), x, shadeY + 0.06, z, BAR, 6),
          rod(0.06, 0.06, 0.02, x, ceiling - 0.02, z, CANOPY, 16),
        ],
        glow: { at: { x, y: shadeY, z }, radii: [0.18, 0.09, 0.18] },
      };
    }
    case "ceiling":
      return {
        body: [rod(0.2, 0.2, 0.03, x, ceiling - 0.03, z, CANOPY, 32)],
        glow: { at: { x, y: ceiling - 0.04, z }, radii: [0.19, 0.025, 0.19] },
      };
    case "portable": {
      const domeY = surface + 0.075;
      return {
        body: [rod(0.1, 0.105, 0.015, x, surface, z, CANOPY, 24)],
        glow: { at: { x, y: domeY, z }, radii: [0.1, 0.07, 0.1] },
      };
    }
    case "spot": {
      const headY = Math.max(y, surface + 0.12);
      return {
        body: [rod(0.04, 0.045, 0.02, x, surface, z, BAR, 12), rod(0.01, 0.01, Math.max(headY - surface - 0.06, 0.02), x, surface + 0.02, z, BAR, 6)],
        glow: { at: { x, y: headY, z }, radii: [0.045, 0.045, 0.045] },
      };
    }
    case "wall":
      return { body: [], glow: { at: { x, y, z }, radii: [0.1, 0.14, 0.06] } };
    default:
      return { body: [], glow: { at: { x, y, z }, radii: [BULB_RADIUS, BULB_RADIUS, BULB_RADIUS] } };
  }
}
