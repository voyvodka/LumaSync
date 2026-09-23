import { describe, expect, it, vi } from "vitest";

import { HUE_COMMANDS, HUE_RUNTIME_TRIGGER_SOURCE } from "@/shared/contracts/hue";
import type { LightingModeConfig } from "../model/contracts";
import {
  getHueStreamStatus,
  getLightingModeStatus,
  restartHue,
  setHueSolidColor,
  startHue,
  setLightingMode,
  stopHue,
  stopLighting,
  type ModeApiError,
} from "../modeApi";

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

  it("carries the room geometry through the normalize that strips it from persistence", async () => {
    const invokeMock = vi.fn().mockResolvedValue({
      active: true,
      mode: { kind: "ambilight" },
      status: { code: "AMBILIGHT_MODE_UPDATED", message: "", details: null },
    });
    const roomGeometry = {
      dimensions: { widthMeters: 5, depthMeters: 4, heightMeters: 2.5 },
      tv: { x: 1.5, y: 0, width: 2, height: 0.3 },
      huePlacements: [{ channelId: 3, positionX: 0.2, positionY: 0.9 }],
    };

    await setLightingMode(
      { kind: "ambilight", ambilight: { brightness: 1 }, roomGeometry },
      invokeMock,
    );
    await setLightingMode({ kind: "ambilight", ambilight: { brightness: 1 } }, invokeMock);

    expect(invokeMock.mock.calls[0][1].payload.roomGeometry).toEqual(roomGeometry);
    expect(invokeMock.mock.calls[1][1].payload).not.toHaveProperty("roomGeometry");
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
      code: "PORT_UNSUPPORTED",
      message: "Invalid mode payload",
      details: "solid payload missing rgb values",
    } satisfies ModeApiError);

    await expect(setLightingMode(SOLID_MODE, invokeMock)).rejects.toEqual({
      code: "PORT_UNSUPPORTED",
      message: "Invalid mode payload",
      details: "solid payload missing rgb values",
    });
  });

  // Was asserted with "MODE_INVALID", a code no producer emits. Relaying an
  // undeclared code would put an unhandleable value on ModeApiError.code.
  it("collapses an undeclared code on a structured rejection to UNKNOWN", async () => {
    const invokeMock = vi.fn().mockRejectedValue({
      code: "MODE_DEFINITELY_INVALID",
      message: "Invalid mode payload",
    });

    await expect(setLightingMode(SOLID_MODE, invokeMock)).rejects.toEqual({
      code: "UNKNOWN",
      message: "Invalid mode payload",
      details: undefined,
    });
  });

  // Every mode/Hue command is `Result<_, String>`: the rejection is a bare
  // string, which used to become UNKNOWN with a placeholder message and no log.
  it("keeps and logs the text of a bare-string Rust rejection", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const invokeMock = vi
      .fn()
      .mockRejectedValue("LIGHTING_RUNTIME_STATE_LOCK_FAILED: poisoned lock");

    await expect(stopLighting(invokeMock)).rejects.toEqual({
      code: "UNKNOWN",
      message: "LIGHTING_RUNTIME_STATE_LOCK_FAILED: poisoned lock",
      details: "poisoned lock",
    });
    expect(errorSpy).toHaveBeenCalledWith(
      "[LumaSync] stop_lighting rejected:",
      "LIGHTING_RUNTIME_STATE_LOCK_FAILED: poisoned lock",
    );
    errorSpy.mockRestore();
  });

  it("relays a declared device code carried in a string rejection", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const invokeMock = vi.fn().mockRejectedValue("PORT_NOT_FOUND: COM9");

    await expect(setLightingMode(SOLID_MODE, invokeMock)).rejects.toMatchObject({
      code: "PORT_NOT_FOUND",
    });
    errorSpy.mockRestore();
  });

  it("invokes get_hue_stream_status and returns full command result", async () => {
    const runtimeStatus = {
      state: "Running",
      code: "HUE_STREAM_RUNNING",
      message: "Hue stream is running.",
      details: null,
      triggerSource: HUE_RUNTIME_TRIGGER_SOURCE.MODE_CONTROL,
    };
    const commandResult = {
      active: true,
      status: runtimeStatus,
      lastSolidColor: null,
    };
    const invokeMock = vi.fn().mockResolvedValue(commandResult);

    await expect(getHueStreamStatus(invokeMock)).resolves.toEqual(commandResult);
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
        clientKey: "AABBCCDD11223344AABBCCDD11223344",
        areaId: "area-1",
      },
      invokeMock,
    );

    expect(invokeMock).toHaveBeenCalledWith(HUE_COMMANDS.START_STREAM, {
      request: {
        bridgeIp: "192.168.1.4",
        username: "demo-user",
        clientKey: "AABBCCDD11223344AABBCCDD11223344",
        areaId: "area-1",
        triggerSource: HUE_RUNTIME_TRIGGER_SOURCE.MODE_CONTROL,
      },
    });
  });

  it("invokes restart_hue_stream with device-surface trigger by default", async () => {
    const invokeMock = vi.fn().mockResolvedValue({
      active: true,
      status: {
        state: "Running",
        code: "HUE_STREAM_RUNNING",
        message: "Hue runtime restarted and running.",
        details: null,
        triggerSource: HUE_RUNTIME_TRIGGER_SOURCE.DEVICE_SURFACE,
      },
    });

    await restartHue(
      {
        bridgeIp: "192.168.1.4",
        username: "demo-user",
        clientKey: "AABBCCDD11223344AABBCCDD11223344",
        areaId: "area-1",
      },
      invokeMock,
    );

    expect(invokeMock).toHaveBeenCalledWith(HUE_COMMANDS.RESTART_STREAM, {
      request: {
        bridgeIp: "192.168.1.4",
        username: "demo-user",
        clientKey: "AABBCCDD11223344AABBCCDD11223344",
        areaId: "area-1",
        triggerSource: HUE_RUNTIME_TRIGGER_SOURCE.DEVICE_SURFACE,
      },
    });
  });

  it("invokes set_hue_solid_color with normalized payload", async () => {
    const invokeMock = vi.fn().mockResolvedValue({
      active: true,
      status: {
        state: "Running",
        code: "HUE_COLOR_APPLIED",
        message: "Hue solid color update applied.",
        details: null,
        triggerSource: HUE_RUNTIME_TRIGGER_SOURCE.MODE_CONTROL,
      },
    });

    await setHueSolidColor(
      {
        r: 123.9,
        g: 200.1,
        b: 40,
        brightness: 0.8,
      },
      invokeMock,
    );

    expect(invokeMock).toHaveBeenCalledWith(HUE_COMMANDS.SET_SOLID_COLOR, {
      request: {
        r: 123,
        g: 200,
        b: 40,
        brightness: 0.8,
        triggerSource: HUE_RUNTIME_TRIGGER_SOURCE.MODE_CONTROL,
      },
    });
  });
});
