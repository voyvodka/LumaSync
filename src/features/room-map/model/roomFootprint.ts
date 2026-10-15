// The room's outline as the editor offers it: a rectangle, an L, a U or a T, each told by where its
// cut is and how big. Reads any outline the contract accepts back into those terms, so the typed
// fields show what is stored; one it cannot name is "custom" and only a new shape replaces it.
import {
  ROOM_FOOTPRINT_MIN_WALL_M,
  type RoomCorner,
  type RoomDimensions,
  resolveRoomFootprint,
} from "@/shared/contracts/roomMap";

export const FOOTPRINT_KINDS = ["rect", "L", "U", "T"] as const;
export type FootprintKind = (typeof FOOTPRINT_KINDS)[number];

/** The corner an L's cut is taken from, as the plan shows it (the TV wall at the top). */
export const FOOTPRINT_CORNERS = ["topLeft", "topRight", "bottomRight", "bottomLeft"] as const;
export type FootprintCorner = (typeof FOOTPRINT_CORNERS)[number];

/** The wall a U's notch opens in, or the one a T's stem reaches. */
export const FOOTPRINT_SIDES = ["top", "right", "bottom", "left"] as const;
export type FootprintSide = (typeof FOOTPRINT_SIDES)[number];

export type FootprintShape =
  | { kind: "rect" }
  /** `width` along x and `depth` along y of the piece cut away. */
  | { kind: "L"; corner: FootprintCorner; width: number; depth: number }
  /** `width` along the wall, `depth` into the room, `offset` from the wall's start (left or top). */
  | { kind: "U"; side: FootprintSide; width: number; depth: number; offset: number }
  /** `width` of the stem along its wall, `depth` of the stem out of the bar, `offset` as for a U. */
  | { kind: "T"; side: FootprintSide; width: number; depth: number; offset: number }
  | { kind: "custom" };

const MIN = ROOM_FOOTPRINT_MIN_WALL_M;
const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(lo, hi));
const round = (v: number) => Math.round(v * 1000) / 1000;

/** The longest a cut can run along `span` and still leave a wall of the minimum on each side. */
const reach = (span: number, walls: number) => span - walls * MIN;

/** A new shape of `kind` at a size that reads at once: a quarter of the room for an L, a third of
 *  the wall and half the room for a notch or a stem. */
export function defaultFootprintShape(kind: FootprintKind, dims: RoomDimensions): FootprintShape {
  const { widthMeters: w, depthMeters: d } = dims;
  switch (kind) {
    case "rect":
      return { kind: "rect" };
    case "L":
      return { kind: "L", corner: "bottomRight", width: round(w / 2), depth: round(d / 2) };
    case "U":
      return { kind: "U", side: "bottom", width: round(w / 3), depth: round(d / 2), offset: round(w / 3) };
    case "T":
      return { kind: "T", side: "bottom", width: round(w / 3), depth: round(d / 2), offset: round(w / 3) };
  }
}

const alongX = (side: FootprintSide) => side === "top" || side === "bottom";

/** Keeps every wall the shape makes at least the minimum long inside `dims`. */
export function clampFootprintShape(shape: FootprintShape, dims: RoomDimensions): FootprintShape {
  const { widthMeters: w, depthMeters: d } = dims;
  if (shape.kind === "L") {
    return { ...shape, width: round(clamp(shape.width, MIN, reach(w, 1))), depth: round(clamp(shape.depth, MIN, reach(d, 1))) };
  }
  if (shape.kind === "U" || shape.kind === "T") {
    const span = alongX(shape.side) ? w : d;
    const into = alongX(shape.side) ? d : w;
    const width = round(clamp(shape.width, MIN, reach(span, 2)));
    const offset = round(clamp(shape.offset, MIN, span - width - MIN));
    return { ...shape, width, depth: round(clamp(shape.depth, MIN, reach(into, 1))), offset };
  }
  return shape;
}

/** Turns a shape drawn against the top wall (x along it, y into the room) to face `side`. */
function orient(points: RoomCorner[], side: FootprintSide, dims: RoomDimensions): RoomCorner[] {
  const { widthMeters: w, depthMeters: d } = dims;
  switch (side) {
    case "top":
      return points;
    case "bottom":
      return points.map((p) => ({ x: p.x, y: d - p.y }));
    case "left":
      return points.map((p) => ({ x: p.y, y: p.x }));
    case "right":
      return points.map((p) => ({ x: w - p.y, y: p.x }));
  }
}

/** The outline a shape stores, or undefined for the rectangle (the writer drops the key then). */
export function buildFootprint(shape: FootprintShape, dims: RoomDimensions): RoomCorner[] | undefined {
  const s = clampFootprintShape(shape, dims);
  const { widthMeters: w, depthMeters: d } = dims;
  let corners: RoomCorner[];
  switch (s.kind) {
    case "rect":
    case "custom":
      return undefined;
    case "L": {
      const left = s.corner === "topLeft" || s.corner === "bottomLeft";
      const top = s.corner === "topLeft" || s.corner === "topRight";
      const cx = left ? s.width : w - s.width;
      const cy = top ? s.depth : d - s.depth;
      const bx = left ? 0 : w;
      const by = top ? 0 : d;
      // The rectangle with its cut corner replaced by the three corners of the step, in the order
      // the walk meets them: it reaches the top-right and bottom-left corners along a level wall.
      const levelFirst = s.corner === "topRight" || s.corner === "bottomLeft";
      const rect = [
        { x: 0, y: 0 },
        { x: w, y: 0 },
        { x: w, y: d },
        { x: 0, y: d },
      ];
      corners = rect.flatMap((c) =>
        c.x === bx && c.y === by
          ? levelFirst
            ? [
                { x: cx, y: c.y },
                { x: cx, y: cy },
                { x: c.x, y: cy },
              ]
            : [
                { x: c.x, y: cy },
                { x: cx, y: cy },
                { x: cx, y: c.y },
              ]
          : [c],
      );
      break;
    }
    case "U":
    case "T": {
      // Drawn against the top wall, then turned: for a U a notch cut down from that wall, for a T
      // the two cuts beside the stem, which reaches the top wall.
      const span = alongX(s.side) ? w : d;
      const into = alongX(s.side) ? d : w;
      const a = s.offset;
      const b = s.offset + s.width;
      const local =
        s.kind === "U"
          ? [
              { x: 0, y: 0 },
              { x: a, y: 0 },
              { x: a, y: s.depth },
              { x: b, y: s.depth },
              { x: b, y: 0 },
              { x: span, y: 0 },
              { x: span, y: into },
              { x: 0, y: into },
            ]
          : [
              { x: a, y: 0 },
              { x: b, y: 0 },
              { x: b, y: s.depth },
              { x: span, y: s.depth },
              { x: span, y: into },
              { x: 0, y: into },
              { x: 0, y: s.depth },
              { x: a, y: s.depth },
            ];
      corners = orient(local, s.side, dims);
      break;
    }
  }
  return resolveRoomFootprint({ dimensions: dims, footprint: corners });
}

/** What the stored outline is, in the editor's terms. */
export function describeFootprint(footprint: RoomCorner[] | undefined, dims: RoomDimensions): FootprintShape {
  const corners = resolveRoomFootprint({ dimensions: dims, footprint });
  if (corners.length === 4) return { kind: "rect" };
  // The cheapest honest read: try every shape this editor makes and keep the one that rebuilds to
  // exactly the same outline.
  const same = (a: RoomCorner[] | undefined) =>
    !!a && a.length === corners.length && a.every((c, i) => c.x === corners[i]!.x && c.y === corners[i]!.y);
  const xs = [...new Set(corners.map((c) => c.x))];
  const ys = [...new Set(corners.map((c) => c.y))];
  const { widthMeters: w, depthMeters: d } = dims;
  if (corners.length === 6) {
    for (const corner of FOOTPRINT_CORNERS) {
      for (const x of xs) {
        for (const y of ys) {
          const left = corner === "topLeft" || corner === "bottomLeft";
          const top = corner === "topLeft" || corner === "topRight";
          const shape: FootprintShape = { kind: "L", corner, width: round(left ? x : w - x), depth: round(top ? y : d - y) };
          if (same(buildFootprint(shape, dims))) return shape;
        }
      }
    }
  }
  if (corners.length === 8) {
    for (const kind of ["U", "T"] as const) {
      for (const side of FOOTPRINT_SIDES) {
        const along = alongX(side) ? xs : ys;
        const across = alongX(side) ? ys : xs;
        const into = alongX(side) ? d : w;
        for (const a of along) {
          for (const b of along) {
            if (b <= a) continue;
            for (const c of across) {
              const depth = side === "top" || side === "left" ? c : into - c;
              const shape: FootprintShape = { kind, side, width: round(b - a), depth: round(depth), offset: round(a) };
              if (same(buildFootprint(shape, dims))) return shape;
            }
          }
        }
      }
    }
  }
  return { kind: "custom" };
}

/** The outline after the room's size changes: corners on its edges stay on them, the ones inside
 *  move by half the growth, as every object in the room does. Undefined when there is none. */
export function resizeFootprint(
  footprint: RoomCorner[] | undefined,
  from: RoomDimensions,
  to: RoomDimensions,
): RoomCorner[] | undefined {
  const corners = resolveRoomFootprint({ dimensions: from, footprint });
  if (corners.length === 4) return undefined;
  const dx = (to.widthMeters - from.widthMeters) / 2;
  const dy = (to.depthMeters - from.depthMeters) / 2;
  const moved = corners.map((c) => ({
    x: c.x === 0 ? 0 : c.x === from.widthMeters ? to.widthMeters : round(c.x + dx),
    y: c.y === 0 ? 0 : c.y === from.depthMeters ? to.depthMeters : round(c.y + dy),
  }));
  const resolved = resolveRoomFootprint({ dimensions: to, footprint: moved });
  return resolved.length === 4 ? undefined : resolved;
}

/** The smallest room the outline fits: every inner corner keeps its distance from the centre, and
 *  every wall at least the minimum. */
export function footprintMinimumSize(
  footprint: RoomCorner[] | undefined,
  dims: RoomDimensions,
): { widthMeters: number; depthMeters: number } {
  const corners = resolveRoomFootprint({ dimensions: dims, footprint });
  let width = 0;
  let depth = 0;
  for (const c of corners) {
    if (c.x !== 0 && c.x !== dims.widthMeters) width = Math.max(width, 2 * Math.abs(c.x - dims.widthMeters / 2) + 2 * MIN);
    if (c.y !== 0 && c.y !== dims.depthMeters) depth = Math.max(depth, 2 * Math.abs(c.y - dims.depthMeters / 2) + 2 * MIN);
  }
  return { widthMeters: round(width), depthMeters: round(depth) };
}

/** A wall of the outline the plan lets you drag: one inside the room's box, so moving it changes
 *  the shape and not the room's size. */
export interface MovableWall {
  index: number;
  /** Level walls move up and down, plumb ones left and right. */
  axis: "x" | "y";
  a: RoomCorner;
  b: RoomCorner;
}

/** The walls of `corners` that do not lie on the room's edges. */
export function movableWalls(corners: readonly RoomCorner[], dims: RoomDimensions): MovableWall[] {
  if (corners.length === 4) return [];
  const walls: MovableWall[] = [];
  corners.forEach((a, index) => {
    const b = corners[(index + 1) % corners.length]!;
    if (a.y === b.y) {
      if (a.y !== 0 && a.y !== dims.depthMeters) walls.push({ index, axis: "y", a, b });
    } else if (a.x !== 0 && a.x !== dims.widthMeters) {
      walls.push({ index, axis: "x", a, b });
    }
  });
  return walls;
}

/** The outline with wall `index` moved `delta` metres along its axis, to the centimetre; null when
 *  that would make an outline the contract refuses, so a drag stops at the last good place. */
export function moveFootprintWall(
  corners: readonly RoomCorner[],
  dims: RoomDimensions,
  index: number,
  delta: number,
): RoomCorner[] | null {
  const n = corners.length;
  const a = corners[index];
  const b = corners[(index + 1) % n];
  if (!a || !b) return null;
  const axis = a.y === b.y ? "y" : "x";
  const to = Math.round((a[axis] + delta) * 100) / 100;
  const moved = corners.map((c, i) => (i === index || i === (index + 1) % n ? { ...c, [axis]: to } : c));
  const resolved = resolveRoomFootprint({ dimensions: dims, footprint: moved });
  return resolved.length === n ? resolved : null;
}

/** A notch cut into one wall of a plain rectangle where it was double-clicked: 60 cm wide (or what
 *  fits) and 40 cm deep, centred on the point. Undefined when the room is already shaped. */
export function notchAt(
  corners: readonly RoomCorner[],
  dims: RoomDimensions,
  side: FootprintSide,
  along: number,
): RoomCorner[] | undefined {
  if (corners.length !== 4) return undefined;
  const span = alongX(side) ? dims.widthMeters : dims.depthMeters;
  const width = Math.min(0.6, reach(span, 2));
  return buildFootprint({ kind: "U", side, width, depth: 0.4, offset: along - width / 2 }, dims);
}
