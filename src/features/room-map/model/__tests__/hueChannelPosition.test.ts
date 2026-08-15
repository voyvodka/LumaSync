import { describe, expect, it } from "vitest";

import type { HueChannelPlacement, HueZone } from "@/shared/contracts/roomMap";
import {
  moveHueChannelToWorld,
  nudgeHueChannel,
  resolveHueChannelWorld,
} from "../hueChannelPosition";

const ZONE: HueZone = {
  id: "zone-a",
  name: "Sofa",
  entertainmentAreaId: "area-1",
  centerX: 0.4,
  centerY: -0.2,
  centerZ: 0,
  scaleX: 0.25,
  scaleY: 0.5,
  scaleZ: 0.5,
  channelIndices: [0],
  borderColor: "#3b82f6",
};

/** Absolute x/y deliberately disagree with the zone-derived position, which is
 *  the shape a stale-leftover channel actually has on disk. */
const BOUND: HueChannelPlacement = {
  channelIndex: 0,
  x: -0.9,
  y: -0.9,
  z: 0,
  zoneId: "zone-a",
  zoneRelativePosition: { x: 0.5, y: -0.5, z: 0 },
};

const FREE: HueChannelPlacement = { channelIndex: 1, x: 0.1, y: 0.2, z: 0 };

describe("resolveHueChannelWorld", () => {
  it("derives a bound channel's position from its zone, ignoring absolute x/y", () => {
    // 0.4 + 0.25*0.5 = 0.525 ; -0.2 + 0.5*(-0.5) = -0.45
    expect(resolveHueChannelWorld(BOUND, [ZONE])).toEqual({ x: 0.525, y: -0.45 });
  });

  it("uses absolute x/y for an unbound channel", () => {
    expect(resolveHueChannelWorld(FREE, [ZONE])).toEqual({ x: 0.1, y: 0.2 });
  });

  it("falls back to absolute when the bound zone is missing from the list", () => {
    expect(resolveHueChannelWorld(BOUND, [])).toEqual({ x: -0.9, y: -0.9 });
  });

  it("clamps a zone-derived position into the Hue cube", () => {
    const far: HueZone = { ...ZONE, centerX: 0.9, scaleX: 0.5 };
    expect(resolveHueChannelWorld({ ...BOUND, zoneRelativePosition: { x: 1, y: 0, z: 0 } }, [far]).x).toBe(1);
  });
});

describe("moveHueChannelToWorld", () => {
  it("writes zone-relative for a bound channel and keeps absolute in step", () => {
    const moved = moveHueChannelToWorld(BOUND, [ZONE], 0.4, -0.2);
    // The zone centre is relative (0, 0).
    expect(moved.zoneRelativePosition?.x).toBeCloseTo(0, 10);
    expect(moved.zoneRelativePosition?.y).toBeCloseTo(0, 10);
    expect(moved.x).toBe(0.4);
    expect(moved.y).toBe(-0.2);
  });

  it("round-trips through resolve", () => {
    const moved = moveHueChannelToWorld(BOUND, [ZONE], 0.5, -0.3);
    const back = resolveHueChannelWorld(moved, [ZONE]);
    expect(back.x).toBeCloseTo(0.5, 10);
    expect(back.y).toBeCloseTo(-0.3, 10);
  });

  it("writes only absolute for an unbound channel", () => {
    const moved = moveHueChannelToWorld(FREE, [ZONE], 0.3, 0.4);
    expect(moved).toEqual({ ...FREE, x: 0.3, y: 0.4 });
    expect(moved.zoneRelativePosition).toBeUndefined();
  });

  it("does not divide by a zero zone scale", () => {
    const degenerate: HueZone = { ...ZONE, scaleX: 0, scaleY: 0 };
    const moved = moveHueChannelToWorld(BOUND, [degenerate], 0.2, 0.2);
    expect(moved.x).toBe(0.2);
    expect(Number.isFinite(moved.zoneRelativePosition?.x ?? 0)).toBe(true);
  });

  it("clamps a move that would leave the zone box", () => {
    const moved = moveHueChannelToWorld(BOUND, [ZONE], 1, 1);
    expect(moved.zoneRelativePosition?.x).toBe(1);
    expect(moved.zoneRelativePosition?.y).toBe(1);
  });
});

describe("nudgeHueChannel", () => {
  it("moves a bound channel by a world delta, which the old code could not do", () => {
    const before = resolveHueChannelWorld(BOUND, [ZONE]);
    const after = resolveHueChannelWorld(nudgeHueChannel(BOUND, [ZONE], 0.05, 0), [ZONE]);
    // Writing ch.x directly left the rendered position untouched.
    expect(after.x - before.x).toBeCloseTo(0.05, 10);
    expect(after.y).toBeCloseTo(before.y, 10);
  });

  it("moves an unbound channel by the same world delta", () => {
    expect(nudgeHueChannel(FREE, [ZONE], 0.05, -0.05)).toMatchObject({
      x: expect.closeTo(0.15, 10),
      y: expect.closeTo(0.15, 10),
    });
  });
});
