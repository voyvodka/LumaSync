import { describe, expect, it } from "vitest";

import type { LedCalibrationConfig } from "../../calibration/model/contracts";
import { canEnableLedMode } from "./modeGuard";

const CALIBRATION: LedCalibrationConfig = {
  templateId: "monitor-27-16-9",
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

describe("canEnableLedMode", () => {
  it("returns CALIBRATION_REQUIRED when calibration is missing", () => {
    expect(canEnableLedMode(undefined)).toEqual({
      canEnable: false,
      reason: "CALIBRATION_REQUIRED",
    });
  });

  it("returns canEnable when calibration exists", () => {
    expect(canEnableLedMode(CALIBRATION)).toEqual({
      canEnable: true,
      reason: null,
    });
  });

  it("returns canEnable for Hue-only targets without calibration (D-05)", () => {
    expect(canEnableLedMode(undefined, ["hue"])).toEqual({
      canEnable: true,
      reason: null,
    });
  });

  it("returns CALIBRATION_REQUIRED for USB target without calibration", () => {
    expect(canEnableLedMode(undefined, ["usb"])).toEqual({
      canEnable: false,
      reason: "CALIBRATION_REQUIRED",
    });
  });

  it("returns CALIBRATION_REQUIRED for mixed targets with USB without calibration", () => {
    expect(canEnableLedMode(undefined, ["usb", "hue"])).toEqual({
      canEnable: false,
      reason: "CALIBRATION_REQUIRED",
    });
  });

  it("returns CALIBRATION_REQUIRED for undefined targets (backward compatible)", () => {
    expect(canEnableLedMode(undefined, undefined)).toEqual({
      canEnable: false,
      reason: "CALIBRATION_REQUIRED",
    });
  });

  it("returns CALIBRATION_REQUIRED for empty targets array (treated as USB default)", () => {
    expect(canEnableLedMode(undefined, [])).toEqual({
      canEnable: false,
      reason: "CALIBRATION_REQUIRED",
    });
  });
});
