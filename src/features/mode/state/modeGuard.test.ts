import { describe, expect, it } from "vitest";

import type { LedCalibrationConfig } from "../../calibration/model/contracts";
import { canEnableLedMode } from "./modeGuard";

const CALIBRATION: LedCalibrationConfig = {
  templateId: "monitor-27-16-9",
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
});
