/**
 * `previewOnly` on `start_led_test_pattern` / `stop_led_test_pattern`.
 *
 * Before this file the mock answered `start_led_test_pattern` with a
 * constant `previewOnly: true`, no matter what the world's serial/WLED/Hue
 * state was. The colour-order "Identify" flow
 * (`src/features/settings/sections/control/useColorOrderIdentify.ts`) reads
 * `previewOnly` to decide whether the probe actually reached a strip — a
 * constant `true` meant the flow's live path (`PATTERN_STARTED`) could never
 * be exercised in the mock, only its `notSending` failure branch.
 *
 * These drive the handler through `dispatch()`, the same path the frontend's
 * `invoke()` bridge takes — `{ payload }`, not a bare argument object; see
 * `previewApi.ts`'s `startLedTestPattern`.
 */
import { beforeEach, describe, expect, it } from "vitest";

import type { LedTestPatternResult } from "../../src/shared/contracts/preview";
import { PREVIEW_COMMANDS } from "../../src/shared/contracts/preview";
import { dispatch } from "../dispatch";
import { SCENARIOS } from "../scenarios";
import { getWorld, setWorld } from "../state";

async function startPattern(targets?: ("usb" | "hue")[]): Promise<LedTestPatternResult> {
  return dispatch<LedTestPatternResult>(PREVIEW_COMMANDS.START_TEST_PATTERN, {
    payload: {
      pattern: { kind: "channelProbe", slot: 0 },
      brightness: 0.5,
      targets,
    },
  });
}

describe("start_led_test_pattern derives previewOnly from the world, not a constant", () => {
  it("is preview-only with nothing connected — the 'empty' scenario", async () => {
    setWorld(SCENARIOS.empty.build());
    const result = await startPattern(["usb"]);

    expect(result.active).toBe(true);
    expect(result.previewOnly).toBe(true);
    expect(result.status.code).toBe("LED_TEST_PATTERN_PREVIEW_ONLY");
  });

  it("reaches the strip once a serial port is connected — the Identify flow's live path", async () => {
    setWorld(SCENARIOS["usb-only"].build());
    expect(getWorld().serial.connectedPort).not.toBeNull();

    const result = await startPattern(["usb"]);

    expect(result.previewOnly).toBe(false);
    expect(result.status.code).toBe("LED_TEST_PATTERN_STARTED");
  });

  it("a registered WLED sink alone satisfies the usb target too, same as the real UsbOutputPlan::Wled", async () => {
    const world = SCENARIOS.empty.build();
    world.wled.devices = [
      { host: "192.168.1.42", name: "WLED Panel", ledCount: 60, port: 4048, protocol: "ddp" },
    ];
    world.wled.connectedHost = "192.168.1.42";
    setWorld(world);
    expect(getWorld().serial.connectedPort).toBeNull();

    const result = await startPattern(["usb"]);

    expect(result.previewOnly).toBe(false);
  });

  it("no target requested defaults to wanting usb, matching the backend's empty/absent-targets fallback", async () => {
    setWorld(SCENARIOS["usb-only"].build());
    const result = await startPattern(undefined);

    expect(result.previewOnly).toBe(false);
  });

  it("a hue target only counts once the stream is actually running with mapped channels", async () => {
    // Paired, reachable, credentials valid — but never started. Real Rust's
    // `snapshot_hue_output_context` reads `active_stream`, which stays `None`
    // until a stream has genuinely gone `Running` (`hue/state_store.rs:451-463`).
    const world = SCENARIOS.furnished.build();
    world.serial.connectedPort = null;
    world.wled.connectedHost = null;
    world.hue.streaming = false;
    setWorld(world);

    const result = await startPattern(["hue"]);

    expect(result.previewOnly).toBe(true);
  });

  it("a running hue stream with mapped channels satisfies the hue target", async () => {
    const world = SCENARIOS.furnished.build();
    world.serial.connectedPort = null;
    world.wled.connectedHost = null;
    setWorld(world);
    expect(getWorld().hue.streaming).toBe(true);
    expect(getWorld().hue.channels.length).toBeGreaterThan(0);

    const result = await startPattern(["hue"]);

    expect(result.previewOnly).toBe(false);
    expect(result.status.code).toBe("LED_TEST_PATTERN_STARTED");
  });

  it("requesting only usb ignores an available hue stream — targets are per-channel, not global", async () => {
    const world = SCENARIOS.furnished.build();
    world.serial.connectedPort = null;
    world.wled.connectedHost = null;
    setWorld(world);
    expect(getWorld().hue.streaming).toBe(true);

    const result = await startPattern(["usb"]);

    expect(result.previewOnly).toBe(true);
  });
});

describe("stop_led_test_pattern always reports previewOnly: false", () => {
  beforeEach(() => {
    setWorld(SCENARIOS.empty.build());
  });

  it("reports previewOnly: false even with nothing connected — the field describes the ended test, not the restored mode", async () => {
    const result = await dispatch<LedTestPatternResult>(PREVIEW_COMMANDS.STOP_TEST_PATTERN);

    expect(result.previewOnly).toBe(false);
    expect(result.status.code).toBe("LED_TEST_PATTERN_STOPPED");
  });

  it("reports previewOnly: false with a strip connected too", async () => {
    setWorld(SCENARIOS["usb-only"].build());
    const result = await dispatch<LedTestPatternResult>(PREVIEW_COMMANDS.STOP_TEST_PATTERN);

    expect(result.previewOnly).toBe(false);
  });
});

// Rust answers with the restored mode's `active`, not a constant `false`.
describe("stop_led_test_pattern reports the restored mode's activity", () => {
  it("is active when the mode that ran before the test resumes", async () => {
    setWorld(SCENARIOS["usb-only"].build());
    expect(getWorld().lighting.mode.kind).toBe("ambilight");

    const result = await dispatch<LedTestPatternResult>(PREVIEW_COMMANDS.STOP_TEST_PATTERN);

    expect(result.active).toBe(true);
    expect(getWorld().lighting.mode.kind).toBe("ambilight");
  });

  it("is inactive when nothing ran before the test", async () => {
    setWorld(SCENARIOS.empty.build());

    const result = await dispatch<LedTestPatternResult>(PREVIEW_COMMANDS.STOP_TEST_PATTERN);

    expect(result.active).toBe(false);
  });

  it("falls back to Off when the restore's own gate refuses it", async () => {
    const world = SCENARIOS["usb-only"].build();
    world.lighting.mode = { kind: "ambilight", targets: ["usb"] };
    world.serial.connectedPort = null;
    setWorld(world);

    const result = await dispatch<LedTestPatternResult>(PREVIEW_COMMANDS.STOP_TEST_PATTERN);

    expect(result.active).toBe(false);
    expect(getWorld().lighting.mode.kind).toBe("off");
  });
});
