/**
 * Contract tests for arg/response-shape bugs found by visual inspection.
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
 * 3. The capture-permission refusal of `set_lighting_mode` sent `details:
 *    null` on `AMBILIGHT_MODE_START_FAILED`. Rust always puts the capture
 *    reason there (`lighting_mode.rs`), and `describeCaptureFailure` in
 *    `src/shared/contracts/capture.ts` reads it to pick the failure bucket
 *    the UI copy keys off — with `null` every mock-driven permission refusal
 *    rendered as an unclassified `internal` failure instead of `permission`.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { describeCaptureFailure } from "../../src/shared/contracts/capture";
import { DEVICE_COMMANDS } from "../../src/shared/contracts/device";
import { HUE_RUNTIME_STATES, HUE_RUNTIME_STATUS } from "../../src/shared/contracts/hue";
import type { FullTelemetrySnapshot } from "../../src/shared/contracts/telemetry";
import type { LightingModeCommandResult } from "../../src/features/mode/modeApi";
import {
  LIGHTING_RUNTIME_COMMANDS,
  type ApplyOutputsResult,
} from "../../src/shared/contracts/lightingRuntime";
import { dispatch } from "../dispatch";
import { handlerFor } from "../handlers";
import { __resetMockLightingRuntime } from "../handlers/lighting";
import { SCENARIOS } from "../scenarios";
import { getWorld, setWorld } from "../state";

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
    }) as LightingModeCommandResult;

    expect(result.mode.kind).toBe("ambilight");
    expect(result.active).toBe(true);
    expect(result.status.code).toBe("AMBILIGHT_MODE_STARTED");
  });

  it("refuses ambilight when capture permission is denied — the gate `args.mode` made unreachable", () => {
    setWorld(SCENARIOS["capture-denied"].build());
    const result = call(DEVICE_COMMANDS.SET_LIGHTING_MODE, {
      payload: { kind: "ambilight" },
    }) as LightingModeCommandResult;

    expect(result.active).toBe(false);
    expect(result.status.code).toBe("AMBILIGHT_MODE_START_FAILED");
  });

  it("carries the real capture reason in `details`, not null, on a permission refusal", () => {
    setWorld(SCENARIOS["capture-denied"].build());
    const result = call(DEVICE_COMMANDS.SET_LIGHTING_MODE, {
      payload: { kind: "ambilight" },
    }) as LightingModeCommandResult;

    expect(result.status.details).toBe("AMBILIGHT_CAPTURE_PERMISSION_DENIED");
    // The read the UI actually performs — `describeCaptureFailure` — must
    // land in the `permission` bucket, not fall through to `internal` the
    // way a `null` details always did.
    expect(describeCaptureFailure(result.status.details).bucket).toBe("permission");
  });

  it("applies solid mode — unreachable under the old `args.mode` read, which always fell back to 'off'", () => {
    const result = call(DEVICE_COMMANDS.SET_LIGHTING_MODE, {
      payload: { kind: "solid" },
    }) as LightingModeCommandResult;

    expect(result.mode.kind).toBe("solid");
    expect(result.active).toBe(true);
    expect(result.status.code).toBe("SOLID_MODE_APPLIED");
  });
});

/**
 * `set_lighting_mode` used to ignore `targets` entirely — every mode applied
 * regardless of whether USB or Hue was actually available, so the two gates
 * `apply_mode_change_inner` runs before ever touching the worker
 * (`src-tauri/src/commands/lighting_mode.rs:2023-2036` USB,
 * `lighting_mode.rs:2039-2052` Hue) were both unreachable through the mock.
 *
 * `hue_output` (the thing the Hue gate actually tests) is `Some` only once
 * `start_hue_stream` has spawned a sender — `snapshot_hue_output_context`
 * (`src-tauri/src/commands/hue/state_store.rs:451-463`) reads
 * `owner.active_stream`, set only at start's step 4c and cleared by every
 * stop/gate-block/abort/reconnect path. `hue.streaming` is the mock's proxy
 * for that fact, not `hue.everActive` or `hue.reachable` — a bridge that is
 * reachable and paired but never started still leaves `hue_output` `None`.
 *
 * These drive the mock through `dispatch()`, not `handlerFor`, matching the
 * hueRuntimeFault regression guard in `mock/__tests__/hue.test.ts`.
 */
describe("set_lighting_mode's USB and Hue gates fire in the same order apply_mode_change_inner does", () => {
  it("refuses a hue-target mode with DEVICE_NOT_CONNECTED before ever checking hue_output — USB gate runs first", async () => {
    // Both targets requested, neither available: real Rust's USB gate
    // (2023-2036) precedes its Hue gate (2039-2052), so DEVICE_NOT_CONNECTED
    // must win even though the Hue side would also refuse.
    const world = SCENARIOS.empty.build();
    setWorld(world);
    expect(world.serial.connectedPort).toBeNull();
    expect(world.wled.connectedHost).toBeNull();
    expect(world.hue.streaming).toBe(false);

    const result = (await dispatch(DEVICE_COMMANDS.SET_LIGHTING_MODE, {
      payload: { kind: "ambilight", targets: ["usb", "hue"] },
    })) as LightingModeCommandResult;

    expect(result.status.code).toBe("DEVICE_NOT_CONNECTED");
    expect(result.active).toBe(false);
  });

  it("refuses a hue-only target with HUE_NOT_READY when no Hue stream has ever gone live", async () => {
    const world = SCENARIOS.empty.build();
    setWorld(world);
    expect(world.hue.streaming).toBe(false);

    const result = (await dispatch(DEVICE_COMMANDS.SET_LIGHTING_MODE, {
      payload: { kind: "ambilight", targets: ["hue"] },
    })) as LightingModeCommandResult;

    expect(result.status.code).toBe("HUE_NOT_READY");
    expect(result.status.details).toBe("HUE_RUNTIME_GATE_FAILED");
    expect(result.active).toBe(false);
    // Gate refusals report the mode actually running, never an echo of the
    // request (`lighting_mode.rs`'s own invariant, restated in
    // `LIGHTING_MODE_GATE_STATUS`'s doc comment).
    expect(result.mode).toEqual(world.lighting.mode);
  });

  it("HUE_NOT_READY also fires while the bridge is reachable and paired but the stream was simply never started", async () => {
    // Reachable + valid credentials but `streaming: false` is exactly
    // "never-started" — not a fault at all — and must still gate, the same
    // as `hue_output.is_none()` does for an untouched runtime in Rust.
    const world = SCENARIOS.furnished.build();
    world.hue.streaming = false;
    setWorld(world);
    expect(world.hue.reachable).toBe(true);
    expect(world.hue.credentialValid).toBe(true);

    const result = (await dispatch(DEVICE_COMMANDS.SET_LIGHTING_MODE, {
      payload: { kind: "solid", targets: ["hue"] },
    })) as LightingModeCommandResult;

    expect(result.status.code).toBe("HUE_NOT_READY");
  });

  it("a gate refusal while a mode is running reports that mode as still active", async () => {
    // `make_result` derives `active` from the running mode, not the request.
    const world = SCENARIOS.furnished.build();
    world.hue.streaming = false;
    world.lighting.mode = { ...world.lighting.mode, kind: "solid" };
    setWorld(world);

    const result = (await dispatch(DEVICE_COMMANDS.SET_LIGHTING_MODE, {
      payload: { kind: "ambilight", targets: ["usb", "hue"] },
    })) as LightingModeCommandResult;

    expect(result.status.code).toBe("HUE_NOT_READY");
    expect(result.mode.kind).toBe("solid");
    expect(result.active).toBe(true);
  });

  it("a hue-target mode succeeds once the Hue stream is actually running", async () => {
    setWorld(SCENARIOS.furnished.build());
    expect(getWorld().hue.streaming).toBe(true);

    const result = (await dispatch(DEVICE_COMMANDS.SET_LIGHTING_MODE, {
      payload: { kind: "solid", targets: ["hue"] },
    })) as LightingModeCommandResult;

    expect(result.status.code).toBe("SOLID_MODE_APPLIED");
    expect(result.active).toBe(true);
  });

  it("a usb-only target mode is unaffected by an unready Hue bridge", async () => {
    const world = SCENARIOS.furnished.build();
    world.hue.streaming = false;
    world.hue.reachable = false;
    setWorld(world);

    const result = (await dispatch(DEVICE_COMMANDS.SET_LIGHTING_MODE, {
      payload: { kind: "ambilight", targets: ["usb"] },
    })) as LightingModeCommandResult;

    expect(result.status.code).toBe("AMBILIGHT_MODE_STARTED");
  });

  it("a WLED sink alone satisfies the USB gate, the same as UsbOutputPlan::Wled does in Rust", async () => {
    const world = SCENARIOS.empty.build();
    world.wled.devices = [{ host: "192.168.1.42", name: "WLED Panel", ledCount: 60, port: 4048, protocol: "ddp" }];
    world.wled.connectedHost = "192.168.1.42";
    setWorld(world);
    expect(world.serial.connectedPort).toBeNull();

    const result = (await dispatch(DEVICE_COMMANDS.SET_LIGHTING_MODE, {
      payload: { kind: "ambilight", targets: ["usb"] },
    })) as LightingModeCommandResult;

    expect(result.status.code).not.toBe("DEVICE_NOT_CONNECTED");
  });

  it("Off never gates — targets are irrelevant when the mode is being turned off", async () => {
    const world = SCENARIOS.empty.build();
    setWorld(world);

    const result = (await dispatch(DEVICE_COMMANDS.SET_LIGHTING_MODE, {
      payload: { kind: "off", targets: ["usb", "hue"] },
    })) as LightingModeCommandResult;

    expect(result.status.code).not.toBe("DEVICE_NOT_CONNECTED");
    expect(result.status.code).not.toBe("HUE_NOT_READY");
  });
});

/**
 * The mock's `apply_outputs` keeps the transaction's USB-only fallback: Hue is
 * started first, a `[usb, hue]` apply the Hue gate refuses runs again on USB,
 * and a start left retrying is cancelled so it does not run on unseen.
 */
describe("a [usb, hue] choice with the bridge unreachable falls back to USB", () => {
  async function choose(world: ReturnType<typeof SCENARIOS.furnished.build>) {
    world.hue.reachable = false;
    world.hue.streaming = false;
    world.lighting.mode = { kind: "off" };
    setWorld(world);
    __resetMockLightingRuntime();
    return (await dispatch(LIGHTING_RUNTIME_COMMANDS.APPLY_OUTPUTS, {
      request: { mode: { kind: "solid" }, targets: ["usb", "hue"], origin: "user" },
    })) as ApplyOutputsResult;
  }

  it("never-started runtime: gated start, then USB runs with Hue left out", async () => {
    const world = SCENARIOS.furnished.build();
    world.hue.everActive = false;

    const result = await choose(world);

    expect(result.outcome.hueStartCode).toBe(HUE_RUNTIME_STATUS.CONFIG_NOT_READY_GATE_BLOCKED);
    expect(result.status.code).toBe("OUTPUTS_APPLIED_PARTIAL");
    expect(result.outcome.hueLeftOut).toBe("unreachable");
    expect(result.outcome.applyStatus?.code).toBe("SOLID_MODE_APPLIED");
    expect(result.snapshot.activeTargets).toEqual(["usb"]);
    expect(getWorld().lighting.mode.kind).toBe("solid");
  });

  it("a runtime that was live reports a scheduled retry, which the fallback cancels", async () => {
    const result = await choose(SCENARIOS["hue-unreachable"].build());

    expect(result.outcome.hueStartCode).toBe(HUE_RUNTIME_STATUS.TRANSIENT_RETRY_SCHEDULED);
    expect(result.outcome.hueLeftOut).toBe("unreachable");
    expect(getWorld().lighting.mode.kind).toBe("solid");
    expect(getWorld().hue.streaming).toBe(false);
  });
});

describe("the mock's apply_outputs keeps the rules a caller can see", () => {
  beforeEach(() => {
    setWorld(SCENARIOS.furnished.build());
    __resetMockLightingRuntime();
  });

  it("Off stops the Hue stream as well as the strip", async () => {
    await dispatch(LIGHTING_RUNTIME_COMMANDS.APPLY_OUTPUTS, {
      request: { mode: { kind: "solid" }, targets: ["usb", "hue"], origin: "popup" },
    });
    expect(getWorld().hue.streaming).toBe(true);

    await dispatch(LIGHTING_RUNTIME_COMMANDS.APPLY_OUTPUTS, {
      request: { mode: { kind: "off" }, origin: "popup" },
    });

    expect(getWorld().lighting.mode.kind).toBe("off");
    expect(getWorld().hue.streaming).toBe(false);
  });

  it("a choice is saved, a USB unplug is not", async () => {
    await dispatch(LIGHTING_RUNTIME_COMMANDS.APPLY_OUTPUTS, {
      request: { mode: { kind: "ambilight" }, targets: ["usb"], origin: "user" },
    });
    expect(getWorld().shellState?.lightingMode?.kind).toBe("ambilight");
    expect(getWorld().shellState?.lastOutputTargets).toEqual(["usb"]);

    await dispatch(LIGHTING_RUNTIME_COMMANDS.APPLY_OUTPUTS, {
      request: { targets: [], origin: "usbUnplug" },
    });
    expect(getWorld().shellState?.lastOutputTargets).toEqual(["usb"]);
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
