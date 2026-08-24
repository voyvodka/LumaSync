import { describe, expect, it } from "vitest";

import { migrateShellState } from "../migrations";
import {
  DEFAULT_ROOM_DIMENSIONS,
  SHELL_STATE_SCHEMA_VERSION,
  makeBaseState,
} from "./support/migrationFixtures";
import type {
  HueChannelPlacement,
  HueZone,
  ShellState,
} from "./support/migrationFixtures";

describe("migrateV5ToV6 — region overrides become positions", () => {
  type WithLegacyRegions = ShellState & {
    hueChannelRegionOverrides?: Record<string, Record<number, string>>;
  };

  function v5State(
    overrides: Record<string, Record<number, string>> | undefined,
    hueChannels: HueChannelPlacement[] = [],
    zones: HueZone[] = [],
  ): ShellState {
    const state = makeBaseState({
      schemaVersion: 5,
      roomMap: {
        dimensions: DEFAULT_ROOM_DIMENSIONS,
        hueChannels,
        usbStrips: [],
        furniture: [],
        zones,
        imageLayers: [],
      },
    }) as WithLegacyRegions;
    if (overrides) state.hueChannelRegionOverrides = overrides;
    return state;
  }

  it("moves the channel to the position its region always meant", () => {
    const out = migrateShellState(
      v5State({ "ea-1": { 0: "left" } }, [
        { channelIndex: 0, entertainmentAreaId: "ea-1", x: 0.8, y: 0.8, z: 0 },
      ]),
    );

    const channel = out.roomMap?.hueChannels[0];
    expect(channel?.x).toBeCloseTo(-1, 6);
    expect(channel?.y).toBeCloseTo(0, 6);
  });

  it("strips the retired field whether or not anything was folded", () => {
    const folded = migrateShellState(v5State({ "ea-1": { 0: "left" } })) as WithLegacyRegions;
    const untouched = migrateShellState(v5State(undefined)) as WithLegacyRegions;

    expect(folded).not.toHaveProperty("hueChannelRegionOverrides");
    expect(untouched).not.toHaveProperty("hueChannelRegionOverrides");
    expect(untouched.schemaVersion).toBe(SHELL_STATE_SCHEMA_VERSION);
  });

  it("keeps an override whose channel has no placement yet", () => {
    const out = migrateShellState(v5State({ "ea-9": { 3: "bottom" } }));

    expect(out.roomMap?.hueChannels).toEqual([
      expect.objectContaining({ channelIndex: 3, entertainmentAreaId: "ea-9", y: -1 }),
    ]);
  });

  it("matches on the area too, so two areas' channel 0 stay apart", () => {
    const out = migrateShellState(
      v5State({ "ea-1": { 0: "right" } }, [
        { channelIndex: 0, entertainmentAreaId: "ea-2", x: 0, y: 0, z: 0 },
      ]),
    );

    const byArea = Object.fromEntries(
      (out.roomMap?.hueChannels ?? []).map((c) => [c.entertainmentAreaId, c.x]),
    );
    expect(byArea["ea-2"]).toBeCloseTo(0, 6);
    expect(byArea["ea-1"]).toBeCloseTo(1, 6);
  });

  it("writes the zone-relative pair for a bound channel, not the absolute one", () => {
    const zone: HueZone = {
      id: "zone-1",
      name: "TV wall",
      entertainmentAreaId: "ea-1",
      centerX: 0,
      centerY: 0,
      centerZ: 0,
      scaleX: 1,
      scaleY: 1,
      scaleZ: 1,
      channelIndices: [0],
    };
    const out = migrateShellState(
      v5State(
        { "ea-1": { 0: "left" } },
        [
          {
            channelIndex: 0,
            entertainmentAreaId: "ea-1",
            x: 0.5,
            y: 0,
            z: 0,
            zoneId: "zone-1",
            zoneRelativePosition: { x: 0.5, y: 0, z: 0 },
          },
        ],
        [zone],
      ),
    );

    expect(out.roomMap?.hueChannels[0]?.zoneRelativePosition?.x).toBeCloseTo(-1, 6);
  });

  it("ignores an override naming a region no preset covers", () => {
    const out = migrateShellState(
      v5State({ "ea-1": { 0: "diagonal" } }, [
        { channelIndex: 0, entertainmentAreaId: "ea-1", x: 0.3, y: 0.4, z: 0 },
      ]),
    );

    expect(out.roomMap?.hueChannels[0]?.x).toBeCloseTo(0.3, 6);
  });
});
