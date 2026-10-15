import { describe, expect, it } from "vitest";

import type { UsbStripPlacement } from "@/shared/contracts/roomMap";

import { clampInsideRoom, freeSpotFor, keepPlacedInside, keepStripInside, landCarriedPiece, resizeFromHandle } from "../pieceGeometry";

const room = { width: 5, depth: 4 };

describe("clampInsideRoom", () => {
  it("keeps what a turned piece covers inside the room", () => {
    // 2 × 1 turned 90°: it covers 1 across and 2 deep, so its middle stops half a metre from the wall.
    const box = clampInsideRoom({ x: -3, y: 1, w: 2, h: 1, r: 90 }, room);
    expect(box.x + box.w / 2).toBeCloseTo(0.5);
  });

  it("centres a piece larger than the room", () => {
    const box = clampInsideRoom({ x: 3, y: 0, w: 8, h: 1, r: 0 }, room);
    expect(box.x + box.w / 2).toBe(2.5);
  });
});

describe("resizeFromHandle", () => {
  const start = { x: 1, y: 1, w: 2, h: 1, r: 0 };
  const options = { min: 0.2, step: 0, keepRatio: false };

  it("grows from the east side with the west side held", () => {
    const box = resizeFromHandle(start, { sx: 1, sy: 0 }, 0.5, 0.3, options);
    expect(box).toEqual({ x: 1, y: 1, w: 2.5, h: 1, r: 0 });
  });

  it("grows from the north-west corner with the south-east corner held", () => {
    const box = resizeFromHandle(start, { sx: -1, sy: -1 }, -0.5, -0.5, options);
    expect(box.x + box.w).toBeCloseTo(3);
    expect(box.y + box.h).toBeCloseTo(2);
    expect(box.w).toBeCloseTo(2.5);
  });

  it("keeps the proportions from a corner with ⇧", () => {
    const box = resizeFromHandle(start, { sx: 1, sy: 1 }, 1, 0, { ...options, keepRatio: true });
    expect(box.w / box.h).toBeCloseTo(2);
  });
});

describe("landCarriedPiece", () => {
  it("puts the piece's middle where it was dropped, turned, inside the room", () => {
    const sofa = { id: "s", x: 0, y: 0, width: 2, height: 1, rotation: 350 };
    const landed = landCarriedPiece(sofa, 2.5, 2, 30, room);
    expect(landed.rotation).toBe(20);
    expect(landed.x + landed.width / 2).toBeCloseTo(2.5, 1);
    expect(landed.y + landed.height / 2).toBeCloseTo(2, 1);
    const pushed = landCarriedPiece(sofa, 9, 2, 0, room);
    expect(pushed.x + pushed.width).toBeLessThanOrEqual(room.width + 0.01);
  });
});

describe("keepPlacedInside", () => {
  // A typed X of −5 sent the sofa off the plan, where no pointer could reach it.
  it("brings a typed position back inside the room", () => {
    expect(keepPlacedInside({ x: -5, y: 2.5, width: 2, height: 0.9 }, room)).toMatchObject({ x: 0, y: 2.5 });
  });

  it("cuts a square-turned piece longer than the room to it, across the turn", () => {
    expect(keepPlacedInside({ x: 0, y: 0, width: 9, height: 1, rotation: 90 }, room)).toMatchObject({ width: 4 });
    expect(keepPlacedInside({ x: 0, y: 0, width: 9, height: 1 }, room)).toMatchObject({ x: 0, width: 5 });
  });

  it("hands back the same piece when it already fits", () => {
    const piece = { x: 1, y: 1, width: 1, height: 1 };
    expect(keepPlacedInside(piece, room)).toBe(piece);
  });
});

describe("keepStripInside", () => {
  const strip = (s: Partial<UsbStripPlacement>): UsbStripPlacement => ({ stripId: "s", ledCount: 60, startX: 0, startY: 0, endX: 1, endY: 0, ...s });

  it("slides a strip whole until both its ends are inside", () => {
    expect(keepStripInside(strip({ startX: 4.5, startY: 1, endX: 5.5, endY: 1 }), room)).toMatchObject({ startX: 4, startY: 1, endX: 5, endY: 1 });
    expect(keepStripInside(strip({ startX: 1, startY: -1, endX: 1, endY: 0.5 }), room)).toMatchObject({ startX: 1, startY: 0, endX: 1, endY: 1.5 });
  });

  // A bent strip whose corner poked out past the wall stayed there: only its ends were checked.
  it("keeps a bent strip's corners inside too, moving them with it", () => {
    const bent = strip({ startX: 1, startY: 1, endX: 2, endY: 1, corners: [{ x: 1.5, y: -0.5 }] });
    expect(keepStripInside(bent, room)).toMatchObject({ startY: 1.5, endY: 1.5, corners: [{ x: 1.5, y: 0 }] });
  });

  it("hands back the same strip when it already fits", () => {
    const inside = strip({ corners: [{ x: 0.5, y: 0.5 }] });
    expect(keepStripInside(inside, room)).toBe(inside);
  });
});

describe("freeSpotFor", () => {
  it("takes the middle of an empty room", () => {
    expect(freeSpotFor(1, 1, room, [])).toEqual({ x: 2, y: 1.5 });
  });

  it("keeps clear of what stands there, and of the cut", () => {
    const table = { x: 2, y: 1.5, width: 1, height: 1 };
    const spot = freeSpotFor(1, 1, room, [table], (x) => x <= 2.5)!;
    expect(spot.x + 1).toBeLessThanOrEqual(2.5);
    expect(spot.x + 1 <= table.x - 0.05 || spot.y + 1 <= table.y - 0.05 || spot.y >= table.y + 1.05).toBe(true);
  });

  it("says when the room has no room left", () => {
    expect(freeSpotFor(1, 1, room, [{ x: 0, y: 0, width: 5, height: 4 }])).toBeNull();
  });
});
