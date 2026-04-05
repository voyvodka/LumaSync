import { describe, expect, it } from "vitest";

import type { LedCalibrationConfig } from "../../calibration/model/contracts";
import { DEVICE_COMMANDS } from "../../../shared/contracts/device";
import {
  HUE_RUNTIME_ACTION_HINT,
  HUE_RUNTIME_STATES,
  HUE_RUNTIME_TRIGGER_SOURCE,
  type HueRuntimeStatus,
  type HueRuntimeTelemetry,
} from "../../../shared/contracts/hue";
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
      lastSection: "lights",
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

  it("exports Hue runtime lifecycle states as Idle/Starting/Running/Reconnecting/Stopping/Failed", () => {
    expect(HUE_RUNTIME_STATES).toEqual({
      IDLE: "Idle",
      STARTING: "Starting",
      RUNNING: "Running",
      RECONNECTING: "Reconnecting",
      STOPPING: "Stopping",
      FAILED: "Failed",
    });
  });

  it("supports retry metadata and action hint in Hue runtime status shape", () => {
    const runtimeStatus: HueRuntimeStatus = {
      state: "Reconnecting",
      code: "TRANSIENT_RETRY_SCHEDULED",
      message: "Retrying Hue stream.",
      details: "socket timeout",
      remainingAttempts: 3,
      nextAttemptMs: 800,
      actionHint: HUE_RUNTIME_ACTION_HINT.RECONNECT,
      triggerSource: HUE_RUNTIME_TRIGGER_SOURCE.MODE_CONTROL,
    };

    expect(runtimeStatus.remainingAttempts).toBe(3);
    expect(runtimeStatus.nextAttemptMs).toBe(800);
    expect(runtimeStatus.actionHint).toBe("reconnect");
    expect(runtimeStatus.triggerSource).toBe("mode_control");
  });

  it("keeps Hue target and aggregate telemetry rows in one typed runtime contract", () => {
    const telemetry: HueRuntimeTelemetry = {
      hue: {
        target: "hue",
        state: "Running",
        code: "HUE_STREAM_RUNNING",
        message: "Hue stream is active.",
      },
      aggregate: {
        activeTargets: ["hue", "usb"],
        runningCount: 2,
        reconnectingCount: 0,
        failedCount: 0,
      },
    };

    expect(telemetry.hue.target).toBe("hue");
    expect(telemetry.aggregate.activeTargets).toContain("usb");
  });
});
