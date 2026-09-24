/**
 * telemetrySource — shared-loop tests.
 *
 * Covers:
 *   - Two concurrent subscribers share ONE round-trip per tick (the F14
 *     regression: StatusBar and LightsSection used to poll independently).
 *   - A late joiner rides the running cadence instead of firing its own tick.
 *   - The loop stops once the last subscriber leaves, and a fresh subscriber
 *     starts cold rather than inheriting a stale snapshot.
 *   - The shared cadence follows the SHORTEST requested interval.
 *   - A failed tick keeps the last-known snapshot and reports the error.
 *   - Polling pauses while the document is hidden and resumes on
 *     `visibilitychange`.
 *   - Polling also pauses while Rust says the window is hidden, though the
 *     document still reads visible (WebView2 hidden to the tray).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { MainWindowVisibility } from "@/shared/contracts/shell";
import type { FullTelemetrySnapshot } from "@/shared/contracts/telemetry";

const getFullTelemetrySnapshotMock = vi.fn<typeof telemetryApiModule.getFullTelemetrySnapshot>();

vi.mock("../telemetryApi", () => ({
  getFullTelemetrySnapshot: () => getFullTelemetrySnapshotMock(),
}));

let pushWindowVisibility: ((visibility: MainWindowVisibility) => void) | null = null;
vi.mock("@/features/shell/windowVisibilityApi", () => ({
  getMainWindowVisibility: () => Promise.resolve({ visible: true }),
}));
vi.mock("@/features/shell/windowVisibilityEventsApi", () => ({
  listenMainWindowVisibility: (handler: (visibility: MainWindowVisibility) => void) => {
    pushWindowVisibility = handler;
    return Promise.resolve(() => {
      pushWindowVisibility = null;
    });
  },
}));

import { __resetWindowVisibilityForTests } from "@/features/shell/windowVisibility";
import { __resetTelemetrySourceForTests, subscribeTelemetry, type TelemetrySourceListener } from "../telemetrySource";
import type * as telemetryApiModule from "../telemetryApi";

function makeSnapshot(captureFps = 60): FullTelemetrySnapshot {
  return {
    usb: {
      captureFps,
      sendFps: captureFps - 2,
      queueHealth: "healthy",
      frameLatencyMs: 12,
      linkConstrained: false,
      linkMaxFps: 0,
      lastCaptureErrorCode: null,
      lastCaptureErrorAtSecs: null,
    },
    hue: null,
  };
}

/** Drain the await chain inside `tick()`. */
async function flush() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function setVisibility(value: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => value,
  });
}

describe("telemetrySource", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getFullTelemetrySnapshotMock.mockResolvedValue(makeSnapshot());
    setVisibility("visible");
    vi.useFakeTimers();
  });

  afterEach(() => {
    __resetTelemetrySourceForTests();
    __resetWindowVisibilityForTests();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("serves two concurrent subscribers from a single round-trip per tick", async () => {
    const a = vi.fn();
    const b = vi.fn();

    const offA = subscribeTelemetry(1000, a);
    const offB = subscribeTelemetry(1000, b);
    await flush();

    expect(getFullTelemetrySnapshotMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1000);
    await flush();
    expect(getFullTelemetrySnapshotMock).toHaveBeenCalledTimes(2);

    // Both saw every snapshot.
    expect(a).toHaveBeenCalledWith(expect.objectContaining({ snapshot: makeSnapshot() }));
    expect(b).toHaveBeenCalledWith(expect.objectContaining({ snapshot: makeSnapshot() }));

    offA();
    offB();
  });

  it("does not fire an extra round-trip for a late joiner", async () => {
    const off1 = subscribeTelemetry(1000, vi.fn());
    await flush();
    expect(getFullTelemetrySnapshotMock).toHaveBeenCalledTimes(1);

    const late = vi.fn();
    const off2 = subscribeTelemetry(1000, late);
    await flush();

    expect(getFullTelemetrySnapshotMock).toHaveBeenCalledTimes(1);
    // The joiner is handed the current snapshot synchronously.
    expect(late).toHaveBeenCalledWith(
      expect.objectContaining({ snapshot: makeSnapshot(), isLoading: false }),
    );

    off1();
    off2();
  });

  it("stops polling when the last subscriber leaves and starts cold on re-subscribe", async () => {
    const off = subscribeTelemetry(1000, vi.fn());
    await flush();
    off();

    await vi.advanceTimersByTimeAsync(5000);
    await flush();
    expect(getFullTelemetrySnapshotMock).toHaveBeenCalledTimes(1);

    const fresh = vi.fn();
    const off2 = subscribeTelemetry(1000, fresh);
    expect(fresh).toHaveBeenNthCalledWith(1, { snapshot: null, error: null, isLoading: true });
    off2();
  });

  it("polls at the shortest interval any subscriber requested", async () => {
    const offSlow = subscribeTelemetry(5000, vi.fn());
    const offFast = subscribeTelemetry(1000, vi.fn());
    await flush();
    expect(getFullTelemetrySnapshotMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1000);
    await flush();
    expect(getFullTelemetrySnapshotMock).toHaveBeenCalledTimes(2);

    offSlow();
    offFast();
  });

  it("keeps the last-known snapshot when a tick fails", async () => {
    const listener = vi.fn();
    const off = subscribeTelemetry(1000, listener);
    await flush();

    getFullTelemetrySnapshotMock.mockRejectedValueOnce(new Error("ipc down"));
    await vi.advanceTimersByTimeAsync(1000);
    await flush();

    const calls = listener.mock.calls;
    const last = calls[calls.length - 1][0];
    expect(last.snapshot).toEqual(makeSnapshot());
    expect(last.error).toBeInstanceOf(Error);

    off();
  });

  it("pauses while hidden and resumes on visibilitychange", async () => {
    const off = subscribeTelemetry(1000, vi.fn());
    await flush();
    expect(getFullTelemetrySnapshotMock).toHaveBeenCalledTimes(1);

    setVisibility("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(5000);
    await flush();
    expect(getFullTelemetrySnapshotMock).toHaveBeenCalledTimes(1);

    setVisibility("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    await flush();
    expect(getFullTelemetrySnapshotMock).toHaveBeenCalledTimes(2);

    off();
  });

  it("pauses while Rust says the window is hidden, though the document reads visible", async () => {
    const off = subscribeTelemetry(1000, vi.fn<TelemetrySourceListener>());
    await flush();
    expect(getFullTelemetrySnapshotMock).toHaveBeenCalledTimes(1);
    expect(pushWindowVisibility).not.toBeNull();

    pushWindowVisibility?.({ visible: false });
    await vi.advanceTimersByTimeAsync(5000);
    await flush();
    expect(document.visibilityState).toBe("visible");
    expect(getFullTelemetrySnapshotMock).toHaveBeenCalledTimes(1);

    pushWindowVisibility?.({ visible: true });
    await flush();
    expect(getFullTelemetrySnapshotMock).toHaveBeenCalledTimes(2);

    off();
  });
});
