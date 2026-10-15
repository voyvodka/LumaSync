import { describe, expect, it } from "vitest";

import type { RoomMapConfig, UsbStripPlacement } from "@/shared/contracts/roomMap";

import { nearestWall, stickStripToWall, WALL_INSET_M } from "../stripWall";

const room: Pick<RoomMapConfig, "footprint" | "dimensions"> = { dimensions: { widthMeters: 5, depthMeters: 4, heightMeters: 2.6 } };
const strip = (startX: number, startY: number, endX: number, endY: number): UsbStripPlacement => ({
  stripId: "s",
  startX,
  startY,
  endX,
  endY,
  ledCount: 60,
});

describe("nearestWall", () => {
  it("finds the wall a point stands nearest", () => {
    expect(nearestWall(room, 2, 0.3)).toMatchObject({ alongX: true, at: 0 });
    expect(nearestWall(room, 4.8, 2)).toMatchObject({ alongX: false, at: 5 });
  });
});

describe("stickStripToWall", () => {
  // The maintainer's strip ran across the middle of the floor, a metre off the wall it was meant for.
  it("lays a strip along its nearest wall, just inside it, at its length", () => {
    const stuck = stickStripToWall(strip(1, 0.6, 3, 0.9), room);
    expect(stuck?.startY).toBe(WALL_INSET_M);
    expect(stuck?.endY).toBe(WALL_INSET_M);
    expect((stuck?.endX ?? 0) - (stuck?.startX ?? 0)).toBeCloseTo(Math.hypot(2, 0.3), 2);
  });

  it("keeps the way the strip runs and holds it inside the wall's span", () => {
    const stuck = stickStripToWall(strip(4.9, 3.5, 4.7, 0.5), room);
    expect(stuck).toMatchObject({ startX: 5 - WALL_INSET_M, endX: 5 - WALL_INSET_M });
    expect(stuck!.startY).toBeGreaterThan(stuck!.endY);
    expect(Math.max(stuck!.startY, stuck!.endY)).toBeLessThanOrEqual(4);
  });

  it("cuts a strip longer than its wall to the wall", () => {
    const stuck = stickStripToWall(strip(-1, 0.2, 6, 0.2), room);
    expect(stuck).toMatchObject({ startX: 0, endX: 5 });
  });

  it("has nothing to do for a strip already on the wall", () => {
    expect(stickStripToWall(strip(1, WALL_INSET_M, 3, WALL_INSET_M), room)).toBeNull();
  });

  it("takes the inner side of the wall for a strip lying on its line", () => {
    expect(stickStripToWall(strip(1, 4, 3, 4), room)).toMatchObject({ startY: 4 - WALL_INSET_M });
  });
});
