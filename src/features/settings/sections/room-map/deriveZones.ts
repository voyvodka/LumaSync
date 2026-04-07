/**
 * deriveZones — Pure LED zone derivation algorithm
 *
 * Maps a USB strip position (relative to a TV anchor) into screen-edge zone
 * assignments with proportional LED distribution.
 *
 * ZONE-01 — Phase 19 Plan 01
 */

import type { UsbStripPlacement, TvAnchorPlacement } from "../../../../shared/contracts/roomMap";
import type { LedSegmentCounts } from "../../../calibration/model/contracts";

// ---------------------------------------------------------------------------
// Exported types
// ---------------------------------------------------------------------------

export interface DerivedSegment {
  edge: "top" | "right" | "bottom" | "left";
  ledCount: number;
  lengthMeters: number;
}

export interface ZoneDeriveResult {
  /** LED counts per screen edge */
  counts: LedSegmentCounts;
  /** Per-segment detail for overlay rendering */
  segments: DerivedSegment[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns the Euclidean distance from point (px, py) to the closest point on
 * segment (ax, ay)→(bx, by).
 *
 * Handles the degenerate case where a === b (zero-length segment) as a simple
 * point-to-point distance.
 */
export function pointToSegmentDistance(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;

  if (lenSq < 1e-14) {
    // Degenerate segment: treat as point
    return Math.sqrt((px - ax) * (px - ax) + (py - ay) * (py - ay));
  }

  // Parameter t clamped to [0, 1]
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
  const closestX = ax + t * dx;
  const closestY = ay + t * dy;
  return Math.sqrt((px - closestX) * (px - closestX) + (py - closestY) * (py - closestY));
}

// ---------------------------------------------------------------------------
// Core algorithm
// ---------------------------------------------------------------------------

/** Minimum strip length in metres below which result is empty. */
const EPSILON = 0.01;

/** Edges in a fixed iteration order. */
const EDGE_KEYS: Array<"top" | "right" | "bottom" | "left"> = ["top", "right", "bottom", "left"];

type EdgeKey = "top" | "right" | "bottom" | "left";

interface EdgeSegment {
  ax: number;
  ay: number;
  bx: number;
  by: number;
}

/** Build the four TV edge segments from a TvAnchorPlacement. */
function buildTvEdges(tv: TvAnchorPlacement): Record<EdgeKey, EdgeSegment> {
  const left = tv.x - tv.width / 2;
  const right = tv.x + tv.width / 2;
  const top = tv.y - tv.height / 2;
  const bottom = tv.y + tv.height / 2;

  return {
    top: { ax: left, ay: top, bx: right, by: top },
    bottom: { ax: left, ay: bottom, bx: right, by: bottom },
    left: { ax: left, ay: top, bx: left, by: bottom },
    right: { ax: right, ay: top, bx: right, by: bottom },
  };
}

/** Returns true if (x, y) lies inside the TV bounding box. */
function insideTvBox(x: number, y: number, tv: TvAnchorPlacement): boolean {
  const left = tv.x - tv.width / 2;
  const right = tv.x + tv.width / 2;
  const top = tv.y - tv.height / 2;
  const bottom = tv.y + tv.height / 2;
  return x >= left && x <= right && y >= top && y <= bottom;
}

/** Find the closest TV edge for a given point. */
function nearestEdge(
  px: number,
  py: number,
  edges: Record<EdgeKey, EdgeSegment>,
): EdgeKey {
  let bestEdge: EdgeKey = "top";
  let bestDist = Infinity;

  for (const key of EDGE_KEYS) {
    const e = edges[key];
    const d = pointToSegmentDistance(px, py, e.ax, e.ay, e.bx, e.by);
    if (d < bestDist) {
      bestDist = d;
      bestEdge = key;
    }
  }

  return bestEdge;
}

/**
 * Distribute totalLeds among segments proportional to their physical length.
 * The last segment absorbs rounding remainder to guarantee exact total.
 */
function distributeLeds(
  segments: Array<{ edge: EdgeKey; lengthMeters: number }>,
  totalLeds: number,
): number[] {
  if (segments.length === 0) return [];

  const totalLength = segments.reduce((sum, s) => sum + s.lengthMeters, 0);
  const counts: number[] = new Array(segments.length).fill(0);
  let allocated = 0;

  for (let i = 0; i < segments.length - 1; i++) {
    const share = totalLength > 0 ? Math.round((segments[i].lengthMeters / totalLength) * totalLeds) : 0;
    counts[i] = share;
    allocated += share;
  }

  // Last segment gets the remainder to prevent rounding drift
  counts[segments.length - 1] = totalLeds - allocated;

  return counts;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Derives LED zone assignments from a USB strip's position relative to a TV.
 *
 * Algorithm (D-01a/D-01b/D-01c):
 * 1. Validate inputs (degenerate strip or strip fully inside TV → empty result)
 * 2. Sample N points along the strip (N = max(ledCount, 20))
 * 3. Assign each sample point to the nearest TV edge
 * 4. Group consecutive same-edge points into segments with physical lengths
 * 5. Distribute totalLeds proportionally, last segment absorbs rounding
 */
export function deriveZones(
  strip: UsbStripPlacement,
  tv: TvAnchorPlacement,
): ZoneDeriveResult {
  const empty: ZoneDeriveResult = {
    counts: { top: 0, right: 0, bottom: 0, left: 0 },
    segments: [],
  };

  // --- 1. Validate inputs ---
  const dx = strip.endX - strip.startX;
  const dy = strip.endY - strip.startY;
  const stripLength = Math.sqrt(dx * dx + dy * dy);

  if (stripLength < EPSILON) {
    return empty;
  }

  if (
    insideTvBox(strip.startX, strip.startY, tv) &&
    insideTvBox(strip.endX, strip.endY, tv)
  ) {
    return empty;
  }

  // --- 2. Sample points ---
  const N = Math.max(strip.ledCount, 20);
  const edges = buildTvEdges(tv);

  // Per-sample edge assignments
  const assignments: EdgeKey[] = new Array(N);
  for (let i = 0; i < N; i++) {
    const t = i / (N - 1);
    const px = strip.startX + t * dx;
    const py = strip.startY + t * dy;
    assignments[i] = nearestEdge(px, py, edges);
  }

  // --- 3 & 4. Group consecutive points into segments ---
  interface RawSegment {
    edge: EdgeKey;
    startIdx: number;
    endIdx: number;
  }

  const rawSegments: RawSegment[] = [];
  let segStart = 0;

  for (let i = 1; i <= N; i++) {
    if (i === N || assignments[i] !== assignments[segStart]) {
      rawSegments.push({ edge: assignments[segStart], startIdx: segStart, endIdx: i - 1 });
      segStart = i;
    }
  }

  // Calculate physical length for each segment
  const segmentsWithLength = rawSegments.map((seg) => {
    const startT = seg.startIdx / (N - 1);
    const endT = seg.endIdx / (N - 1);
    const startPx = strip.startX + startT * dx;
    const startPy = strip.startY + startT * dy;
    const endPx = strip.startX + endT * dx;
    const endPy = strip.startY + endT * dy;
    const ldx = endPx - startPx;
    const ldy = endPy - startPy;
    const lengthMeters = Math.sqrt(ldx * ldx + ldy * ldy);
    return { edge: seg.edge, lengthMeters };
  });

  // --- 5. Distribute LEDs ---
  const ledCounts = distributeLeds(segmentsWithLength, strip.ledCount);

  const derivedSegments: DerivedSegment[] = segmentsWithLength.map((seg, i) => ({
    edge: seg.edge,
    ledCount: ledCounts[i],
    lengthMeters: seg.lengthMeters,
  }));

  // Merge per-edge counts
  const counts: LedSegmentCounts = { top: 0, right: 0, bottom: 0, left: 0 };
  for (const seg of derivedSegments) {
    counts[seg.edge] += seg.ledCount;
  }

  return { counts, segments: derivedSegments };
}
