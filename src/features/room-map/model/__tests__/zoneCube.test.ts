import { describe, expect, it } from "vitest";

import type { HueChannelPlacement, HueZone } from "@/shared/contracts/roomMap";

import { resolveHueChannelWorld, resolveHueChannelWorldZ } from "../hueChannelPosition";
import { cubeZones, isCubeZone, withCubeScale } from "../zoneCube";

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
const bound = (channelIndex: number, rel: { x: number; y: number; z: number }, zoneId = "z"): HueChannelPlacement => ({
  channelIndex,
  x: 0,
  y: 0,
  z: 0,
  zoneId,
  zoneRelativePosition: rel,
});
const world = (ch: HueChannelPlacement, zones: HueZone[]) => ({ ...resolveHueChannelWorld(ch, zones), z: resolveHueChannelWorldZ(ch, zones) });

describe("zoneCube", () => {
  it("makes a zone one scale on every axis, keeping each bound light where it was", () => {
    const zones = [zone()];
    const hueChannels = [bound(0, { x: 1, y: -1, z: 0.8 }), bound(1, { x: -0.5, y: 0.5, z: -0.6 }), { channelIndex: 2, x: 0.9, y: 0.9, z: 0 }];
    const out = cubeZones({ zones, hueChannels });
    expect(isCubeZone(out.zones[0]!)).toBe(true);
    for (const [i, ch] of hueChannels.entries()) {
      const was = world(ch, zones);
      const now = world(out.hueChannels[i]!, out.zones);
      expect(now.x).toBeCloseTo(was.x);
      expect(now.y).toBeCloseTo(was.y);
      expect(now.z).toBeCloseTo(was.z);
    }
    // Its larger side, grown to the lights' spread in height: -0.6 to 0.8.
    expect(out.zones[0]!.scaleX).toBeCloseTo(0.7);
    expect(out.hueChannels[2]).toBe(hueChannels[2]);
  });

  it("keeps its larger side and sits at mid-height with no light to cover", () => {
    const out = cubeZones({ zones: [zone()], hueChannels: [] }).zones[0]!;
    expect([out.scaleX, out.scaleY, out.scaleZ, out.centerZ]).toEqual([0.4, 0.4, 0.4, 0]);
  });

  it("keeps the cube inside the Hue space", () => {
    const out = cubeZones({ zones: [zone({ centerX: 0.8, scaleX: 0.2, scaleY: 0.6 })], hueChannels: [] }).zones[0]!;
    expect(out.centerX).toBeCloseTo(0.4);
    expect(isCubeZone(out)).toBe(true);
  });

  it("does nothing the second time, nor to a zone already a cube", () => {
    const room = { zones: [zone()], hueChannels: [bound(0, { x: 1, y: 0, z: 0.5 })] };
    const once = cubeZones(room);
    expect(cubeZones(once)).toBe(once);
    const cube = { zones: [zone({ scaleX: 0.5, scaleY: 0.5, scaleZ: 0.5 })], hueChannels: [] };
    expect(cubeZones(cube)).toBe(cube);
  });

  it("binds lights through the first zone with their id, as the resolvers do", () => {
    const zones = [zone(), zone({ centerX: -0.5 })];
    const ch = bound(0, { x: 0.5, y: 0, z: 0 });
    const out = cubeZones({ zones, hueChannels: [ch] });
    expect(world(out.hueChannels[0]!, out.zones).x).toBeCloseTo(world(ch, zones).x);
    expect(out.zones[1]).toBe(zones[1]);
  });

  it("sizes a cube within the Rust band, centred so it fits", () => {
    const z = withCubeScale(zone({ centerX: 0.9 }), 0.01);
    expect([z.scaleX, z.scaleY, z.scaleZ]).toEqual([0.05, 0.05, 0.05]);
    expect(withCubeScale(zone({ centerX: 0.9 }), 0.5).centerX).toBe(0.5);
  });
});
