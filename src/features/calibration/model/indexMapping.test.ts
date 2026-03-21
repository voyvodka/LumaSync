import { describe, expect, it } from "vitest";

import type { LedCalibrationConfig } from "./contracts";
import { buildLedSequence, resolveLedSequenceItem } from "./indexMapping";

const BASE_CONFIG: LedCalibrationConfig = {
  counts: {
    top: 3,
    right: 2,
    bottom: 4,
    left: 2,
  },
  bottomMissing: 0,
  cornerOwnership: "horizontal",
  visualPreset: "vivid",
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

  it("reverses traversal after the shared anchor-led between cw and ccw", () => {
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

    expect(ccwKeys[0]).toBe(cwKeys[0]);
    expect(ccwKeys.slice(1)).toEqual([...cwKeys.slice(1)].reverse());
  });

  it("does not change led count when only bottom missing count changes", () => {
    const withSmallGap = buildLedSequence({
      ...BASE_CONFIG,
      bottomMissing: 0,
    });
    const withLargeGap = buildLedSequence({
      ...BASE_CONFIG,
      bottomMissing: 6,
    });

    expect(withSmallGap.length).toBe(BASE_CONFIG.totalLeds);
    expect(withLargeGap.length).toBe(BASE_CONFIG.totalLeds);
    expect(withLargeGap.length).toBe(withSmallGap.length);
  });

  it("preserves physical index set across orientation changes", () => {
    const combinations: Array<Pick<LedCalibrationConfig, "startAnchor" | "direction">> = [
      { startAnchor: "top-start", direction: "cw" },
      { startAnchor: "top-start", direction: "ccw" },
      { startAnchor: "bottom-end", direction: "cw" },
      { startAnchor: "bottom-end", direction: "ccw" },
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
      { startAnchor: "bottom-end", direction: "cw", expectedFirstIndex: 8 },
      { startAnchor: "bottom-end", direction: "ccw", expectedFirstIndex: 8 },
      { startAnchor: "bottom-gap-right", direction: "cw", expectedFirstIndex: 6 },
      { startAnchor: "bottom-gap-left", direction: "cw", expectedFirstIndex: 7 },
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
      "bottom-start",
      "bottom-end",
      "bottom-gap-right",
      "bottom-gap-left",
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
  it("treats non-finite marker indexes as first marker", () => {
    const sequence = buildLedSequence(BASE_CONFIG);

    expect(resolveLedSequenceItem(sequence, Number.NaN)).toEqual(sequence[0]);
    expect(resolveLedSequenceItem(sequence, Number.POSITIVE_INFINITY)).toEqual(sequence[0]);
    expect(resolveLedSequenceItem(sequence, Number.NEGATIVE_INFINITY)).toEqual(sequence[0]);
  });

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
