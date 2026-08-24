import { describe, expect, it } from "vitest";

import { migrateShellState } from "../migrations";
import {
  DEFAULT_ROOM_DIMENSIONS,
  SHELL_STATE_SCHEMA_VERSION,
  makeBaseState,
} from "./support/migrationFixtures";
import type {
  HueChannelPlacement,
  ShellState,
} from "./support/migrationFixtures";

describe("migrateV4ToV5 — hue channel area attribution", () => {
  function v4State(
    hueChannels: HueChannelPlacement[],
    lastHueAreaId?: string,
  ): ShellState {
    return makeBaseState({
      schemaVersion: 4,
      lastHueAreaId,
      roomMap: {
        dimensions: DEFAULT_ROOM_DIMENSIONS,
        hueChannels,
        usbStrips: [],
        furniture: [],
        zones: [],
        imageLayers: [],
      },
    });
  }

  it("stamps every placement with the last edited area", () => {
    const out = migrateShellState(
      v4State([{ channelIndex: 0, x: 0, y: 0, z: 0 }, { channelIndex: 2, x: 1, y: 1, z: 0 }], "ea-7"),
    );

    expect(out.schemaVersion).toBe(SHELL_STATE_SCHEMA_VERSION);
    expect(out.roomMap?.hueChannels.map((c) => c.entertainmentAreaId)).toEqual(["ea-7", "ea-7"]);
  });

  it("leaves placements unscoped when no area was ever selected", () => {
    // Inventing an id would bind them to an area that may not exist; unscoped
    // records are adopted by whichever area is being viewed instead.
    const out = migrateShellState(v4State([{ channelIndex: 0, x: 0, y: 0, z: 0 }]));

    expect(out.schemaVersion).toBe(SHELL_STATE_SCHEMA_VERSION);
    expect(out.roomMap?.hueChannels[0].entertainmentAreaId).toBeUndefined();
  });

  it("does not overwrite an area a record already names", () => {
    const out = migrateShellState(
      v4State([{ channelIndex: 0, x: 0, y: 0, z: 0, entertainmentAreaId: "ea-original" }], "ea-7"),
    );

    expect(out.roomMap?.hueChannels[0].entertainmentAreaId).toBe("ea-original");
  });

  it("bumps a state that carries no room map at all", () => {
    const out = migrateShellState(makeBaseState({ schemaVersion: 4, roomMap: undefined }));
    expect(out.schemaVersion).toBe(SHELL_STATE_SCHEMA_VERSION);
  });
});

// ---------------------------------------------------------------------------
// 5 → 6 — retire the region overrides into channel positions
// ---------------------------------------------------------------------------
