import { describe, expect, it } from "vitest";

import { clickedZoneRect, drawnZoneRect, rectToZone, resizeZoneRect, zoneEdgeBounds, zoneRect } from "../zoneRect";

// A 5 × 4 × 2.5 m room: edges from 0.25 m (the band on 5 m) to 2.5 m (the ceiling).
const W = 5;
const D = 4;
const H = 2.5;

describe("zoneEdgeBounds", () => {
  it("floors at the band on the longest side and caps at the shortest", () => {
    expect(zoneEdgeBounds(W, D, H)).toEqual({ min: 0.25, max: 2.5 });
  });

  it("collapses to the floor in a room too long for any cube", () => {
    expect(zoneEdgeBounds(30, 1, 2.5)).toEqual({ min: 1.5, max: 1.5 });
  });
});

describe("zoneRect and rectToZone", () => {
  it("round-trips a cube in metres through its square on the plan", () => {
    const zone = { centerX: 0.2, centerY: -0.3, scaleX: 2 / W, scaleY: 2 / D };
    const rect = zoneRect(zone, W, D);
    expect([rect.x0, rect.x1, rect.y0, rect.y1].map((v) => Number(v.toFixed(6)))).toEqual([2, 4, 1.6, 3.6]);
    const back = rectToZone(rect, W, D, H);
    expect(back.centerX).toBeCloseTo(zone.centerX);
    expect(back.centerY).toBeCloseTo(zone.centerY);
    expect(back.edge).toBeCloseTo(2);
  });

  it("takes the larger side of a rectangle that is not square", () => {
    expect(rectToZone({ x0: 1, y0: 1, x1: 2, y1: 2.5 }, W, D, H).edge).toBeCloseTo(1.5);
  });

  it("holds the edge between the band and the ceiling", () => {
    expect(rectToZone({ x0: 1, y0: 1, x1: 1.01, y1: 1.01 }, W, D, H).edge).toBeCloseTo(0.25);
    expect(rectToZone({ x0: 0, y0: 0, x1: 4, y1: 4 }, W, D, H).edge).toBeCloseTo(2.5);
  });
});

describe("resizeZoneRect", () => {
  const start = { x0: 1, y0: 1, x1: 2, y1: 2 };
  const square = (r: { x0: number; y0: number; x1: number; y1: number }) => (r.x1 - r.x0) / (r.y1 - r.y0);

  it("stays square from any grip, grown from the side or corner held", () => {
    const east = resizeZoneRect(start, "e", 0.5, 9, W, D, H);
    expect(square(east)).toBeCloseTo(1);
    expect(east.x0).toBe(1);
    expect(east.x1).toBeCloseTo(2.5);
    const corner = resizeZoneRect(start, "nw", -0.5, -0.1, W, D, H);
    expect(square(corner)).toBeCloseTo(1);
    expect(corner).toMatchObject({ x1: 2, y1: 2 });
    expect(corner.x1 - corner.x0).toBeCloseTo(1.5);
  });

  it("stops at the ceiling's height, the walls and the smallest edge", () => {
    const tall = resizeZoneRect(start, "se", 10, 10, W, D, H);
    expect(tall.x1 - tall.x0).toBeCloseTo(H);
    expect(square(tall)).toBeCloseTo(1);
    const walled = resizeZoneRect({ x0: 3, y0: 1, x1: 4, y1: 2 }, "e", 10, 0, W, D, H);
    expect(walled.x1).toBeCloseTo(W);
    expect(walled.y1 - walled.y0).toBeCloseTo(2);
    const shrunk = resizeZoneRect(start, "w", 10, 0, W, D, H);
    expect(shrunk.x1 - shrunk.x0).toBeCloseTo(0.25);
  });
});

describe("drawnZoneRect", () => {
  it("draws a square from the pointer's larger reach", () => {
    expect(drawnZoneRect({ x: 1, y: 1 }, { x: 2, y: 1.5 }, W, D, H)).toEqual({ x0: 1, y0: 1, x1: 2, y1: 2 });
  });

  it("draws in either direction, held to the room and the ceiling", () => {
    const r = drawnZoneRect({ x: 3, y: 3 }, { x: 1, y: 9 }, W, D, H);
    expect(r).toMatchObject({ x0: 2, y0: 3, x1: 3, y1: D });
    const capped = drawnZoneRect({ x: 0, y: 0 }, { x: 5, y: 4 }, W, D, H);
    expect(capped).toEqual({ x0: 0, y0: 0, x1: H, y1: H });
  });
});

describe("clickedZoneRect", () => {
  it("centres half the tallest cube on the click, pushed off the walls", () => {
    expect(clickedZoneRect({ x: 2.5, y: 2 }, W, D, H)).toEqual({ x0: 1.875, y0: 1.375, x1: 3.125, y1: 2.625 });
    expect(clickedZoneRect({ x: 0, y: 4 }, W, D, H)).toEqual({ x0: 0, y0: 2.75, x1: 1.25, y1: 4 });
  });
});
