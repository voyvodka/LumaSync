/**
 * geometry.ts — twin LED position mapping tests.
 *
 * The highest-correctness requirement of the twin overlay is:
 *   twin LED #N === strip LED #N
 *
 * `computeTwinLedPositions` reuses `buildLedSequence` (the same function the
 * calibration editor and synthetic test generator use) to derive strip order,
 * then maps each {segment, localIndex} to a normalized 0..1 screen-perimeter
 * position. These tests verify that the mapping is consistent with the
 * canonical calibration sequence and places dots on the correct edges.
 *
 * Covers:
 *   - Result array length equals total LED count (every LED has a position).
 *   - result[N].index === N for every N (array position IS the strip index).
 *   - result[N].edge matches the segment in buildLedSequence[N].
 *   - Top-edge LEDs sit at y === EDGE_INSET (pinned to the top border).
 *   - Right-edge LEDs sit at x === 1 − EDGE_INSET (pinned to the right border).
 *   - Bottom-edge LEDs sit at y === 1 − EDGE_INSET (pinned to the bottom border).
 *   - Left-edge LEDs sit at x === EDGE_INSET (pinned to the left border).
 *   - All normalized coordinates are clamped within [0, 1].
 */

import { describe, expect, it } from "vitest";

import type { LedCalibrationConfig } from "../../calibration/model/contracts";
import { buildLedSequence } from "../../calibration/model/indexMapping";
import { computeTwinLedPositions } from "../geometry";

// ---------------------------------------------------------------------------
// Layout constants mirrored from geometry.ts (test-side copies; if the
// implementation changes these numbers, the tests break loudly).
// ---------------------------------------------------------------------------
const EDGE_INSET = 0.022;
const CORNER_INSET = 0.03;

// ---------------------------------------------------------------------------
// Fixture configs
// ---------------------------------------------------------------------------

const STANDARD_CONFIG: LedCalibrationConfig = {
  counts: { top: 10, right: 6, bottom: 8, left: 6 },
  bottomMissing: 0,
  cornerOwnership: "horizontal",
  visualPreset: "vivid",
  startAnchor: "top-start",
  direction: "cw",
  totalLeds: 30,
};

/** Config with a non-zero bottomMissing gap so the gap-packing branch fires. */
const GAP_CONFIG: LedCalibrationConfig = {
  counts: { top: 8, right: 5, bottom: 10, left: 5 },
  bottomMissing: 4,
  cornerOwnership: "horizontal",
  visualPreset: "vivid",
  startAnchor: "bottom-start",
  direction: "cw",
  totalLeds: 28,
};

/** CCW direction to verify that reversed traversal still maps edges correctly. */
const CCW_CONFIG: LedCalibrationConfig = {
  ...STANDARD_CONFIG,
  direction: "ccw",
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("computeTwinLedPositions — array length and strip index mapping", () => {
  it("returns one position per LED (standard config)", () => {
    const positions = computeTwinLedPositions(STANDARD_CONFIG);
    expect(positions).toHaveLength(STANDARD_CONFIG.totalLeds);
  });

  it("result[N].index === N for every LED in standard config (twin LED #N = strip LED #N)", () => {
    const positions = computeTwinLedPositions(STANDARD_CONFIG);
    positions.forEach((pos, i) => {
      expect(pos.index).toBe(i);
    });
  });

  it("result[N].edge matches buildLedSequence[N].segment for every LED", () => {
    const positions = computeTwinLedPositions(STANDARD_CONFIG);
    const sequence = buildLedSequence(STANDARD_CONFIG);
    positions.forEach((pos, i) => {
      expect(pos.edge).toBe(sequence[i]?.segment);
    });
  });

  it("returns one position per LED with bottomMissing gap config", () => {
    const positions = computeTwinLedPositions(GAP_CONFIG);
    expect(positions).toHaveLength(GAP_CONFIG.totalLeds);
  });

  it("result[N].index === N for CCW direction traversal", () => {
    const positions = computeTwinLedPositions(CCW_CONFIG);
    positions.forEach((pos, i) => {
      expect(pos.index).toBe(i);
    });
  });
});

describe("computeTwinLedPositions — edge-pinned y/x coordinates", () => {
  it("every top-edge LED has y === EDGE_INSET", () => {
    const positions = computeTwinLedPositions(STANDARD_CONFIG);
    const topLeds = positions.filter((p) => p.edge === "top");
    expect(topLeds.length).toBe(STANDARD_CONFIG.counts.top);
    topLeds.forEach((p) => {
      expect(p.y).toBeCloseTo(EDGE_INSET, 6);
    });
  });

  it("every right-edge LED has x === 1 − EDGE_INSET", () => {
    const positions = computeTwinLedPositions(STANDARD_CONFIG);
    const rightLeds = positions.filter((p) => p.edge === "right");
    expect(rightLeds.length).toBe(STANDARD_CONFIG.counts.right);
    rightLeds.forEach((p) => {
      expect(p.x).toBeCloseTo(1 - EDGE_INSET, 6);
    });
  });

  it("every bottom-edge LED has y === 1 − EDGE_INSET", () => {
    const positions = computeTwinLedPositions(STANDARD_CONFIG);
    const bottomLeds = positions.filter((p) => p.edge === "bottom");
    expect(bottomLeds.length).toBe(STANDARD_CONFIG.counts.bottom);
    bottomLeds.forEach((p) => {
      expect(p.y).toBeCloseTo(1 - EDGE_INSET, 6);
    });
  });

  it("every left-edge LED has x === EDGE_INSET", () => {
    const positions = computeTwinLedPositions(STANDARD_CONFIG);
    const leftLeds = positions.filter((p) => p.edge === "left");
    expect(leftLeds.length).toBe(STANDARD_CONFIG.counts.left);
    leftLeds.forEach((p) => {
      expect(p.x).toBeCloseTo(EDGE_INSET, 6);
    });
  });

  it("all normalized x and y coordinates are within [0, 1]", () => {
    const positions = computeTwinLedPositions(STANDARD_CONFIG);
    positions.forEach((p) => {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(1);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeLessThanOrEqual(1);
    });
  });
});

describe("computeTwinLedPositions — horizontal spread within CORNER_INSET", () => {
  it("top-edge LED x positions stay within [CORNER_INSET, 1 − CORNER_INSET]", () => {
    const positions = computeTwinLedPositions(STANDARD_CONFIG);
    positions
      .filter((p) => p.edge === "top")
      .forEach((p) => {
        expect(p.x).toBeGreaterThanOrEqual(CORNER_INSET - 1e-9);
        expect(p.x).toBeLessThanOrEqual(1 - CORNER_INSET + 1e-9);
      });
  });

  it("bottom-edge LED x positions stay within [CORNER_INSET, 1 − CORNER_INSET]", () => {
    const positions = computeTwinLedPositions(GAP_CONFIG);
    positions
      .filter((p) => p.edge === "bottom")
      .forEach((p) => {
        expect(p.x).toBeGreaterThanOrEqual(CORNER_INSET - 1e-9);
        expect(p.x).toBeLessThanOrEqual(1 - CORNER_INSET + 1e-9);
      });
  });
});
