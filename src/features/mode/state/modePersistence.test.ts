import { describe, expect, it } from "vitest";

import type { LedCalibrationConfig } from "../../calibration/model/contracts";
import type { ShellState } from "../../../shared/contracts/shell";
import type { LightingModeConfig } from "../model/contracts";
import { mergeLightingModeIntoShellState } from "./modeRuntimeFlow";

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

const SOLID_MODE: LightingModeConfig = {
  kind: "solid",
  solid: { r: 20, g: 40, b: 60, brightness: 0.5 },
};

describe("mergeLightingModeIntoShellState", () => {
  it("writes only lighting mode fields and preserves ledCalibration", () => {
    const currentState: ShellState = {
      windowWidth: 1280,
      windowHeight: 720,
      windowX: 0,
      windowY: 0,
      lastSection: "control",
      trayHintShown: true,
      startupEnabled: false,
      language: "en",
      lastSuccessfulPort: "tty.usbserial-001",
      ledCalibration: CALIBRATION,
    };

    const nextState = mergeLightingModeIntoShellState(currentState, SOLID_MODE);

    expect(nextState.ledCalibration).toEqual(CALIBRATION);
    expect(nextState.lastSuccessfulPort).toBe("tty.usbserial-001");
    expect(nextState.language).toBe("en");
    expect(nextState.lightingMode).toEqual(SOLID_MODE);
  });
});
