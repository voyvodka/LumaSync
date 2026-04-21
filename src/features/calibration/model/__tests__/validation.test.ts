import { describe, expect, it } from "vitest";

import type { LedCalibrationConfig } from "../contracts";
import { validateCalibrationConfig } from "../validation";

const VALID_CONFIG: LedCalibrationConfig = {
  counts: {
    top: 36,
    right: 22,
    bottom: 34,
    left: 22,
  },
  bottomMissing: 2,
  cornerOwnership: "horizontal",
  visualPreset: "vivid",
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

  it("accepts a partial-edge configuration (only top strip)", () => {
    const topOnly: LedCalibrationConfig = {
      ...VALID_CONFIG,
      counts: { top: 30, right: 0, bottom: 0, left: 0 },
      bottomMissing: 0,
      totalLeds: 30,
    };
    const result = validateCalibrationConfig(topOnly);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("rejects negative segment values", () => {
    const result = validateCalibrationConfig({
      ...VALID_CONFIG,
      counts: {
        ...VALID_CONFIG.counts,
        top: -1,
      },
      totalLeds: VALID_CONFIG.totalLeds - VALID_CONFIG.counts.top - 1,
    });

    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => error.code === "SEGMENT_NEGATIVE")).toBe(true);
  });

  it("rejects negative bottom missing led count", () => {
    const result = validateCalibrationConfig({
      ...VALID_CONFIG,
      bottomMissing: -1,
    });

    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => error.code === "BOTTOM_MISSING_NEGATIVE")).toBe(true);
  });

  it("rejects stand gap larger than bottom edge", () => {
    const result = validateCalibrationConfig({
      ...VALID_CONFIG,
      bottomMissing: VALID_CONFIG.counts.bottom + 1,
    });

    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => error.code === "BOTTOM_MISSING_EXCEEDS_BOTTOM")).toBe(true);
  });

  it("rejects empty configuration (no LEDs anywhere)", () => {
    const result = validateCalibrationConfig({
      ...VALID_CONFIG,
      counts: { top: 0, right: 0, bottom: 0, left: 0 },
      bottomMissing: 0,
      totalLeds: 0,
    });

    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => error.code === "NO_LEDS_CONFIGURED")).toBe(true);
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
