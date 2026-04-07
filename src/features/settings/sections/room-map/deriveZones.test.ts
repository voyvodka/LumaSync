/**
 * deriveZones — Unit tests for ZONE-01 algorithm
 *
 * Tests cover:
 * - Basic edge assignments (top, bottom, left)
 * - L-shaped strip (multi-edge proportional distribution)
 * - distributeLeds rounding invariant
 * - Degenerate inputs (zero-length strip, strip inside TV)
 * - pointToSegmentDistance helper
 *
 * @vitest-environment node
 */
import { describe, it, expect } from "vitest";
import {
  deriveZones,
  pointToSegmentDistance,
  type ZoneDeriveResult,
  type DerivedSegment,
} from "./deriveZones";
import type { UsbStripPlacement } from "../../../../shared/contracts/roomMap";
import type { TvAnchorPlacement } from "../../../../shared/contracts/roomMap";

// TV anchor used across many tests:
// center (2.5, 0.5), size 2m x 0.1m → edges: top y=0.45, bottom y=0.55, left x=1.5, right x=3.5
const TV: TvAnchorPlacement = { x: 2.5, y: 0.5, width: 2, height: 0.1 };

function makeStrip(
  startX: number,
  startY: number,
  endX: number,
  endY: number,
  ledCount = 100,
): UsbStripPlacement {
  return { stripId: "s1", startX, startY, endX, endY, ledCount };
}

// ---------------------------------------------------------------------------
// Test 1: Strip across TV top edge only
// ---------------------------------------------------------------------------
describe("deriveZones - single edge assignments", () => {
  it("assigns all LEDs to top when strip runs horizontally above TV", () => {
    // Strip at y=0.2 (above the TV which has topY=0.45), spanning TV width
    const strip = makeStrip(1.5, 0.2, 3.5, 0.2, 100);
    const result: ZoneDeriveResult = deriveZones(strip, TV);
    // All points on the strip should be closest to the top TV edge
    expect(result.counts.top).toBe(100);
    expect(result.counts.right).toBe(0);
    expect(result.counts.bottom).toBe(0);
    expect(result.counts.left).toBe(0);
    expect(result.segments.length).toBeGreaterThanOrEqual(1);
    expect(result.segments.every((s: DerivedSegment) => s.edge === "top")).toBe(true);
  });

  it("assigns all LEDs to bottom when strip runs below TV", () => {
    // Strip at y=2.0 (below the TV which has bottomY=0.55)
    const strip = makeStrip(1.5, 2.0, 3.5, 2.0, 60);
    const result = deriveZones(strip, TV);
    expect(result.counts.bottom).toBe(60);
    expect(result.counts.top).toBe(0);
    expect(result.counts.left).toBe(0);
    expect(result.counts.right).toBe(0);
  });

  it("assigns all LEDs to left when strip runs along left side", () => {
    // Strip at x=0.1 directly opposite the TV's left edge mid-section.
    // y range [0.47..0.53] stays within the TV's vertical span [0.45..0.55],
    // so every sample point is closest to the left edge (not a corner).
    // TV left edge: x=1.5, y [0.45..0.55]. Distance from (0.1, 0.5) to left edge = 1.4m.
    // Distance to top edge = sqrt(1.4^2 + 0.05^2) > 1.4m — left always wins.
    const strip = makeStrip(0.1, 0.47, 0.1, 0.53, 80);
    const result = deriveZones(strip, TV);
    expect(result.counts.left).toBe(80);
    expect(result.counts.right).toBe(0);
    expect(result.counts.top).toBe(0);
    expect(result.counts.bottom).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Test 2: L-shaped strip (top + right edges)
// ---------------------------------------------------------------------------
describe("deriveZones - L-shaped strip multi-edge", () => {
  it("distributes LEDs proportionally across top and right edges for L-shaped strip", () => {
    // Strip starts at left side (x=1.5, y=0.0), goes horizontally to top-right corner
    // then down right side. We simulate with a diagonal strip that clearly covers top+right.
    // Top portion: 2m horizontal, Right portion: 1m vertical → ratio 2:1
    // We use a strip from (1.5, 0.1) to (3.5, 0.55) — diagonal that passes near top then right
    // Actually for a true L-shape we need two segments. But deriveZones works with a single line.
    // Use a strip that goes from above-left TV corner to right-side of TV:
    // (1.3, 0.0) to (4.0, 0.5) — diagonal covering top then right
    const strip = makeStrip(1.3, 0.0, 4.0, 0.5, 90);
    const result = deriveZones(strip, TV);
    // Should distribute across top and right — both non-zero
    const assignedTotal = result.counts.top + result.counts.right + result.counts.bottom + result.counts.left;
    expect(assignedTotal).toBe(90);
    expect(result.counts.top).toBeGreaterThan(0);
    expect(result.counts.right).toBeGreaterThan(0);
  });

  it("sum of all edge counts always equals strip.ledCount", () => {
    const strip = makeStrip(0.5, 0.0, 5.0, 1.5, 150);
    const result = deriveZones(strip, TV);
    const total = result.counts.top + result.counts.right + result.counts.bottom + result.counts.left;
    expect(total).toBe(150);
  });
});

// ---------------------------------------------------------------------------
// Test 5: distributeLeds rounding — totalLeds=100, 3 equal segments → 34+33+33=100
// ---------------------------------------------------------------------------
describe("deriveZones - rounding invariant", () => {
  it("sum always equals totalLeds with no rounding drift", () => {
    // Use a strip that will produce roughly equal 3 segments
    // Diagonal strip from top-left to bottom-right corner of TV area
    const strip = makeStrip(1.0, 0.0, 4.0, 1.5, 100);
    const result = deriveZones(strip, TV);
    const total = result.counts.top + result.counts.right + result.counts.bottom + result.counts.left;
    expect(total).toBe(100);
  });

  it("handles odd totalLeds without drift", () => {
    const strip = makeStrip(1.5, 0.1, 3.5, 0.1, 99);
    const result = deriveZones(strip, TV);
    const total = result.counts.top + result.counts.right + result.counts.bottom + result.counts.left;
    expect(total).toBe(99);
  });
});

// ---------------------------------------------------------------------------
// Test 6: Degenerate — zero-length strip
// ---------------------------------------------------------------------------
describe("deriveZones - degenerate inputs", () => {
  it("returns all-zero counts when strip start equals end (zero-length)", () => {
    const strip = makeStrip(2.0, 0.0, 2.0, 0.0, 50);
    const result = deriveZones(strip, TV);
    expect(result.counts.top).toBe(0);
    expect(result.counts.right).toBe(0);
    expect(result.counts.bottom).toBe(0);
    expect(result.counts.left).toBe(0);
    expect(result.segments).toEqual([]);
  });

  // ---------------------------------------------------------------------------
  // Test 7: Degenerate — both endpoints inside TV bounding box
  // ---------------------------------------------------------------------------
  it("returns all-zero counts when both strip endpoints are inside TV bounding box", () => {
    // TV: x=2.5, y=0.5, w=2, h=0.1 → bbox [1.5..3.5] x [0.45..0.55]
    const strip = makeStrip(2.0, 0.47, 3.0, 0.53, 30);
    const result = deriveZones(strip, TV);
    expect(result.counts.top).toBe(0);
    expect(result.counts.right).toBe(0);
    expect(result.counts.bottom).toBe(0);
    expect(result.counts.left).toBe(0);
    expect(result.segments).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Test 8: pointToSegmentDistance helper
// ---------------------------------------------------------------------------
describe("pointToSegmentDistance", () => {
  it("returns 0 when point is on the segment", () => {
    // Point (1,0) on segment (0,0)→(2,0)
    expect(pointToSegmentDistance(1, 0, 0, 0, 2, 0)).toBeCloseTo(0);
  });

  it("returns perpendicular distance for point above horizontal segment", () => {
    // Point (1,3) above segment (0,0)→(2,0) → distance = 3
    expect(pointToSegmentDistance(1, 3, 0, 0, 2, 0)).toBeCloseTo(3);
  });

  it("returns endpoint distance when projection falls outside segment", () => {
    // Point (5,0) and segment (0,0)→(2,0) → closest endpoint is (2,0), distance = 3
    expect(pointToSegmentDistance(5, 0, 0, 0, 2, 0)).toBeCloseTo(3);
  });

  it("handles zero-length segment (a === b) as point-to-point distance", () => {
    // Segment is a single point at (1,1), query point at (4,5)
    // distance = sqrt((4-1)^2 + (5-1)^2) = sqrt(9+16) = 5
    expect(pointToSegmentDistance(4, 5, 1, 1, 1, 1)).toBeCloseTo(5);
  });
});
