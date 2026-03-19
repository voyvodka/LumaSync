import { describe, expect, it } from "vitest";

import type { LedCalibrationConfig } from "./contracts";
import { buildLedSequence } from "./indexMapping";

const BASE_CONFIG: LedCalibrationConfig = {
  counts: {
    top: 3,
    left: 2,
    right: 2,
    bottomLeft: 2,
    bottomRight: 2,
  },
  bottomGapPx: 120,
  startAnchor: "top-start",
  direction: "cw",
  totalLeds: 11,
};

describe("buildLedSequence", () => {
  it("returns deterministic order for same input", () => {
    const first = buildLedSequence(BASE_CONFIG);
    const second = buildLedSequence(BASE_CONFIG);

    expect(second).toEqual(first);
  });

  it("returns reversed traversal between cw and ccw", () => {
    const clockwise = buildLedSequence({
      ...BASE_CONFIG,
      direction: "cw",
    });
    const counterClockwise = buildLedSequence({
      ...BASE_CONFIG,
      direction: "ccw",
    });

    const cwKeys = clockwise.map((item) => `${item.segment}:${item.localIndex}`);
    const ccwKeys = counterClockwise.map((item) => `${item.segment}:${item.localIndex}`);

    expect(cwKeys).toEqual([...ccwKeys].reverse());
  });

  it("does not change led count when only bottom gap changes", () => {
    const withSmallGap = buildLedSequence({
      ...BASE_CONFIG,
      bottomGapPx: 60,
    });
    const withLargeGap = buildLedSequence({
      ...BASE_CONFIG,
      bottomGapPx: 300,
    });

    expect(withSmallGap.length).toBe(BASE_CONFIG.totalLeds);
    expect(withLargeGap.length).toBe(BASE_CONFIG.totalLeds);
    expect(withLargeGap.length).toBe(withSmallGap.length);
  });
});
