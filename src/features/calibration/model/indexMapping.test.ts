import { describe, expect, it } from "vitest";

import type { LedCalibrationConfig } from "./contracts";
import { buildLedSequence, resolveLedSequenceItem } from "./indexMapping";

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

  it("preserves physical index set across orientation changes", () => {
    const combinations: Array<Pick<LedCalibrationConfig, "startAnchor" | "direction">> = [
      { startAnchor: "top-start", direction: "cw" },
      { startAnchor: "top-start", direction: "ccw" },
      { startAnchor: "bottom-right-end", direction: "cw" },
      { startAnchor: "bottom-right-end", direction: "ccw" },
    ];

    const expectedIndexes = Array.from({ length: BASE_CONFIG.totalLeds }, (_, index) => index);

    for (const combination of combinations) {
      const sequence = buildLedSequence({
        ...BASE_CONFIG,
        ...combination,
      });

      expect(sequence).toHaveLength(BASE_CONFIG.totalLeds);
      expect([...sequence.map((item) => item.index)].sort((a, b) => a - b)).toEqual(expectedIndexes);
    }
  });

  it("returns deterministic first physical indexes for anchor and direction pairs", () => {
    const cases: Array<{
      startAnchor: LedCalibrationConfig["startAnchor"];
      direction: LedCalibrationConfig["direction"];
      expectedFirstIndex: number;
    }> = [
      { startAnchor: "top-start", direction: "cw", expectedFirstIndex: 0 },
      { startAnchor: "top-start", direction: "ccw", expectedFirstIndex: 0 },
      { startAnchor: "left-end", direction: "cw", expectedFirstIndex: 10 },
      { startAnchor: "left-end", direction: "ccw", expectedFirstIndex: 10 },
      { startAnchor: "bottom-right-end", direction: "cw", expectedFirstIndex: 6 },
      { startAnchor: "bottom-right-end", direction: "ccw", expectedFirstIndex: 6 },
    ];

    for (const testCase of cases) {
      const sequence = buildLedSequence({
        ...BASE_CONFIG,
        startAnchor: testCase.startAnchor,
        direction: testCase.direction,
      });

      expect(sequence[0]?.index).toBe(testCase.expectedFirstIndex);
    }
  });

  it("keeps the same anchor-led physical index as first item for both directions", () => {
    const anchors: LedCalibrationConfig["startAnchor"][] = [
      "top-start",
      "top-end",
      "right-start",
      "right-end",
      "bottom-right-start",
      "bottom-right-end",
      "bottom-left-start",
      "bottom-left-end",
      "left-start",
      "left-end",
    ];

    for (const startAnchor of anchors) {
      const clockwise = buildLedSequence({ ...BASE_CONFIG, startAnchor, direction: "cw" });
      const counterClockwise = buildLedSequence({ ...BASE_CONFIG, startAnchor, direction: "ccw" });

      expect(counterClockwise[0]?.index).toBe(clockwise[0]?.index);
    }
  });
});

describe("resolveLedSequenceItem", () => {
  it("normalizes negative and overflowing marker indexes", () => {
    const sequence = buildLedSequence(BASE_CONFIG);
    const sequenceLength = sequence.length;

    expect(resolveLedSequenceItem(sequence, 0)).toEqual(sequence[0]);
    expect(resolveLedSequenceItem(sequence, sequenceLength)).toEqual(sequence[0]);
    expect(resolveLedSequenceItem(sequence, sequenceLength + 3)).toEqual(sequence[3]);
    expect(resolveLedSequenceItem(sequence, -1)).toEqual(sequence[sequenceLength - 1]);
    expect(resolveLedSequenceItem(sequence, -(sequenceLength + 2))).toEqual(sequence[sequenceLength - 2]);
  });

  it("returns null for empty sequence", () => {
    expect(resolveLedSequenceItem([], 0)).toBeNull();
    expect(resolveLedSequenceItem([], 12)).toBeNull();
    expect(resolveLedSequenceItem([], -2)).toBeNull();
  });
});
