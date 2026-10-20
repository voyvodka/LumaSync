import {
  MAX_STRIP_CORNERS,
  type RoomCorner,
  resolveStripCorners,
  stripPoints,
  type UsbStripPlacement,
} from "@/shared/contracts/roomMap";

export interface StripLeg {
  a: RoomCorner;
  b: RoomCorner;
  length: number;
}

/** The straight runs between a strip's start, its corners and its end, in order. */
export function stripLegs(strip: UsbStripPlacement): StripLeg[] {
  const points = stripPoints(strip);
  const legs: StripLeg[] = [];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    legs.push({ a, b, length: Math.hypot(b.x - a.x, b.y - a.y) });
  }
  return legs;
}

/** The point `distance` metres along the run from its start, held to the run. */
export function pointAlongStrip(strip: UsbStripPlacement, distance: number): RoomCorner {
  const legs = stripLegs(strip);
  let left = Math.max(0, distance);
  for (const leg of legs) {
    if (left <= leg.length || leg === legs[legs.length - 1]) {
      const k = leg.length < 1e-9 ? 0 : Math.min(1, left / leg.length);
      return { x: leg.a.x + (leg.b.x - leg.a.x) * k, y: leg.a.y + (leg.b.y - leg.a.y) * k };
    }
    left -= leg.length;
  }
  return { x: strip.startX, y: strip.startY };
}

/** How the strip's LEDs fall across its legs, by length, adding up to its LED count. */
export function ledsPerLeg(legs: readonly StripLeg[], ledCount: number): number[] {
  const total = legs.reduce((sum, leg) => sum + leg.length, 0);
  if (total < 1e-9) return legs.map((_, i) => (i === 0 ? ledCount : 0));
  let walked = 0;
  let given = 0;
  return legs.map((leg) => {
    walked += leg.length;
    const upTo = Math.round((walked / total) * ledCount);
    const count = upTo - given;
    given = upTo;
    return count;
  });
}

const mm = (v: number) => Math.round(v * 1000) / 1000;

/**
 * The strip with a corner put on leg `leg` (0 is the one from its start) at `at`, held to that leg;
 * without `at`, in the middle of its longest leg. `null` once it has as many corners as it may.
 */
export function addStripCorner<T extends UsbStripPlacement>(strip: T, leg?: number, at?: RoomCorner): T | null {
  const corners = resolveStripCorners(strip);
  if (corners.length >= MAX_STRIP_CORNERS) return null;
  const legs = stripLegs(strip);
  const index = leg ?? legs.reduce((best, l, i) => (l.length > legs[best]!.length ? i : best), 0);
  const on = legs[index];
  if (!on) return null;
  const dx = on.b.x - on.a.x;
  const dy = on.b.y - on.a.y;
  const k = at && on.length > 1e-9 ? Math.min(1, Math.max(0, ((at.x - on.a.x) * dx + (at.y - on.a.y) * dy) / (on.length * on.length))) : 0.5;
  const corner = { x: mm(on.a.x + dx * k), y: mm(on.a.y + dy * k) };
  return { ...strip, corners: [...corners.slice(0, index), corner, ...corners.slice(index)] };
}

/** The strip without its corner `index`; the last one gone leaves it straight. */
export function removeStripCorner<T extends UsbStripPlacement>(strip: T, index: number): T {
  const corners = resolveStripCorners(strip).filter((_, i) => i !== index);
  return { ...strip, corners: corners.length > 0 ? corners : null };
}
