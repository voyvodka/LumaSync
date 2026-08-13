// Regression: invalidation must live on the command, not in one call site's file.
// Real modeApi + real hueReadCache here, so an App.tsx-local wrapper cannot pass.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (command: string, payload?: Record<string, unknown>) => invokeMock(command, payload),
}));

import { __resetHueReadCacheForTests, readHueStreamStatus } from "@/features/hue/hueReadCache";
import { HUE_COMMANDS } from "@/shared/contracts/hue";
import { restartHue, startHue, stopHue } from "../modeApi";

const START_PAYLOAD = {
  bridgeIp: "192.168.1.50",
  username: "app-key",
  clientKey: "client-key",
  areaId: "area-1",
};

/** How many times the status command actually reached the Tauri boundary. */
function statusRoundTrips(): number {
  return invokeMock.mock.calls.filter(([command]) => command === HUE_COMMANDS.GET_STREAM_STATUS)
    .length;
}

describe("modeApi Hue mutations invalidate the shared status cache", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetHueReadCacheForTests();
    invokeMock.mockResolvedValue({
      active: true,
      status: {
        state: "Running",
        code: "HUE_STREAM_RUNNING",
        message: "ok",
        details: null,
        triggerSource: "ModeControl",
      },
    });
  });

  afterEach(() => {
    __resetHueReadCacheForTests();
  });

  it.each([
    ["startHue", () => startHue(START_PAYLOAD)],
    ["stopHue", () => stopHue()],
    ["restartHue", () => restartHue(START_PAYLOAD)],
  ])("%s forces the next status read back to the bridge", async (_name, mutate) => {
    await readHueStreamStatus();
    expect(statusRoundTrips()).toBe(1);

    // Without invalidation this second read is served from the 2 s cache.
    await mutate();
    await readHueStreamStatus();

    expect(statusRoundTrips()).toBe(2);
  });

  it("invalidates even when the mutation rejects", async () => {
    await readHueStreamStatus();
    invokeMock.mockRejectedValueOnce({ code: "HUE_STREAM_START_FAILED", message: "bridge busy" });

    await expect(startHue(START_PAYLOAD)).rejects.toMatchObject({
      code: "HUE_STREAM_START_FAILED",
    });
    await readHueStreamStatus();

    expect(statusRoundTrips()).toBe(2);
  });
});
