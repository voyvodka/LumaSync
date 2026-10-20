import { describe, expect, it } from "vitest";

import { furnitureObjectId, TV_ANCHOR_OBJECT_ID } from "@/features/room-map/model/objectId";
import { DEFAULT_ROOM_MAP, type FurniturePlacement, type RoomMapConfig } from "@/shared/contracts/roomMap";

import { planMorph } from "../templateMorph";

const piece = (id: string, type: FurniturePlacement["type"], x: number, y: number): FurniturePlacement => ({ id, type, x, y, width: 1, height: 1 });
const room = (furniture: FurniturePlacement[], width = 4, depth = 4, tv = false): RoomMapConfig => ({
  ...DEFAULT_ROOM_MAP,
  dimensions: { ...DEFAULT_ROOM_MAP.dimensions, widthMeters: width, depthMeters: depth },
  furniture,
  tvAnchor: tv ? { x: 1.5, y: 0, width: 1, height: 0.1 } : undefined,
});

describe("planMorph", () => {
  it("pairs each kind nearest first, whatever the ids", () => {
    const plan = planMorph(
      room([piece("mine-a", "sofa", 0, 0), piece("mine-b", "sofa", 3, 3)]),
      room([piece("t-1", "sofa", 2.8, 3), piece("t-2", "sofa", 0.5, 0)]),
    );
    expect(plan.matched.map(({ from, to }) => [from.objectId, to.objectId])).toEqual([
      [furnitureObjectId("mine-b"), furnitureObjectId("t-1")],
      [furnitureObjectId("mine-a"), furnitureObjectId("t-2")],
    ]);
    expect(plan.leaving).toEqual([]);
    expect(plan.arriving).toEqual([]);
  });

  it("sends off what the new room has no place for and brings in the rest, nearest the middle first", () => {
    const plan = planMorph(room([piece("bed", "bed", 0, 0)]), room([piece("far", "plant", 0, 0), piece("near", "plant", 1.5, 1.5), piece("rug", "rug", 3, 3)]));
    expect(plan.matched).toEqual([]);
    expect(plan.leaving.map((p) => p.objectId)).toEqual([furnitureObjectId("bed")]);
    expect(plan.arriving.map((p) => p.objectId)).toEqual([furnitureObjectId("near"), furnitureObjectId("far"), furnitureObjectId("rug")]);
  });

  it("measures both rooms from their middles, so a bigger room still pairs a piece at its middle", () => {
    const plan = planMorph(room([piece("a", "table", 1.5, 1.5)], 4, 4, true), room([piece("b", "table", 5.5, 3.5)], 12, 8, true));
    const table = plan.matched.find(({ from }) => from.kind === "table")!;
    expect(table.from.x).toBeCloseTo(table.to.x);
    expect(table.from.z).toBeCloseTo(table.to.z);
    expect(plan.matched.some(({ from }) => from.objectId === TV_ANCHOR_OBJECT_ID)).toBe(true);
  });
});
