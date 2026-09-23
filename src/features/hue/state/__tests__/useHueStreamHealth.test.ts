import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LIGHTING_MODE_KIND, type LightingModeConfig } from "@/features/mode/model/contracts";
import type { LightingModeDispatcher } from "@/features/mode/state/useLightingModeDispatch";
import type { HueRuntimeTarget } from "@/shared/contracts/hue";

import { isHueSessionReconnecting, isHueStreamFailed, useHueStreamHealth } from "../useHueStreamHealth";

const readHueStreamStatusMock = vi.fn();
const invalidationListeners = new Set<() => void>();

vi.mock("../../hueReadCache", () => ({
  readHueStreamStatus: (...args: unknown[]) => readHueStreamStatusMock(...args),
  subscribeHueStreamStatusInvalidation: (listener: () => void) => {
    invalidationListeners.add(listener);
    return () => {
      invalidationListeners.delete(listener);
    };
  },
}));

const invalidate = () => {
  act(() => {
    for (const listener of invalidationListeners) listener();
  });
};

const failedStatus = (message = "bridge dropped the stream") => ({
  status: { state: "Failed", code: "X", message, details: null },
});
const runningStatus = () => ({
  status: { state: "Running", code: "X", message: "ok", details: null },
});
const reconnectingStatus = () => ({
  status: { state: "Reconnecting", code: "X", message: "bridge unreachable", details: null },
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
    invalidationListeners.clear();
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

  // A bridge unreachable for hours stays RECONNECTING with "hue" still in the
  // active targets, so the shell read membership as STREAMING the whole time.
  it("reports RECONNECTING so the shell can stop calling the session live", async () => {
    readHueStreamStatusMock.mockResolvedValue(reconnectingStatus());
    const { view, activeOutputTargetsRef } = mount({ activeOutputTargets: ["hue"], mode: ambilightMode });

    await flush(0);

    // The backend is still retrying, so the target is kept…
    expect(activeOutputTargetsRef.current).toEqual(["hue"]);
    // …but the state it reports is what the UI must show.
    expect(view.result.current.runtimeState).toBe("Reconnecting");
    expect(
      isHueSessionReconnecting(
        activeOutputTargetsRef.current.includes("hue"),
        view.result.current.runtimeState,
      ),
    ).toBe(true);

    readHueStreamStatusMock.mockResolvedValue(runningStatus());
    await flush(5_000);
    expect(view.result.current.runtimeState).toBe("Running");
  });

  // The shell shows FAILED from this reading. The dead cadence is 15 s, so a
  // restart from the Devices card would otherwise leave FAILED up that long.
  it("reports Failed until a start or stop invalidates the status", async () => {
    readHueStreamStatusMock.mockResolvedValue(failedStatus());
    const { view } = mount({ activeOutputTargets: ["hue"], mode: ambilightMode });

    await flush(0);
    expect(isHueStreamFailed(view.result.current.runtimeState)).toBe(true);

    invalidate();
    expect(view.result.current.runtimeState).toBeNull();
    expect(isHueStreamFailed(view.result.current.runtimeState)).toBe(false);
  });

  it("keeps a non-Failed reading through an invalidation", async () => {
    readHueStreamStatusMock.mockResolvedValue(reconnectingStatus());
    const { view } = mount({ activeOutputTargets: ["hue"], mode: ambilightMode });

    await flush(0);
    invalidate();
    expect(view.result.current.runtimeState).toBe("Reconnecting");
  });

  it("only calls an owned session reconnecting", () => {
    expect(isHueSessionReconnecting(false, "Reconnecting")).toBe(false);
    expect(isHueSessionReconnecting(true, "Running")).toBe(false);
    expect(isHueSessionReconnecting(true, null)).toBe(false);
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
   * Falsifying this takes removing **both** `inFlight` terms, not either one.
   *
   * `handleVisibilityChange` is the only reachable path back into `poll()`
   * while a read is pending, and it carries `!inFlight` ahead of the call;
   * `poll()` then checks `inFlight` again on entry. The timer path cannot
   * race them, because `scheduleNext` only arms the timer after `poll()`'s
   * `finally` has already reset the flag. So the two checks cover each other
   * on every path that exists today, and deleting one leaves this green.
   *
   * That makes it look like a false guard under a one-line mutation, and it
   * is not one — delete both and it fails, alone. Keep it. The behaviour it
   * pins is real: a concurrent poll means two reads of the stream racing to
   * mutate the same target list. The one-line-mutation heuristic is a way of
   * finding weak tests, not a definition of what a test must be, and applied
   * literally here it deletes a regression guard because the source happens
   * to be defensively doubled. If a later refactor collapses the two checks
   * into one, this is the test that catches the next person removing it.
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
