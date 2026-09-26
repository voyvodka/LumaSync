import type { LedSegmentKey } from "../model/contracts";
import type { DisplayAspect } from "../model/ledLayout";
import {
  adjacent,
  cornerLed,
  ends,
  gapRightCount,
  leds,
  same,
  stripOrder,
  type Corner,
  type LedRef,
  type StartPoint,
  type StripShape,
} from "../model/startPoint";

/** The stage's own coordinate space; the SVG and the chips above it both use it. */
export const VIEW_W = 600;
export const VIEW_H = 420;
const BOX_W = 360;
const BOX_H = 250;
const OFFSET = 9;

export interface Frame {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Point extends LedRef {
  pi: number;
  L: number;
  x: number;
  y: number;
  /** What this LED would show for the sample picture on the screen, as `rgb()`. */
  color: string;
}

export type Ring =
  | { kind: "end"; id: "A" | "B"; cx: number; cy: number }
  | { kind: "corner"; id: Corner; cx: number; cy: number };

/** Where a number sits over the stage; the bottom beside a stand has one per side. */
export type ChipAnchor =
  | { kind: "edge"; edge: LedSegmentKey; x: number; y: number }
  | { kind: "side"; side: "right" | "left"; count: number; x: number; y: number }
  | { kind: "gap"; x: number; y: number }
  | { kind: "ghost"; edge: LedSegmentKey; x: number; y: number }
  | { kind: "addStand"; x: number; y: number };

export interface StageLayout {
  frame: Frame;
  pts: Point[];
  rings: Ring[];
  first: Point | null;
  /** The whole strip, inset on the screen, as runs broken wherever the light does not continue. */
  track: string[];
  /** The way the light goes from LED #1: one path along the track, from LED #1 to its head. */
  flow: string | null;
  /** The head of the flow and the angle it points at, in degrees. */
  head: { x: number; y: number; angle: number } | null;
  /** Where the flow starts: LED #1's place on the track, drawn as a small dot. */
  tail: { x: number; y: number } | null;
  /** The corner LED #1 sits on, if any: its own ring then stands in for the corner's and flips the way. */
  firstCorner: Corner | null;
  chips: ChipAnchor[];
}

export function frameFor(display: DisplayAspect): Frame {
  const scale = Math.min(BOX_W / display.width, BOX_H / display.height);
  const w = display.width * scale;
  const h = display.height * scale;
  return { x: (VIEW_W - w) / 2, y: (VIEW_H - h) / 2 - 16, w, h };
}

/** Every LED at its place around the frame; the bottom leaves the stand gap in LED pitches. */
function placeLeds(shape: StripShape, f: Frame): Point[] {
  const { counts, gap } = shape;
  const bottomPitch = f.w / (counts.bottom + gap || 1);
  const rightRun = gapRightCount(counts.bottom);
  return leds(shape).map((p) => {
    const t = (p.k + 0.5) / counts[p.edge];
    const at = (x: number, y: number): Point => ({ ...p, x, y, color: sampleColor(f, x, y) });
    switch (p.edge) {
      case "top":
        return at(f.x + f.w * t, f.y - OFFSET);
      case "right":
        return at(f.x + f.w + OFFSET, f.y + f.h * t);
      case "left":
        return at(f.x - OFFSET, f.y + f.h * (1 - t));
      case "bottom": {
        const skip = gap > 0 && p.k >= rightRun ? gap : 0;
        return at(f.x + f.w - bottomPitch * (p.k + skip + 0.5), f.y + f.h + OFFSET);
      }
    }
  });
}

/** The sample picture's stops, top-left to bottom-right; `SetupCanvas` draws the same gradient. */
export const SCREEN_STOPS: readonly (readonly [number, string])[] = [
  [0, "#d9a06a"],
  [0.4, "#b8532f"],
  [0.7, "#5a2c5c"],
  [1, "#1c2f5a"],
];

const rgbOf = (hex: string) => [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
const STOP_RGB = SCREEN_STOPS.map(([at, hex]) => [at, rgbOf(hex)] as const);

/**
 * The colour the picture has nearest an LED, lifted to a light's brightness: an LED shows the hue
 * at full drive, so a dark corner of the picture still reads as its colour rather than as black.
 */
function sampleColor(f: Frame, x: number, y: number): string {
  const u = Math.min(1, Math.max(0, (x - f.x) / f.w));
  const v = Math.min(1, Math.max(0, (y - f.y) / f.h));
  const t = (u + v) / 2;
  let i = 1;
  while (i < STOP_RGB.length - 1 && STOP_RGB[i]![0] < t) i += 1;
  const [a0, c0] = STOP_RGB[i - 1]!;
  const [a1, c1] = STOP_RGB[i]!;
  const k = a1 > a0 ? (t - a0) / (a1 - a0) : 0;
  const mixed = c0.map((c, j) => c + (c1[j]! - c) * k);
  const lift = Math.max(1, 200 / Math.max(...mixed));
  const [r, g, b] = mixed.map((c) => Math.round(Math.min(255, c * lift)));
  return `rgb(${r} ${g} ${b})`;
}

const key = (p: LedRef) => `${p.edge}:${p.k}`;
const OUT: Record<LedSegmentKey, [number, number]> = { top: [0, -1], right: [1, 0], bottom: [0, 1], left: [-1, 0] };

const FLOW_INSET = 18;
/** The share of the strip the flow runs along before its head. */
const FLOW_SHARE = 0.42;

/** An LED's place on the track: its edge, pulled in onto the screen and kept off the corners. */
function onTrack(p: Point, f: Frame): [number, number] {
  const L = f.x + FLOW_INSET;
  const R = f.x + f.w - FLOW_INSET;
  const T = f.y + FLOW_INSET;
  const B = f.y + f.h - FLOW_INSET;
  const cx = (x: number) => Math.min(R, Math.max(L, x));
  const cy = (y: number) => Math.min(B, Math.max(T, y));
  switch (p.edge) {
    case "top":
      return [cx(p.x), T];
    case "right":
      return [R, cy(p.y)];
    case "bottom":
      return [cx(p.x), B];
    case "left":
      return [L, cy(p.y)];
  }
}

/** The track's corner between two edges that meet. */
function trackCorner(a: LedSegmentKey, b: LedSegmentKey, f: Frame): [number, number] {
  const vertical = a === "left" || a === "right" ? a : b;
  const horizontal = a === "top" || a === "bottom" ? a : b;
  return [
    vertical === "left" ? f.x + FLOW_INSET : f.x + f.w - FLOW_INSET,
    horizontal === "top" ? f.y + FLOW_INSET : f.y + f.h - FLOW_INSET,
  ];
}

/** The strip in order as track runs: a new run wherever the next LED is not next to the last. */
function trackRuns(order: Point[], f: Frame): [number, number][][] {
  const runs: [number, number][][] = [];
  let run: [number, number][] = [];
  order.forEach((p, i) => {
    const prev = order[i - 1];
    if (prev && !adjacent(prev, p)) {
      runs.push(run);
      run = [];
    } else if (prev && prev.edge !== p.edge) {
      run.push(trackCorner(prev.edge, p.edge, f));
    }
    const pt = onTrack(p, f);
    const last = run[run.length - 1];
    if (!last || Math.hypot(last[0] - pt[0], last[1] - pt[1]) > 0.01) run.push(pt);
  });
  if (run.length) runs.push(run);
  return runs;
}

const polyline = (run: [number, number][]) => run.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join("");

/** The head keeps this far from a corner, so it always sits on one edge and points along it. */
const HEAD_CLEAR = 10;

/**
 * The flow: the first stretch of the first run, as one path. It shows where the light goes and
 * which way it turns at a corner, which an arrow beside LED #1 could not. The head is placed on an
 * edge, never on a corner: landing exactly on one left it pointing along the next edge by a
 * rounding hair.
 */
function flowOf(runs: [number, number][][]): { flow: string | null; head: StageLayout["head"] } {
  const run = runs[0]?.filter((p, i, all) => i === 0 || Math.hypot(p[0] - all[i - 1]![0], p[1] - all[i - 1]![1]) > 0.01);
  if (!run || run.length < 2) return { flow: null, head: null };
  const total = runs.reduce((sum, r) => sum + r.slice(1).reduce((d, p, i) => d + Math.hypot(p[0] - r[i]![0], p[1] - r[i]![1]), 0), 0);
  let left = Math.max(40, total * FLOW_SHARE);
  const points: [number, number][] = [run[0]!];
  for (let i = 1; i < run.length; i += 1) {
    const [ax, ay] = run[i - 1]!;
    const [bx, by] = run[i]!;
    const len = Math.hypot(bx - ax, by - ay);
    const last = i === run.length - 1;
    if (left > len && !last) {
      points.push([bx, by]);
      left -= len;
      continue;
    }
    let along = Math.min(left, len);
    if (len >= 2 * HEAD_CLEAR) along = Math.min(len - (last ? 0 : HEAD_CLEAR), Math.max(HEAD_CLEAR, along));
    else along = len / 2;
    const k = along / len;
    const hx = ax + (bx - ax) * k;
    const hy = ay + (by - ay) * k;
    points.push([hx, hy]);
    return { flow: polyline(points), head: { x: hx, y: hy, angle: (Math.atan2(by - ay, bx - ax) * 180) / Math.PI } };
  }
  return { flow: null, head: null };
}

export function computeStage(shape: StripShape, start: StartPoint, f: Frame): StageLayout {
  const pts = placeLeds(shape, f);
  const byKey = new Map(pts.map((p) => [key(p), p]));
  const order = stripOrder(shape, start)
    .map((p) => byKey.get(key(p)))
    .filter((p): p is Point => !!p);
  const first = order[0] ?? null;
  const { counts, gap } = shape;

  const rings: Ring[] = [];
  const en = ends(shape);
  if (en) {
    const endRings = (["A", "B"] as const)
      .filter((id) => !same(en[id], start.led))
      .map((id) => {
        const p = byKey.get(key(en[id]))!;
        const [dx, dy] = OUT[p.edge];
        return { kind: "end" as const, id, cx: p.x + dx * 13, cy: p.y + dy * 13 };
      });
    const [a, b] = endRings;
    // A narrow stand puts both rings on top of each other: spread them.
    if (a && b) {
      const d = Math.hypot(a.cx - b.cx, a.cy - b.cy);
      if (d < 16) {
        const ux = d ? (a.cx - b.cx) / d : 1;
        const uy = d ? (a.cy - b.cy) / d : 0;
        const m = (16 - d) / 2;
        a.cx += ux * m;
        a.cy += uy * m;
        b.cx -= ux * m;
        b.cy -= uy * m;
      }
    }
    rings.push(...endRings);
  }
  const cornerAt: Record<Corner, [number, number]> = {
    tl: [f.x - 10, f.y - 10],
    tr: [f.x + f.w + 10, f.y - 10],
    br: [f.x + f.w + 10, f.y + f.h + 10],
    bl: [f.x - 10, f.y + f.h + 10],
  };
  let firstCorner: Corner | null = null;
  for (const c of ["tl", "tr", "br", "bl"] as const) {
    const cw = cornerLed(shape, c, "cw");
    const ccw = cornerLed(shape, c, "ccw");
    if (!cw && !ccw) continue;
    if (en && [en.A, en.B].some((t) => same(t, cw?.led) || same(t, ccw?.led))) continue;
    // LED #1 already sits on this corner: its own ring takes the corner's press (which flips the
    // way the strip leaves it), rather than a second ring crowding beside it.
    if (same(start.led, cw?.led) || same(start.led, ccw?.led)) {
      firstCorner = c;
      continue;
    }
    const [cx, cy] = cornerAt[c];
    rings.push({ kind: "corner", id: c, cx, cy });
  }

  const runs = trackRuns(order, f);
  const track = runs.filter((run) => run.length > 1).map(polyline);
  const { flow, head } = flowOf(runs);
  // Starting on the track beside LED #1 rather than at the LED: a line from the LED would cross
  // the bezel diagonally at a corner.
  const tail = runs[0]?.[0] ? { x: runs[0][0][0], y: runs[0][0][1] } : null;

  const chips: ChipAnchor[] = [];
  const mid = { top: [f.x + f.w / 2, f.y - 30], right: [f.x + f.w + 38, f.y + f.h / 2], left: [f.x - 38, f.y + f.h / 2] } as const;
  for (const edge of ["top", "right", "left"] as const) {
    const [x, y] = mid[edge];
    chips.push(counts[edge] > 0 ? { kind: "edge", edge, x, y } : { kind: "ghost", edge, x, y });
  }
  const below = f.y + f.h + 30;
  if (counts.bottom <= 0) chips.push({ kind: "ghost", edge: "bottom", x: f.x + f.w / 2, y: below });
  else if (gap > 0) {
    const right = gapRightCount(counts.bottom);
    for (const [side, run] of [
      ["right", pts.filter((p) => p.edge === "bottom" && p.k < right)],
      ["left", pts.filter((p) => p.edge === "bottom" && p.k >= right)],
    ] as const) {
      const a = run[0];
      const b = run[run.length - 1];
      if (a && b) chips.push({ kind: "side", side, count: run.length, x: (a.x + b.x) / 2, y: below });
    }
    chips.push({ kind: "gap", x: f.x + f.w / 2, y: f.y + f.h + 66 });
  } else {
    chips.push({ kind: "edge", edge: "bottom", x: f.x + f.w / 2, y: below });
    chips.push({ kind: "addStand", x: f.x + f.w / 2, y: f.y + f.h + 58 });
  }

  return { frame: f, pts, rings, first, track, flow, head, tail, firstCorner, chips };
}
