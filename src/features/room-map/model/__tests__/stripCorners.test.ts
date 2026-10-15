import { describe, expect, it } from "vitest";

import { MAX_STRIP_CORNERS, type UsbStripPlacement } from "@/shared/contracts/roomMap";

import { addStripCorner, ledsPerLeg, pointAlongStrip, removeStripCorner, stripLegs } from "../stripCorners";

const strip = (s: Partial<UsbStripPlacement> = {}): UsbStripPlacement => ({ stripId: "s", ledCount: 60, startX: 0, startY: 0, endX: 2, endY: 0, ...s });
const ell = strip({ endX: 1, endY: 1, corners: [{ x: 1, y: 0 }] });

describe("stripLegs / pointAlongStrip", () => {
  it("walks the run through its corners", () => {
    expect(stripLegs(ell).map((l) => l.length)).toEqual([1, 1]);
    expect(pointAlongStrip(ell, 1.5)).toEqual({ x: 1, y: 0.5 });
    expect(pointAlongStrip(ell, 9)).toEqual({ x: 1, y: 1 });
  });
});

describe("ledsPerLeg", () => {
  it("shares the LEDs out by length and loses none to rounding", () => {
    const legs = stripLegs(strip({ endX: 1, endY: 1, corners: [{ x: 0.5, y: 0 }, { x: 1, y: 0 }] }));
    const counts = ledsPerLeg(legs, 61);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(61);
    expect(counts).toEqual([15, 16, 30]);
  });
});

describe("addStripCorner / removeStripCorner", () => {
  it("bends the middle of the longest leg when no place is given", () => {
    expect(addStripCorner(strip({ corners: [{ x: 0.5, y: 0 }] }))?.corners).toEqual([{ x: 0.5, y: 0 }, { x: 1.25, y: 0 }]);
  });

  it("puts a corner where it was asked for, held to that leg and in run order", () => {
    expect(addStripCorner(ell, 1, { x: 1.4, y: 0.25 })?.corners).toEqual([{ x: 1, y: 0 }, { x: 1, y: 0.25 }]);
    expect(addStripCorner(ell, 0, { x: 0.3, y: -2 })?.corners).toEqual([{ x: 0.3, y: 0 }, { x: 1, y: 0 }]);
  });

  it("stops at the cap", () => {
    const full = strip({ corners: Array.from({ length: MAX_STRIP_CORNERS }, (_, i) => ({ x: i * 0.2, y: 0 })) });
    expect(addStripCorner(full)).toBeNull();
  });

  it("straightens the strip when its last corner goes", () => {
    expect(removeStripCorner(ell, 0).corners).toBeNull();
    const two = strip({ corners: [{ x: 0.5, y: 0 }, { x: 1, y: 0 }] });
    expect(removeStripCorner(two, 0).corners).toEqual([{ x: 1, y: 0 }]);
  });
});
