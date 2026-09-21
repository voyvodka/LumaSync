import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LIGHTING_MODE_KIND, type LightingModeConfig } from "@/features/mode/model/contracts";
import type { LightingModeDispatcher } from "@/features/mode/state/useLightingModeDispatch";
import type { HueRuntimeTarget } from "@/shared/contracts/hue";

import { useHueStreamHealth } from "../useHueStreamHealth";

const readHueStreamStatusMock = vi.fn();

vi.mock("../../hueReadCache", () => ({
  readHueStreamStatus: (...args: unknown[]) => readHueStreamStatusMock(...args),
}));

const failedStatus = (message = "bridge dropped the stream") => ({
  status: { state: "Failed", code: "X", message, details: null },
});
const runningStatus = () => ({
  status: { state: "Running", code: "X", message: "ok", details: null },
});

const ambilightMode: LightingModeConfig = {
  kind: LIGHTING_MODE_KIND.AMBILIGHT,
  targets: ["hue"],
} as LightingModeConfig;
const offMode: LightingModeConfig = { kind: LIGHTING_MODE_KIND.OFF, targets: [] } as LightingModeConfig;

function mount(opts: {
  activeOutputTargets: HueRuntimeTarget[];
  mode: LightingModeConfig;
  selectedOutputTargets?: HueRuntimeTarget[];
  hueTargetSelected?: boolean;
}) {
  const activeOutputTargetsRef = { current: opts.activeOutputTargets };
  const lightingModeRef = { current: opts.mode };
  const selectedOutputTargetsRef = { current: opts.selectedOutputTargets ?? opts.activeOutputTargets };
  const dispatchMock = vi.fn<LightingModeDispatcher>().mockResolvedValue(null);
  const dispatchRef = { current: dispatchMock as LightingModeDispatcher | null };

  const setActiveOutputTargets = vi.fn((updater: (prev: HueRuntimeTarget[]) => HueRuntimeTarget[]) => {
    activeOutputTargetsRef.current = updater(activeOutputTargetsRef.current);
  });

  const view = renderHook(() =>
    useHueStreamHealth({
      hueTargetSelected: opts.hueTargetSelected ?? true,
      activeOutputTargetsRef,
      lightingModeRef,
      selectedOutputTargetsRef,
      dispatchRef,
      setActiveOutputTargets,
    }),
  );

  return { view, activeOutputTargetsRef, selectedOutputTargetsRef, lightingModeRef, dispatchMock, setActiveOutputTargets };
}

const flush = async (ms = 0) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

describe("useHueStreamHealth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("drops hue from active targets the moment the backend reports Failed", async () => {
    readHueStreamStatusMock.mockResolvedValue(failedStatus());
    const { activeOutputTargetsRef } = mount({ activeOutputTargets: ["hue"], mode: ambilightMode });

    await flush(0);

    expect(activeOutputTargetsRef.current).toEqual([]);
  });

  it("restores hue and force re-applies the mode once the stream recovers", async () => {
    readHueStreamStatusMock.mockResolvedValueOnce(failedStatus());
    const { activeOutputTargetsRef, dispatchMock, selectedOutputTargetsRef } = mount({
      activeOutputTargets: ["hue"],
      mode: ambilightMode,
    });

    await flush(0);
    expect(activeOutputTargetsRef.current).toEqual([]);

    // Dead cadence is 15 s (HUE_STREAM_HEALTH_RECOVERY_POLL_MS) — advance
    // exactly that far to trigger the next tick.
    readHueStreamStatusMock.mockResolvedValueOnce(runningStatus());
    await flush(15_000);

    expect(activeOutputTargetsRef.current).toEqual(["hue"]);
    expect(dispatchMock).toHaveBeenCalledWith(
      { ...ambilightMode, targets: selectedOutputTargetsRef.current },
      { force: true },
    );
  });

  it("does not restore hue while the lighting mode is off", async () => {
    readHueStreamStatusMock.mockResolvedValue(runningStatus());
    const { setActiveOutputTargets, dispatchMock } = mount({
      activeOutputTargets: [],
      mode: offMode,
    });

    await flush(0);

    expect(setActiveOutputTargets).not.toHaveBeenCalled();
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("never calls the backend while the tray is hidden", async () => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "hidden",
    });
    readHueStreamStatusMock.mockResolvedValue(runningStatus());

    mount({ activeOutputTargets: ["hue"], mode: ambilightMode });
    await flush(30_000);

    expect(readHueStreamStatusMock).not.toHaveBeenCalled();
  });

  /**
   * Falsifying this one takes removing **both** guards, not either.
   *
   * `poll()` checks `inFlight` on entry and the `visibilitychange` handler
   * checks `!inFlight` before calling it, and at the moment this test fires
   * the event `timerId` is still null — the mount-time `poll()` has not
   * reached `scheduleNext` yet — so the handler's own `timerId === null` term
   * does not help either. The two `inFlight` terms cover for each other
   * exactly, so deleting one leaves this test green and proves nothing about
   * it. Delete both and it fails. Verified; noted because the single-guard
   * mutation reads as a false guard and it is not one.
   */
  it("does not start a second poll while one is already in flight", async () => {
    let resolveFirst!: (value: ReturnType<typeof runningStatus>) => void;
    readHueStreamStatusMock.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveFirst = resolve;
      }),
    );

    mount({ activeOutputTargets: ["hue"], mode: ambilightMode });
    await flush(0);
    expect(readHueStreamStatusMock).toHaveBeenCalledOnce();

    // Fire the visibility handler while the first read is still pending —
    // without the `inFlight` guard this would kick off a concurrent poll.
    document.dispatchEvent(new Event("visibilitychange"));
    await flush(0);
    expect(readHueStreamStatusMock).toHaveBeenCalledOnce();

    resolveFirst(runningStatus());
    await flush(0);
  });
});
