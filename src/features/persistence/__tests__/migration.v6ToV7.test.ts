import { describe, expect, it } from "vitest";

import { migrateShellState } from "../migrations";
import { SHELL_STATE_SCHEMA_VERSION, makeBaseState } from "./support/migrationFixtures";
import type { ShellState } from "./support/migrationFixtures";

describe("migrateV6ToV7 — keys nothing read are dropped", () => {
  type WithRetired = ShellState & {
    startupEnabled?: boolean;
    notificationsEnabled?: boolean;
    roomMapBackgroundOpacity?: number;
  };

  function v6State(extra: Record<string, unknown>): ShellState {
    return { ...makeBaseState({ schemaVersion: 6 }), ...extra } as ShellState;
  }

  it("removes startupEnabled, notificationsEnabled and roomMapBackgroundOpacity", () => {
    const out = migrateShellState(
      v6State({ startupEnabled: false, notificationsEnabled: true, roomMapBackgroundOpacity: 40 }),
    ) as WithRetired;

    expect(out).not.toHaveProperty("startupEnabled");
    expect(out).not.toHaveProperty("notificationsEnabled");
    expect(out).not.toHaveProperty("roomMapBackgroundOpacity");
    expect(out.schemaVersion).toBe(SHELL_STATE_SCHEMA_VERSION);
  });

  it("drops lightingMode.targets and keeps the kind and both payloads", () => {
    const solid = { r: 1, g: 2, b: 3, brightness: 0.5 };
    const ambilight = { brightness: 0.8 };
    const out = migrateShellState(
      v6State({
        lightingMode: { kind: "solid", solid, ambilight, targets: ["usb", "hue"] },
        lastOutputTargets: ["usb", "hue"],
      }),
    );

    expect(out.lightingMode).toEqual({ kind: "solid", solid, ambilight });
    expect(out.lastOutputTargets).toEqual(["usb", "hue"]);
  });

  it("leaves every other key as it was", () => {
    const input = v6State({
      language: "tr",
      trayHintShown: true,
      lastSuccessfulPort: "/dev/ttyUSB0",
      roomMapShowGrid: true,
      lightingMode: { kind: "off" },
    });

    const out = migrateShellState(input);

    expect(out).toEqual({ ...input, schemaVersion: 7 });
  });

  it("does not run again on a v7 state", () => {
    const current = { ...makeBaseState({ schemaVersion: 7 }) };

    expect(migrateShellState(current)).toBe(current);
  });
});
