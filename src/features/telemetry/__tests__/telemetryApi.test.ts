import { describe, expect, it } from "vitest";

import { LINK_MAX_FPS_ABSENT } from "@/shared/contracts/telemetry";
import { mapRuntimeTelemetrySnapshot } from "../telemetryApi";

function dto(partial: Partial<Parameters<typeof mapRuntimeTelemetrySnapshot>[0]> = {}) {
  return {
    captureFps: 60,
    sendFps: 58,
    queueHealth: "healthy",
    frameLatencyMs: 12,
    linkConstrained: false,
    linkMaxFps: 0,
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
