import { describe, expect, it } from "vitest";

import { CAPTURE_TARGET_FPS_ABSENT, LINK_MAX_FPS_ABSENT } from "@/shared/contracts/telemetry";
import type { CommandInvoker } from "@/shared/ipcApi";
import { getRuntimeTelemetryHistory, mapRuntimeTelemetrySnapshot } from "../telemetryApi";

function dto(partial: Partial<Parameters<typeof mapRuntimeTelemetrySnapshot>[0]> = {}) {
  return {
    captureFps: 60,
    sendFps: 58,
    queueHealth: "healthy",
    frameLatencyMs: 12,
    linkConstrained: false,
    linkMaxFps: 0,
    lastCaptureErrorCode: null,
    lastCaptureErrorAtSecs: null,
    captureTargetFps: 30.3,
    ...partial,
  };
}

describe("mapRuntimeTelemetrySnapshot", () => {
  // The mapper used to build its result field by field without these two, so a
  // budget Rust had already computed was dropped at the IPC boundary.
  it("carries the serial link budget through to the domain shape", () => {
    const snapshot = mapRuntimeTelemetrySnapshot(dto({ linkConstrained: true, linkMaxFps: 19.01 }));

    expect(snapshot.linkConstrained).toBe(true);
    expect(snapshot.linkMaxFps).toBe(19.01);
  });

  it("floors a negative or garbled link budget at the absent sentinel", () => {
    expect(mapRuntimeTelemetrySnapshot(dto({ linkMaxFps: -5 })).linkMaxFps).toBe(
      LINK_MAX_FPS_ABSENT,
    );
    expect(
      mapRuntimeTelemetrySnapshot(dto({ linkMaxFps: Number.NaN })).linkMaxFps,
    ).toBe(LINK_MAX_FPS_ABSENT);
  });

  it("treats a missing linkConstrained flag as unconstrained", () => {
    const snapshot = mapRuntimeTelemetrySnapshot(
      dto({ linkConstrained: undefined as unknown as boolean }),
    );

    expect(snapshot.linkConstrained).toBe(false);
  });
});

describe("capture target and history", () => {
  it("carries the capture target and floors a garbled one at the absent sentinel", () => {
    expect(mapRuntimeTelemetrySnapshot(dto()).captureTargetFps).toBe(30.3);
    expect(
      mapRuntimeTelemetrySnapshot(dto({ captureTargetFps: undefined as unknown as number }))
        .captureTargetFps,
    ).toBe(CAPTURE_TARGET_FPS_ABSENT);
  });

  it("keeps well-formed samples in order and drops malformed ones", async () => {
    const invoker = (async () => ({
      samples: [
        { epochMs: 1000, fps: 19.5, targetFps: 20 },
        { epochMs: 2000, fps: "18", targetFps: 20 },
        null,
        { epochMs: 3000, fps: -1, targetFps: 20 },
      ],
    })) as unknown as CommandInvoker;

    const history = await getRuntimeTelemetryHistory(invoker);

    expect(history.samples).toEqual([
      { epochMs: 1000, fps: 19.5, targetFps: 20 },
      { epochMs: 3000, fps: 0, targetFps: 20 },
    ]);
  });

  it("reads a missing sample list as an empty history", async () => {
    const invoker = (async () => ({})) as unknown as CommandInvoker;
    expect((await getRuntimeTelemetryHistory(invoker)).samples).toEqual([]);
  });
});
