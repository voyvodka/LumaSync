import { Box3, type BufferAttribute, type BufferGeometry } from "three";
import { describe, expect, it } from "vitest";

import { DEFAULT_ROOM_MAP, type RoomMapConfig, type RoomStructure } from "@/shared/contracts/roomMap";

import { roomEdges } from "../../../model/roomOutline";
import { floorParts, openRuns, wallFootShade } from "../environment";
import { PALETTE } from "../palette";
import { decorLights, doorGaps, gappedWallGeometry, openingsTop, planStructures, thresholds } from "../structures";

const room = (structures: RoomStructure[]): RoomMapConfig => ({ ...DEFAULT_ROOM_MAP, structures });
const edges = roomEdges(5, 4, null);
const door: RoomStructure = { id: "d", kind: "door", x: 2.5, y: 0, width: 0.9, heightMeters: 2.05, hinge: "left", swing: "in" };
const window_: RoomStructure = { id: "w", kind: "window", x: 0, y: 2, width: 1.2, sillMeters: 0.9, heightMeters: 1.2 };

describe("planStructures", () => {
  it("cuts a door's gap in its wall and draws its leaf on that wall", () => {
    const plan = planStructures(room([door]), edges, "warmWhite", 1.75);
    const tvWall = edges.findIndex((e) => e.outwardZ < 0);
    expect([...plan.gaps.keys()]).toEqual([tvWall]);
    expect(plan.gaps.get(tvWall)![0]!.from).toBeCloseTo(-0.45);
    expect(plan.gaps.get(tvWall)![0]!.to).toBeCloseTo(0.45);
    expect(plan.wallParts.get(tvWall)?.length).toBeGreaterThan(0);
  });

  it("draws a window on its wall's inner face, under the walls' top, and cuts no gap for it", () => {
    const plan = planStructures(room([window_]), edges, "warmWhite", 2.25);
    const left = edges.findIndex((e) => e.outwardX < 0);
    expect(plan.gaps.size).toBe(0);
    const box = new Box3();
    for (const part of plan.wallParts.get(left)!) {
      part.geometry.computeBoundingBox();
      box.union(part.geometry.boundingBox!);
    }
    expect(box.min.x).toBeGreaterThanOrEqual(-2.5 - 1e-6);
    expect(box.max.y).toBeLessThanOrEqual(2.25);
    expect(box.max.y).toBeCloseTo(2.1, 2);
  });

  // A window over the walls' 70% notched them in the first sketch; the walls stand above it instead.
  it("asks the walls to stand above the tallest window or niche", () => {
    expect(openingsTop(room([window_]))).toBeCloseTo(2.25);
    expect(openingsTop(room([door]))).toBe(0);
  });

  it("leaves columns and beams to be built whole, and a kind it does not know undrawn", () => {
    const plan = planStructures(
      room([
        { id: "c", kind: "column", x: 1, y: 1, width: 0.4, depth: 0.4 },
        { id: "b", kind: "beam", x1: 1, y1: 0, x2: 1, y2: 4, width: 0.2, dropMeters: 0.3 },
        { id: "s", kind: "skylight" } as never,
      ]),
      edges,
      "warmWhite",
      1.75,
    );
    expect(plan.columns.map((c) => c.id)).toEqual(["c"]);
    expect(plan.beams.map((b) => b.id)).toEqual(["b"]);
    expect(plan.wallParts.size).toBe(0);
  });
});

describe("decorLights", () => {
  it("hangs each light where its fixture hangs, or its drop below the ceiling, in its own white", () => {
    const lights = decorLights(
      room([
        { id: "p", kind: "light", x: 1, y: 1, fixture: "pendant" },
        { id: "s", kind: "light", x: 2, y: 1, fixture: "spot", dropMeters: 0.4, kelvin: 6500 },
      ]),
      2.7,
    );
    expect(lights[0]!.height).toBeLessThan(2.7);
    expect(lights[1]!.height).toBeCloseTo(2.3);
    const blue = (c: number) => c & 0xff;
    const red = (c: number) => c >> 16;
    expect(red(lights[0]!.colour)).toBeGreaterThan(blue(lights[0]!.colour));
    expect(blue(lights[1]!.colour)).toBeGreaterThan(blue(lights[0]!.colour));
  });
});

describe("gappedWallGeometry", () => {
  it("leaves the gap open and keeps the wall's length either side", () => {
    const geometry = gappedWallGeometry(true, 5, 0, [{ from: -0.45, to: 0.45 }], 0.1, "warmWhite")!;
    const xs = Array.from((geometry.getAttribute("position") as BufferAttribute).array).filter((_, i) => i % 3 === 0);
    expect(xs.some((x) => x > -0.44 && x < 0.44)).toBe(false);
    expect(Math.min(...xs)).toBeCloseTo(-2.5);
    expect(Math.max(...xs)).toBeCloseTo(2.5);
    expect(geometry.getAttribute("color")).toBeDefined();
  });
});

describe("a door's gap at the wall's foot", () => {
  const tvWall = edges.findIndex((e) => e.outwardZ < 0);
  const gaps = doorGaps(room([door]), edges);
  it("runs the skirting and the foot shade either side of a door and not across it", () => {
    expect(openRuns(-2.5, 2.5, gaps.get(tvWall))).toEqual([
      [-2.5, -0.45],
      [0.45, 2.5],
    ]);
    const acrossDoorway = (g?: typeof gaps) =>
      floorParts(5, 4, null, edges, "oak", g).filter((part) => {
        if (part.color !== PALETTE.skirting) return false;
        const box = new Box3().setFromBufferAttribute(part.geometry.getAttribute("position") as BufferAttribute);
        return box.min.x < 0 && box.max.x > 0 && box.max.z < -1.9;
      }).length;
    expect(acrossDoorway(gaps)).toBe(0);
    expect(acrossDoorway()).toBe(1);
    // Where the shade's quads start or end along the TV wall's middle stretch: the door's jambs.
    const ends = (shade: BufferGeometry) => {
      const position = shade.getAttribute("position") as BufferAttribute;
      const xs = new Set<number>();
      for (let i = 0; i < position.count; i++) if (Math.abs(position.getZ(i) + 2) < 1e-6 && Math.abs(position.getX(i)) < 2) xs.add(Math.round(position.getX(i) * 100) / 100);
      return [...xs].sort((a, b) => a - b);
    };
    expect(ends(wallFootShade(edges, gaps))).toEqual([-0.45, 0.45]);
    expect(ends(wallFootShade(edges))).toEqual([]);
  });

  it("lays a sill across the doorway the wall's depth, outside the room", () => {
    const [sill] = thresholds(gaps, edges);
    const box = new Box3().setFromBufferAttribute(sill!.geometry.getAttribute("position") as BufferAttribute);
    expect(box.min.x).toBeCloseTo(-0.45);
    expect(box.max.x).toBeCloseTo(0.45);
    expect(box.max.z).toBeCloseTo(-2);
    expect(box.min.z).toBeCloseTo(-2.1);
  });
});
