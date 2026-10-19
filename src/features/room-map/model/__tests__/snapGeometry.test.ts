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

  it("adds the other lights as points for a light, through their zone, and none for a piece", () => {
    const config = configWith({
      dimensions: { widthMeters: 4, depthMeters: 4, heightMeters: 2.5 },
      furniture: [],
      tvAnchor: undefined,
      zones: [{ id: "z", name: "z", entertainmentAreaId: "a", centerX: 0.5, centerY: 0, centerZ: 0, scaleX: 0.5, scaleY: 0.5, scaleZ: 1, channelIndices: [1] }],
      hueChannels: [
        { channelIndex: 0, x: -1, y: 1, z: 0 },
        { channelIndex: 1, x: 0, y: 0, z: 0, zoneId: "z", zoneRelativePosition: { x: 1, y: 0, z: 0 } },
        { channelIndex: 2, x: 0, y: 0, z: 0 },
      ],
    });
    const lights = getObjectRects(config, "hue-2").filter((r) => r.id.startsWith("hue-"));
    expect(lights).toEqual([
      { id: "hue-0", x: 0, y: 0, w: 0, h: 0 },
      { id: "hue-1", x: 4, y: 2, w: 0, h: 0 },
    ]);
    expect(getObjectRects(config, "furniture-a").some((r) => r.id.startsWith("hue-"))).toBe(false);
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

    expect(result).toEqual({ snapX: null, snapY: null, guides: [], hold: {} });
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
    expect(result.guides).toEqual([{ axis: "x", position: 1.05, kind: "edge" }]);
  });

  it("aligns the dragged left edge to another object's right edge", () => {
    const result = computeSnap(
      dragging,
      [{ id: "o", x: 0, y: 9, w: 0.97, h: 1 }],
      SNAP_THRESHOLD_M,
    );

    expect(result.snapX).toBeCloseTo(0.97);
    expect(result.guides).toContainEqual({ axis: "x", position: 0.97, kind: "edge" });
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
      { axis: "x", position: 1.01, kind: "edge" },
    ]);
  });

  it("keeps an x guide alive while a later y match resets the guide list", () => {
    const result = computeSnap(
      dragging,
      [{ id: "o", x: 1.02, y: 1.02, w: 5, h: 5 }],
      SNAP_THRESHOLD_M,
    );

    expect(result.guides).toEqual([
      { axis: "x", position: 1.02, kind: "edge" },
      { axis: "y", position: 1.02, kind: "edge" },
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
    expect(result.guides).toContainEqual({ axis: "x", position: 3, kind: "centre" });
  });
});

describe("computeSnap — both axes", () => {
  // A closer x match found on a later piece wiped the y guide an earlier one had drawn.
  it("draws a guide for each axis it snaps on, from different pieces", () => {
    const dragging = { id: "d", x: 0.02, y: 5.03, w: 1, h: 1 };
    const level = { id: "a", x: 9, y: 5, w: 1, h: 1 };
    const above = { id: "b", x: 0, y: 0, w: 1, h: 1 };
    const result = computeSnap(dragging, [level, above], 0.1);
    expect(result.snapX).not.toBeNull();
    expect(result.snapY).not.toBeNull();
    expect(new Set(result.guides.map((g) => g.axis))).toEqual(new Set(["x", "y"]));
  });
});

describe("computeSnap — a turned piece", () => {
  // A desk turned a quarter: 2 × 0.6 m stored, so it covers 0.6 across and 2 deep on the plan.
  const desk: ObjectRect = { id: "desk", x: 1, y: 1, w: 2, h: 0.6, r: 90 };

  it("offers the edges it covers on the plan, not the ones it was drawn with", () => {
    // Its covered left edge is at 1.7 (middle 2, half of 0.6 across); the stored rect's is at 1.
    const result = computeSnap({ id: "d", x: 1.72, y: 9, w: 0.5, h: 0.5 }, [desk], 0.05);
    expect(result.snapX).toBeCloseTo(1.7);
    expect(result.guides).toContainEqual({ axis: "x", position: 1.7, kind: "edge" });
  });

  it("aligns a dragged quarter-turned piece by the box it covers, and gives back its stored corner", () => {
    // Stored 1 × 0.4 at r 90: it covers 0.4 across, so its covered left edge is 0.3 in from x.
    const result = computeSnap({ id: "d", x: 1.42, y: 9, w: 1, h: 0.4, r: 90 }, [{ id: "o", x: 1.7, y: 20, w: 1, h: 1 }], 0.05);
    expect(result.snapX).toBeCloseTo(1.4);
  });

  it("offers only its middle when turned off a quarter", () => {
    const slanted: ObjectRect = { ...desk, r: 30 };
    expect(computeSnap({ id: "d", x: 1.02, y: 9, w: 0.5, h: 0.5 }, [slanted], 0.05).snapX).toBeNull();
    // Its middle is at (2, 1.3).
    expect(computeSnap({ id: "d", x: 1.77, y: 9, w: 0.5, h: 0.5 }, [slanted], 0.05).snapX).toBeCloseTo(1.75);
  });
});

describe("computeSnap — holding on", () => {
  const target: ObjectRect = { id: "o", x: 2, y: 20, w: 1, h: 1 };

  it("lets go only past the release radius, once caught", () => {
    const caught = computeSnap({ id: "d", x: 2.04, y: 9, w: 0.5, h: 0.5 }, [target], 0.05, { release: 0.1 });
    expect(caught.snapX).toBeCloseTo(2);
    const held = computeSnap({ id: "d", x: 2.08, y: 9, w: 0.5, h: 0.5 }, [target], 0.05, { release: 0.1, hold: caught.hold });
    expect(held.snapX).toBeCloseTo(2);
    const gone = computeSnap({ id: "d", x: 2.12, y: 9, w: 0.5, h: 0.5 }, [target], 0.05, { release: 0.1, hold: held.hold });
    expect(gone.snapX).toBeNull();
  });

  it("does not catch from the release radius when nothing is held", () => {
    expect(computeSnap({ id: "d", x: 2.08, y: 9, w: 0.5, h: 0.5 }, [target], 0.05, { release: 0.1 }).snapX).toBeNull();
  });
});

describe("getObjectRects — walls and the screen's mirror", () => {
  it("offers a piece the walls it may stand flush against, each on the one axis it runs across", () => {
    const config = configWith({ dimensions: { widthMeters: 4, depthMeters: 3, heightMeters: 2.5 }, furniture: [furniture("a", 1, 1, 1, 1)], tvAnchor: undefined });
    const walls = getObjectRects(config, "furniture-a").filter((r) => r.id.startsWith("wall-"));
    expect(walls.map((w) => [w.axis, w.axis === "x" ? w.x : w.y]).sort()).toEqual([["x", 0], ["x", 4], ["y", 0], ["y", 3]]);
    expect(getObjectRects(config, "hue-0").some((r) => r.id.startsWith("wall-"))).toBe(false);
  });

  it("brings a piece flush to a wall it is near", () => {
    const config = configWith({ dimensions: { widthMeters: 4, depthMeters: 3, heightMeters: 2.5 }, furniture: [], tvAnchor: undefined });
    const result = computeSnap({ id: "furniture-a", x: 2.97, y: 1.2, w: 1, h: 0.5 }, getObjectRects(config, "furniture-a"), 0.05);
    expect(result.snapX).toBeCloseTo(3);
    expect(result.guides).toContainEqual({ axis: "x", position: 4, kind: "wall" });
  });

  it("puts a light where its pair's mirror across the screen's middle stands, on both axes at once", () => {
    const config = configWith({
      dimensions: { widthMeters: 4, depthMeters: 4, heightMeters: 2.5 },
      furniture: [],
      // The screen's middle is at x = 2.
      tvAnchor: { x: 1.5, y: 0, width: 1, height: 0.1 },
      // Hue (-0.4, 0.6) is plan (1.2, 0.8): its mirror is (2.8, 0.8).
      hueChannels: [{ channelIndex: 0, x: -0.4, y: 0.6, z: 0 }, { channelIndex: 1, x: 0, y: 0, z: 0 }],
    });
    const result = computeSnap({ id: "hue-1", x: 2.83, y: 0.77, w: 0, h: 0 }, getObjectRects(config, "hue-1"), 0.05);
    expect(result.snapX).toBeCloseTo(2.8);
    expect(result.snapY).toBeCloseTo(0.8);
    expect(result.guides).toContainEqual({ axis: "x", position: 2, kind: "mirror", at: 0.8 });
    expect(result.hold).toEqual({ mirror: "hue-0~mirror" });
  });
});
