// The room's outline as the 3D room builds it: the plain rectangle, or an orthogonal polygon drawn on
// the plan. Free of three.js. Plan coordinates are metres from the top-left corner (x right, y down
// from the TV wall); scene coordinates centre the room's bounding box on the origin (x, z).

import type { RoomCorner } from "@/shared/contracts/roomMap";

/** A corner on the plan, in metres. */
export type PlanCorner = RoomCorner;

/** One wall's run along the outline, in scene coordinates. */
export interface OutlineEdge {
  ax: number;
  az: number;
  bx: number;
  bz: number;
  /** Unit normal pointing out of the room. */
  outwardX: number;
  outwardZ: number;
  length: number;
  /** Whether the room turns outward at each end — a corner a wall has to wrap. */
  convexA: boolean;
  convexB: boolean;
}

/** Twice the signed area; positive for a walk that keeps the room on its right, as the plan
 *  draws it (y down). */
function signedArea2(corners: readonly PlanCorner[]): number {
  let sum = 0;
  for (let i = 0; i < corners.length; i++) {
    const a = corners[i]!;
    const b = corners[(i + 1) % corners.length]!;
    sum += a.x * b.y - b.x * a.y;
  }
  return sum;
}

/** The outline's corners in one winding — the room on the right of every edge — starting where they
 *  were given. The rectangle when there is no polygon. */
export function outlineCorners(widthM: number, depthM: number, corners: readonly PlanCorner[] | null): PlanCorner[] {
  if (!corners || corners.length < 4) {
    return [
      { x: 0, y: 0 },
      { x: widthM, y: 0 },
      { x: widthM, y: depthM },
      { x: 0, y: depthM },
    ];
  }
  return signedArea2(corners) >= 0 ? [...corners] : [...corners].reverse();
}

/** Every wall of the outline, walking it with the room on the right. */
export function roomEdges(widthM: number, depthM: number, corners: readonly PlanCorner[] | null): OutlineEdge[] {
  const walk = outlineCorners(widthM, depthM, corners);
  const n = walk.length;
  const direction = (i: number) => {
    const a = walk[i]!;
    const b = walk[(i + 1) % n]!;
    const length = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    return { x: (b.x - a.x) / length, y: (b.y - a.y) / length };
  };
  // With y down and the room on the right, a turn to the right is a corner the room bulges out at.
  const convexAt = (i: number) => {
    const into = direction((i - 1 + n) % n);
    const out = direction(i);
    return into.x * out.y - into.y * out.x > 0;
  };
  return walk.map((a, i) => {
    const b = walk[(i + 1) % n]!;
    const d = direction(i);
    return {
      ax: a.x - widthM / 2,
      az: a.y - depthM / 2,
      bx: b.x - widthM / 2,
      bz: b.y - depthM / 2,
      // `|| 0` keeps a negative zero out of the numbers.
      outwardX: d.y || 0,
      outwardZ: -d.x || 0,
      length: Math.hypot(b.x - a.x, b.y - a.y),
      convexA: convexAt(i),
      convexB: convexAt((i + 1) % n),
    };
  });
}

/** Where a line across the room at `at` runs inside it, as sorted [from, to] intervals along the
 *  other axis. `alongX` lines run in x at a fixed plan y; otherwise in y at a fixed x. An orthogonal
 *  outline crosses such a line only on its edges at right angles to it. */
export function insideAlong(
  widthM: number,
  depthM: number,
  corners: readonly PlanCorner[] | null,
  alongX: boolean,
  at: number,
): Array<[number, number]> {
  const walk = outlineCorners(widthM, depthM, corners);
  const crossings: number[] = [];
  for (let i = 0; i < walk.length; i++) {
    const a = walk[i]!;
    const b = walk[(i + 1) % walk.length]!;
    const [a0, a1, cross] = alongX ? [a.y, b.y, a.x] : [a.x, b.x, a.y];
    const lo = Math.min(a0, a1);
    const hi = Math.max(a0, a1);
    // Half-open, so a line through a corner counts the edge on one side only.
    if (lo !== hi && at >= lo && at < hi) crossings.push(cross);
  }
  crossings.sort((p, q) => p - q);
  const intervals: Array<[number, number]> = [];
  for (let i = 0; i + 1 < crossings.length; i += 2) intervals.push([crossings[i]!, crossings[i + 1]!]);
  return intervals;
}

/** The distinct plan coordinates of the outline's corners along one axis, sorted: the lines where
 *  what is inside the room can change. */
export function cornerCoordinates(widthM: number, depthM: number, corners: readonly PlanCorner[] | null, axisX: boolean): number[] {
  const values = outlineCorners(widthM, depthM, corners).map((c) => (axisX ? c.x : c.y));
  return [...new Set(values)].sort((p, q) => p - q);
}
