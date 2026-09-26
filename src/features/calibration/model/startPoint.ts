import type { LedDirection, LedSegmentCounts, LedSegmentKey } from "./contracts";

/** One LED: its edge and its index along that edge in canonical order (top L→R, right T→B, bottom R→L, left B→T). */
export interface LedRef {
  edge: LedSegmentKey;
  k: number;
}

export interface StartPoint {
  led: LedRef;
  direction: LedDirection;
}

export type Corner = "tl" | "tr" | "br" | "bl";

/** What a person can find on the strip; anything else is just its edge. */
export type PlaceName =
  | { kind: "corner"; corner: Corner }
  | { kind: "gapRight" }
  | { kind: "gapLeft" }
  | { kind: "edge"; edge: LedSegmentKey };

interface Slot extends LedRef {
  /** Position around the frame, clockwise from the top-left corner, dark stretches included. */
  pi: number;
  /** Length of that loop, dark stretches included. */
  L: number;
}

export interface StripShape {
  counts: LedSegmentCounts;
  gap: number;
}

export const same = (a: LedRef | null | undefined, b: LedRef | null | undefined): boolean =>
  !!a && !!b && a.edge === b.edge && a.k === b.k;

/**
 * LEDs to the right of the stand gap. Mirrors `resolveBottomGapAnchorLocalIndex`
 * (indexMapping.ts) and `resolve_bottom_gap_local` (led_calibration.rs), so an
 * odd bottom puts its extra LED on the same side the output does.
 */
export const gapRightCount = (bottom: number): number => Math.floor(bottom / 2);

/** The frame clockwise from the top-left corner; `null` marks a stretch with no LEDs (stand gap, missing edge). */
function perimeter({ counts, gap }: StripShape): Array<LedRef | null> {
  const seq: Array<LedRef | null> = [];
  const run = (edge: LedSegmentKey, from: number, to: number) => {
    for (let k = from; k < to; k += 1) seq.push({ edge, k });
  };
  for (const edge of ["top", "right", "bottom", "left"] as const) {
    const n = counts[edge];
    if (n <= 0) {
      seq.push(null);
      continue;
    }
    if (edge === "bottom" && gap > 0) {
      run("bottom", 0, gapRightCount(n));
      seq.push(null);
      run("bottom", gapRightCount(n), n);
    } else run(edge, 0, n);
  }
  return seq;
}

export function leds(shape: StripShape): Slot[] {
  const seq = perimeter(shape);
  const out: Slot[] = [];
  seq.forEach((p, pi) => {
    if (p) out.push({ ...p, pi, L: seq.length });
  });
  return out;
}

function ledAt(shape: StripShape, ref: LedRef): Slot | null {
  return leds(shape).find((p) => same(p, ref)) ?? null;
}

/** Physically next to each other on the strip — no stand gap or missing edge in between. */
export const adjacent = (a: Slot, b: Slot): boolean => (a.pi + 1) % a.L === b.pi || (b.pi + 1) % b.L === a.pi;

/**
 * The strip's two ends when something interrupts the loop: A is where it
 * starts heading clockwise, B where it ends. `null` for a closed loop.
 */
export function ends(shape: StripShape): { A: Slot; B: Slot } | null {
  const seq = perimeter(shape);
  const i0 = seq.indexOf(null);
  if (i0 < 0) return null;
  const all = leds(shape);
  const rotated = [...all.filter((p) => p.pi > i0), ...all.filter((p) => p.pi < i0)];
  const A = rotated[0];
  const B = rotated[rotated.length - 1];
  return A && B ? { A, B } : null;
}

/** A corner is where two edges meet; which LED is "at" it depends on the way the strip leaves. */
const CORNER_LEDS: Record<Corner, Record<LedDirection, [LedSegmentKey, "first" | "last"]>> = {
  tl: { cw: ["top", "first"], ccw: ["left", "last"] },
  tr: { cw: ["right", "first"], ccw: ["top", "last"] },
  br: { cw: ["bottom", "first"], ccw: ["right", "last"] },
  bl: { cw: ["left", "first"], ccw: ["bottom", "last"] },
};

export function cornerLed(shape: StripShape, corner: Corner, direction: LedDirection): StartPoint | null {
  const at = ([edge, which]: [LedSegmentKey, "first" | "last"]): LedRef | null => {
    const n = shape.counts[edge];
    if (n <= 0) return null;
    return { edge, k: which === "first" ? 0 : n - 1 };
  };
  const own = at(CORNER_LEDS[corner][direction]);
  if (own) return { led: own, direction };
  const other: LedDirection = direction === "cw" ? "ccw" : "cw";
  const fallback = at(CORNER_LEDS[corner][other]);
  return fallback ? { led: fallback, direction: other } : null;
}

/** The corner an edge's end LED sits at. */
function cornerOf(shape: StripShape, p: LedRef): Corner | null {
  const n = shape.counts[p.edge];
  if (p.k !== 0 && p.k !== n - 1) return null;
  const at: Record<LedSegmentKey, [Corner, Corner]> = {
    top: ["tl", "tr"],
    right: ["tr", "br"],
    bottom: ["br", "bl"],
    left: ["bl", "tl"],
  };
  return p.k === 0 ? at[p.edge][0] : at[p.edge][1];
}

const hasGap = (shape: StripShape) => shape.gap > 0 && shape.counts.bottom > 0;

export function placeName(shape: StripShape, p: LedRef): PlaceName {
  if (p.edge === "bottom" && hasGap(shape)) {
    const right = gapRightCount(shape.counts.bottom);
    if (p.k === right - 1) return { kind: "gapRight" };
    if (p.k === right) return { kind: "gapLeft" };
  }
  const corner = cornerOf(shape, p);
  if (corner) return { kind: "corner", corner };
  return { kind: "edge", edge: p.edge };
}

/** Open strip: its first end, heading in. Closed loop: bottom-left, clockwise. */
export function defaultStart(shape: StripShape): StartPoint | null {
  const en = ends(shape);
  if (en) return { led: { edge: en.A.edge, k: en.A.k }, direction: "cw" };
  return cornerLed(shape, "bl", "cw");
}

/** An end is only read heading in: the A end clockwise, the B end counter-clockwise. */
function atEnd(shape: StripShape, led: LedRef, fallback: LedDirection): StartPoint {
  const en = ends(shape);
  if (en && same(led, en.A)) return { led, direction: "cw" };
  if (en && same(led, en.B)) return { led, direction: "ccw" };
  return { led, direction: fallback };
}

export function pickLed(shape: StripShape, led: LedRef, current: StartPoint): StartPoint {
  return atEnd(shape, { edge: led.edge, k: led.k }, current.direction);
}

/** A corner shortcut; the same corner again turns the strip round, staying at that corner. */
export function pickCorner(shape: StripShape, corner: Corner, current: StartPoint): StartPoint {
  const m = cornerLed(shape, corner, current.direction);
  if (!m) return current;
  if (same(m.led, current.led)) {
    const flipped = cornerLed(shape, corner, current.direction === "cw" ? "ccw" : "cw");
    return flipped ?? current;
  }
  return m;
}

/** An end shortcut; the end already picked moves LED #1 to the other one. */
export function pickEnd(shape: StripShape, key: "A" | "B", current: StartPoint): StartPoint {
  const en = ends(shape);
  if (!en) return current;
  const target = same(current.led, en[key]) ? (key === "A" ? "B" : "A") : key;
  const p = en[target];
  return { led: { edge: p.edge, k: p.k }, direction: target === "A" ? "cw" : "ccw" };
}

/** Flipping direction at a corner keeps LED #1 at that corner: it moves to the edge the strip now leaves along. */
export function setDirection(shape: StripShape, current: StartPoint, direction: LedDirection): StartPoint {
  const corner = cornerOf(shape, current.led);
  const name = placeName(shape, current.led);
  if (corner && name.kind === "corner") {
    const m = cornerLed(shape, corner, direction);
    if (m) return m;
  }
  return { led: current.led, direction };
}

interface Stop extends StartPoint {
  corner?: Corner;
  pos: number;
}

/** The places ‹ › steps through, clockwise: the corners and the stand's two gap ends. Any other LED is picked on the canvas. */
export function stops(shape: StripShape, direction: LedDirection): Stop[] {
  const all = leds(shape);
  const slot = (ref: LedRef) => all.find((p) => same(p, ref));
  const list: Array<StartPoint & { corner?: Corner }> = [];
  const push = (st: (StartPoint & { corner?: Corner }) | null) => {
    if (st && !list.some((o) => same(o.led, st.led))) list.push(st);
  };
  const corner = (c: Corner) => {
    const m = cornerLed(shape, c, direction);
    return m && cornerOf(shape, m.led) === c && placeName(shape, m.led).kind === "corner" ? { ...m, corner: c } : null;
  };
  const en = ends(shape);
  push(corner("tl"));
  push(corner("tr"));
  push(corner("br"));
  if (hasGap(shape) && en) {
    push({ led: { edge: en.B.edge, k: en.B.k }, direction: "ccw" });
    push({ led: { edge: en.A.edge, k: en.A.k }, direction: "cw" });
  }
  push(corner("bl"));
  // Along the strip; a corner counts from whichever of its two LEDs comes first.
  const pos = (st: StartPoint & { corner?: Corner }) => {
    if (!st.corner) return slot(st.led)?.pi ?? 0;
    const both = (["cw", "ccw"] as const)
      .map((d) => cornerLed(shape, st.corner!, d))
      .filter((m): m is StartPoint => !!m && cornerOf(shape, m.led) === st.corner)
      .map((m) => slot(m.led)?.pi ?? 0);
    return Math.min(...both);
  };
  return list.map((st) => ({ ...st, pos: pos(st) })).sort((a, b) => a.pos - b.pos);
}

/** ‹ › : the next stop along the frame, or the nearest one ahead/behind from between two stops. */
export function nudge(shape: StripShape, current: StartPoint, step: 1 | -1): StartPoint {
  const list = stops(shape, current.direction);
  const cur = ledAt(shape, current.led);
  if (!list.length || !cur) return current;
  const corner = cornerOf(shape, cur);
  let i = list.findIndex((st) => same(st.led, cur) || (st.corner !== undefined && st.corner === corner && placeName(shape, cur).kind === "corner"));
  if (i < 0) {
    const after = list.findIndex((st) => st.pos > cur.pi);
    const a = after < 0 ? 0 : after;
    i = step > 0 ? a - 1 : a;
  }
  const next = list[(i + step + list.length) % list.length];
  return next ? { led: next.led, direction: next.direction } : current;
}

/** LEDs in the order the strip lights them, from LED #1. */
export function stripOrder(shape: StripShape, start: StartPoint): Slot[] {
  const all = leds(shape);
  const s = all.findIndex((p) => same(p, start.led));
  if (s < 0) return [];
  const n = all.length;
  return Array.from({ length: n }, (_, i) => all[start.direction === "cw" ? (s + i) % n : (s - i + n) % n]!);
}

/**
 * Where LED #1 has to be remembered when counts change: an end, or an edge's
 * last LED, stays that; anything else keeps its index, clamped onto its edge.
 */
export type StartHold = { end: "A" | "B" } | { edge: LedSegmentKey; last: boolean; k: number };

export function holdStart(shape: StripShape, start: StartPoint): StartHold | null {
  const p = ledAt(shape, start.led);
  if (!p) return null;
  const en = ends(shape);
  if (en && same(p, en.A)) return { end: "A" };
  if (en && same(p, en.B)) return { end: "B" };
  return { edge: p.edge, last: p.k > 0 && p.k === shape.counts[p.edge] - 1, k: p.k };
}

export function restoreStart(shape: StripShape, start: StartPoint, hold: StartHold | null): StartPoint {
  if (hold && "end" in hold) {
    const en = ends(shape);
    if (en) {
      const q = en[hold.end];
      return { led: { edge: q.edge, k: q.k }, direction: start.direction };
    }
  } else if (hold && shape.counts[hold.edge] > 0) {
    const n = shape.counts[hold.edge];
    return { led: { edge: hold.edge, k: hold.last ? n - 1 : Math.min(hold.k, n - 1) }, direction: start.direction };
  }
  return clampStart(shape, start);
}

/** Keeps LED #1 on a lit LED; an edge that went dark hands it to the default start. */
function clampStart(shape: StripShape, start: StartPoint): StartPoint {
  if (ledAt(shape, start.led)) return start;
  const n = shape.counts[start.led.edge];
  if (n > 0) return { led: { edge: start.led.edge, k: Math.min(start.led.k, n - 1) }, direction: start.direction };
  return defaultStart(shape) ?? start;
}

/**
 * After a layout change: a loop keeps LED #1 anywhere; an open strip keeps it
 * only at an end (heading in), else starts from its first end.
 */
export function keepStartAfterLayout(shape: StripShape, start: StartPoint): StartPoint {
  const p = ledAt(shape, start.led);
  const en = ends(shape);
  if (p && !en) return start;
  if (p && en && same(p, en.A)) return { led: start.led, direction: "cw" };
  if (p && en && same(p, en.B)) return { led: start.led, direction: "ccw" };
  return defaultStart(shape) ?? start;
}
