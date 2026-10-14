import { describe, expect, it } from "vitest";

import { migrateShellState } from "../migrations";
import { SHELL_STATE_SCHEMA_VERSION, makeBaseState } from "./support/migrationFixtures";
import type { ShellState } from "./support/migrationFixtures";

describe("migrateV9ToV10 — roomMapVersion is dropped", () => {
  function v9State(extra: Record<string, unknown>): ShellState {
    return { ...makeBaseState({ schemaVersion: 9 }), ...extra } as ShellState;
  }

  it("removes the counter and keeps the room map", () => {
    const roomMap = { dimensions: { widthMeters: 5, depthMeters: 4, heightMeters: 2.5 } };
    const out = migrateShellState(v9State({ roomMapVersion: 42, roomMap }));

    expect(out).not.toHaveProperty("roomMapVersion");
    expect(out.roomMap).toEqual(roomMap);
    expect(out.schemaVersion).toBe(SHELL_STATE_SCHEMA_VERSION);
  });

  it("is harmless on a state that never had one", () => {
    const out = migrateShellState(v9State({}));

    expect(out).not.toHaveProperty("roomMapVersion");
    expect(out.schemaVersion).toBe(SHELL_STATE_SCHEMA_VERSION);
  });
});
