// The room around the furniture: a plank floor, walls with a lit top edge, the evening light, and
// the soft contact shadows that sit every piece on the floor.
import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  DirectionalLight,
  HemisphereLight,
  type Matrix4,
} from "three";

import { PALETTE } from "./palette";
import { block, type Part, seeded } from "./parts";

const PLANK_WIDTH = 0.19;
const PLANK_GAP = 0.005;
const PLANK_MIN = 0.9;
const PLANK_SPREAD = 1.3;
export const WALL_THICKNESS = 0.1;
const SKIRTING_HEIGHT = 0.07;

function shade(hex: number, factor: number): number {
  return new Color(hex).multiplyScalar(factor).getHex();
}

/** Planks laid along the room's longer side, staggered, each a shade of oak: real wood rows
 *  instead of a texture, merged into the floor's one draw call. */
export function floorParts(widthM: number, depthM: number): Part[] {
  const parts: Part[] = [block(widthM, 0.03, depthM, 0, -0.05, 0, PALETTE.floorGap, 0)];
  const alongX = widthM >= depthM;
  const length = alongX ? widthM : depthM;
  const across = alongX ? depthM : widthM;
  const rand = seeded(((widthM * 7.31 + depthM * 3.17) % 1) || 0.5);
  const rows = Math.ceil(across / PLANK_WIDTH);
  for (let r = 0; r < rows; r++) {
    const a0 = -across / 2 + r * PLANK_WIDTH;
    const a1 = Math.min(a0 + PLANK_WIDTH, across / 2);
    const plankAcross = a1 - a0 - PLANK_GAP;
    if (plankAcross <= 0.01) continue;
    let pos = -length / 2 - rand() * PLANK_MIN;
    while (pos < length / 2) {
      const span = PLANK_MIN + rand() * PLANK_SPREAD;
      const s0 = Math.max(pos, -length / 2);
      const s1 = Math.min(pos + span, length / 2);
      if (s1 - s0 > 0.03) {
        const base = PALETTE.planks[Math.floor(rand() * PALETTE.planks.length)] ?? PALETTE.planks[0];
        const color = shade(base, 0.97 + rand() * 0.05);
        const along = s1 - s0 - PLANK_GAP;
        const mid = (s0 + s1) / 2;
        const across0 = (a0 + a1) / 2;
        parts.push(
          alongX
            ? block(along, 0.02, plankAcross, mid, -0.02, across0, color, 0)
            : block(plankAcross, 0.02, along, across0, -0.02, mid, color, 0),
        );
      }
      pos += span;
    }
  }
  for (const [len, x, z, alongWidth] of [
    [widthM, 0, -depthM / 2 + 0.007, true],
    [widthM, 0, depthM / 2 - 0.007, true],
    [depthM, -widthM / 2 + 0.007, 0, false],
    [depthM, widthM / 2 - 0.007, 0, false],
  ] as const) {
    parts.push(
      alongWidth
        ? block(len, SKIRTING_HEIGHT, 0.014, x, 0, z, PALETTE.skirting, 0.004)
        : block(0.014, SKIRTING_HEIGHT, len, x, 0, z, PALETTE.skirting, 0.004),
    );
  }
  return parts;
}

/** One wall, one unit tall (the mesh's scale sets its height, so a cut is a scale change): its
 *  top face is the cut edge's lighter cap, its sides darken a little toward the floor. */
export function wallGeometry(alongX: boolean, span: number): BoxGeometry {
  const geometry = new BoxGeometry(alongX ? span : WALL_THICKNESS, 1, alongX ? WALL_THICKNESS : span);
  geometry.translate(0, 0.5, 0);
  const position = geometry.getAttribute("position");
  const normal = geometry.getAttribute("normal");
  const wall = new Color(PALETTE.wall);
  const cap = new Color(PALETTE.wallCap);
  const colours = new Float32Array(position.count * 3);
  for (let i = 0; i < position.count; i++) {
    const c = normal.getY(i) > 0.5 ? cap : wall.clone().multiplyScalar(0.86 + 0.14 * position.getY(i));
    colours.set([c.r, c.g, c.b], i * 3);
  }
  geometry.setAttribute("color", new BufferAttribute(colours, 3));
  return geometry;
}

export interface RoomLights {
  hemisphere: HemisphereLight;
  key: DirectionalLight;
  fill: DirectionalLight;
}

/** An evening interior: a cool sky over a warm floor bounce, a warm key that casts the one static
 *  shadow map, and a faint cool fill from the other side so no face goes flat black. */
export function roomLights(widthM: number, depthM: number, heightM: number, shadows: boolean): RoomLights {
  const hemisphere = new HemisphereLight(0xdde4ff, 0x3a2b21, 1.05);
  const key = new DirectionalLight(0xfff0dc, 1.75);
  // From the side the view opens on, so both far walls and the room's fronts catch it.
  key.position.set(0.35 * widthM, 1.4 * heightM + 2, 0.75 * depthM);
  key.castShadow = shadows;
  key.shadow.mapSize.set(1024, 1024);
  key.shadow.radius = 3;
  key.shadow.bias = -0.0005;
  key.shadow.normalBias = 0.02;
  const half = Math.max(widthM, depthM) * 0.75;
  Object.assign(key.shadow.camera, { left: -half, right: half, top: half, bottom: -half, near: 0.1, far: 40 });
  const fill = new DirectionalLight(0xa9b8e8, 0.35);
  fill.position.set(-0.7 * widthM, heightM + 1, -0.4 * depthM);
  return { hemisphere, key, fill };
}

const SHADOW_MARGIN = 0.12;
/** How far the shade where wall meets floor reaches into the room. */
const CORNER_SHADE_REACH = 0.32;
const CORNER_SHADE = 0.2;

/** A soft dark band along the foot of every wall, deepest where two walls meet: the occlusion a
 *  real room has there, which a room drawn without it looks pasted onto the floor for lacking. */
export function wallFootShade(widthM: number, depthM: number): BufferGeometry {
  const positions: number[] = [];
  const colours: number[] = [];
  const index: number[] = [];
  const y = 0.0025;
  const band = (ax: number, az: number, bx: number, bz: number, nx: number, nz: number) => {
    const base = positions.length / 3;
    const r = CORNER_SHADE_REACH;
    positions.push(ax, y, az, bx, y, bz, bx + nx * r, y, bz + nz * r, ax + nx * r, y, az + nz * r);
    colours.push(0, 0, 0, CORNER_SHADE, 0, 0, 0, CORNER_SHADE, 0, 0, 0, 0, 0, 0, 0, 0);
    index.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };
  const w = widthM / 2;
  const d = depthM / 2;
  band(-w, -d, w, -d, 0, 1);
  band(-w, d, w, d, 0, -1);
  band(-w, -d, -w, d, 1, 0);
  band(w, -d, w, d, -1, 0);
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(new Float32Array(positions), 3));
  geometry.setAttribute("color", new BufferAttribute(new Float32Array(colours), 4));
  geometry.setIndex(index);
  return geometry;
}

/** A soft shadow under a footprint: an opaque-ish core fading to nothing a margin outside it,
 *  built as geometry with per-vertex alpha so it keeps its edge width at any size and rotation —
 *  a stretched blur texture would smear on a long sofa. */
export function contactShadow(halfW: number, halfD: number, strength: number, place: Matrix4): BufferGeometry {
  const hw = Math.max(halfW - 0.02, 0.01);
  const hd = Math.max(halfD - 0.02, 0.01);
  const ow = halfW + SHADOW_MARGIN;
  const od = halfD + SHADOW_MARGIN;
  const y = 0.003;
  // Inner corners 0–3, outer corners 4–7, both clockwise from the back left.
  const positions = new Float32Array([
    -hw, y, -hd, hw, y, -hd, hw, y, hd, -hw, y, hd,
    -ow, y, -od, ow, y, -od, ow, y, od, -ow, y, od,
  ]);
  const colours = new Float32Array(8 * 4);
  for (let i = 0; i < 4; i++) colours[i * 4 + 3] = strength;
  const index = [0, 2, 1, 0, 3, 2];
  for (let i = 0; i < 4; i++) {
    const a = i;
    const b = (i + 1) % 4;
    index.push(a, b, b + 4, a, b + 4, a + 4);
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(positions, 3));
  geometry.setAttribute("color", new BufferAttribute(colours, 4));
  geometry.setIndex(index);
  geometry.applyMatrix4(place);
  return geometry;
}
