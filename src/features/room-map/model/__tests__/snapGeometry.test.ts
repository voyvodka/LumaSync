import { describe, it, expect } from "vitest";
import type { FurniturePlacement, RoomMapConfig } from "@/shared/contracts/roomMap";
import { DEFAULT_ROOM_MAP } from "@/shared/contracts/roomMap";
import {
  computeSnap,
  getObjectRects,
  SNAP_THRESHOLD_M,
  type ObjectRect,
} from "../snapGeometry";

function configWith(overrides: Partial<RoomMapConfig>): RoomMapConfig {
  return { ...DEFAULT_ROOM_MAP, ...overrides };
}

function furniture(
  id: string,
  x: number,
  y: number,
  width: number,
  height: number,
): FurniturePlacement {
  return { id, type: "sofa", x, y, width, height };
}

describe("getObjectRects", () => {
  it("always contributes the room centre as a zero-size origin rect", () => {
    const rects = getObjectRects(
      configWith({
        dimensions: { widthMeters: 6, depthMeters: 4, heightMeters: 2.5 },
        furniture: [],
        tvAnchor: undefined,
      }),
      "",
    );

    expect(rects).toEqual([{ id: "__origin", x: 3, y: 2, w: 0, h: 0 }]);
  });

  it("excludes the dragged object so it cannot snap to itself", () => {
    const config = configWith({
      furniture: [furniture("a", 1, 1, 2, 1), furniture("b", 4, 1, 2, 1)],
      tvAnchor: undefined,
    });

    const ids = getObjectRects(config, "furniture-a").map((r) => r.id);

    expect(ids).toContain("furniture-b");
    expect(ids).not.toContain("furniture-a");
  });

  it("excludes the TV anchor under its bare `tv` id, not a prefixed one", () => {
    const config = configWith({
      furniture: [],
      tvAnchor: { x: 1, y: 0, width: 1.2, height: 0.7 },
    });

    expect(getObjectRects(config, "tv").map((r) => r.id)).not.toContain("tv");
    expect(getObjectRects(config, "furniture-tv").map((r) => r.id)).toContain("tv");
  });
});

describe("computeSnap", () => {
  const dragging: ObjectRect = { id: "d", x: 1, y: 1, w: 2, h: 1 };

  it("returns no snap when every candidate is beyond the threshold", () => {
    const result = computeSnap(
      dragging,
      [{ id: "o", x: 5, y: 5, w: 1, h: 1 }],
      SNAP_THRESHOLD_M,
    );

    expect(result).toEqual({ snapX: null, snapY: null, guides: [] });
  });

  it("aligns left edges and reports the target edge as the guide position", () => {
    // The target is deliberately much wider, so left↔left is the only pair in range.
    const result = computeSnap(
      dragging,
      [{ id: "o", x: 1.05, y: 9, w: 5, h: 1 }],
      SNAP_THRESHOLD_M,
    );

    expect(result.snapX).toBeCloseTo(1.05);
    expect(result.snapY).toBeNull();
    expect(result.guides).toEqual([{ axis: "x", position: 1.05 }]);
  });

  it("aligns the dragged left edge to another object's right edge", () => {
    const result = computeSnap(
      dragging,
      [{ id: "o", x: 0, y: 9, w: 0.97, h: 1 }],
      SNAP_THRESHOLD_M,
    );

    expect(result.snapX).toBeCloseTo(0.97);
    expect(result.guides).toContainEqual({ axis: "x", position: 0.97 });
  });

  it("aligns centres on both axes at once", () => {
    // dragging centre is (2, 1.5); target centre is (2.02, 1.52)
    const result = computeSnap(
      dragging,
      [{ id: "o", x: 1.52, y: 1.27, w: 1, h: 0.5 }],
      SNAP_THRESHOLD_M,
    );

    expect(result.snapX).toBeCloseTo(1.02);
    expect(result.snapY).toBeCloseTo(1.02);
    expect(result.guides.some((g) => g.axis === "x")).toBe(true);
    expect(result.guides.some((g) => g.axis === "y")).toBe(true);
  });

  it("keeps the closest candidate when two objects both fall inside the threshold", () => {
    const result = computeSnap(
      dragging,
      [
        { id: "far", x: 1.07, y: 9, w: 1, h: 1 },
        { id: "near", x: 1.01, y: 9, w: 1, h: 1 },
      ],
      SNAP_THRESHOLD_M,
    );

    expect(result.snapX).toBeCloseTo(1.01);
    expect(result.guides.filter((g) => g.axis === "x")).toEqual([
      { axis: "x", position: 1.01 },
    ]);
  });

  it("keeps an x guide alive while a later y match resets the guide list", () => {
    const result = computeSnap(
      dragging,
      [{ id: "o", x: 1.02, y: 1.02, w: 5, h: 5 }],
      SNAP_THRESHOLD_M,
    );

    expect(result.guides).toEqual([
      { axis: "x", position: 1.02 },
      { axis: "y", position: 1.02 },
    ]);
  });

  it("treats the threshold as exclusive — a difference exactly at it does not snap", () => {
    // Integers only: a fractional threshold would make the boundary a float-rounding test.
    const result = computeSnap({ id: "d", x: 1, y: 1, w: 2, h: 1 }, [
      { id: "o", x: 2, y: 20, w: 2, h: 1 },
    ], 1);

    expect(result.snapX).toBeNull();
  });

  it("snaps to the zero-size origin rect like any other candidate", () => {
    const origin: ObjectRect = { id: "__origin", x: 3, y: 2, w: 0, h: 0 };
    const result = computeSnap({ id: "d", x: 2.97, y: 9, w: 1, h: 1 }, [origin], SNAP_THRESHOLD_M);

    expect(result.snapX).toBeCloseTo(3);
    expect(result.guides).toContainEqual({ axis: "x", position: 3 });
  });
});
