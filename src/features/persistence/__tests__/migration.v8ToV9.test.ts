import { describe, expect, it } from "vitest";

import { migrateShellState } from "../migrations";
import { SHELL_STATE_SCHEMA_VERSION, makeBaseState } from "./support/migrationFixtures";
import type { ShellState } from "./support/migrationFixtures";

describe("migrateV8ToV9 — the old LED preview's keys are dropped", () => {
  function v8State(extra: Record<string, unknown>): ShellState {
    return { ...makeBaseState({ schemaVersion: 8 }), ...extra } as ShellState;
  }

  it("removes the popup's visibility, the twin's test switch, the last pattern and the hint", () => {
    const out = migrateShellState(
      v8State({
        ledPreviewPopupVisible: true,
        ledTwinEnabledTest: true,
        lastLedTestPattern: { kind: "gamut" },
        ledPreviewHintShown: true,
      }),
    );

    for (const key of ["ledPreviewPopupVisible", "ledTwinEnabledTest", "lastLedTestPattern", "ledPreviewHintShown"]) {
      expect(out).not.toHaveProperty(key);
    }
    expect(out.schemaVersion).toBe(SHELL_STATE_SCHEMA_VERSION);
  });

  // Where the popup sat is the one thing the rebuilt preview still remembers.
  it("keeps the popup's place", () => {
    const out = migrateShellState(v8State({ ledPreviewPopupCenterX: 640, ledPreviewPopupCenterY: 400 }));

    expect(out.ledPreviewPopupCenterX).toBe(640);
    expect(out.ledPreviewPopupCenterY).toBe(400);
  });

  it("leaves a state already at 9 untouched", () => {
    const state = { ...makeBaseState({ schemaVersion: 9 }), lastSection: "devices" } as ShellState;
    expect(migrateShellState(state)).toBe(state);
  });
});
