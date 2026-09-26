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

  it("accepts a stand gap wider than the bottom edge", () => {
    const result = validateCalibrationConfig({
      ...VALID_CONFIG,
      bottomMissing: VALID_CONFIG.counts.bottom + 1,
    });

    expect(result.ok).toBe(true);
  });

  it("rejects a stand gap with fewer than one LED each side of it", () => {
    const counts = { ...VALID_CONFIG.counts, bottom: 1 };
    const result = validateCalibrationConfig({
      ...VALID_CONFIG,
      counts,
      bottomMissing: 4,
      totalLeds: counts.top + counts.right + counts.bottom + counts.left,
    });

    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => error.code === "BOTTOM_GAP_NEEDS_TWO_LEDS")).toBe(true);
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

  it("rejects bottomMissing > 0 when bottom edge has zero LEDs (contradictory config)", () => {
    const result = validateCalibrationConfig({
      ...VALID_CONFIG,
      counts: { top: 36, right: 22, bottom: 0, left: 22 },
      bottomMissing: 1,
      totalLeds: 80, // top + right + left = 80; bottom intentionally 0
    });

    expect(result.ok).toBe(false);
    expect(result.errors.find((e) => e.code === "BOTTOM_GAP_NEEDS_TWO_LEDS")?.field).toBe("bottomMissing");
  });
});
