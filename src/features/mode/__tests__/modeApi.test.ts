import { describe, expect, it, vi } from "vitest";

import { HUE_COMMANDS, HUE_RUNTIME_TRIGGER_SOURCE } from "@/shared/contracts/hue";
import { outputsResult } from "@/test/lightingRuntime";
import { mockCommands } from "@/test/mockCommands";
import {
  acquireHueForTest,
  applyOutputs,
  releaseHueAfterTest,
  restartHue,
  retuneLighting,
  startHue,
  type ModeApiError,
} from "../modeApi";

const APPLIED = outputsResult();

/** `apply_outputs` rejecting the way a `Result<_, String>` command does. */
function rejectingApply(reason: unknown) {
  return mockCommands({ apply_outputs: () => Promise.reject(reason) });
}

describe("modeApi wrappers", () => {
  it("sends a choice as its kind and only the payload the caller has", async () => {
    const invokeMock = mockCommands({ apply_outputs: APPLIED });

    await applyOutputs({ mode: { kind: "solid" }, origin: "tray" }, invokeMock);
    await applyOutputs(
      { mode: { kind: "solid", solid: { r: 300, g: 1, b: 2, brightness: 0.5 } }, origin: "user" },
      invokeMock,
    );

    // Absent keeps the last colour in Rust; a default filled in here would
    // overwrite it with white.
    expect(invokeMock.mock.calls[0]).toEqual([
      "apply_outputs",
      { request: { mode: { kind: "solid" }, origin: "tray" } },
    ]);
    expect(invokeMock.mock.calls[1]?.[1]).toMatchObject({
      request: { mode: { kind: "solid", solid: { r: 255, g: 1, b: 2, brightness: 0.5 } } },
    });
  });

  it("sends a target change without a mode", async () => {
    const invokeMock = mockCommands({ apply_outputs: APPLIED });

    await applyOutputs({ targets: ["usb", "hue"], origin: "user" }, invokeMock);

    expect(invokeMock).toHaveBeenCalledWith("apply_outputs", {
      request: { targets: ["usb", "hue"], origin: "user", mode: undefined },
    });
  });

  it("invokes retune_lighting with the tuning as given", async () => {
    const invokeMock = mockCommands({
      retune_lighting: { status: { code: "RETUNE_APPLIED", message: "", details: null } },
    });

    await retuneLighting({ ambilight: { brightness: 0.4 } }, invokeMock);

    expect(invokeMock).toHaveBeenCalledWith("retune_lighting", {
      tuning: { ambilight: { brightness: 0.4 } },
    });
  });

  it("borrows Hue for a test only when the test targets it, and always hands it back", async () => {
    const invokeMock = mockCommands({ apply_outputs: APPLIED });

    await acquireHueForTest(["usb"], invokeMock);
    expect(invokeMock).not.toHaveBeenCalled();

    await acquireHueForTest(["usb", "hue"], invokeMock);
    await releaseHueAfterTest(invokeMock);

    expect(invokeMock.mock.calls).toEqual([
      ["apply_outputs", { request: { targets: ["hue"], origin: "leaseHue", mode: undefined } }],
      ["apply_outputs", { request: { targets: [], origin: "leaseHue", mode: undefined } }],
    ]);
  });

  it("maps invoke errors to code/message/details shape", async () => {
    const invokeMock = rejectingApply({
      code: "PORT_UNSUPPORTED",
      message: "Invalid mode payload",
      details: "solid payload missing rgb values",
    } satisfies ModeApiError);

    await expect(applyOutputs({ origin: "user" }, invokeMock)).rejects.toEqual({
      code: "PORT_UNSUPPORTED",
      message: "Invalid mode payload",
      details: "solid payload missing rgb values",
    });
  });

  // Was asserted with "MODE_INVALID", a code no producer emits. Relaying an
  // undeclared code would put an unhandleable value on ModeApiError.code.
  it("collapses an undeclared code on a structured rejection to UNKNOWN", async () => {
    const invokeMock = rejectingApply({
      code: "MODE_DEFINITELY_INVALID",
      message: "Invalid mode payload",
    });

    await expect(applyOutputs({ origin: "user" }, invokeMock)).rejects.toEqual({
      code: "UNKNOWN",
      message: "Invalid mode payload",
      details: undefined,
    });
  });

  // Every mode/Hue command is `Result<_, String>`: the rejection is a bare
  // string, which used to become UNKNOWN with a placeholder message and no log.
  it("keeps and logs the text of a bare-string Rust rejection", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const invokeMock = rejectingApply("LIGHTING_RUNTIME_STATE_LOCK_FAILED: poisoned lock");

    await expect(applyOutputs({ origin: "user" }, invokeMock)).rejects.toEqual({
      code: "UNKNOWN",
      message: "LIGHTING_RUNTIME_STATE_LOCK_FAILED: poisoned lock",
      details: "poisoned lock",
    });
    expect(errorSpy).toHaveBeenCalledWith(
      "[LumaSync] apply_outputs rejected:",
      "LIGHTING_RUNTIME_STATE_LOCK_FAILED: poisoned lock",
    );
    errorSpy.mockRestore();
  });

  it("relays a declared device code carried in a string rejection", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const invokeMock = rejectingApply("PORT_NOT_FOUND: COM9");

    await expect(applyOutputs({ origin: "user" }, invokeMock)).rejects.toMatchObject({
      code: "PORT_NOT_FOUND",
    });
    errorSpy.mockRestore();
  });

  it("keeps start_hue_stream wrapper behavior and default mode-control trigger", async () => {
    const invokeMock = mockCommands({
      start_hue_stream: {
        active: true,
        status: {
          state: "Starting",
          code: "HUE_STREAM_STARTING",
          message: "Hue stream is starting.",
          details: null,
          triggerSource: HUE_RUNTIME_TRIGGER_SOURCE.MODE_CONTROL,
        },
        lastSolidColor: null,
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
    const invokeMock = mockCommands({
      restart_hue_stream: {
        active: true,
        status: {
          state: "Running",
          code: "HUE_STREAM_RUNNING",
          message: "Hue runtime restarted and running.",
          details: null,
          triggerSource: HUE_RUNTIME_TRIGGER_SOURCE.DEVICE_SURFACE,
        },
        lastSolidColor: null,
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
});
