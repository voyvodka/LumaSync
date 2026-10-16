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

import { FLOOR_FINISHES, type FloorFinish, WALL_COLORS, type WallColor } from "@/shared/contracts/roomMap";

import { cornerCoordinates, insideAlong, type OutlineEdge, type PlanCorner } from "../../model/roomOutline";
import { FLOOR_PALETTE, type FloorLook, WALL_PALETTE } from "../../model/surfaceColours";
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
  finish: FloorFinish = FLOOR_FINISHES.OAK,
  gaps: ReadonlyMap<number, readonly WallGap[]> = new Map(),
): Part[] {
  const look: FloorLook = FLOOR_PALETTE[finish] ?? FLOOR_PALETTE.oak;
  const rects = outlineRects(widthM, depthM, corners);
  const parts: Part[] = rects.map((r) =>
    block(r.x1 - r.x0, 0.03, r.y1 - r.y0, (r.x0 + r.x1) / 2 - widthM / 2, -0.05, (r.y0 + r.y1) / 2 - depthM / 2, look.gap, 0),
  );
  if ("slab" in look) {
    slabs(parts, rects, widthM, depthM, look.slab, look.size, look.alternate);
    skirting(parts, edges, gaps);
    return parts;
  }
  if (look.herringbone) {
    herringbone(parts, rects, widthM, depthM, look.planks);
    skirting(parts, edges, gaps);
    return parts;
  }
  const planks = look.planks;
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
            const base = planks[Math.floor(rand() * planks.length)] ?? planks[0];
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
  skirting(parts, edges, gaps);
  return parts;
}

export interface WallGap {
  /** Along the wall's axis, in scene metres: x for a wall along x, z otherwise. */
  from: number;
  to: number;
}

export function openRuns(lo: number, hi: number, gaps: readonly WallGap[] = []): Array<[number, number]> {
  const runs: Array<[number, number]> = [];
  let at = lo;
  for (const gap of [...gaps].sort((a, b) => a.from - b.from)) {
    const end = Math.min(Math.max(gap.from, lo), hi);
    if (end - at > 0.01) runs.push([at, end]);
    at = Math.max(at, Math.min(gap.to, hi));
  }
  if (hi - at > 0.01) runs.push([at, hi]);
  return runs;
}

function skirting(parts: Part[], edges: readonly OutlineEdge[], gaps: ReadonlyMap<number, readonly WallGap[]>): void {
  edges.forEach((e, i) => {
    const alongX = e.outwardZ !== 0;
    const [lo, hi] = alongX ? [Math.min(e.ax, e.bx), Math.max(e.ax, e.bx)] : [Math.min(e.az, e.bz), Math.max(e.az, e.bz)];
    for (const [from, to] of openRuns(lo, hi, gaps.get(i))) {
      const mid = (from + to) / 2;
      parts.push(
        alongX
          ? block(to - from, SKIRTING_HEIGHT, 0.014, mid, 0, e.az - e.outwardZ * 0.007, PALETTE.skirting, 0.004)
          : block(0.014, SKIRTING_HEIGHT, to - from, e.ax - e.outwardX * 0.007, 0, mid, PALETTE.skirting, 0.004),
      );
    }
  });
}

/** Square slabs on a grid from the room's corner, cut to the outline; `size` 0 is one even sheet
 *  (carpet). Each slab varies a hair, so a tiled floor does not read as a flat colour. */
function slabs(
  parts: Part[],
  rects: readonly { x0: number; y0: number; x1: number; y1: number }[],
  widthM: number,
  depthM: number,
  colour: number,
  size: number,
  alternate?: number,
): void {
  const rand = seeded(((widthM * 5.13 + depthM * 2.71) % 1) || 0.5);
  const gap = size > 0 ? 0.004 : 0;
  for (const r of rects) {
    if (size === 0) {
      parts.push(block(r.x1 - r.x0, 0.02, r.y1 - r.y0, (r.x0 + r.x1) / 2 - widthM / 2, -0.02, (r.y0 + r.y1) / 2 - depthM / 2, colour, 0));
      continue;
    }
    for (let x = Math.floor(r.x0 / size) * size; x < r.x1 - 1e-6; x += size) {
      for (let y = Math.floor(r.y0 / size) * size; y < r.y1 - 1e-6; y += size) {
        const x0 = Math.max(x, r.x0);
        const x1 = Math.min(x + size, r.x1);
        const y0 = Math.max(y, r.y0);
        const y1 = Math.min(y + size, r.y1);
        if (x1 - x0 - gap <= 0.01 || y1 - y0 - gap <= 0.01) continue;
        const shadeBy = 0.96 + rand() * 0.06;
        // A checkerboard counts its squares from the room's corner, so the grid does not shift with a cut.
        const odd = alternate !== undefined && (Math.round(x / size) + Math.round(y / size)) % 2 !== 0;
        parts.push(
          block(x1 - x0 - gap, 0.02, y1 - y0 - gap, (x0 + x1) / 2 - widthM / 2, -0.02, (y0 + y1) / 2 - depthM / 2, shade(odd ? alternate : colour, shadeBy), 0),
        );
      }
    }
  }
}

const HERRING_WIDTH = 0.09;
const HERRING_LENGTH = 0.45;

/**
 * Herringbone: short planks laid in pairs at right angles, each one's end against the next one's
 * side, so the rows zigzag. On the lattice n·(w, −w) + m·(l, l) each point holds one plank along x
 * at [0, l] × [0, w] and one along y at [l, l + w] × [0, l]; that tiles the plane with no overlap.
 * Every plank is cut to the outline.
 */
function herringbone(
  parts: Part[],
  rects: readonly { x0: number; y0: number; x1: number; y1: number }[],
  widthM: number,
  depthM: number,
  planks: readonly number[],
): void {
  const w = HERRING_WIDTH;
  const l = HERRING_LENGTH;
  const rand = seeded(((widthM * 3.71 + depthM * 1.93) % 1) || 0.5);
  const lay = (x0: number, y0: number, x1: number, y1: number) => {
    const base = planks[Math.floor(rand() * planks.length)] ?? planks[0]!;
    const colour = shade(base, 0.96 + rand() * 0.07);
    for (const r of rects) {
      const cx0 = Math.max(x0, r.x0);
      const cx1 = Math.min(x1, r.x1);
      const cy0 = Math.max(y0, r.y0);
      const cy1 = Math.min(y1, r.y1);
      if (cx1 - cx0 - PLANK_GAP <= 0.01 || cy1 - cy0 - PLANK_GAP <= 0.01) continue;
      parts.push(
        block(cx1 - cx0 - PLANK_GAP, 0.02, cy1 - cy0 - PLANK_GAP, (cx0 + cx1) / 2 - widthM / 2, -0.02, (cy0 + cy1) / 2 - depthM / 2, colour, 0),
      );
    }
  };
  // u = x + y = 2ml, v = x − y = 2nw at a lattice point; each plank reaches l + w beyond its point.
  const mFrom = Math.floor(-(l + w) / (2 * l)) - 1;
  const mTo = Math.ceil((widthM + depthM) / (2 * l)) + 1;
  const nFrom = Math.floor(-(depthM + l + w) / (2 * w)) - 1;
  const nTo = Math.ceil((widthM + l + w) / (2 * w)) + 1;
  for (let m = mFrom; m <= mTo; m++) {
    for (let n = nFrom; n <= nTo; n++) {
      const px = n * w + m * l;
      const py = -n * w + m * l;
      if (px > widthM || py > depthM || px + l + w < 0 || py + l < 0) continue;
      lay(px, py, px + l, py + w);
      lay(px + l, py, px + l + w, py + l);
    }
  }
}

/** One wall, one unit tall (the mesh's scale sets its height, so a cut is a scale change): its
 *  top face is the cut edge's lighter cap, its sides darken a little toward the floor. */
export function wallGeometry(alongX: boolean, span: number, paint: WallColor = WALL_COLORS.WARM_WHITE): BoxGeometry {
  const geometry = new BoxGeometry(alongX ? span : WALL_THICKNESS, 1, alongX ? WALL_THICKNESS : span);
  geometry.translate(0, 0.5, 0);
  const position = geometry.getAttribute("position");
  const normal = geometry.getAttribute("normal");
  const look = WALL_PALETTE[paint] ?? WALL_PALETTE.warmWhite;
  const wall = new Color(look.wall);
  const cap = new Color(look.cap);
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
  // Low enough that the lamps' pools carry the room, as an evening interior does; high enough that
  // every piece still reads.
  const hemisphere = new HemisphereLight(0xdde4ff, 0x3a2b21, 0.8);
  const key = new DirectionalLight(0xfff0dc, 1.35);
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
export function wallFootShade(edges: readonly OutlineEdge[], gaps: ReadonlyMap<number, readonly WallGap[]> = new Map()): BufferGeometry {
  const positions: number[] = [];
  const colours: number[] = [];
  const index: number[] = [];
  const y = 0.0025;
  const r = CORNER_SHADE_REACH;
  edges.forEach((e, i) => {
    const nx = -e.outwardX;
    const nz = -e.outwardZ;
    const alongX = e.outwardZ !== 0;
    const [lo, hi] = alongX ? [Math.min(e.ax, e.bx), Math.max(e.ax, e.bx)] : [Math.min(e.az, e.bz), Math.max(e.az, e.bz)];
    for (const [from, to] of openRuns(lo, hi, gaps.get(i))) {
      const [ax, az, bx, bz] = alongX ? [from, e.az, to, e.az] : [e.ax, from, e.ax, to];
      const base = positions.length / 3;
      positions.push(ax, y, az, bx, y, bz, bx + nx * r, y, bz + nz * r, ax + nx * r, y, az + nz * r);
      colours.push(0, 0, 0, CORNER_SHADE, 0, 0, 0, CORNER_SHADE, 0, 0, 0, 0, 0, 0, 0, 0);
      index.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
  });
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
