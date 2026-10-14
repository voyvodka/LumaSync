import { Box3 } from "three";
import { describe, expect, it } from "vitest";

import type { Part } from "../parts";
import { lampFixture } from "../lamps";

function bounds(parts: readonly Part[]): Box3 {
  const box = new Box3();
  for (const part of parts) {
    part.geometry.computeBoundingBox();
    if (part.geometry.boundingBox) box.union(part.geometry.boundingBox);
  }
  return box;
}

const at = { x: 1, y: 0.9, z: -0.5 };

describe("lampFixture", () => {
  it("stands a Play bar on the desk under it, its lit back at the bar's middle", () => {
    const { body, glow } = lampFixture("playBar", at, 0.755, 2.5);
    expect(bounds(body).min.y).toBeCloseTo(0.755, 5);
    expect(glow.at.y).toBeGreaterThan(0.755);
    expect(glow.radii[1]).toBeGreaterThan(glow.radii[0]);
  });

  it("raises a floor lamp's pole from the floor and lights its shade", () => {
    const { body, glow } = lampFixture("floorLamp", { ...at, y: 1.5 }, 0, 2.5);
    expect(bounds(body).min.y).toBeCloseTo(0, 5);
    expect(glow.at.y).toBeCloseTo(1.5, 5);
  });

  it("hangs a pendant from the ceiling", () => {
    const { body } = lampFixture("pendant", { ...at, y: 2.0 }, 0, 2.6);
    expect(bounds(body).max.y).toBeCloseTo(2.6, 5);
  });

  it("draws an unknown light as a bare bulb with no body", () => {
    const { body, glow } = lampFixture("bulb", at, 0, 2.5);
    expect(body).toHaveLength(0);
    expect(glow.at).toEqual(at);
  });
});
