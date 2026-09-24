import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { HueBridgeSummary, HuePairingCredentials } from "../../hueOnboardingApi";
import { HUE_ONBOARDING_TRANSPORT_CODES, type HueOnboardingStatus } from "../../model/onboardingStatusCodes";
import { runtimeStatusRetryDelayMs } from "../../model/pollingCadence";
import { __resetHueHealthStoreForTests } from "../hueHealthStore";
import { useHueRuntimeStatus } from "../useHueRuntimeStatus";
import {
  fakeHueHealthApi,
  publishHealth,
  resetHealth,
  runtimeResult,
  runtimeStatus,
  setHealth,
} from "../../__tests__/fakeHueHealth";
import type * as modeApiModule from "@/features/mode/modeApi";

const startHueMock = vi.fn<typeof modeApiModule.startHue>();
const restartHueMock = vi.fn<typeof modeApiModule.restartHue>();
const shellLoadMock = vi.fn();

vi.mock("../../hueHealthApi", async () => (await import("../../__tests__/fakeHueHealth")).fakeHueHealthApi);

vi.mock("@/features/mode/modeApi", () => ({
  startHue: (...args: Parameters<typeof startHueMock>) => startHueMock(...args),
  restartHue: (...args: Parameters<typeof restartHueMock>) => restartHueMock(...args),
}));

vi.mock("@/features/persistence/shellStore", () => ({
  shellStore: { load: () => shellLoadMock() },
}));

const bridge: HueBridgeSummary = { id: "bridge-1", ip: "192.168.1.10", name: "Bridge" } as HueBridgeSummary;
const credentials: HuePairingCredentials = { username: "app-user", clientKey: "AABBCCDD" };

const running = { stream: { active: true, status: runtimeStatus("Running") } };

const flush = async (ms = 0) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

const mount = (onError: (status: HueOnboardingStatus) => void = () => {}) =>
  renderHook(() => useHueRuntimeStatus({ bridge, credentials, areaId: "area-1", onError }));

describe("useHueRuntimeStatus", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    __resetHueHealthStoreForTests();
    resetHealth();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    shellLoadMock.mockResolvedValue({});
  });

  afterEach(() => {
    __resetHueHealthStoreForTests();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // Regression: the Devices-tab loop went silent in Idle, so a stream started
  // from Lights, the tray or a keybind left the bridge card on "Ready" while
  // the status bar said STREAMING. Rust now publishes every runtime change,
  // whichever surface made it.
  it("follows a stream another surface started, without polling for it", async () => {
    const { result } = mount();
    await flush();
    expect(result.current.runtimeStatus?.state).toBe("Idle");

    act(() => {
      publishHealth(running);
    });
    await flush(60_000);

    expect(result.current.runtimeStatus?.state).toBe("Running");
    expect(result.current.runtimeTargets[0]).toMatchObject({ target: "hue", state: "Running" });
    expect(fakeHueHealthApi.getHueHealth).not.toHaveBeenCalled();
  });

  it("reads afresh after its own start, so the card never paints the state it left", async () => {
    startHueMock.mockImplementation(async () => {
      setHealth(running);
      return runtimeResult();
    });
    const { result } = mount();
    await flush();

    await act(async () => {
      await result.current.startRuntime();
    });

    expect(fakeHueHealthApi.getHueHealth).toHaveBeenCalledOnce();
    expect(result.current.runtimeStatus?.state).toBe("Running");
    expect(result.current.isRuntimeMutating).toBe(false);
  });

  it("holds a rejected read beside the last reported status instead of minting a Failed state", async () => {
    setHealth(running);
    const { result } = mount();
    await flush();

    fakeHueHealthApi.getHueHealth.mockRejectedValueOnce(new Error("IPC channel closed"));
    startHueMock.mockResolvedValue(runtimeResult());
    await act(async () => {
      await result.current.startRuntime();
    });

    expect(result.current.runtimeStatus?.state).toBe("Running");
    expect(result.current.runtimeTargets[0]?.state).toBe("Running");
    expect(result.current.runtimeStatusReadFailure).toEqual({
      code: HUE_ONBOARDING_TRANSPORT_CODES.STREAM_STATUS_UNAVAILABLE,
      message: expect.any(String),
      details: "IPC channel closed",
    });

    // Retried on the backoff until a read lands.
    await flush(runtimeStatusRetryDelayMs(1));
    expect(result.current.runtimeStatusReadFailure).toBeNull();
  });

  it("does nothing when startRuntime is called without a paired bridge", async () => {
    const onError = vi.fn();
    const { result } = renderHook(() =>
      useHueRuntimeStatus({ bridge: null, credentials, areaId: "area-1", onError }),
    );
    await flush();

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
    const { result } = mount(onError);
    await flush();

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

  it("surfaces HUE_STREAM_RECOVERY_FAILED when the card's restart rejects", async () => {
    restartHueMock.mockRejectedValue(new Error("bridge unreachable"));
    const onError = vi.fn<(status: HueOnboardingStatus) => void>();
    const { result } = mount(onError);
    await flush();

    await act(async () => {
      await result.current.retryRuntimeTarget("hue");
    });

    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ code: HUE_ONBOARDING_TRANSPORT_CODES.STREAM_RECOVERY_FAILED }),
    );
    expect(fakeHueHealthApi.getHueHealth).toHaveBeenCalledOnce();
  });

  it("ignores a second startRuntime call while the first is still mutating", async () => {
    let resolveStart!: () => void;
    startHueMock.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveStart = () => resolve(runtimeResult());
      }),
    );
    const { result } = mount();
    await flush();

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
