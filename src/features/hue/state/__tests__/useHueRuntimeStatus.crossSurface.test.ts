// Regression: the Devices-tab runtime loop goes silent in Idle, so a stream
// started from Lights, the tray or a keybind left the bridge card on "Ready"
// while the status bar said STREAMING. Real modeApi + real hueReadCache; only
// the Tauri boundary is mocked, so the wake-up has to travel the path the
// orchestrator's own start takes.

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HUE_COMMANDS, HUE_RUNTIME_TRIGGER_SOURCE } from "@/shared/contracts/hue";

import { __resetHueReadCacheForTests } from "../../hueReadCache";
import type { HueBridgeSummary, HuePairingCredentials } from "../../hueOnboardingApi";
import { useHueRuntimeStatus } from "../useHueRuntimeStatus";
import { releaseHueOutput, startHue } from "@/features/mode/modeApi";
import { LIGHTING_RUNTIME_COMMANDS } from "@/shared/contracts/lightingRuntime";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (command: string, payload?: Record<string, unknown>) => invokeMock(command, payload),
}));

vi.mock("@/features/persistence/shellStore", () => ({
  shellStore: { load: vi.fn().mockResolvedValue({}) },
}));

const bridge = { id: "bridge-1", ip: "192.168.1.10", name: "Bridge" } as HueBridgeSummary;
const credentials: HuePairingCredentials = { username: "app-user", clientKey: "AABBCCDD" };

const START_PAYLOAD = {
  bridgeIp: bridge.ip,
  username: credentials.username,
  clientKey: credentials.clientKey,
  areaId: "area-1",
};

let backendState: "Idle" | "Running" = "Idle";

function statusResult() {
  return {
    active: backendState === "Running",
    status: {
      state: backendState,
      code: backendState === "Running" ? "HUE_STREAM_RUNNING" : "HUE_STREAM_IDLE",
      message: "ok",
      details: null,
      triggerSource: HUE_RUNTIME_TRIGGER_SOURCE.MODE_CONTROL,
    },
  };
}

function statusReads(): number {
  return invokeMock.mock.calls.filter(([command]) => command === HUE_COMMANDS.GET_STREAM_STATUS)
    .length;
}

const flush = async (ms = 0) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

function renderRuntime() {
  return renderHook(() =>
    useHueRuntimeStatus({ bridge, credentials, areaId: "area-1", onError: () => {} }),
  );
}

describe("useHueRuntimeStatus follows a stream started from another surface", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    invokeMock.mockReset();
    __resetHueReadCacheForTests();
    backendState = "Idle";
    invokeMock.mockImplementation(async (command: string) => {
      if (command === HUE_COMMANDS.START_STREAM) backendState = "Running";
      if (command === LIGHTING_RUNTIME_COMMANDS.RELEASE_HUE_OUTPUT) backendState = "Idle";
      return statusResult();
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    __resetHueReadCacheForTests();
  });

  it("reports Running right after the orchestrator's startHue, without waiting on a poll", async () => {
    const { result } = renderRuntime();
    await flush(0);
    expect(result.current.runtimeStatus?.state).toBe("Idle");

    // Past the min-interval floor, so only a missing wake-up can explain a stale card.
    await flush(5_000);
    await act(async () => {
      await startHue(START_PAYLOAD);
    });
    await flush(0);

    expect(result.current.runtimeStatus?.state).toBe("Running");
  });

  it("wakes up inside the min-interval floor too", async () => {
    const { result } = renderRuntime();
    await flush(0);

    await act(async () => {
      await startHue(START_PAYLOAD);
    });
    await flush(0);

    expect(result.current.runtimeStatus?.state).toBe("Running");
  });

  it("reports Idle right after a stop that bypassed this hook, such as the card's own Stop button", async () => {
    backendState = "Running";
    const { result } = renderRuntime();
    await flush(0);
    expect(result.current.runtimeStatus?.state).toBe("Running");

    await act(async () => {
      await releaseHueOutput(HUE_RUNTIME_TRIGGER_SOURCE.DEVICE_SURFACE);
    });
    await flush(0);

    expect(result.current.runtimeStatus?.state).toBe("Idle");
  });

  it("does not lose a start that lands while the stop's re-read is still in flight", async () => {
    backendState = "Running";
    const { result } = renderRuntime();
    await flush(0);
    expect(result.current.runtimeStatus?.state).toBe("Running");

    // Hold the next status read open so the start arrives mid-flight.
    let releaseRead!: () => void;
    const baseImpl = invokeMock.getMockImplementation()!;
    invokeMock.mockImplementation(async (command: string, payload?: Record<string, unknown>) => {
      if (command === HUE_COMMANDS.GET_STREAM_STATUS && releaseRead === undefined) {
        const snapshot = statusResult();
        await new Promise<void>((resolve) => {
          releaseRead = resolve;
        });
        return snapshot;
      }
      return baseImpl(command, payload);
    });

    await act(async () => {
      await releaseHueOutput(HUE_RUNTIME_TRIGGER_SOURCE.SYSTEM);
    });
    // The stop's re-read is now in flight with an Idle snapshot.
    await act(async () => {
      await startHue(START_PAYLOAD);
    });
    await act(async () => {
      releaseRead();
    });
    await flush(0);

    expect(result.current.runtimeStatus?.state).toBe("Running");
  });

  it("does not add a read of its own when the start came from this hook", async () => {
    const { result } = renderRuntime();
    await flush(0);
    await flush(5_000);
    const before = statusReads();

    await act(async () => {
      await result.current.startRuntime();
    });
    await flush(0);

    // One forced read from startRuntime itself; the invalidation must not add another.
    expect(statusReads() - before).toBe(1);
    expect(result.current.runtimeStatus?.state).toBe("Running");
  });
});
