import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  NO_RUNTIME_HEALTH_ISSUES,
  type FullTelemetrySnapshot,
  type RuntimeHealth,
} from "@/shared/contracts/telemetry";

const { getFullTelemetrySnapshotMock, healthListeners } = vi.hoisted(() => ({
  getFullTelemetrySnapshotMock: vi.fn(),
  healthListeners: [] as Array<(health: RuntimeHealth) => void>,
}));

vi.mock("@/features/telemetry/telemetryApi", () => ({
  getFullTelemetrySnapshot: () => getFullTelemetrySnapshotMock(),
}));

vi.mock("@/features/telemetry/runtimeHealthEventsApi", () => ({
  listenRuntimeHealth: (listener: (health: RuntimeHealth) => void) => {
    healthListeners.push(listener);
    return Promise.resolve(() => {});
  },
}));

import { __resetRuntimeHealthForTests } from "../../runtimeHealthSource";
import { useCaptureStallNotice } from "../useCaptureStallNotice";

function makeSnapshot(partial?: Partial<FullTelemetrySnapshot["usb"]>): FullTelemetrySnapshot {
  return {
    usb: {
      captureFps: 60,
      sendFps: 58,
      queueHealth: "healthy",
      frameLatencyMs: 12,
      linkConstrained: false,
      linkMaxFps: 0,
      lastCaptureErrorCode: null,
      lastCaptureErrorAtSecs: null,
      ...partial,
    },
    hue: null,
  };
}

const stall = (code: string): RuntimeHealth => ({ ...NO_RUNTIME_HEALTH_ISSUES, captureFailureCode: code });

async function settle() {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  });
}

function push(health: RuntimeHealth) {
  act(() => {
    for (const listener of healthListeners) listener(health);
  });
}

describe("useCaptureStallNotice", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    healthListeners.length = 0;
    __resetRuntimeHealthForTests();
    getFullTelemetrySnapshotMock.mockResolvedValue(makeSnapshot());
  });

  afterEach(() => {
    // Unmount first: resetting under a mounted hook is an update outside act.
    cleanup();
    __resetRuntimeHealthForTests();
    vi.useRealTimers();
  });

  it("raises a classified notice when the worker pushes a stall", async () => {
    const { result } = renderHook(() => useCaptureStallNotice(true));
    await settle();

    push(stall("AMBILIGHT_CAPTURE_MONITOR_NOT_FOUND"));

    expect(result.current).toEqual({
      bucket: "display",
      reason: "AMBILIGHT_CAPTURE_MONITOR_NOT_FOUND",
    });
  });

  it("clears when the worker pushes the recovery", async () => {
    const { result } = renderHook(() => useCaptureStallNotice(true));
    await settle();
    push(stall("AMBILIGHT_CAPTURE_MONITOR_NOT_FOUND"));

    push(NO_RUNTIME_HEALTH_ISSUES);

    expect(result.current).toBeNull();
  });

  it("shows nothing outside Ambilight, whatever was pushed", async () => {
    const { result } = renderHook(() => useCaptureStallNotice(false));
    await settle();

    push(stall("AMBILIGHT_CAPTURE_MONITOR_NOT_FOUND"));

    expect(result.current).toBeNull();
  });

  it("picks up a stall already running when the window started listening", async () => {
    getFullTelemetrySnapshotMock.mockResolvedValue(
      makeSnapshot({ lastCaptureErrorCode: "AMBILIGHT_CAPTURE_MONITOR_NOT_FOUND", lastCaptureErrorAtSecs: 0 }),
    );

    const { result } = renderHook(() => useCaptureStallNotice(true));
    await settle();

    expect(result.current).toEqual({
      bucket: "display",
      reason: "AMBILIGHT_CAPTURE_MONITOR_NOT_FOUND",
    });
  });

  it("does not seed a failure the worker already recovered from", async () => {
    // Sticky code, stale age — the exact case a code-only read would misreport.
    getFullTelemetrySnapshotMock.mockResolvedValue(
      makeSnapshot({ lastCaptureErrorCode: "AMBILIGHT_CAPTURE_MONITOR_NOT_FOUND", lastCaptureErrorAtSecs: 90 }),
    );

    const { result } = renderHook(() => useCaptureStallNotice(true));
    await settle();

    expect(result.current).toBeNull();
  });

  it("lets a push that beat the seed stand", async () => {
    let resolveSeed: (snapshot: FullTelemetrySnapshot) => void = () => {};
    getFullTelemetrySnapshotMock.mockReturnValue(
      new Promise<FullTelemetrySnapshot>((resolve) => {
        resolveSeed = resolve;
      }),
    );
    const { result } = renderHook(() => useCaptureStallNotice(true));
    await settle();

    push(NO_RUNTIME_HEALTH_ISSUES);
    push(stall("AMBILIGHT_CAPTURE_FRAME_UNAVAILABLE"));
    resolveSeed(makeSnapshot());
    await settle();

    expect(result.current?.reason).toBe("AMBILIGHT_CAPTURE_FRAME_UNAVAILABLE");
  });

  it("never polls: one seed read, then only pushes", async () => {
    vi.useFakeTimers();
    renderHook(() => useCaptureStallNotice(true));
    renderHook(() => useCaptureStallNotice(true));
    await settle();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });

    expect(getFullTelemetrySnapshotMock).toHaveBeenCalledTimes(1);
  });

  it("keeps the same notice, and the caller's render count, across repeated identical pushes", async () => {
    let renders = 0;
    const { result } = renderHook(() => {
      renders += 1;
      return useCaptureStallNotice(true);
    });
    await settle();
    push(stall("AMBILIGHT_CAPTURE_MONITOR_NOT_FOUND"));
    const first = result.current;
    const rendersAfterFirst = renders;

    push(stall("AMBILIGHT_CAPTURE_MONITOR_NOT_FOUND"));
    push({ ...stall("AMBILIGHT_CAPTURE_MONITOR_NOT_FOUND") });

    expect(first).not.toBeNull();
    expect(result.current).toBe(first);
    expect(renders).toBe(rendersAfterFirst);
  });
});
