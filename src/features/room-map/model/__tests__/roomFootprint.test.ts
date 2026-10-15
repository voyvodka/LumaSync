import { describe, expect, it } from "vitest";

import { resolveRoomFootprint } from "@/shared/contracts/roomMap";

import {
  buildFootprint,
  clampFootprintShape,
  defaultFootprintShape,
  describeFootprint,
  FOOTPRINT_CORNERS,
  FOOTPRINT_SIDES,
  type FootprintShape,
  footprintMinimumSize,
  movableWalls,
  moveFootprintWall,
  moveFootprintWallClamped,
  notchAt,
  outsideOutline,
  resizeFootprint,
} from "../roomFootprint";

const dims = { widthMeters: 5, depthMeters: 4, heightMeters: 2.5 };

describe("buildFootprint and describeFootprint", () => {
  const shapes: FootprintShape[] = [
    ...FOOTPRINT_CORNERS.map((corner) => ({ kind: "L" as const, corner, width: 2, depth: 1.5 })),
    ...FOOTPRINT_SIDES.map((side) => ({ kind: "U" as const, side, width: 1.2, depth: 1, offset: 1.4 })),
    ...FOOTPRINT_SIDES.map((side) => ({ kind: "T" as const, side, width: 1.2, depth: 2, offset: 1 })),
  ];

  it.each(shapes.map((s) => [`${s.kind} ${"corner" in s ? s.corner : "side" in s ? s.side : ""}`, s] as const))(
    "builds %s into an outline the contract keeps, and reads it back as itself",
    (_name, shape) => {
      const corners = buildFootprint(shape, dims);
      expect(corners).toBeDefined();
      expect(resolveRoomFootprint({ dimensions: dims, footprint: corners })).toEqual(corners);
      expect(describeFootprint(corners, dims)).toEqual(shape);
    },
  );

  it("cuts an L from the corner it names", () => {
    expect(buildFootprint({ kind: "L", corner: "bottomRight", width: 2, depth: 1.5 }, dims)).toEqual([
      { x: 0, y: 0 },
      { x: 5, y: 0 },
      { x: 5, y: 2.5 },
      { x: 3, y: 2.5 },
      { x: 3, y: 4 },
      { x: 0, y: 4 },
    ]);
  });

  it("opens a U's notch in the wall it names, and reaches a T's stem to it", () => {
    const u = buildFootprint({ kind: "U", side: "bottom", width: 1, depth: 1, offset: 2 }, dims) ?? [];
    expect(u).toContainEqual({ x: 2, y: 3 });
    expect(u).toContainEqual({ x: 3, y: 4 });
    const t = buildFootprint({ kind: "T", side: "bottom", width: 1, depth: 2, offset: 2 }, dims) ?? [];
    expect(t).toContainEqual({ x: 2, y: 4 });
    expect(t).toContainEqual({ x: 0, y: 2 });
  });

  it("stores nothing for the rectangle", () => {
    expect(buildFootprint({ kind: "rect" }, dims)).toBeUndefined();
    expect(describeFootprint(undefined, dims)).toEqual({ kind: "rect" });
  });

  it("names an outline it cannot make as custom", () => {
    // Two cuts at opposite corners: a valid outline, but no shape this editor offers.
    const z = [
      { x: 1, y: 0 },
      { x: 5, y: 0 },
      { x: 5, y: 3 },
      { x: 4, y: 3 },
      { x: 4, y: 4 },
      { x: 0, y: 4 },
      { x: 0, y: 1 },
      { x: 1, y: 1 },
    ];
    expect(describeFootprint(z, dims)).toEqual({ kind: "custom" });
  });

  it("keeps every wall at least 10 cm whatever is typed", () => {
    const tooBig = clampFootprintShape({ kind: "L", corner: "topLeft", width: 9, depth: 0 }, dims);
    expect(tooBig).toEqual({ kind: "L", corner: "topLeft", width: 4.9, depth: 0.1 });
    const notch = clampFootprintShape({ kind: "U", side: "top", width: 5, depth: 1, offset: 0 }, dims);
    expect(notch).toMatchObject({ width: 4.8, offset: 0.1 });
    expect(buildFootprint(notch, dims)).toBeDefined();
  });

  it("offers each shape at a size that reads at once", () => {
    for (const kind of ["L", "U", "T"] as const) {
      expect(buildFootprint(defaultFootprintShape(kind, dims), dims)).toBeDefined();
    }
  });
});

describe("resizeFootprint", () => {
  const L = buildFootprint({ kind: "L", corner: "bottomRight", width: 2, depth: 1.5 }, dims);

  it("keeps corners on the room's edges and moves the inner one by half the growth", () => {
    const grown = resizeFootprint(L, dims, { ...dims, widthMeters: 7 });
    expect(grown).toEqual([
      { x: 0, y: 0 },
      { x: 7, y: 0 },
      { x: 7, y: 2.5 },
      { x: 4, y: 2.5 },
      { x: 4, y: 4 },
      { x: 0, y: 4 },
    ]);
  });

  it("has nothing to move for the rectangle, and gives up an outline the new size cannot hold", () => {
    expect(resizeFootprint(undefined, dims, { ...dims, widthMeters: 7 })).toBeUndefined();
    // The inner corner at x 3 is 0.5 m right of the centre; a 1 m room puts it past the edge.
    expect(resizeFootprint(L, dims, { ...dims, widthMeters: 1 })).toBeUndefined();
  });

  it("leaves the outline alone on a height-only change", () => {
    expect(resizeFootprint(L, dims, { ...dims, heightMeters: 3 })).toEqual(L);
  });
});

describe("footprintMinimumSize", () => {
  it("is what keeps every inner corner's walls at least 10 cm", () => {
    const L = buildFootprint({ kind: "L", corner: "bottomRight", width: 2, depth: 1.5 }, dims);
    // Inner x 3 sits 0.5 m off centre, inner y 2.5 sits 0.5 m off centre.
    expect(footprintMinimumSize(L, dims)).toEqual({ widthMeters: 1.2, depthMeters: 1.2 });
    const atMinimum = resizeFootprint(L, dims, { ...dims, widthMeters: 1.2, depthMeters: 1.2 });
    expect(atMinimum).toHaveLength(6);
  });

  it("asks nothing of the rectangle", () => {
    expect(footprintMinimumSize(undefined, dims)).toEqual({ widthMeters: 0, depthMeters: 0 });
  });
});

describe("dragging and notching the outline", () => {
  const L = buildFootprint({ kind: "L", corner: "bottomRight", width: 2, depth: 1.5 }, dims) ?? [];

  it("offers only the walls inside the room's box", () => {
    const walls = movableWalls(L, dims);
    expect(walls.map((w) => [w.axis, w.a, w.b])).toEqual([
      ["y", { x: 5, y: 2.5 }, { x: 3, y: 2.5 }],
      ["x", { x: 3, y: 2.5 }, { x: 3, y: 4 }],
    ]);
    expect(movableWalls(resolveRoomFootprint({ dimensions: dims }), dims)).toEqual([]);
  });

  it("moves a wall to the centimetre, and stops where the outline would break", () => {
    const [level] = movableWalls(L, dims);
    expect(moveFootprintWall(L, dims, level!.index, 0.504)).toContainEqual({ x: 3, y: 3 });
    // Down onto the back wall would leave a zero-length wall.
    expect(moveFootprintWall(L, dims, level!.index, 1.5)).toBeNull();
  });

  it("lands a drag past the limit on the last good centimetre instead of freezing short of it", () => {
    const [level] = movableWalls(L, dims);
    const landed = moveFootprintWallClamped(L, dims, level!.index, 1.5);
    const y = landed!.find((c) => c.x === 5 && c.y > 2.5 && c.y < 4)!.y;
    // A wall keeps 10 cm, so the cut's floor stops 10 cm short of the back wall.
    expect(y).toBeCloseTo(3.9, 5);
    expect(moveFootprintWallClamped(L, dims, level!.index, 0.5)).toEqual(moveFootprintWall(L, dims, level!.index, 0.5));
  });

  it("cuts a notch into a rectangle where it was double-clicked, and not into a shaped room", () => {
    const rect = resolveRoomFootprint({ dimensions: dims });
    expect(describeFootprint(notchAt(rect, dims, "bottom", 1), dims)).toEqual({
      kind: "U",
      side: "bottom",
      width: 0.6,
      depth: 0.4,
      offset: 0.7,
    });
    expect(notchAt(L, dims, "bottom", 1)).toBeUndefined();
  });
});

describe("outsideOutline", () => {
  const L = buildFootprint({ kind: "L", corner: "bottomRight", width: 2, depth: 1.5 }, dims) ?? [];

  it("finds a point in the cut-away corner outside, and one in the room inside", () => {
    expect(outsideOutline(4, 3.5, L)).toBe(true);
    expect(outsideOutline(1, 3.5, L)).toBe(false);
    expect(outsideOutline(4, 1, L)).toBe(false);
  });

  it("counts a point on a wall as inside, and nothing as outside a plain room", () => {
    expect(outsideOutline(3, 3, L)).toBe(false);
    expect(outsideOutline(4, 2.5, L)).toBe(false);
    expect(outsideOutline(4.9, 3.9, resolveRoomFootprint({ dimensions: dims }))).toBe(false);
  });
});
