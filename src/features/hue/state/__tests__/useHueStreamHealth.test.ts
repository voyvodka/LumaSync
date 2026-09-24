import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  isHueSessionReconnecting,
  isHueStreamDead,
  isHueStreamFailed,
  useHueStreamHealth,
} from "../useHueStreamHealth";

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

function mount(opts: { hueTargetSelected?: boolean } = {}) {
  const view = renderHook(() => useHueStreamHealth({ hueTargetSelected: opts.hueTargetSelected ?? true }));
  return { view };
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

  // Read-only since the transaction: the worker follows the live stream slot
  // through every reconnect, so a stream that comes back is re-applied by
  // nobody. The re-apply this poll used to force was one of the storms.
  it("reads a stream dying and coming back without asking for anything", async () => {
    readHueStreamStatusMock.mockResolvedValueOnce(failedStatus());
    const { view } = mount();

    await flush(0);
    expect(isHueStreamDead(view.result.current.runtimeState)).toBe(true);

    // Dead cadence is 15 s (HUE_STREAM_HEALTH_RECOVERY_POLL_MS).
    readHueStreamStatusMock.mockResolvedValueOnce(runningStatus());
    await flush(15_000);

    expect(view.result.current.runtimeState).toBe("Running");
    expect(isHueStreamDead(view.result.current.runtimeState)).toBe(false);
    expect(readHueStreamStatusMock).toHaveBeenCalledTimes(2);
  });

  it("clears its reading when Hue is not a selected output", async () => {
    readHueStreamStatusMock.mockResolvedValue(runningStatus());
    const { view } = mount({ hueTargetSelected: false });

    await flush(0);

    expect(view.result.current.runtimeState).toBeNull();
    expect(readHueStreamStatusMock).not.toHaveBeenCalled();
  });

  // A bridge unreachable for hours stays RECONNECTING with "hue" still in the
  // active targets, so the shell read membership as STREAMING the whole time.
  it("reports RECONNECTING so the shell can stop calling the session live", async () => {
    readHueStreamStatusMock.mockResolvedValue(reconnectingStatus());
    const { view } = mount();

    await flush(0);

    // The backend is still retrying, so a reconnecting stream is not dead…
    expect(isHueStreamDead(view.result.current.runtimeState)).toBe(false);
    // …but the state it reports is what the UI must show.
    expect(view.result.current.runtimeState).toBe("Reconnecting");
    expect(isHueSessionReconnecting(true, view.result.current.runtimeState)).toBe(true);

    readHueStreamStatusMock.mockResolvedValue(runningStatus());
    await flush(5_000);
    expect(view.result.current.runtimeState).toBe("Running");
  });

  // The shell shows FAILED from this reading. The dead cadence is 15 s, so a
  // restart from the Devices card would otherwise leave FAILED up that long.
  it("reports Failed until a start or stop invalidates the status", async () => {
    readHueStreamStatusMock.mockResolvedValue(failedStatus());
    const { view } = mount();

    await flush(0);
    expect(isHueStreamFailed(view.result.current.runtimeState)).toBe(true);

    invalidate();
    expect(view.result.current.runtimeState).toBeNull();
    expect(isHueStreamFailed(view.result.current.runtimeState)).toBe(false);
  });

  it("keeps a non-Failed reading through an invalidation", async () => {
    readHueStreamStatusMock.mockResolvedValue(reconnectingStatus());
    const { view } = mount();

    await flush(0);
    invalidate();
    expect(view.result.current.runtimeState).toBe("Reconnecting");
  });

  it("only calls an owned session reconnecting", () => {
    expect(isHueSessionReconnecting(false, "Reconnecting")).toBe(false);
    expect(isHueSessionReconnecting(true, "Running")).toBe(false);
    expect(isHueSessionReconnecting(true, null)).toBe(false);
  });

  it("never calls the backend while the tray is hidden", async () => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "hidden",
    });
    readHueStreamStatusMock.mockResolvedValue(runningStatus());

    mount();
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
   * set the same reading. The one-line-mutation heuristic is a way of
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

    mount();
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
