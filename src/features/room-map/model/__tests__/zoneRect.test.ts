import { describe, expect, it } from "vitest";

import { clickedZoneRect, drawnZoneRect, rectToZone, resizeZoneRect, zoneRect } from "../zoneRect";

const W = 5;
const D = 4;

describe("zoneRect and rectToZone", () => {
  it("round-trips a cube through its plan rectangle, which keeps the room's proportions", () => {
    const zone = { centerX: 0.2, centerY: -0.3, scaleX: 0.4, scaleY: 0.4 };
    const rect = zoneRect(zone, W, D);
    expect([rect.x0, rect.x1, rect.y0, rect.y1].map((v) => Number(v.toFixed(6)))).toEqual([2, 4, 1.8, 3.4]);
    const back = rectToZone(rect, W, D);
    expect(back.centerX).toBeCloseTo(zone.centerX);
    expect(back.centerY).toBeCloseTo(zone.centerY);
    expect(back.scale).toBeCloseTo(0.4);
  });

  it("takes the larger side of a rectangle that is not in the room's proportions", () => {
    expect(rectToZone({ x0: 1, y0: 1, x1: 2, y1: 3 }, W, D).scale).toBeCloseTo(0.5);
  });

  it("is no smaller than the backend's band", () => {
    expect(rectToZone({ x0: 1, y0: 1, x1: 1.01, y1: 1.01 }, W, D).scale).toBeCloseTo(0.05);
  });
});

describe("resizeZoneRect", () => {
  // A cube of scale 0.4 in a 5 × 4 m room.
  const start = { x0: 1, y0: 1, x1: 3, y1: 2.6 };
  const ratio = (r: { x0: number; y0: number; x1: number; y1: number }) => (r.x1 - r.x0) / (r.y1 - r.y0);

  it("keeps the room's proportions from any grip, grown from the side or corner held", () => {
    const east = resizeZoneRect(start, "e", 0.5, 9, W, D);
    expect(ratio(east)).toBeCloseTo(W / D);
    expect(east.x0).toBe(1);
    expect(east.x1).toBeCloseTo(3.5);
    const corner = resizeZoneRect(start, "nw", -0.5, -0.1, W, D);
    expect(ratio(corner)).toBeCloseTo(W / D);
    expect(corner).toMatchObject({ x1: 3, y1: 2.6 });
  });

  it("stops at the walls and at the smallest size", () => {
    const walled = resizeZoneRect(start, "se", 10, 10, W, D);
    expect(walled.x1).toBeLessThanOrEqual(W + 1e-9);
    expect(walled.y1).toBeLessThanOrEqual(D + 1e-9);
    expect(ratio(walled)).toBeCloseTo(W / D);
    const shrunk = resizeZoneRect(start, "w", 10, 0, W, D);
    expect(shrunk.x1 - shrunk.x0).toBeCloseTo(0.05 * W);
  });
});

describe("drawnZoneRect", () => {
  it("draws a cube in the room's proportions from the pointer's larger reach", () => {
    expect(drawnZoneRect({ x: 1, y: 1 }, { x: 2, y: 1.5 }, W, D)).toEqual({ x0: 1, y0: 1, x1: 2, y1: 1.8 });
  });

  it("draws in either direction, held to the room", () => {
    const r = drawnZoneRect({ x: 3, y: 3 }, { x: 1, y: 9 }, W, D);
    expect(r.x0).toBeCloseTo(1.75);
    expect(r).toMatchObject({ y0: 3, x1: 3, y1: D });
  });
});

describe("clickedZoneRect", () => {
  it("centres the cube of scale 0.5 on the click, pushed off the walls", () => {
    expect(clickedZoneRect({ x: 2.5, y: 2 }, W, D)).toEqual({ x0: 1.25, y0: 1, x1: 3.75, y1: 3 });
    expect(clickedZoneRect({ x: 0, y: 4 }, W, D)).toEqual({ x0: 0, y0: 2, x1: 2.5, y1: 4 });
  });
});
