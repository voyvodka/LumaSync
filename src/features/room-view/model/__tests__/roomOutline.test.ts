import { describe, expect, it } from "vitest";

import { cornerCoordinates, insideAlong, nearestWallFacing, nearestWallFacingDegrees, outlineCorners, type PlanCorner, roomEdges } from "../roomOutline";

// An L: a 4 × 4 m room with the 2 × 2 m back-right quarter cut away.
const L: PlanCorner[] = [
  { x: 0, y: 0 },
  { x: 4, y: 0 },
  { x: 4, y: 2 },
  { x: 2, y: 2 },
  { x: 2, y: 4 },
  { x: 0, y: 4 },
];

describe("roomEdges", () => {
  it("walks the plain rectangle with every wall facing out and every corner wrapped", () => {
    const edges = roomEdges(5, 4, null);
    expect(edges.map((e) => [e.outwardX, e.outwardZ])).toEqual([
      [0, -1],
      [1, 0],
      [0, 1],
      [-1, 0],
    ]);
    expect(edges.map((e) => e.length)).toEqual([5, 4, 5, 4]);
    expect(edges.every((e) => e.convexA && e.convexB)).toBe(true);
    // Scene coordinates centre the room on the origin.
    expect(edges[0]).toMatchObject({ ax: -2.5, az: -2, bx: 2.5, bz: -2 });
  });

  it("finds the one corner an L turns inward at, whichever way it was drawn", () => {
    for (const corners of [L, [...L].reverse()]) {
      const edges = roomEdges(4, 4, corners);
      expect(edges).toHaveLength(6);
      const concave = edges.flatMap((e) => [
        ...(e.convexA ? [] : [[e.ax, e.az]]),
        ...(e.convexB ? [] : [[e.bx, e.bz]]),
      ]);
      // (2, 2) on the plan is the origin of the 4 × 4 scene; it ends one wall and starts the next.
      expect(concave).toEqual([
        [0, 0],
        [0, 0],
      ]);
      // Every normal points away from the room: a step out from an edge's middle leaves it.
      for (const e of edges) {
        const mx = (e.ax + e.bx) / 2 + e.outwardX * 0.1 + 2;
        const my = (e.az + e.bz) / 2 + e.outwardZ * 0.1 + 2;
        expect(insideAlong(4, 4, corners, true, my).some(([a, b]) => mx > a && mx < b)).toBe(false);
      }
    }
  });

  it("keeps the order it was given when the winding is already right", () => {
    expect(outlineCorners(4, 4, L)).toEqual(L);
    // Drawn the other way round, the walk is turned back: the same corners, the same way as L.
    expect(outlineCorners(4, 4, [...L].reverse())).toEqual(L);
  });
});

describe("insideAlong", () => {
  it("gives the room's extent across a line, notch included", () => {
    expect(insideAlong(4, 4, L, true, 1)).toEqual([[0, 4]]);
    expect(insideAlong(4, 4, L, true, 3)).toEqual([[0, 2]]);
    expect(insideAlong(4, 4, L, false, 3)).toEqual([[0, 2]]);
    expect(insideAlong(4, 4, null, true, 3)).toEqual([[0, 4]]);
  });

  it("names the lines where the inside can change", () => {
    expect(cornerCoordinates(4, 4, L, true)).toEqual([0, 2, 4]);
    expect(cornerCoordinates(5, 4, null, false)).toEqual([0, 4]);
  });

  // The user's Play bar lights the wall it is turned to; drawn lighting the room all round, it was wrong.
  it("turns a one-sided light to the wall it stands nearest", () => {
    const edges = roomEdges(4, 3, null);
    expect(nearestWallFacing(-1.9, 0, edges)).toBeCloseTo(-Math.PI / 2);
    expect(nearestWallFacing(1.9, 0, edges)).toBeCloseTo(Math.PI / 2);
    expect(nearestWallFacing(0, -1.4, edges)).toBeCloseTo(0);
    expect(Math.abs(nearestWallFacing(0, 1.4, edges))).toBeCloseTo(Math.PI);
  });
  it("names the nearest wall in the degrees the map stores", () => {
    expect(nearestWallFacingDegrees(0.1, 1.5, 4, 3, null)).toBe(270);
    expect(nearestWallFacingDegrees(2, 0.2, 4, 3, null)).toBe(0);
    expect(nearestWallFacingDegrees(3.9, 1.5, 4, 3, null)).toBe(90);
  });
});
