import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { migrateShellState } from "../migrations";
import {
  DEFAULT_ROOM_DIMENSIONS,
  SHELL_STATE_SCHEMA_VERSION,
  makeBaseState,
  makeLegacyHueZone,
} from "./support/migrationFixtures";
import type {
  HueZone,
  LegacyHueZone,
  ShellState,
} from "./support/migrationFixtures";

describe("migrateShellState — schemaVersion 3 → 4 (stranded zone recovery)", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  function makeV3State(
    zones: HueZone[],
    hueZones?: LegacyHueZone[],
  ): ShellState {
    return makeBaseState({
      schemaVersion: 3,
      roomMap: {
        dimensions: DEFAULT_ROOM_DIMENSIONS,
        hueChannels: [],
        usbStrips: [],
        furniture: [],
        zones,
        ...(hueZones ? { hueZones } : {}),
        imageLayers: [],
      },
    });
  }

  it("appends_stranded_hueZones_after_the_zones_already_rendered", () => {
    const rendered: HueZone = {
      id: "z-rendered",
      name: "Rendered",
      entertainmentAreaId: "ea-1",
      centerX: 0,
      centerY: 0,
      centerZ: 0,
      scaleX: 1,
      scaleY: 1,
      scaleZ: 1,
      channelIndices: [0],
    };
    const stranded = makeLegacyHueZone({ id: "z-stranded", name: "Stranded" });

    const out = migrateShellState(makeV3State([rendered], [stranded]));

    expect(out.schemaVersion).toBe(SHELL_STATE_SCHEMA_VERSION);
    expect(out.roomMap?.zones.map((z) => z.id)).toEqual(["z-rendered", "z-stranded"]);
    expect(out.roomMap).not.toHaveProperty("hueZones");
    expect(warnSpy).toHaveBeenCalled();
  });

  it("skips_a_stranded_zone_whose_id_already_exists_in_zones", () => {
    const duplicate: HueZone = {
      id: "z-dup",
      name: "Canonical copy",
      entertainmentAreaId: "ea-1",
      centerX: 0,
      centerY: 0,
      centerZ: 0,
      scaleX: 1,
      scaleY: 1,
      scaleZ: 1,
      channelIndices: [],
    };

    const out = migrateShellState(
      makeV3State([duplicate], [makeLegacyHueZone({ id: "z-dup", name: "Stranded copy" })]),
    );

    expect(out.roomMap?.zones).toHaveLength(1);
    expect(out.roomMap?.zones[0].name).toBe("Canonical copy");
  });

  it("drops_corrupt_stranded_records_and_keeps_the_valid_ones", () => {
    const out = migrateShellState(
      makeV3State(
        [],
        [
          makeLegacyHueZone({ id: "z-ok" }),
          makeLegacyHueZone({ id: "z-bad", scaleX: Number.NaN }),
          makeLegacyHueZone({ id: "z-worse", entertainmentAreaId: "" }),
        ],
      ),
    );

    expect(out.roomMap?.zones.map((z) => z.id)).toEqual(["z-ok"]);
  });

  it("strips_the_deprecated_centerColor_from_recovered_zones", () => {
    const out = migrateShellState(
      makeV3State([], [makeLegacyHueZone({ id: "z-ok", centerColor: "#ff0000" })]),
    );

    expect(out.roomMap?.zones[0]).not.toHaveProperty("centerColor");
    expect(out.roomMap?.zones[0].borderColor).toBe("#f59e0b");
  });

  it("bumps_a_clean_v3_state_without_warning", () => {
    const out = migrateShellState(makeV3State([]));

    expect(out.schemaVersion).toBe(SHELL_STATE_SCHEMA_VERSION);
    expect(out.roomMap?.zones).toEqual([]);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("bumps_a_v3_state_that_has_no_room_map_at_all", () => {
    const out = migrateShellState(makeBaseState({ schemaVersion: 3 }));

    expect(out.schemaVersion).toBe(SHELL_STATE_SCHEMA_VERSION);
    expect(out.roomMap).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Cross-step contract — chained migration + idempotency
// ---------------------------------------------------------------------------
