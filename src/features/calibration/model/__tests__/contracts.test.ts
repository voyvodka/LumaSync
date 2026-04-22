import { describe, expect, it } from "vitest";

import {
  normalizeLedCalibrationConfig,
  normalizeStartAnchor,
  sumSegmentCounts,
} from "../contracts";

describe("normalizeLedCalibrationConfig", () => {
  it("returns undefined for non-object input", () => {
    expect(normalizeLedCalibrationConfig(undefined)).toBeUndefined();
    expect(normalizeLedCalibrationConfig(null)).toBeUndefined();
    expect(normalizeLedCalibrationConfig("not-an-object")).toBeUndefined();
    expect(normalizeLedCalibrationConfig(42)).toBeUndefined();
  });

  it("normalizes a well-formed config and derives totalLeds from sum", () => {
    const result = normalizeLedCalibrationConfig({
      templateId: "monitor-27-16-9",
      counts: { top: 36, right: 22, bottom: 34, left: 22 },
      bottomMissing: 2,
      cornerOwnership: "horizontal",
      visualPreset: "vivid",
      startAnchor: "top-start",
      direction: "cw",
      totalLeds: 9999, // should be recomputed, not trusted
    });

    expect(result).toBeDefined();
    expect(result?.totalLeds).toBe(114);
    expect(result?.totalLeds).toBe(sumSegmentCounts(result!.counts));
  });

  it("clamps bottomMissing to counts.bottom so stand gap never exceeds the edge", () => {
    const result = normalizeLedCalibrationConfig({
      counts: { top: 10, right: 5, bottom: 4, left: 5 },
      bottomMissing: 99,
      cornerOwnership: "horizontal",
      visualPreset: "vivid",
      startAnchor: "top-start",
      direction: "cw",
    });

    expect(result?.bottomMissing).toBe(4);
  });

  it("floors fractional counts and rejects negative values to zero", () => {
    const result = normalizeLedCalibrationConfig({
      counts: { top: 10.9, right: -4, bottom: 0, left: 5 },
      bottomMissing: -1,
      cornerOwnership: "horizontal",
      visualPreset: "vivid",
      startAnchor: "top-start",
      direction: "cw",
    });

    expect(result?.counts).toEqual({ top: 10, right: 0, bottom: 0, left: 5 });
    expect(result?.bottomMissing).toBe(0);
  });

  it("migrates legacy bottomLeft+bottomRight counts into a single bottom edge", () => {
    const result = normalizeLedCalibrationConfig({
      counts: { top: 10, right: 6, bottomLeft: 8, bottomRight: 12, left: 6 },
      bottomMissing: 0,
      cornerOwnership: "horizontal",
      visualPreset: "vivid",
      startAnchor: "top-start",
      direction: "cw",
    });

    expect(result?.counts.bottom).toBe(20);
    expect(result?.counts.top).toBe(10);
  });

  it("falls back to safe defaults for unknown string enums", () => {
    const result = normalizeLedCalibrationConfig({
      counts: { top: 4, right: 4, bottom: 4, left: 4 },
      bottomMissing: 0,
      cornerOwnership: "not-a-real-value",
      visualPreset: "mystery",
      startAnchor: "moon-start",
      direction: "sideways",
    });

    expect(result?.cornerOwnership).toBe("horizontal");
    expect(result?.visualPreset).toBe("vivid");
    expect(result?.startAnchor).toBe("top-start");
    expect(result?.direction).toBe("cw");
  });
});

describe("healStartAnchor (via normalizeLedCalibrationConfig)", () => {
  it("moves the anchor to the first non-zero edge when its current edge is disabled", () => {
    const result = normalizeLedCalibrationConfig({
      counts: { top: 0, right: 12, bottom: 0, left: 0 },
      bottomMissing: 0,
      cornerOwnership: "horizontal",
      visualPreset: "vivid",
      startAnchor: "top-start",
      direction: "cw",
    });

    expect(result?.startAnchor).toBe("right-start");
  });

  it("falls back to bottom-start when bottomMissing is zero and anchor was bottom-gap-right", () => {
    const result = normalizeLedCalibrationConfig({
      counts: { top: 10, right: 6, bottom: 20, left: 6 },
      bottomMissing: 0,
      cornerOwnership: "horizontal",
      visualPreset: "vivid",
      startAnchor: "bottom-gap-right",
      direction: "cw",
    });

    expect(result?.startAnchor).toBe("bottom-start");
  });

  it("falls back to bottom-end when bottomMissing is zero and anchor was bottom-gap-left", () => {
    const result = normalizeLedCalibrationConfig({
      counts: { top: 10, right: 6, bottom: 20, left: 6 },
      bottomMissing: 0,
      cornerOwnership: "horizontal",
      visualPreset: "vivid",
      startAnchor: "bottom-gap-left",
      direction: "cw",
    });

    expect(result?.startAnchor).toBe("bottom-end");
  });

  it("keeps bottom-gap anchors when bottomMissing is positive (stand gap is real)", () => {
    const result = normalizeLedCalibrationConfig({
      counts: { top: 10, right: 6, bottom: 20, left: 6 },
      bottomMissing: 4,
      cornerOwnership: "horizontal",
      visualPreset: "vivid",
      startAnchor: "bottom-gap-right",
      direction: "cw",
    });

    expect(result?.startAnchor).toBe("bottom-gap-right");
  });

  it("returns the original anchor unchanged when every edge is zero (nothing to fall back to)", () => {
    const result = normalizeLedCalibrationConfig({
      counts: { top: 0, right: 0, bottom: 0, left: 0 },
      bottomMissing: 0,
      cornerOwnership: "horizontal",
      visualPreset: "vivid",
      startAnchor: "right-end",
      direction: "cw",
    });

    expect(result?.startAnchor).toBe("right-end");
  });
});

describe("normalizeStartAnchor", () => {
  it("maps legacy bottom-left / bottom-right anchors onto the new gap-free anchor set", () => {
    expect(normalizeStartAnchor("bottom-left-start")).toBe("bottom-end");
    expect(normalizeStartAnchor("bottom-left-end")).toBe("bottom-end");
    expect(normalizeStartAnchor("bottom-right-start")).toBe("bottom-start");
    expect(normalizeStartAnchor("bottom-right-end")).toBe("bottom-start");
  });

  it("preserves already-valid anchors and falls back to top-start for garbage", () => {
    expect(normalizeStartAnchor("bottom-gap-right")).toBe("bottom-gap-right");
    expect(normalizeStartAnchor("left-end")).toBe("left-end");
    expect(normalizeStartAnchor("")).toBe("top-start");
    expect(normalizeStartAnchor(undefined)).toBe("top-start");
    expect(normalizeStartAnchor(123 as unknown)).toBe("top-start");
  });
});
