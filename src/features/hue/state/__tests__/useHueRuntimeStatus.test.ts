import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HUE_RUNTIME_TRIGGER_SOURCE } from "@/shared/contracts/hue";

import type { HueBridgeSummary, HuePairingCredentials } from "../../hueOnboardingApi";
import { HUE_ONBOARDING_TRANSPORT_CODES, type HueOnboardingStatus } from "../../model/onboardingStatusCodes";
import { RUNTIME_POLL_INTERVAL_MS } from "../../model/pollingCadence";
import { useHueRuntimeStatus } from "../useHueRuntimeStatus";

const readHueStreamStatusMock = vi.fn();
const startHueMock = vi.fn();
const restartHueMock = vi.fn();
const shellLoadMock = vi.fn();

vi.mock("../../hueReadCache", () => ({
  readHueStreamStatus: (...args: unknown[]) => readHueStreamStatusMock(...args),
  subscribeHueStreamStatusInvalidation: () => () => {},
}));

vi.mock("@/features/mode/modeApi", () => ({
  startHue: (...args: unknown[]) => startHueMock(...args),
  restartHue: (...args: unknown[]) => restartHueMock(...args),
}));

vi.mock("@/features/persistence/shellStore", () => ({
  shellStore: { load: () => shellLoadMock() },
}));

const bridge: HueBridgeSummary = { id: "bridge-1", ip: "192.168.1.10", name: "Bridge" } as HueBridgeSummary;
const credentials: HuePairingCredentials = { username: "app-user", clientKey: "AABBCCDD" };

const statusOf = (state: string) => ({
  status: { state, code: "X", message: "ok", details: null, triggerSource: HUE_RUNTIME_TRIGGER_SOURCE.SYSTEM },
});

const flush = async (ms = 0) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

describe("useHueRuntimeStatus", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => {});
    shellLoadMock.mockResolvedValue({});
    readHueStreamStatusMock.mockResolvedValue(statusOf("Idle"));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("does not double-poll when a startRuntime-triggered transition lands inside the min-interval floor", async () => {
    readHueStreamStatusMock.mockResolvedValueOnce(statusOf("Idle"));
    startHueMock.mockResolvedValue(undefined);

    const { result } = renderHook(() =>
      useHueRuntimeStatus({ bridge, credentials, areaId: "area-1", onError: () => {} }),
    );

    // Mount tick.
    await flush(0);
    expect(readHueStreamStatusMock).toHaveBeenCalledOnce();

    // startRuntime does its own forced poll, landing the state on "Starting"
    // — a state change that reruns the polling effect within the same tick.
    readHueStreamStatusMock.mockResolvedValueOnce(statusOf("Starting"));
    await act(async () => {
      await result.current.startRuntime();
    });

    // Without the `RUNTIME_POLL_MIN_INTERVAL_MS` floor, the effect rerun
    // triggered by the "Idle" → "Starting" jump would immediately re-fetch a
    // third time — the exact "three round-trips per burst" the guard exists
    // to prevent (see pollingCadence.ts).
    expect(readHueStreamStatusMock).toHaveBeenCalledTimes(2);

    // The throttled tick still eventually fires once the streaming cadence elapses.
    readHueStreamStatusMock.mockResolvedValueOnce(statusOf("Running"));
    await flush(RUNTIME_POLL_INTERVAL_MS);
    expect(readHueStreamStatusMock).toHaveBeenCalledTimes(3);
  });

  it("does nothing when startRuntime is called without a paired bridge", async () => {
    const onError = vi.fn();
    const { result } = renderHook(() =>
      useHueRuntimeStatus({ bridge: null, credentials, areaId: "area-1", onError }),
    );
    await flush(0);

    await act(async () => {
      await result.current.startRuntime();
    });

    expect(startHueMock).not.toHaveBeenCalled();
    // The guard must return before the try/catch, not merely avoid calling
    // startHue — otherwise `bridge.ip` throws and onError fires with a
    // TypeError instead of staying silent.
    expect(onError).not.toHaveBeenCalled();
  });

  it("surfaces a coded HUE_STREAM_START_FAILED error when startHue rejects", async () => {
    startHueMock.mockRejectedValue(new Error("bridge unreachable"));
    const onError = vi.fn<(status: HueOnboardingStatus) => void>();

    const { result } = renderHook(() =>
      useHueRuntimeStatus({ bridge, credentials, areaId: "area-1", onError }),
    );
    await flush(0);

    await act(async () => {
      await result.current.startRuntime();
    });

    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({
        code: HUE_ONBOARDING_TRANSPORT_CODES.STREAM_START_FAILED,
        details: "bridge unreachable",
      }),
    );
  });

  it("ignores a second startRuntime call while the first is still mutating", async () => {
    let resolveStart!: () => void;
    startHueMock.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        resolveStart = resolve;
      }),
    );

    const { result } = renderHook(() =>
      useHueRuntimeStatus({ bridge, credentials, areaId: "area-1", onError: () => {} }),
    );
    await flush(0);

    // A real second click is a separate React event, so it always sees a
    // render that already reflects the first click's `isRuntimeMutating`
    // flag — reproduce that ordering instead of firing both calls in the
    // same microtask, which races the state update.
    let firstCall!: Promise<void>;
    act(() => {
      firstCall = result.current.startRuntime();
    });
    expect(result.current.isRuntimeMutating).toBe(true);

    await act(async () => {
      // Fires once `isRuntimeMutating` is committed and must be a no-op.
      await result.current.startRuntime();
    });

    expect(startHueMock).toHaveBeenCalledOnce();

    resolveStart();
    await act(async () => {
      await firstCall;
    });
  });
});
