import { describe, expect, it } from "vitest";

import type { LedCalibrationConfig } from "./contracts";
import { validateCalibrationConfig } from "./validation";

const VALID_CONFIG: LedCalibrationConfig = {
  counts: {
    top: 36,
    left: 22,
    right: 22,
    bottomLeft: 17,
    bottomRight: 17,
  },
  bottomGapPx: 140,
  startAnchor: "top-start",
  direction: "cw",
  totalLeds: 114,
};

describe("validateCalibrationConfig", () => {
  it("accepts a valid configuration", () => {
    const result = validateCalibrationConfig(VALID_CONFIG);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("rejects non-positive segment values", () => {
    const result = validateCalibrationConfig({
      ...VALID_CONFIG,
      counts: {
        ...VALID_CONFIG.counts,
        top: 0,
      },
    });

    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => error.code === "SEGMENT_NON_POSITIVE")).toBe(true);
  });

  it("rejects negative bottom gap", () => {
    const result = validateCalibrationConfig({
      ...VALID_CONFIG,
      bottomGapPx: -1,
    });

    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => error.code === "BOTTOM_GAP_NEGATIVE")).toBe(true);
  });

  it("rejects total mismatch", () => {
    const result = validateCalibrationConfig({
      ...VALID_CONFIG,
      totalLeds: 999,
    });

    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => error.code === "TOTAL_MISMATCH")).toBe(true);
  });
});
