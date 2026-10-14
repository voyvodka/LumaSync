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

import { cornerCoordinates, insideAlong, type OutlineEdge, type PlanCorner } from "../../model/roomOutline";
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

/** The outline as rectangles between its corner lines, in plan metres. */
function outlineRects(
  widthM: number,
  depthM: number,
  corners: readonly PlanCorner[] | null,
): Array<{ x0: number; x1: number; y0: number; y1: number }> {
  const ys = cornerCoordinates(widthM, depthM, corners, false);
  const rects: Array<{ x0: number; x1: number; y0: number; y1: number }> = [];
  for (let i = 0; i + 1 < ys.length; i++) {
    const y0 = ys[i]!;
    const y1 = ys[i + 1]!;
    for (const [x0, x1] of insideAlong(widthM, depthM, corners, true, (y0 + y1) / 2)) rects.push({ x0, x1, y0, y1 });
  }
  return rects;
}

/** Planks laid along the room's longer side, staggered, each a shade of oak: real wood rows
 *  instead of a texture, merged into the floor's one draw call. Inside an outline that is not a
 *  rectangle, a row runs only where the room does, and one that crosses a corner line is laid in
 *  two parts. */
export function floorParts(
  widthM: number,
  depthM: number,
  corners: readonly PlanCorner[] | null = null,
  edges: readonly OutlineEdge[] = [],
): Part[] {
  const parts: Part[] = outlineRects(widthM, depthM, corners).map((r) =>
    block(r.x1 - r.x0, 0.03, r.y1 - r.y0, (r.x0 + r.x1) / 2 - widthM / 2, -0.05, (r.y0 + r.y1) / 2 - depthM / 2, PALETTE.floorGap, 0),
  );
  const alongX = widthM >= depthM;
  const length = alongX ? widthM : depthM;
  const across = alongX ? depthM : widthM;
  const cuts = cornerCoordinates(widthM, depthM, corners, !alongX).map((c) => c - across / 2);
  const rand = seeded(((widthM * 7.31 + depthM * 3.17) % 1) || 0.5);
  const rows = Math.ceil(across / PLANK_WIDTH);
  for (let r = 0; r < rows; r++) {
    const a0 = -across / 2 + r * PLANK_WIDTH;
    const a1 = Math.min(a0 + PLANK_WIDTH, across / 2);
    const bounds = [a0, ...cuts.filter((c) => c > a0 && c < a1), a1];
    for (let k = 0; k + 1 < bounds.length; k++) {
      const b0 = bounds[k]!;
      const b1 = bounds[k + 1]!;
      const plankAcross = b1 - b0 - PLANK_GAP;
      if (plankAcross <= 0.01) continue;
      const across0 = (b0 + b1) / 2;
      for (const [from, to] of insideAlong(widthM, depthM, corners, alongX, across0 + across / 2)) {
        const l0 = from - length / 2;
        const l1 = to - length / 2;
        let pos = l0 - rand() * PLANK_MIN;
        while (pos < l1) {
          const span = PLANK_MIN + rand() * PLANK_SPREAD;
          const s0 = Math.max(pos, l0);
          const s1 = Math.min(pos + span, l1);
          if (s1 - s0 > 0.03) {
            const base = PALETTE.planks[Math.floor(rand() * PALETTE.planks.length)] ?? PALETTE.planks[0];
            const color = shade(base, 0.97 + rand() * 0.05);
            const along = s1 - s0 - PLANK_GAP;
            const mid = (s0 + s1) / 2;
            parts.push(
              alongX
                ? block(along, 0.02, plankAcross, mid, -0.02, across0, color, 0)
                : block(plankAcross, 0.02, along, across0, -0.02, mid, color, 0),
            );
          }
          pos += span;
        }
      }
    }
  }
  // Skirting along the inside of every wall.
  for (const e of edges) {
    const x = (e.ax + e.bx) / 2 - e.outwardX * 0.007;
    const z = (e.az + e.bz) / 2 - e.outwardZ * 0.007;
    parts.push(
      e.outwardZ !== 0
        ? block(e.length, SKIRTING_HEIGHT, 0.014, x, 0, z, PALETTE.skirting, 0.004)
        : block(0.014, SKIRTING_HEIGHT, e.length, x, 0, z, PALETTE.skirting, 0.004),
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
export function wallFootShade(edges: readonly OutlineEdge[]): BufferGeometry {
  const positions: number[] = [];
  const colours: number[] = [];
  const index: number[] = [];
  const y = 0.0025;
  const r = CORNER_SHADE_REACH;
  for (const e of edges) {
    const nx = -e.outwardX;
    const nz = -e.outwardZ;
    const base = positions.length / 3;
    positions.push(e.ax, y, e.az, e.bx, y, e.bz, e.bx + nx * r, y, e.bz + nz * r, e.ax + nx * r, y, e.az + nz * r);
    colours.push(0, 0, 0, CORNER_SHADE, 0, 0, 0, CORNER_SHADE, 0, 0, 0, 0, 0, 0, 0, 0);
    index.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
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
