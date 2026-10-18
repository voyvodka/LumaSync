import { describe, expect, it } from "vitest";

import { buildFootprint } from "../roomFootprint";
import { ROOM_SIDE_MIN_M, resizeRoomFromSide } from "../roomResize";

const dims = { widthMeters: 5, depthMeters: 4, heightMeters: 2.5 };

describe("resizeRoomFromSide", () => {
  it("grows from the right wall with nothing in the room moving", () => {
    expect(resizeRoomFromSide(dims, undefined, "right", 1.2)).toEqual({
      dimensions: { ...dims, widthMeters: 6.2 },
      footprint: undefined,
      shift: { x: 0, y: 0 },
    });
  });

  it("grows from the left wall by moving the room's contents with it", () => {
    expect(resizeRoomFromSide(dims, undefined, "left", 0.5)?.shift).toEqual({ x: 0.5, y: 0 });
  });

  it("stops at the smallest room", () => {
    const next = resizeRoomFromSide(dims, undefined, "bottom", -10);
    expect(next?.dimensions.depthMeters).toBe(ROOM_SIDE_MIN_M);
    expect(next?.shift).toEqual({ x: 0, y: 0 });
  });

  it("keeps an L's cut where it stands while the far wall moves", () => {
    const L = buildFootprint({ kind: "L", corner: "bottomRight", width: 2, depth: 1.5 }, dims);
    const next = resizeRoomFromSide(dims, L, "left", 1);
    // The step's inner corner was at (3, 2.5); the room grew a metre to the left, so it is at 4.
    expect(next?.footprint).toContainEqual({ x: 4, y: 2.5 });
    expect(next?.dimensions.widthMeters).toBe(6);
  });

  it("refuses a pull that would break the outline", () => {
    const L = buildFootprint({ kind: "L", corner: "bottomRight", width: 2, depth: 1.5 }, dims);
    expect(resizeRoomFromSide(dims, L, "right", -2)).toBeNull();
  });
});
