import { describe, expect, it } from "vitest";

import { resolveHueChannelWorldZ } from "@/features/room-map/model/hueChannelPosition";
import { DEFAULT_ROOM_MAP, type HueChannelPlacement, type HueZone } from "@/shared/contracts/roomMap";

import { migrateShellState } from "../migrations";
import { SHELL_STATE_SCHEMA_VERSION, makeBaseState } from "./support/migrationFixtures";
import type { ShellState } from "./support/migrationFixtures";

const zone = (id: string, centerZ: number, scaleZ: number): HueZone => ({
  id,
  name: id,
  entertainmentAreaId: "area",
  centerX: 0.2,
  centerY: -0.1,
  centerZ,
  scaleX: 0.4,
  scaleY: 0.3,
  scaleZ,
  channelIndices: [],
});

const light = (channelIndex: number, zoneId: string | undefined, z: number): HueChannelPlacement => ({
  channelIndex,
  x: 0,
  y: 0,
  z: 0.9,
  entertainmentAreaId: "area",
  ...(zoneId ? { zoneId, zoneRelativePosition: { x: 0.5, y: -0.5, z } } : {}),
});

function v10(zones: HueZone[], hueChannels: HueChannelPlacement[]): ShellState {
  return { ...makeBaseState({ schemaVersion: 10 }), roomMap: { ...DEFAULT_ROOM_MAP, zones, hueChannels } } as ShellState;
}

describe("migrateV10ToV11 — zones span floor to ceiling", () => {
  it("opens every zone to the room's height and moves no light", () => {
    const before = v10([zone("a", 0, 0.5), zone("b", 0.2, 0.3)], [light(0, "a", 1), light(1, "a", -0.4), light(2, "b", 0.5), light(3, undefined, 0)]);
    const out = migrateShellState(before);

    expect(out.schemaVersion).toBe(SHELL_STATE_SCHEMA_VERSION);
    expect(out.roomMap!.zones.map((z) => [z.centerZ, z.scaleZ])).toEqual([
      [0, 1],
      [0, 1],
    ]);
    for (const [i, ch] of out.roomMap!.hueChannels.entries()) {
      const was = before.roomMap!.hueChannels[i]!;
      expect(resolveHueChannelWorldZ(ch, out.roomMap!.zones)).toBeCloseTo(resolveHueChannelWorldZ(was, before.roomMap!.zones));
      expect(ch.zoneRelativePosition?.x).toBe(was.zoneRelativePosition?.x);
      expect(ch.zoneRelativePosition?.y).toBe(was.zoneRelativePosition?.y);
    }
    expect(out.roomMap!.hueChannels[0]!.zoneRelativePosition!.z).toBeCloseTo(0.5);
    expect(out.roomMap!.hueChannels[3]).toBe(before.roomMap!.hueChannels[3]);
    expect(out.roomMap!.zones[0]).toMatchObject({ centerX: 0.2, centerY: -0.1, scaleX: 0.4, scaleY: 0.3 });
  });

  it("rewrites a light once through the first zone with its id, as the resolvers do", () => {
    const out = migrateShellState(v10([zone("a", 0, 0.5), zone("a", 0.5, 0.5)], [light(0, "a", 1)]));
    expect(out.roomMap!.hueChannels[0]!.zoneRelativePosition!.z).toBeCloseTo(0.5);
  });

  it("puts a zone with no height at its centre", () => {
    const out = migrateShellState(v10([zone("a", 0.3, 0)], [light(0, "a", 1)]));
    expect(out.roomMap!.hueChannels[0]!.zoneRelativePosition!.z).toBeCloseTo(0.3);
  });

  it("leaves a zone with a non-finite height and its lights alone", () => {
    const broken = zone("a", Number.NaN, 0.5);
    const out = migrateShellState(v10([broken], [light(0, "a", 1)]));
    expect(out.roomMap!.zones[0]!.centerZ).toBeNaN();
    expect(out.roomMap!.hueChannels[0]!.zoneRelativePosition!.z).toBe(1);
  });

  it("is a no-op the second time and on a state with no room map", () => {
    const once = migrateShellState(v10([zone("a", 0, 0.5)], [light(0, "a", 1)]));
    expect(migrateShellState(once)).toBe(once);
    const bare = migrateShellState(makeBaseState({ schemaVersion: 10 }) as ShellState);
    expect(bare.schemaVersion).toBe(SHELL_STATE_SCHEMA_VERSION);
    expect(bare.roomMap).toBeUndefined();
  });
});
