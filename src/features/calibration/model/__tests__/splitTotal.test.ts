import { describe, expect, it } from "vitest";

import { sumSegmentCounts } from "../contracts";
import { ALL_EDGES, litEdges, MAX_STRIP_LEDS, splitTotalAcrossEdges } from "../splitTotal";

const FHD = { width: 1920, height: 1080 };
const PORTRAIT = { width: 1080, height: 1920 };
const ULTRAWIDE = { width: 3440, height: 1440 };

describe("splitTotalAcrossEdges", () => {
  it("splits a 16:9 strip by edge length", () => {
    expect(splitTotalAcrossEdges({ total: 120, display: FHD, edges: ALL_EDGES })).toEqual({
      counts: { top: 38, right: 22, bottom: 38, left: 22 },
      bottomMissing: 0,
    });
  });

  it("depends on the display's shape, not its pixel count", () => {
    const retina = splitTotalAcrossEdges({ total: 120, display: { width: 3840, height: 2160 }, edges: ALL_EDGES });
    expect(retina).toEqual(splitTotalAcrossEdges({ total: 120, display: FHD, edges: ALL_EDGES }));
  });

  it("always adds up to the total, whatever the total and shape", () => {
    for (const display of [FHD, PORTRAIT, ULTRAWIDE, { width: 1280, height: 1024 }, { width: 1, height: 1 }]) {
      for (let total = 1; total <= 400; total += 1) {
        for (const edges of [ALL_EDGES, ["top", "right", "left"] as const, ["top"] as const]) {
          const { counts } = splitTotalAcrossEdges({ total, display, edges, bottomGap: 6 });
          expect(sumSegmentCounts(counts)).toBe(total);
        }
      }
    }
  });

  it("gives an odd total's spare LED to the edge that lost the most to rounding", () => {
    const { counts } = splitTotalAcrossEdges({ total: 121, display: FHD, edges: ALL_EDGES });
    // Shares 38.72 / 21.78 / 38.72 / 21.78: the sides round up first, then top.
    expect(counts).toEqual({ top: 39, right: 22, bottom: 38, left: 22 });
  });

  it("gives a portrait display's long edges to the sides", () => {
    const { counts } = splitTotalAcrossEdges({ total: 120, display: PORTRAIT, edges: ALL_EDGES });
    expect(counts).toEqual({ top: 22, right: 38, bottom: 22, left: 38 });
  });

  it("leaves an edge the strip does not run along at zero", () => {
    const { counts } = splitTotalAcrossEdges({ total: 120, display: FHD, edges: ["top", "right", "left"] });
    expect(counts).toEqual({ top: 56, right: 32, bottom: 0, left: 32 });
  });

  it("takes the stand gap's room from the bottom edge only", () => {
    const result = splitTotalAcrossEdges({ total: 120, display: FHD, edges: ALL_EDGES, bottomGap: 10 });
    // 130 pitches of perimeter, 10 of them empty under the stand.
    expect(result).toEqual({ counts: { top: 42, right: 23, bottom: 32, left: 23 }, bottomMissing: 10 });
  });

  it("drops the gap when the bottom edge is not lit", () => {
    const result = splitTotalAcrossEdges({ total: 120, display: FHD, edges: ["top", "right", "left"], bottomGap: 10 });
    expect(result.bottomMissing).toBe(0);
  });

  it("shrinks a gap the bottom edge cannot hold to one the layout accepts", () => {
    const result = splitTotalAcrossEdges({ total: 20, display: FHD, edges: ALL_EDGES, bottomGap: 40 });
    expect(sumSegmentCounts(result.counts)).toBe(20);
    expect(result.bottomMissing).toBeGreaterThan(0);
    expect(result.bottomMissing).toBeLessThanOrEqual(result.counts.bottom);
  });

  it("lights every edge once there are as many LEDs as edges", () => {
    const { counts } = splitTotalAcrossEdges({ total: 4, display: ULTRAWIDE, edges: ALL_EDGES });
    expect(counts).toEqual({ top: 1, right: 1, bottom: 1, left: 1 });
  });

  it("returns nothing to light for no LEDs or no edges", () => {
    const empty = { counts: { top: 0, right: 0, bottom: 0, left: 0 }, bottomMissing: 0 };
    expect(splitTotalAcrossEdges({ total: 0, display: FHD, edges: ALL_EDGES })).toEqual(empty);
    expect(splitTotalAcrossEdges({ total: 120, display: FHD, edges: [] })).toEqual(empty);
    expect(splitTotalAcrossEdges({ total: Number.NaN, display: FHD, edges: ALL_EDGES })).toEqual(empty);
  });

  it("caps the total at the largest strip it takes", () => {
    const { counts } = splitTotalAcrossEdges({ total: 5000, display: FHD, edges: ["top"] });
    expect(counts.top).toBe(MAX_STRIP_LEDS);
  });

  it("falls back to 16:9 for a display with no size", () => {
    expect(splitTotalAcrossEdges({ total: 120, display: { width: 0, height: 0 }, edges: ALL_EDGES }).counts)
      .toEqual({ top: 38, right: 22, bottom: 38, left: 22 });
  });
});

describe("litEdges", () => {
  it("lists the edges with LEDs, and all four for an empty layout", () => {
    expect(litEdges({ top: 3, right: 0, bottom: 2, left: 0 })).toEqual(["top", "bottom"]);
    expect(litEdges({ top: 0, right: 0, bottom: 0, left: 0 })).toEqual(["top", "right", "bottom", "left"]);
  });
});
