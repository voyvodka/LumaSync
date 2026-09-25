import type { LedSegmentCounts, LedSegmentKey } from "./contracts";

/** Largest total LED Setup takes as one strip; each edge is capped at the same. */
export const MAX_STRIP_LEDS = 1000;

export const ALL_EDGES: readonly LedSegmentKey[] = ["top", "right", "bottom", "left"];

export interface SplitTotalInput {
  /** LEDs on the strip, as the user counted them or the device reported them. */
  total: number;
  /** Aspect of the captured display; only the ratio matters. */
  display: { width: number; height: number };
  /** Edges the strip runs along. The rest get zero. */
  edges: readonly LedSegmentKey[];
  /** Monitor-stand gap on the bottom edge, in LED pitches. */
  bottomGap?: number;
}

export interface SplitTotalResult {
  counts: LedSegmentCounts;
  /** The gap as given, or less when the bottom edge cannot hold it. */
  bottomMissing: number;
}

const EDGE_ORDER: readonly LedSegmentKey[] = ALL_EDGES;

function wholeNonNegative(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

/** Hamilton apportionment: floors, then the leftover LEDs to the largest fractions. */
function apportion(shares: Record<LedSegmentKey, number>, total: number): LedSegmentCounts {
  const counts: LedSegmentCounts = { top: 0, right: 0, bottom: 0, left: 0 };
  let assigned = 0;
  for (const edge of EDGE_ORDER) {
    // The epsilon keeps 52.999999 from flooring to 52 and costing an LED to float error.
    counts[edge] = Math.floor(shares[edge] + 1e-9);
    assigned += counts[edge];
  }
  const byFraction = [...EDGE_ORDER].sort(
    (a, b) => (shares[b] - counts[b]) - (shares[a] - counts[a]) || EDGE_ORDER.indexOf(a) - EDGE_ORDER.indexOf(b),
  );
  // Floors leave fewer spare LEDs than there are edges with a share, so one
  // pass over the lit edges places them all.
  for (const edge of byFraction) {
    if (assigned >= total) break;
    if (shares[edge] <= 0) continue;
    counts[edge] += 1;
    assigned += 1;
  }
  return counts;
}

/**
 * Shares a strip's LEDs out over the display's edges in proportion to each
 * edge's length, so the counts always add up to `total` exactly. The rule, and
 * how the stand gap takes its room, is in docs/architecture/ui-and-shell.md.
 */
export function splitTotalAcrossEdges({
  total: rawTotal,
  display,
  edges,
  bottomGap,
}: SplitTotalInput): SplitTotalResult {
  const zero: SplitTotalResult = { counts: { top: 0, right: 0, bottom: 0, left: 0 }, bottomMissing: 0 };
  const total = Math.min(wholeNonNegative(rawTotal), MAX_STRIP_LEDS);
  const enabled = EDGE_ORDER.filter((edge) => edges.includes(edge));
  if (total === 0 || enabled.length === 0) return zero;

  const width = display.width > 0 ? display.width : 16;
  const height = display.height > 0 ? display.height : 9;
  const edgeLength = (edge: LedSegmentKey) => (edge === "top" || edge === "bottom" ? width : height);
  const perimeter = enabled.reduce((sum, edge) => sum + edgeLength(edge), 0);

  const sharesFor = (gap: number): Record<LedSegmentKey, number> => {
    // Pitch is uniform along the strip, so the gap is `gap` more pitches of
    // perimeter that carry no LED — all of them taken from the bottom edge.
    const slots = total + gap;
    const shares = { top: 0, right: 0, bottom: 0, left: 0 };
    for (const edge of enabled) shares[edge] = (slots * edgeLength(edge)) / perimeter;
    shares.bottom = Math.max(0, shares.bottom - gap);
    return shares;
  };

  let gap = enabled.includes("bottom") ? wholeNonNegative(bottomGap) : 0;
  // A gap wider than the LEDs left beside it is one the layout refuses
  // (BOTTOM_MISSING_EXCEEDS_BOTTOM): shrink it to half the bottom edge.
  if (gap > 0 && sharesFor(gap).bottom < gap) {
    gap = Math.floor((total * edgeLength("bottom")) / perimeter / 2);
  }

  const counts = apportion(sharesFor(gap), total);
  return { counts, bottomMissing: Math.min(gap, counts.bottom) };
}

/** The edges a layout lights; all four for an empty one, which lights none yet. */
export function litEdges(counts: LedSegmentCounts): LedSegmentKey[] {
  const lit = EDGE_ORDER.filter((edge) => counts[edge] > 0);
  return lit.length > 0 ? lit : [...EDGE_ORDER];
}
