/**
 * Contract tests for two arg/response-shape bugs found by visual inspection.
 *
 * 1. `set_lighting_mode` read `args.mode`, but `setLightingMode` in
 *    `src/features/mode/modeApi.ts` has only ever sent `{ payload }`. Every
 *    call landed on the `undefined` fallback, so every mode applied as "off":
 *    the capture-permission gate below was unreachable and Solid mode could
 *    never be entered. These tests call the handler with the *real* envelope
 *    the bridge sends, not the one the old fixture happened to read.
 * 2. `get_runtime_telemetry`'s Hue block never produced `lastErrorCode` and
 *    reported "Idle" for both an unreachable bridge and an expired key —
 *    collapsing exactly the distinction `get_hue_stream_status` already
 *    got right. See `hueRuntimeFault` in `mock/handlers/hue.ts`.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { DEVICE_COMMANDS } from "../../src/shared/contracts/device";
import { HUE_RUNTIME_STATES, HUE_RUNTIME_STATUS } from "../../src/shared/contracts/hue";
import type { FullTelemetrySnapshot } from "../../src/shared/contracts/telemetry";
import type { ModeCommandResult } from "../../src/features/mode/modeApi";
import { handlerFor } from "../handlers";
import { SCENARIOS } from "../scenarios";
import { setWorld } from "../state";

const call = (command: string, args?: Record<string, unknown>) => {
  const handler = handlerFor(command);
  expect(handler, `no handler for ${command}`).toBeDefined();
  return handler?.(args);
};

describe("set_lighting_mode reads the real invoke payload shape", () => {
  beforeEach(() => {
    setWorld(SCENARIOS.furnished.build());
  });

  it("applies ambilight when called with the real { payload } envelope", () => {
    const result = call(DEVICE_COMMANDS.SET_LIGHTING_MODE, {
      payload: { kind: "ambilight" },
    }) as ModeCommandResult;

    expect(result.mode.kind).toBe("ambilight");
    expect(result.active).toBe(true);
    expect(result.status.code).toBe("AMBILIGHT_MODE_STARTED");
  });

  it("refuses ambilight when capture permission is denied — the gate `args.mode` made unreachable", () => {
    setWorld(SCENARIOS["capture-denied"].build());
    const result = call(DEVICE_COMMANDS.SET_LIGHTING_MODE, {
      payload: { kind: "ambilight" },
    }) as ModeCommandResult;

    expect(result.active).toBe(false);
    expect(result.status.code).toBe("AMBILIGHT_MODE_START_FAILED");
  });

  it("applies solid mode — unreachable under the old `args.mode` read, which always fell back to 'off'", () => {
    const result = call(DEVICE_COMMANDS.SET_LIGHTING_MODE, {
      payload: { kind: "solid" },
    }) as ModeCommandResult;

    expect(result.mode.kind).toBe("solid");
    expect(result.active).toBe(true);
    expect(result.status.code).toBe("SOLID_MODE_APPLIED");
  });
});

describe("get_runtime_telemetry reports the real Hue fault state", () => {
  it("hue-unreachable reports Reconnecting with reconnect counts and a last error", () => {
    setWorld(SCENARIOS["hue-unreachable"].build());
    const snapshot = call(DEVICE_COMMANDS.GET_RUNTIME_TELEMETRY) as FullTelemetrySnapshot;

    expect(snapshot.hue).not.toBeNull();
    expect(snapshot.hue?.state).toBe(HUE_RUNTIME_STATES.RECONNECTING);
    expect(snapshot.hue?.lastErrorCode).toBe(HUE_RUNTIME_STATUS.TRANSIENT_RETRY_SCHEDULED);
    expect(snapshot.hue?.totalReconnects).toBeGreaterThan(0);
    expect(snapshot.hue?.failedReconnects).toBe(snapshot.hue?.totalReconnects);
    expect(snapshot.hue?.successfulReconnects).toBe(0);
  });

  it("hue-key-expired reports a last error consistent with AUTH_INVALID", () => {
    setWorld(SCENARIOS["hue-key-expired"].build());
    const snapshot = call(DEVICE_COMMANDS.GET_RUNTIME_TELEMETRY) as FullTelemetrySnapshot;

    expect(snapshot.hue).not.toBeNull();
    expect(snapshot.hue?.state).toBe(HUE_RUNTIME_STATES.FAILED);
    expect(snapshot.hue?.lastErrorCode).toBe(HUE_RUNTIME_STATUS.AUTH_INVALID_CREDENTIALS);
  });

  it("a streaming session reports Running with no last error", () => {
    setWorld(SCENARIOS.furnished.build());
    const snapshot = call(DEVICE_COMMANDS.GET_RUNTIME_TELEMETRY) as FullTelemetrySnapshot;

    expect(snapshot.hue?.state).toBe(HUE_RUNTIME_STATES.RUNNING);
    expect(snapshot.hue?.lastErrorCode).toBeNull();
  });
});
