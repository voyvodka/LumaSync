import { describe, expect, it, vi } from "vitest";

import type { LightingModeConfig } from "./model/contracts";
import {
  getLightingModeStatus,
  setLightingMode,
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
});
