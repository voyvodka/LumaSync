import { LED_CALIBRATION_MAX_TOTAL_LEDS } from "@/shared/contracts/calibration";

import type { LedSegmentCounts, LedSegmentKey } from "./contracts";

export type LinkedPair = "tb" | "lr";
/** What one number on the canvas edits: an edge, a linked pair, or the stand gap. */
export type CountKey = LedSegmentKey | LinkedPair | "gap";

export const EDGES: readonly LedSegmentKey[] = ["top", "right", "bottom", "left"];
/** The backend's hard ceiling; the editor's own limits below are far tighter. */
export const MAX_COUNT = LED_CALIBRATION_MAX_TOTAL_LEDS;

/**
 * The densest strip sold is 144 LEDs/m; 200 leaves room. The display's physical
 * size is unknown (only its pixels are), so an edge is capped at that density
 * along a 100-inch screen of the display's shape — a count past that is a typo.
 */
const MAX_LEDS_PER_M = 200;
const MAX_DIAGONAL_M = 2.54;

/**
 * The edge counts as LED Setup edits them. `links` and `memo` are how the page
 * handles the counts, not facts about the strip: nothing here is saved beyond
 * `counts` and `gap`, and both are derived again when a layout loads.
 */
export interface LayoutDraft {
  counts: LedSegmentCounts;
  /** Monitor-stand gap on the bottom edge, in LED pitches (`bottomMissing`). */
  gap: number;
  /** A linked pair edits as one number and keeps one count. */
  links: Record<LinkedPair, boolean>;
  /** Counts of edges switched off, given back when the edge returns. */
  memo: Partial<LedSegmentCounts>;
}

export interface DisplayAspect {
  width: number;
  height: number;
}

const PARTNER: Record<LedSegmentKey, LedSegmentKey> = { top: "bottom", bottom: "top", left: "right", right: "left" };

const isOn = (counts: LedSegmentCounts, edge: LedSegmentKey) => counts[edge] > 0;

export function sumCounts(counts: LedSegmentCounts): number {
  return counts.top + counts.right + counts.bottom + counts.left;
}

function hasStand(draft: Pick<LayoutDraft, "counts" | "gap">): boolean {
  return draft.gap > 0 && isOn(draft.counts, "bottom");
}

function deriveLinks(counts: LedSegmentCounts): Record<LinkedPair, boolean> {
  return {
    tb: isOn(counts, "top") && isOn(counts, "bottom") && counts.top === counts.bottom,
    lr: isOn(counts, "left") && isOn(counts, "right") && counts.left === counts.right,
  };
}

/** A saved layout opened in the editor: links from equal counts, no memory yet. */
export function draftFromCounts(counts: LedSegmentCounts, gap: number): LayoutDraft {
  return { counts: { ...counts }, gap: isOn(counts, "bottom") ? gap : 0, links: deriveLinks(counts), memo: {} };
}

/** A linked pair edits as one while both of its edges are lit. */
export function isLinked(draft: LayoutDraft, pair: LinkedPair): boolean {
  if (!draft.links[pair]) return false;
  const [a, b] = pair === "lr" ? (["left", "right"] as const) : (["top", "bottom"] as const);
  return isOn(draft.counts, a) && isOn(draft.counts, b);
}

/** The number an edge's chip edits: its pair while linked, else the edge itself. */
export function keyForEdge(draft: LayoutDraft, edge: LedSegmentKey): CountKey {
  if ((edge === "top" || edge === "bottom") && isLinked(draft, "tb")) return "tb";
  if ((edge === "left" || edge === "right") && isLinked(draft, "lr")) return "lr";
  return edge;
}

function aspectOf(display: DisplayAspect): DisplayAspect {
  return display.width > 0 && display.height > 0 ? display : { width: 16, height: 9 };
}

/** Most LEDs an edge of `display`'s shape can carry (see MAX_LEDS_PER_M). */
function edgeMax(edge: LedSegmentKey, display: DisplayAspect): number {
  const { width, height } = aspectOf(display);
  const len = edge === "top" || edge === "bottom" ? width : height;
  return Math.ceil((MAX_LEDS_PER_M * MAX_DIAGONAL_M * len) / Math.hypot(width, height));
}

/** Most LEDs the lit edges can carry together (all four while none is lit). */
export function maxTotal(draft: LayoutDraft, display: DisplayAspect): number {
  const lit = EDGES.filter((e) => isOn(draft.counts, e));
  return (lit.length ? lit : EDGES).reduce((sum, e) => sum + edgeMax(e, display), 0);
}

/**
 * Allowed range per number. The counts are the user's: nothing moves another
 * edge. A lit edge holds at least one LED, and a stand keeps one LED each side
 * of it (the bottom, or the linked top-and-bottom, ≥ 2).
 */
export function countBounds(draft: LayoutDraft, key: CountKey, display: DisplayAspect): { min: number; max: number } {
  const edge: LedSegmentKey = key === "tb" || key === "gap" ? "top" : key === "lr" ? "left" : key;
  const max = edgeMax(edge, display);
  if (hasStand(draft) && (key === "bottom" || key === "tb")) return { min: 2, max };
  return { min: 1, max };
}

export function countOf(draft: LayoutDraft, key: CountKey): number {
  if (key === "gap") return draft.gap;
  if (key === "tb") return draft.counts.top;
  if (key === "lr") return draft.counts.left;
  return draft.counts[key];
}

export function setCount(draft: LayoutDraft, key: CountKey, value: number, display: DisplayAspect): LayoutDraft {
  const { min, max } = countBounds(draft, key, display);
  const v = Math.max(min, Math.min(max, Math.floor(value)));
  const counts = { ...draft.counts };
  let gap = draft.gap;
  if (key === "tb") counts.top = counts.bottom = v;
  else if (key === "lr") counts.left = counts.right = v;
  else if (key === "gap") gap = v;
  else counts[key] = v;
  return { ...draft, counts, gap };
}

/** The chain between a pair: linked comes apart, split is made equal (to the top or right edge) and linked. */
export function toggleLink(draft: LayoutDraft, pair: LinkedPair): LayoutDraft {
  if (isLinked(draft, pair)) return { ...draft, links: { ...draft.links, [pair]: false } };
  const counts = { ...draft.counts };
  if (pair === "lr") counts.left = counts.right;
  else counts.bottom = Math.max(counts.top, hasStand(draft) ? 2 : 1);
  return { ...draft, counts, links: { ...draft.links, [pair]: true } };
}


/** An edge's share of `total` by its length on the display, for an edge that comes back with no memory. */
function lengthShare(edge: LedSegmentKey, total: number, display: DisplayAspect): number {
  const { width, height } = aspectOf(display);
  const len = edge === "top" || edge === "bottom" ? width : height;
  return Math.max(1, Math.round((total * len) / (2 * (width + height))));
}

/**
 * Lights an edge or puts it out; the other edges keep their counts. One put out
 * keeps its count in memory and gets it back — else the opposite edge's count,
 * else its share of the total. The last lit edge stays lit, and the stand goes
 * with the bottom.
 */
export function toggleEdge(draft: LayoutDraft, edge: LedSegmentKey, lit: boolean, display: DisplayAspect): LayoutDraft {
  const counts = { ...draft.counts };
  const memo = { ...draft.memo };
  if (lit === isOn(counts, edge)) return draft;
  if (!lit) {
    if (EDGES.filter((e) => isOn(counts, e)).length === 1) return draft;
    memo[edge] = counts[edge];
    counts[edge] = 0;
  } else {
    const partner = PARTNER[edge];
    counts[edge] = memo[edge] || counts[partner] || lengthShare(edge, sumCounts(counts), display);
  }
  const gap = isOn(counts, "bottom") ? draft.gap : 0;
  return { ...draft, counts, gap, memo, links: deriveLinks(counts) };
}

/** Puts a stand gap in the bottom edge or takes it out; only the gap changes, but a stand needs two LEDs beside it. */
export function setStand(draft: LayoutDraft, on: boolean): LayoutDraft {
  if (!isOn(draft.counts, "bottom") || on === hasStand(draft)) return draft;
  if (!on) return { ...draft, gap: 0 };
  const counts = { ...draft.counts, bottom: Math.max(2, draft.counts.bottom) };
  if (isLinked(draft, "tb")) counts.top = counts.bottom;
  return { ...draft, counts, gap: Math.max(1, Math.round(counts.bottom * 0.16)) };
}

/** Smallest total the lit edges can take: one LED each, two beside a stand (both edges two when they are linked). */
export function minTotal(draft: LayoutDraft): number {
  const lit = EDGES.filter((e) => isOn(draft.counts, e)).length || EDGES.length;
  if (!hasStand(draft)) return lit;
  return lit + (isLinked(draft, "tb") ? 2 : 1);
}

/**
 * Shares `total` over the lit edges (all four when none is) by each edge's
 * length on the display. Linked pairs stay equal. An unlinked bottom beside a
 * stand gives up the gap's share (the strip's pitch is even, and the gap holds
 * no LEDs); a linked one keeps the top's count. When one LED is left over and
 * every edge is paired, the top takes it; with a stand the sides do, since the
 * gap is a measurement and a side one LED longer is how an odd strip really ends.
 */
export function distribute(draft: LayoutDraft, total: number, display: DisplayAspect): LayoutDraft {
  const allOff = EDGES.every((e) => !isOn(draft.counts, e));
  const on = Object.fromEntries(EDGES.map((e) => [e, allOff || isOn(draft.counts, e)])) as Record<LedSegmentKey, boolean>;
  const start: LayoutDraft = allOff ? { ...draft, counts: { top: 1, right: 1, bottom: 1, left: 1 } } : draft;
  const T = Math.min(Math.floor(total), maxTotal(start, display));
  if (T < minTotal(start)) return draft;

  const stand = hasStand(start);
  const g = stand ? start.gap : 0;
  const tb = on.top && on.bottom && start.links.tb;
  const lr = on.left && on.right && start.links.lr;
  const { width, height } = aspectOf(display);
  const len = (e: LedSegmentKey) => (!on[e] ? 0 : e === "top" || e === "bottom" ? width : height);
  const perimeter = EDGES.reduce((s, e) => s + len(e), 0);
  // An unlinked bottom's share loses the gap: strip length that holds no LEDs.
  const cut = stand && !tb ? g : 0;
  const share = (e: LedSegmentKey) => ((T + cut) * len(e)) / perimeter - (e === "bottom" ? cut : 0);
  const min = (e: LedSegmentKey) => (!on[e] ? 0 : stand && (e === "bottom" || (tb && e === "top")) ? 2 : 1);

  const groups: LedSegmentKey[][] = [];
  if (tb) groups.push(["top", "bottom"]);
  else for (const e of ["top", "bottom"] as const) if (on[e]) groups.push([e]);
  if (lr) groups.push(["left", "right"]);
  else for (const e of ["left", "right"] as const) if (on[e]) groups.push([e]);

  const e: LedSegmentCounts = { top: 0, right: 0, bottom: 0, left: 0 };
  for (const k of EDGES) e[k] = on[k] ? Math.max(min(k), Math.floor(share(k) + 1e-9)) : 0;
  if (tb) e.top = e.bottom = Math.min(e.top, e.bottom);
  if (lr) e.left = e.right = Math.min(e.left, e.right);

  let rest = T - sumCounts(e);
  // Minimums can overshoot a small total: take back from the biggest group that can give.
  while (rest < 0) {
    const giver = groups
      .filter((gr) => gr.every((k) => e[k] > min(k)))
      .sort((a, b) => e[b[0]!] - e[a[0]!])[0];
    if (!giver) break;
    for (const k of giver) e[k] -= 1;
    rest += giver.length;
  }
  // Pairs take two at a time so they stay equal; the edge furthest below its share goes first.
  while (rest > 0) {
    const taker = groups
      .filter((gr) => gr.length <= rest)
      .sort((a, b) => e[a[0]!] - share(a[0]!) - (e[b[0]!] - share(b[0]!)))[0];
    if (!taker) break;
    for (const k of taker) e[k] += 1;
    rest -= taker.length;
  }
  if (rest > 0) {
    const k: LedSegmentKey = stand && lr ? "left" : on.top ? "top" : on.left ? "left" : on.right ? "right" : "bottom";
    e[k] += rest;
  }
  return { ...start, counts: e, gap: g, links: deriveLinks(e) };
}
