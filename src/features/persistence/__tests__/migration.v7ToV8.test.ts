import { describe, expect, it } from "vitest";

import { migrateShellState } from "../migrations";
import { SHELL_STATE_SCHEMA_VERSION, makeBaseState } from "./support/migrationFixtures";
import type { ShellState } from "./support/migrationFixtures";

describe("migrateV7ToV8 — the local output is stored as strips", () => {
  function v7State(extra: Record<string, unknown>): ShellState {
    return { ...makeBaseState({ schemaVersion: 7 }), ...extra } as ShellState;
  }

  it("derives the strip from the legacy keys and leaves those keys frozen on disk", () => {
    const legacy = {
      lastSuccessfulPort: "COM3",
      ledCalibration: { totalLeds: 60 },
      selectedChipType: "sk6812-rgbw",
    };
    const out = migrateShellState(v7State(legacy));

    expect(out.schemaVersion).toBe(SHELL_STATE_SCHEMA_VERSION);
    expect(out.ledStrips).toEqual([
      {
        id: "strip-1",
        enabled: true,
        transport: { kind: "serial", portName: "COM3" },
        hardware: { chipType: "sk6812-rgbw" },
        layout: { totalLeds: 60 },
      },
    ]);
    expect(out).toMatchObject(legacy);
  });

  it("writes an empty list when nothing describes a strip, so the key reads as migrated", () => {
    expect(migrateShellState(v7State({})).ledStrips).toEqual([]);
  });

  // Rust stores the list first when a WLED device is forgotten before any window migrated; the
  // frozen `lastWledSink` must not bring the device back.
  it("keeps a list that is already there", () => {
    const out = migrateShellState(
      v7State({
        lastWledSink: { ip: "10.0.0.5", port: 4048, ledCount: 60, protocol: "ddp" },
        ledStrips: [{ id: "strip-1", enabled: true, transport: null, hardware: {}, layout: { totalLeds: 60 } }],
      }),
    );

    expect(out.ledStrips).toEqual([
      { id: "strip-1", enabled: true, transport: null, hardware: {}, layout: { totalLeds: 60 } },
    ]);
  });

  it("reads a null list as absent, as Rust does", () => {
    const out = migrateShellState(v7State({ lastSuccessfulPort: "COM3", ledStrips: null }));

    expect(out.ledStrips).toEqual([
      { id: "strip-1", enabled: true, transport: { kind: "serial", portName: "COM3" }, hardware: {} },
    ]);
  });

  it("leaves a v8 state alone", () => {
    const state = { ...makeBaseState({ schemaVersion: 8 }), lastSuccessfulPort: "COM3" } as ShellState;
    expect(migrateShellState(state)).toBe(state);
  });
});
