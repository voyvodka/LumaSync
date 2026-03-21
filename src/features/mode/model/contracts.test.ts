import { describe, expect, it } from "vitest";

import type { LedCalibrationConfig } from "../../calibration/model/contracts";
import { DEVICE_COMMANDS } from "../../../shared/contracts/device";
import { type ShellState } from "../../../shared/contracts/shell";
import {
  LIGHTING_MODE_KIND,
  isLightingModeKind,
  normalizeSolidColorPayload,
} from "./contracts";

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

describe("lighting mode contracts", () => {
  it("accepts only off | ambilight | solid mode kind values", () => {
    expect(LIGHTING_MODE_KIND).toEqual({
      OFF: "off",
      AMBILIGHT: "ambilight",
      SOLID: "solid",
    });

    expect(isLightingModeKind("off")).toBe(true);
    expect(isLightingModeKind("ambilight")).toBe(true);
    expect(isLightingModeKind("solid")).toBe(true);
    expect(isLightingModeKind("rainbow")).toBe(false);
  });

  it("normalizes solid mode payload as r,g,b,brightness", () => {
    expect(
      normalizeSolidColorPayload({
        r: 300,
        g: -10,
        b: 10.9,
        brightness: 2,
      }),
    ).toEqual({
      r: 255,
      g: 0,
      b: 10,
      brightness: 1,
    });
  });

  it("keeps ledCalibration contract intact when shell state includes lighting mode fields", () => {
    const shellState: ShellState = {
      windowWidth: 1200,
      windowHeight: 840,
      windowX: 0,
      windowY: 0,
      lastSection: "general",
      trayHintShown: true,
      startupEnabled: false,
      ledCalibration: CALIBRATION,
      lightingMode: {
        kind: "solid",
        solid: {
          r: 120,
          g: 70,
          b: 40,
          brightness: 0.5,
        },
      },
    };

    expect(shellState.ledCalibration).toEqual(CALIBRATION);
  });

  it("maps mode command IDs in DEVICE_COMMANDS contract", () => {
    expect(DEVICE_COMMANDS.SET_LIGHTING_MODE).toBe("set_lighting_mode");
    expect(DEVICE_COMMANDS.STOP_LIGHTING).toBe("stop_lighting");
    expect(DEVICE_COMMANDS.GET_LIGHTING_MODE_STATUS).toBe("get_lighting_mode_status");
  });
});
