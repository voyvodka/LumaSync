import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { FullTelemetrySnapshot } from "../../model/contracts";

const getFullTelemetrySnapshotMock = vi.fn();

vi.mock("../../telemetryApi", () => ({
  getFullTelemetrySnapshot: () => getFullTelemetrySnapshotMock(),
}));

import { useFullTelemetryPoll } from "../useFullTelemetryPoll";

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

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("useFullTelemetryPoll", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getFullTelemetrySnapshotMock.mockResolvedValue(makeSnapshot());
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("invokes the telemetry API on mount and exposes the snapshot to consumers", async () => {
    const { result } = renderHook(() => useFullTelemetryPoll(true));

    await act(async () => {
      await flushMicrotasks();
    });

    expect(getFullTelemetrySnapshotMock).toHaveBeenCalledTimes(1);
    expect(result.current.snapshot).toEqual(makeSnapshot());
    expect(result.current.error).toBeNull();
    expect(result.current.isLoading).toBe(false);
  });

  it("does not invoke the backend while disabled and resumes when flipped to true", async () => {
    vi.useFakeTimers();
    const { rerender, result } = renderHook(
      ({ enabled }: { enabled: boolean }) => useFullTelemetryPoll(enabled, 1000),
      { initialProps: { enabled: false } },
    );

    await act(async () => {
      await flushMicrotasks();
      await vi.advanceTimersByTimeAsync(2000);
      await flushMicrotasks();
    });
    expect(getFullTelemetrySnapshotMock).not.toHaveBeenCalled();
    expect(result.current.snapshot).toBeNull();
    expect(result.current.isLoading).toBe(false);

    rerender({ enabled: true });
    await act(async () => {
      await flushMicrotasks();
    });
    expect(getFullTelemetrySnapshotMock).toHaveBeenCalledTimes(1);
    expect(result.current.snapshot).not.toBeNull();

    rerender({ enabled: false });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
      await flushMicrotasks();
    });
    expect(getFullTelemetrySnapshotMock).toHaveBeenCalledTimes(1);
    expect(result.current.snapshot).toBeNull();
  });

  it("pauses polling while hidden and resumes immediately on visibilitychange", async () => {
    vi.useFakeTimers();
    renderHook(() => useFullTelemetryPoll(true, 1000));

    await act(async () => {
      await flushMicrotasks();
    });
    expect(getFullTelemetrySnapshotMock).toHaveBeenCalledTimes(1);

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "hidden",
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
      await flushMicrotasks();
    });
    expect(getFullTelemetrySnapshotMock).toHaveBeenCalledTimes(1);

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

  it("preserves the last-known snapshot when a tick fails and surfaces the error", async () => {
    vi.useFakeTimers();
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    getFullTelemetrySnapshotMock.mockResolvedValueOnce(makeSnapshot({ captureFps: 30 }));
    getFullTelemetrySnapshotMock.mockRejectedValueOnce(new Error("transient"));
    getFullTelemetrySnapshotMock.mockResolvedValueOnce(makeSnapshot({ captureFps: 45 }));

    const { result } = renderHook(() => useFullTelemetryPoll(true, 1000));

    await act(async () => {
      await flushMicrotasks();
    });
    expect(result.current.snapshot?.usb.captureFps).toBe(30);
    expect(result.current.error).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
      await flushMicrotasks();
    });
    expect(result.current.snapshot?.usb.captureFps).toBe(30);
    expect(result.current.error).toBeInstanceOf(Error);
    expect(consoleErrorSpy).toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
      await flushMicrotasks();
    });
    expect(result.current.snapshot?.usb.captureFps).toBe(45);
    expect(result.current.error).toBeNull();

    consoleErrorSpy.mockRestore();
  });

  it("clears the pending setTimeout and stops invoking after unmount", async () => {
    vi.useFakeTimers();
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
    const { unmount } = renderHook(() => useFullTelemetryPoll(true, 1000));

    await act(async () => {
      await flushMicrotasks();
    });
    expect(getFullTelemetrySnapshotMock).toHaveBeenCalledTimes(1);

    unmount();
    expect(clearTimeoutSpy).toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
      await flushMicrotasks();
    });
    expect(getFullTelemetrySnapshotMock).toHaveBeenCalledTimes(1);

    clearTimeoutSpy.mockRestore();
  });
});
