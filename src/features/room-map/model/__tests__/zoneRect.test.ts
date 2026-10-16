import { describe, expect, it } from "vitest";

import { clickedZoneRect, drawnZoneRect, rectToZone, resizeZoneRect, zoneRect } from "../zoneRect";

const W = 5;
const D = 4;

describe("zoneRect and rectToZone", () => {
  it("round-trip a zone through its plan rectangle", () => {
    const zone = { centerX: 0.2, centerY: -0.3, scaleX: 0.4, scaleY: 0.25 };
    const rect = zoneRect(zone, W, D);
    expect(rect.x0).toBeCloseTo(2);
    expect(rect.x1).toBeCloseTo(4);
    expect(rect.y0).toBeCloseTo(2.1);
    expect(rect.y1).toBeCloseTo(3.1);
    const back = rectToZone(rect, W, D);
    expect(back.centerX).toBeCloseTo(zone.centerX);
    expect(back.centerY).toBeCloseTo(zone.centerY);
    expect(back.scaleX).toBeCloseTo(zone.scaleX);
    expect(back.scaleY).toBeCloseTo(zone.scaleY);
  });

  it("keeps a rectangle inside the room and no smaller than the backend's band", () => {
    const zone = rectToZone({ x0: -1, y0: 3.99, x1: 0.01, y1: 3.99 }, W, D);
    expect(zone.scaleX).toBeCloseTo(0.05);
    expect(zone.scaleY).toBeCloseTo(0.05);
    expect(Math.abs(zone.centerX) + zone.scaleX).toBeLessThanOrEqual(1 + 1e-9);
    expect(Math.abs(zone.centerY) + zone.scaleY).toBeLessThanOrEqual(1 + 1e-9);
  });
});

describe("resizeZoneRect", () => {
  const start = { x0: 1, y0: 1, x1: 3, y1: 2 };

  it("moves only the edges the handle holds", () => {
    expect(resizeZoneRect(start, "e", 0.5, 9, W, D)).toEqual({ x0: 1, y0: 1, x1: 3.5, y1: 2 });
    expect(resizeZoneRect(start, "nw", -0.5, -0.5, W, D)).toEqual({ x0: 0.5, y0: 0.5, x1: 3, y1: 2 });
  });

  it("stops at the walls and at the smallest size", () => {
    expect(resizeZoneRect(start, "se", 10, 10, W, D)).toEqual({ x0: 1, y0: 1, x1: W, y1: D });
    const shrunk = resizeZoneRect(start, "w", 10, 0, W, D);
    expect(shrunk.x1 - shrunk.x0).toBeCloseTo(0.05 * W);
  });

  it("keeps the proportions with square, inside the room", () => {
    const grown = resizeZoneRect(start, "se", 1, 0, W, D, true);
    expect((grown.x1 - grown.x0) / (grown.y1 - grown.y0)).toBeCloseTo(2);
    expect(grown).toMatchObject({ x0: 1, y0: 1 });
    const walled = resizeZoneRect(start, "se", 10, 10, W, D, true);
    expect(walled.x1).toBeLessThanOrEqual(W + 1e-9);
    expect(walled.y1).toBeLessThanOrEqual(D + 1e-9);
    expect((walled.x1 - walled.x0) / (walled.y1 - walled.y0)).toBeCloseTo(2);
  });
});

describe("drawnZoneRect", () => {
  it("spans the drag in either direction and stops at the walls", () => {
    expect(drawnZoneRect({ x: 3, y: 3 }, { x: 1, y: 9 }, W, D)).toEqual({ x0: 1, y0: 3, x1: 3, y1: D });
  });

  it("draws a square with square, held to the room", () => {
    expect(drawnZoneRect({ x: 1, y: 1 }, { x: 2, y: 1.5 }, W, D, true)).toEqual({ x0: 1, y0: 1, x1: 2, y1: 2 });
    const walled = drawnZoneRect({ x: 4, y: 1 }, { x: 9, y: 3 }, W, D, true);
    expect(walled.x1 - walled.x0).toBeCloseTo(walled.y1 - walled.y0);
    expect(walled.x1).toBeLessThanOrEqual(W);
  });
});

describe("clickedZoneRect", () => {
  it("centres half the room on the click, pushed off the walls", () => {
    expect(clickedZoneRect({ x: 2.5, y: 2 }, W, D)).toEqual({ x0: 1.25, y0: 1, x1: 3.75, y1: 3 });
    expect(clickedZoneRect({ x: 0, y: 4 }, W, D)).toEqual({ x0: 0, y0: 2, x1: 2.5, y1: 4 });
  });
});
