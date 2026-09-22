/**
 * A scenario's job is to put the app in the state its label claims. When it
 * does not, the failure is silent and looks like an app bug: `furnished`
 * wrote `lastHueBridge` as `{ internalipaddress }` — the Hue *discovery
 * endpoint's* field name, where `HueBridgeSummary` declares `ip` — so
 * `toHueStartConfig` returned null and every scenario derived from it showed
 * "Hue · Not configured" in the output dock while the status bar said
 * STREAMING. Nothing failed. The screen just disagreed with itself.
 *
 * `shellState` is now `Partial<ShellState>`, so that exact shape is a compile
 * error. These tests cover the half a type cannot: that the values are not
 * only well-typed but consistent with what the scenario says it is.
 */

import { describe, expect, it } from "vitest";

import { toHueStartConfig } from "../../src/features/hue/model/hueStartConfig";
import { SCENARIOS, SCENARIO_IDS } from "../scenarios";

/** Scenarios whose label promises a bridge that is paired and area-selected. */
const PAIRED = [
  "furnished",
  "hue-only",
  "hue-area-empty",
  "hue-unreachable",
  "hue-key-expired",
  "hue-busy-at-boot",
  "capture-denied",
  "persist-failing",
] as const;

describe("scenarios put the app in the state they claim", () => {
  it.each(PAIRED)("%s resolves a Hue start config", (id) => {
    // Null here is what made the dock say "Not configured" under a status bar
    // reading STREAMING — the two read different sources.
    const config = toHueStartConfig(SCENARIOS[id].build().shellState);
    expect(config, `${id} claims a paired bridge but resolves no start config`).not.toBeNull();
    expect(config?.bridgeIp).toBeTruthy();
    expect(config?.areaId).toBeTruthy();
  });

  it("empty resolves no Hue config, because that is what first run means", () => {
    expect(toHueStartConfig(SCENARIOS.empty.build().shellState)).toBeNull();
  });

  it("usb-only resolves no Hue config", () => {
    expect(toHueStartConfig(SCENARIOS["usb-only"].build().shellState)).toBeNull();
  });

  it("every scenario in the catalogue builds and names itself", () => {
    for (const id of SCENARIO_IDS) {
      const scenario = SCENARIOS[id];
      expect(scenario.id).toBe(id);
      expect(scenario.summary.length).toBeGreaterThan(0);
      // A world that does not carry its own id cannot report a stale response
      // correctly — `dispatch.ts` compares generations across a swap.
      expect(scenario.build().scenario).toBe(id);
    }
  });

  // `capture-denied` inherited a live stream from `furnished` while its mode
  // was off, so the status bar said STREAMING over a stopped app.
  it.each(SCENARIO_IDS)("%s reports no Hue stream while lighting is off", (id) => {
    const world = SCENARIOS[id].build();
    if (world.lighting.mode.kind !== "off") return;
    expect(world.hue.streaming, `${id} is off but streams to Hue`).toBe(false);
    expect(world.hue.everActive, `${id} is off but claims a stream ran`).toBe(false);
  });

  it("the furnished calibration agrees with its own edge counts", () => {
    // `totalLeds` is what the frame generator and the dock both read; an edge
    // sum that disagrees with it is the kind of fixture that sends someone
    // hunting an off-by-one in the strip mapping.
    const calibration = SCENARIOS.furnished.build().shellState.ledCalibration;
    expect(calibration).toBeDefined();
    const { top, right, bottom, left } = calibration!.counts;
    expect(top + right + bottom + left).toBe(calibration!.totalLeds);
  });
});
