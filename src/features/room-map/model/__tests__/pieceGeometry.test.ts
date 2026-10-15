import { describe, expect, it } from "vitest";

import { clampInsideRoom, resizeFromHandle } from "../pieceGeometry";

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
