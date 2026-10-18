import { describe, expect, it } from "vitest";

import type { HueChannelPlacement, HueZone } from "@/shared/contracts/roomMap";

import { resolveHueChannelWorld, resolveHueChannelWorldZ } from "../hueChannelPosition";
import { bottomKeptCenterZ, cubeZones, isCubeZone, maxZoneEdgeAt, withCubeEdge, zoneEdge } from "../zoneCube";

const dimensions = { widthMeters: 5, depthMeters: 4, heightMeters: 2.5 };
// A zone as 10 → 11 left it: 2 × 1.2 m on the floor, floor to ceiling.
const zone = (patch: Partial<HueZone> = {}): HueZone => ({
  id: "z",
  name: "Sofa",
  entertainmentAreaId: "area",
  centerX: 0.2,
  centerY: -0.1,
  centerZ: 0,
  scaleX: 0.4,
  scaleY: 0.3,
  scaleZ: 1,
  channelIndices: [0, 1],
  ...patch,
});
const cube = (edge: number, patch: Partial<HueZone> = {}) =>
  zone({ scaleX: edge / dimensions.widthMeters, scaleY: edge / dimensions.depthMeters, scaleZ: edge / dimensions.heightMeters, ...patch });
const bound = (channelIndex: number, rel: { x: number; y: number; z: number }, zoneId = "z"): HueChannelPlacement => ({
  channelIndex,
  x: 0,
  y: 0,
  z: 0,
  zoneId,
  zoneRelativePosition: rel,
});
const world = (ch: HueChannelPlacement, zones: HueZone[]) => ({ ...resolveHueChannelWorld(ch, zones), z: resolveHueChannelWorldZ(ch, zones) });
const sides = (z: HueZone) => [z.scaleX * dimensions.widthMeters, z.scaleY * dimensions.depthMeters, z.scaleZ * dimensions.heightMeters];

describe("zoneCube", () => {
  it("makes a zone one edge in metres on every side, keeping each bound light where it was", () => {
    const zones = [zone()];
    const hueChannels = [bound(0, { x: 1, y: -1, z: 0.8 }), bound(1, { x: -0.5, y: 0.5, z: -0.6 }), { channelIndex: 2, x: 0.9, y: 0.9, z: 0 }];
    const out = cubeZones({ zones, hueChannels, dimensions });
    expect(isCubeZone(out.zones[0]!, dimensions)).toBe(true);
    // The middle of its sides, 2 m: the lights' 1.75 m of height fits inside.
    for (const side of sides(out.zones[0]!)) expect(side).toBeCloseTo(2);
    for (const [i, ch] of hueChannels.entries()) {
      const was = world(ch, zones);
      const now = world(out.hueChannels[i]!, out.zones);
      expect(now.x).toBeCloseTo(was.x);
      expect(now.y).toBeCloseTo(was.y);
      expect(now.z).toBeCloseTo(was.z);
    }
    expect(out.hueChannels[2]).toBe(hueChannels[2]);
    expect(out.zones[0]!.channelIndices).toEqual([0, 1]);
  });

  it("lets a light the ceiling-capped cube cannot hold leave the zone where it stood", () => {
    // 5 m wide: its lights at either wall are farther apart than the 2.5 m the ceiling allows.
    const zones = [zone({ centerX: 0, scaleX: 1 })];
    const hueChannels = [bound(0, { x: -1, y: 0, z: 0 }), bound(1, { x: 0.1, y: 0, z: 0 })];
    const out = cubeZones({ zones, hueChannels, dimensions });
    for (const side of sides(out.zones[0]!)) expect(side).toBeCloseTo(2.5);
    expect(out.hueChannels[0]).toMatchObject({ channelIndex: 0, x: -1, y: -0.1, z: 0 });
    expect(out.hueChannels[0]!.zoneId).toBeUndefined();
    expect(out.hueChannels[1]!.zoneId).toBe("z");
    expect(world(out.hueChannels[1]!, out.zones).x).toBeCloseTo(0.1);
    expect(out.zones[0]!.channelIndices).toEqual([1]);
  });

  it("keeps its centre with no light to cover", () => {
    const out = cubeZones({ zones: [zone()], hueChannels: [], dimensions }).zones[0]!;
    expect([out.scaleX, out.scaleY, out.scaleZ, out.centerX, out.centerZ].map((v) => Number(v.toFixed(6)))).toEqual([0.4, 0.5, 0.8, 0.2, 0]);
  });

  it("keeps the cube inside the Hue space", () => {
    const out = cubeZones({ zones: [zone({ centerX: 0.8, scaleX: 0.2, scaleY: 0.6 })], hueChannels: [], dimensions }).zones[0]!;
    expect(out.centerX).toBeCloseTo(0.52);
    expect(isCubeZone(out, dimensions)).toBe(true);
  });

  it("does nothing the second time, nor to a zone already a cube", () => {
    const room = { zones: [zone()], hueChannels: [bound(0, { x: 1, y: 0, z: 0.5 })], dimensions };
    const once = cubeZones(room);
    expect(cubeZones(once)).toBe(once);
    const already = { zones: [cube(2)], hueChannels: [], dimensions };
    expect(cubeZones(already)).toBe(already);
  });

  it("takes a cube in Hue units for what it is in a room that is not one: a flat box", () => {
    const hueCube = zone({ centerX: 0, centerY: 0, scaleX: 0.4, scaleY: 0.4, scaleZ: 0.4 });
    expect(isCubeZone(hueCube, dimensions)).toBe(false);
  });

  it("forgives the drift a stored scale picks up through f32", () => {
    expect(isCubeZone(cube(2, { scaleY: 0.5 + 1e-7 }), dimensions)).toBe(true);
  });

  it("keeps the edge through a room resized on every side, read in the room it was", () => {
    const grown = { widthMeters: 7, depthMeters: 6, heightMeters: 3 };
    const out = cubeZones({ zones: [cube(2)], hueChannels: [], dimensions: grown }, dimensions).zones[0]!;
    expect(zoneEdge(out, grown)).toBeCloseTo(2);
    expect(isCubeZone(out, grown)).toBe(true);
  });

  it("leaves a room with no real dimensions alone", () => {
    const room = { zones: [zone()], hueChannels: [], dimensions: { ...dimensions, heightMeters: 0 } };
    expect(cubeZones(room)).toBe(room);
  });

  it("binds lights through the first zone with their id, as the resolvers do", () => {
    const zones = [zone(), zone({ centerX: -0.5 })];
    const ch = bound(0, { x: 0.5, y: 0, z: 0 });
    const out = cubeZones({ zones, hueChannels: [ch], dimensions });
    expect(world(out.hueChannels[0]!, out.zones).x).toBeCloseTo(world(ch, zones).x);
    expect(out.zones[1]).toBe(zones[1]);
  });

  it("sizes a cube within the Rust band and the ceiling, centred so it fits", () => {
    const small = withCubeEdge(zone({ centerX: 0.9 }), 0.01, dimensions);
    expect([small.scaleX, small.scaleY, small.scaleZ]).toEqual([0.05, 0.0625, 0.1]);
    const tall = withCubeEdge(zone({ centerX: 0.9 }), 9, dimensions);
    expect(sides(tall).map((v) => Number(v.toFixed(6)))).toEqual([2.5, 2.5, 2.5]);
    expect(tall.centerX).toBe(0.5);
  });

  it("grows no further about its centre than the nearest wall, floor or ceiling allows", () => {
    expect(maxZoneEdgeAt({ centerX: 0.6, centerY: 0, centerZ: 0 }, dimensions)).toBeCloseTo(2);
    expect(maxZoneEdgeAt({ centerX: 0, centerY: 0, centerZ: 0 }, dimensions)).toBeCloseTo(2.5);
  });

  it("keeps the bottom as the edge changes, until the top meets the ceiling", () => {
    expect(bottomKeptCenterZ({ centerZ: -0.5, scaleZ: 0.3 }, 1.25, dimensions)).toBeCloseTo(-0.3);
    expect(bottomKeptCenterZ({ centerZ: 0.5, scaleZ: 0.3 }, 1.5, dimensions)).toBeCloseTo(0.4);
  });
});
