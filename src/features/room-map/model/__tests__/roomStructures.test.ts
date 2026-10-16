import { describe, expect, it } from "vitest";

import { DEFAULT_ROOM_DIMENSIONS } from "@/shared/contracts/roomMap";

import { resizeRoomFromSide } from "../roomResize";
import { anchorWallItem, moveStructures } from "../roomStructures";

const room = { dimensions: DEFAULT_ROOM_DIMENSIONS };

describe("anchorWallItem", () => {
  it("sets an item in the wall nearest it, on the room's side", () => {
    const tv = anchorWallItem({ x: 2, y: 0.2, width: 1 }, room)!;
    expect(tv).toMatchObject({ alongX: true, at: 0, centre: 2, width: 1, inward: 1 });
    const back = anchorWallItem({ x: 2, y: 3.9, width: 1 }, room)!;
    expect(back).toMatchObject({ alongX: true, at: 4, inward: -1 });
    const right = anchorWallItem({ x: 4.8, y: 2, width: 0.9 }, room)!;
    expect(right).toMatchObject({ alongX: false, at: 5, centre: 2, inward: -1 });
  });

  it("moves an item in from a corner so its whole width fits, and cuts one wider than the wall", () => {
    expect(anchorWallItem({ x: 0.1, y: 0, width: 1 }, room)!.centre).toBeCloseTo(0.5);
    expect(anchorWallItem({ x: 2, y: 0, width: 9 }, room)!.width).toBe(5);
  });

  // In the notch of an L, the point is in front of no wall: it takes the one whose end is nearest.
  it("takes the nearest wall's end for a point in front of none", () => {
    const footprint = [
      { x: 0, y: 0 },
      { x: 3, y: 0 },
      { x: 3, y: 2 },
      { x: 5, y: 2 },
      { x: 5, y: 4 },
      { x: 0, y: 4 },
    ];
    const anchor = anchorWallItem({ x: 3.6, y: 1.2, width: 0.8 }, { dimensions: DEFAULT_ROOM_DIMENSIONS, footprint })!;
    expect([anchor.alongX, anchor.at]).toEqual([false, 3]);
    expect(anchor.inward).toBe(-1);
  });
});

describe("moveStructures", () => {
  it("moves every structure's points, a kind this build does not know included, and nothing else", () => {
    const stored = [
      { id: "c", kind: "column", x: 1, y: 1, width: 0.3, depth: 0.3 },
      { id: "b", kind: "beam", x1: 0, y1: 1, x2: 5, y2: 1, width: 0.2, dropMeters: 0.3 },
      { id: "s", kind: "skylight", x: 2, y: 2, glazing: "triple" },
    ];
    expect(moveStructures(stored, { x: 0.5, y: -0.25 }, room, room)).toEqual([
      { id: "c", kind: "column", x: 1.5, y: 0.75, width: 0.3, depth: 0.3 },
      { id: "b", kind: "beam", x1: 0.5, y1: 0.75, x2: 5.5, y2: 0.75, width: 0.2, dropMeters: 0.3 },
      { id: "s", kind: "skylight", x: 2.5, y: 1.75, glazing: "triple" },
    ]);
    expect(moveStructures(undefined, { x: 1, y: 1 }, room, room)).toBeUndefined();
  });

  // Left where it stood, a window on a wall pulled 3 m out is nearer another wall and jumps to it.
  it("keeps a window on its wall when that wall is pulled out or the room is resized about its middle", () => {
    const window = { id: "w", kind: "window", x: 5, y: 2, width: 1, sillMeters: 0.9, heightMeters: 1.2 };
    for (const side of ["right", "left"] as const) {
      const next = resizeRoomFromSide(room.dimensions, undefined, side, 3)!;
      const [moved] = moveStructures([window], next.shift, room, next) as [typeof window];
      expect(moved.x).toBe(8);
      expect(anchorWallItem(moved, next)).toMatchObject({ edge: 1, alongX: false, at: 8, centre: 2 });
    }
    const wider = { dimensions: { ...room.dimensions, widthMeters: 7, depthMeters: 6 } };
    const [moved] = moveStructures([window], { x: 1, y: 1 }, room, wider) as [typeof window];
    expect([moved.x, moved.y]).toEqual([7, 3]);
  });
});
