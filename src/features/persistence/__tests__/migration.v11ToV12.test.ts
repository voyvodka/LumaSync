import { describe, expect, it } from "vitest";

import { resolveHueChannelWorld, resolveHueChannelWorldZ } from "@/features/room-map/model/hueChannelPosition";
import { DEFAULT_ROOM_DIMENSIONS, DEFAULT_ROOM_MAP, type HueChannelPlacement, type HueZone } from "@/shared/contracts/roomMap";

import { migrateShellState } from "../migrations";
import { makeBaseState } from "./support/migrationFixtures";
import type { ShellState } from "./support/migrationFixtures";

const zone: HueZone = { id: "z", name: "Desk", entertainmentAreaId: "area", centerX: 0.2, centerY: -0.1, centerZ: 0, scaleX: 0.4, scaleY: 0.3, scaleZ: 1, channelIndices: [0] };
const light: HueChannelPlacement = { channelIndex: 0, x: 0, y: 0, z: 0, zoneId: "z", zoneRelativePosition: { x: 1, y: -1, z: 0.8 } };
// One edge in metres on all three sides of the 5 × 4 × 2.5 m default room.
const sides = (z: HueZone) => [z.scaleX * DEFAULT_ROOM_DIMENSIONS.widthMeters, z.scaleY * DEFAULT_ROOM_DIMENSIONS.depthMeters, z.scaleZ * DEFAULT_ROOM_DIMENSIONS.heightMeters];
const cube = (z: HueZone) => sides(z).every((s) => Math.abs(s - sides(z)[0]!) < 1e-9);

describe("migrateV11ToV12 — a zone is a cube in metres", () => {
  it("cubes the room's zones and the kept rooms', and moves no light", () => {
    const room = { ...DEFAULT_ROOM_MAP, zones: [zone], hueChannels: [light] };
    const before = {
      ...makeBaseState({ schemaVersion: 11 }),
      roomMap: room,
      roomLayouts: { activeId: "room-1", rooms: [{ id: "room-1" }, { id: "room-2", config: room }] },
    } as ShellState;
    const out = migrateShellState(before, 12);
    expect(out.schemaVersion).toBe(12);
    expect(cube(out.roomMap!.zones[0]!)).toBe(true);
    expect(cube(out.roomLayouts!.rooms[1]!.config!.zones[0]!)).toBe(true);
    const moved = out.roomMap!.hueChannels[0]!;
    expect(resolveHueChannelWorld(moved, out.roomMap!.zones).x).toBeCloseTo(resolveHueChannelWorld(light, [zone]).x);
    expect(resolveHueChannelWorldZ(moved, out.roomMap!.zones)).toBeCloseTo(resolveHueChannelWorldZ(light, [zone]));
  });

  it("grows a cube to cover its lights' spread, and binds lights through the first zone with their id", () => {
    const wide: HueChannelPlacement = { ...light, channelIndex: 1, zoneRelativePosition: { x: -1, y: 1, z: -0.9 } };
    const twin: HueZone = { ...zone, centerX: -0.6 };
    const before = { ...makeBaseState({ schemaVersion: 11 }), roomMap: { ...DEFAULT_ROOM_MAP, zones: [zone, twin], hueChannels: [light, wide] } } as ShellState;
    const out = migrateShellState(before, 12).roomMap!;
    // Heights 0.8 and -0.9 through `zone`, not its twin: 1.7 of the room's 2.5 m, a 2.125 m edge.
    expect(sides(out.zones[0]!)[0]).toBeCloseTo(2.125);
    expect(cube(out.zones[0]!)).toBe(true);
    expect(out.zones[1]).toEqual(twin);
    for (const [i, ch] of [light, wide].entries()) {
      expect(resolveHueChannelWorld(out.hueChannels[i]!, out.zones).x).toBeCloseTo(resolveHueChannelWorld(ch, [zone]).x);
      expect(resolveHueChannelWorldZ(out.hueChannels[i]!, out.zones)).toBeCloseTo(resolveHueChannelWorldZ(ch, [zone]));
    }
  });

  it("is a no-op the second time and on a state with no room map", () => {
    const once = migrateShellState({ ...makeBaseState({ schemaVersion: 11 }), roomMap: { ...DEFAULT_ROOM_MAP, zones: [zone] } } as ShellState, 12);
    expect(migrateShellState(once, 12)).toBe(once);
    const bare = migrateShellState(makeBaseState({ schemaVersion: 11 }) as ShellState, 12);
    expect(bare.roomMap).toBeUndefined();
  });
});
