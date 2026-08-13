import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { FullTelemetrySnapshot } from "@/shared/contracts/telemetry";

const getFullTelemetrySnapshotMock = vi.fn();

vi.mock("@/features/telemetry/telemetryApi", () => ({
  getFullTelemetrySnapshot: () => getFullTelemetrySnapshotMock(),
}));

import { __resetTelemetrySourceForTests } from "../../telemetrySource";
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

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("useCaptureStallNotice", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetTelemetrySourceForTests();
    getFullTelemetrySnapshotMock.mockResolvedValue(makeSnapshot());
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });
  });

  afterEach(() => {
    __resetTelemetrySourceForTests();
    vi.restoreAllMocks();
  });

  it("raises a classified notice while capture is failing now", async () => {
    getFullTelemetrySnapshotMock.mockResolvedValue(
      makeSnapshot({
        lastCaptureErrorCode: "AMBILIGHT_CAPTURE_MONITOR_NOT_FOUND",
        lastCaptureErrorAtSecs: 0,
      }),
    );

    const { result, rerender } = renderHook(() => useCaptureStallNotice(true));
    await flushMicrotasks();
    rerender();

    expect(result.current).toEqual({
      bucket: "display",
      reason: "AMBILIGHT_CAPTURE_MONITOR_NOT_FOUND",
    });
  });

  it("stays silent for a failure the worker already recovered from", async () => {
    // Sticky code, stale age — the exact case a code-only read would misreport.
    getFullTelemetrySnapshotMock.mockResolvedValue(
      makeSnapshot({
        lastCaptureErrorCode: "AMBILIGHT_CAPTURE_MONITOR_NOT_FOUND",
        lastCaptureErrorAtSecs: 90,
      }),
    );

    const { result, rerender } = renderHook(() => useCaptureStallNotice(true));
    await flushMicrotasks();
    rerender();

    expect(result.current).toBeNull();
  });

  it("stays silent on a healthy worker", async () => {
    const { result, rerender } = renderHook(() => useCaptureStallNotice(true));
    await flushMicrotasks();
    rerender();

    expect(result.current).toBeNull();
  });

  it("does not poll at all when the mode is not ambilight", async () => {
    renderHook(() => useCaptureStallNotice(false));
    await flushMicrotasks();

    expect(getFullTelemetrySnapshotMock).not.toHaveBeenCalled();
  });
});
