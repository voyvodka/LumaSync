import { describe, expect, it, vi } from "vitest";

import { HUE_COMMANDS, HUE_RUNTIME_TRIGGER_SOURCE } from "../../shared/contracts/hue";
import type { LightingModeConfig } from "./model/contracts";
import {
  getHueStreamStatus,
  getLightingModeStatus,
  startHue,
  setLightingMode,
  stopHue,
  stopLighting,
  type ModeApiError,
} from "./modeApi";

const SOLID_MODE: LightingModeConfig = {
  kind: "solid",
  solid: { r: 100, g: 50, b: 25, brightness: 0.7 },
};

describe("modeApi wrappers", () => {
  it("invokes set_lighting_mode with payload contract", async () => {
    const invokeMock = vi.fn().mockResolvedValue({
      active: true,
      mode: SOLID_MODE,
      status: { code: "OK", message: "Set", details: null },
    });

    await setLightingMode(SOLID_MODE, invokeMock);

    expect(invokeMock).toHaveBeenCalledWith("set_lighting_mode", { payload: SOLID_MODE });
  });

  it("invokes stop_lighting and get_lighting_mode_status commands", async () => {
    const invokeMock = vi.fn().mockResolvedValue({
      active: false,
      mode: { kind: "off" },
      status: { code: "OK", message: "Stopped", details: null },
    });

    await stopLighting(invokeMock);
    await getLightingModeStatus(invokeMock);

    expect(invokeMock).toHaveBeenNthCalledWith(1, "stop_lighting");
    expect(invokeMock).toHaveBeenNthCalledWith(2, "get_lighting_mode_status");
  });

  it("maps invoke errors to code/message/details shape", async () => {
    const invokeMock = vi.fn().mockRejectedValue({
      code: "MODE_INVALID",
      message: "Invalid mode payload",
      details: "solid payload missing rgb values",
    } satisfies ModeApiError);

    await expect(setLightingMode(SOLID_MODE, invokeMock)).rejects.toEqual({
      code: "MODE_INVALID",
      message: "Invalid mode payload",
      details: "solid payload missing rgb values",
    });
  });

  it("invokes get_hue_stream_status and returns typed runtime status", async () => {
    const runtimeStatus = {
      state: "Running",
      code: "HUE_STREAM_RUNNING",
      message: "Hue stream is running.",
      details: null,
      triggerSource: HUE_RUNTIME_TRIGGER_SOURCE.MODE_CONTROL,
    };
    const invokeMock = vi.fn().mockResolvedValue(runtimeStatus);

    await expect(getHueStreamStatus(invokeMock)).resolves.toEqual(runtimeStatus);
    expect(invokeMock).toHaveBeenCalledWith(HUE_COMMANDS.GET_STREAM_STATUS);
  });

  it("invokes stop_hue_stream with device-surface trigger payload", async () => {
    const invokeMock = vi.fn().mockResolvedValue({
      active: false,
      status: {
        state: "Idle",
        code: "HUE_STREAM_STOPPED",
        message: "Hue stream is idle.",
        details: null,
        triggerSource: HUE_RUNTIME_TRIGGER_SOURCE.DEVICE_SURFACE,
      },
    });

    await stopHue(HUE_RUNTIME_TRIGGER_SOURCE.DEVICE_SURFACE, invokeMock);

    expect(invokeMock).toHaveBeenCalledWith(HUE_COMMANDS.STOP_STREAM, {
      triggerSource: HUE_RUNTIME_TRIGGER_SOURCE.DEVICE_SURFACE,
    });
  });

  it("keeps start_hue_stream wrapper behavior and default mode-control trigger", async () => {
    const invokeMock = vi.fn().mockResolvedValue({
      active: true,
      status: {
        state: "Starting",
        code: "HUE_STREAM_STARTING",
        message: "Hue stream is starting.",
        details: null,
        triggerSource: HUE_RUNTIME_TRIGGER_SOURCE.MODE_CONTROL,
      },
    });

    await startHue(
      {
        bridgeIp: "192.168.1.4",
        username: "demo-user",
        areaId: "area-1",
      },
      invokeMock,
    );

    expect(invokeMock).toHaveBeenCalledWith(HUE_COMMANDS.START_STREAM, {
      request: {
        bridgeIp: "192.168.1.4",
        username: "demo-user",
        areaId: "area-1",
        triggerSource: HUE_RUNTIME_TRIGGER_SOURCE.MODE_CONTROL,
      },
    });
  });
});
