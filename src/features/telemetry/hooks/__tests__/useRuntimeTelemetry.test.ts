import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { FullTelemetrySnapshot } from "../../model/contracts";

// Mock the telemetryApi module — the hook only calls `getFullTelemetrySnapshot`
// so that is the single dependency the tests drive.
const getFullTelemetrySnapshotMock = vi.fn();

vi.mock("../../telemetryApi", () => ({
  getFullTelemetrySnapshot: () => getFullTelemetrySnapshotMock(),
}));

// Import after the mock is registered so the hook picks up the mocked module.
import { useRuntimeTelemetry } from "../useRuntimeTelemetry";

/** Small helper: build a FullTelemetrySnapshot with sane defaults. */
function makeSnapshot(partial?: Partial<FullTelemetrySnapshot["usb"]>): FullTelemetrySnapshot {
  return {
    usb: {
      captureFps: 60,
      sendFps: 58,
      queueHealth: "healthy",
      frameLatencyMs: 12,
      ...partial,
    },
    hue: null,
  };
}

/** Flush microtasks — awaits the invoke promise + setState update. */
async function flushMicrotasks() {
  // Multiple awaits cover the await chain inside `tick()`.
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("useRuntimeTelemetry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getFullTelemetrySnapshotMock.mockResolvedValue(makeSnapshot());
    // Default: "visible" page so polls run.
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("invokes get_runtime_telemetry on mount and exposes projected FPS/latency", async () => {
    const { result } = renderHook(() => useRuntimeTelemetry());

    await act(async () => {
      await flushMicrotasks();
    });

    expect(getFullTelemetrySnapshotMock).toHaveBeenCalledTimes(1);
    expect(result.current.fps).toBe(60);
    expect(result.current.latencyMs).toBe(12);
    expect(result.current.frameDrops).toBe(2);
    expect(result.current.timestamp).toBeGreaterThan(0);
  });

  it("pauses polling while visibilityState is 'hidden' and resumes on visibilitychange", async () => {
    vi.useFakeTimers();
    renderHook(() => useRuntimeTelemetry(1000));

    // First tick happens immediately after mount.
    await act(async () => {
      await flushMicrotasks();
    });
    expect(getFullTelemetrySnapshotMock).toHaveBeenCalledTimes(1);

    // Flip the page to hidden before the next scheduled tick fires.
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "hidden",
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
      await flushMicrotasks();
    });

    // Hidden page: the recursive schedule bailed out before the invoke, so
    // the mock count must stay at 1.
    expect(getFullTelemetrySnapshotMock).toHaveBeenCalledTimes(1);

    // Another cycle while still hidden — still no new calls.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
      await flushMicrotasks();
    });
    expect(getFullTelemetrySnapshotMock).toHaveBeenCalledTimes(1);

    // Flip back to visible + dispatch the event: hook should resume and
    // immediately fire a fresh tick.
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });

    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await flushMicrotasks();
    });

    expect(getFullTelemetrySnapshotMock).toHaveBeenCalledTimes(2);
  });

  it("clears the pending setTimeout and does not poll after unmount", async () => {
    vi.useFakeTimers();
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
    const { unmount } = renderHook(() => useRuntimeTelemetry(1000));

    await act(async () => {
      await flushMicrotasks();
    });
    expect(getFullTelemetrySnapshotMock).toHaveBeenCalledTimes(1);

    unmount();
    expect(clearTimeoutSpy).toHaveBeenCalled();

    // Advance far beyond the next scheduled tick — no extra invokes must
    // leak through after unmount.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
      await flushMicrotasks();
    });
    expect(getFullTelemetrySnapshotMock).toHaveBeenCalledTimes(1);

    clearTimeoutSpy.mockRestore();
  });

  it("does not invoke the backend while enabled is false and resumes when flipped to true", async () => {
    vi.useFakeTimers();
    const { rerender, result } = renderHook(
      ({ enabled }: { enabled: boolean }) => useRuntimeTelemetry(1000, enabled),
      { initialProps: { enabled: false } },
    );

    // Disabled mount: the effect short-circuits before scheduling a tick.
    await act(async () => {
      await flushMicrotasks();
      await vi.advanceTimersByTimeAsync(2000);
      await flushMicrotasks();
    });
    expect(getFullTelemetrySnapshotMock).not.toHaveBeenCalled();
    expect(result.current.fps).toBeNull();

    // Flip to enabled — the effect remounts, fires an immediate tick, and
    // surfaces the projected snapshot to consumers.
    rerender({ enabled: true });
    await act(async () => {
      await flushMicrotasks();
    });
    expect(getFullTelemetrySnapshotMock).toHaveBeenCalledTimes(1);
    expect(result.current.fps).toBe(60);

    // Flip back to disabled — the snapshot resets to the inactive
    // placeholder and the loop stops issuing further invokes.
    rerender({ enabled: false });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
      await flushMicrotasks();
    });
    expect(getFullTelemetrySnapshotMock).toHaveBeenCalledTimes(1);
    expect(result.current.fps).toBeNull();
    expect(result.current.frameDrops).toBe(0);
  });

  it("projects captureFps=0 as fps=null so consumers render the inactive placeholder", async () => {
    getFullTelemetrySnapshotMock.mockResolvedValue(
      makeSnapshot({ captureFps: 0, sendFps: 0, frameLatencyMs: 0 }),
    );

    const { result } = renderHook(() => useRuntimeTelemetry());

    await act(async () => {
      await flushMicrotasks();
    });

    expect(result.current.fps).toBeNull();
    expect(result.current.latencyMs).toBeNull();
    expect(result.current.frameDrops).toBe(0);
  });
});
