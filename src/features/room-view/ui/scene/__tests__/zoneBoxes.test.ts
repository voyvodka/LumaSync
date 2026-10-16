import { LineSegments, Mesh, MeshBasicMaterial } from "three";
import { describe, expect, it } from "vitest";

import type { HueZone } from "@/shared/contracts/roomMap";

import { buildZoneBoxes } from "../zoneBoxes";

const dims = { widthMeters: 5, depthMeters: 4, heightMeters: 2.5 };
const zone = (id: string): HueZone => ({ id, name: `Zone ${id}`, entertainmentAreaId: "x", centerX: 0, centerY: 0, centerZ: 0, scaleX: 0.5, scaleY: 0.5, scaleZ: 0.5, channelIndices: [] });

const parts = (boxes: ReturnType<typeof buildZoneBoxes>, i: number) => {
  const one = boxes.group.children[i]!;
  const [fill, edges, label] = one.children as [Mesh, LineSegments, Mesh];
  return { one, fill, edges, label };
};

describe("buildZoneBoxes", () => {
  it("shows nothing until a zone is marked", () => {
    const boxes = buildZoneBoxes([zone("a"), zone("b")], dims);
    expect(boxes.group.visible).toBe(false);
    expect(boxes.mark(null)).toBe(false);
  });

  it("draws the zone being edited named and brighter, the others faint and unnamed", () => {
    const boxes = buildZoneBoxes([zone("a"), zone("b"), zone("c")], dims);
    expect(boxes.mark({ active: "a", others: ["b"] })).toBe(true);
    const a = parts(boxes, 0);
    const b = parts(boxes, 1);
    expect(boxes.group.visible).toBe(true);
    expect([a.one.visible, b.one.visible, parts(boxes, 2).one.visible]).toEqual([true, true, false]);
    expect(a.label.visible).toBe(true);
    expect(b.label.visible).toBe(false);
    expect((a.fill.material as MeshBasicMaterial).opacity).toBeGreaterThan((b.fill.material as MeshBasicMaterial).opacity);
    expect(boxes.mark({ active: "a", others: ["b"] })).toBe(false);
  });

  it("keeps the name one size on screen, over the box's top", () => {
    const boxes = buildZoneBoxes([zone("a")], dims);
    boxes.mark({ active: "a", others: [] });
    const { label } = parts(boxes, 0);
    boxes.setPixelsPerMetre(100);
    const near = label.scale.y;
    boxes.setPixelsPerMetre(50);
    expect(label.scale.y).toBeCloseTo(near * 2);
    // Half the zone's 1.25 m height, and the lift.
    expect(label.position.y).toBeGreaterThan(0.625);
  });

  it("is outlined in the zone's colour", () => {
    const boxes = buildZoneBoxes([{ ...zone("a"), borderColor: "var(--lm-zone-2)" }], dims);
    const { edges } = parts(boxes, 0);
    expect((edges.material as MeshBasicMaterial).color.getHexString()).toBe("10b981");
  });
});
