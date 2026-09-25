import { describe, expect, it } from "vitest";

import type { LedCalibrationConfig } from "@/features/calibration/model/contracts";
import { canEnableLedMode } from "../modeGuard";

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

  // Rust refuses a layout past the cap before it sizes a frame, so offering
  // the mode would only fail: it reads as a calibration to redo.
  it("returns CALIBRATION_REQUIRED for a layout past the LED cap", () => {
    const counts = { top: 2000, right: 100, bottom: 2000, left: 100 };
    expect(canEnableLedMode({ ...CALIBRATION, counts, totalLeds: 4200 }, ["usb"])).toEqual({
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

  // A fresh install selects `usb`; a Hue-only user was locked out of every mode.
  it("returns canEnable when USB is selected but no strip or WLED panel is connected", () => {
    expect(canEnableLedMode(undefined, ["usb", "hue"], false)).toEqual({
      canEnable: true,
      reason: null,
    });
    expect(canEnableLedMode(undefined, ["usb"], false).canEnable).toBe(true);
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
