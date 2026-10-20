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

  it("draws a pendant as a wide, flat dish", () => {
    const { glow } = lampFixture("pendant", { ...at, y: 1.8 }, 0, 2.5);
    expect(glow.shape).toBe("flare");
    expect(glow.radii[0] * 2).toBeCloseTo(0.475);
    expect(glow.radii[1]).toBeLessThan(glow.radii[0] / 4);
  });

  it("throws a pendant's light down", () => {
    expect(lampFixture("pendant", { ...at, y: 1.8 }, 0, 2.5).beam?.aim.y).toBe(-1);
  });

  // A recessed ceiling spot stood on a pole from the floor.
  it("sets a spot at the ceiling into it, as a downlight thrown straight down", () => {
    const { body, glow, beam } = lampFixture("spot", { ...at, y: 2.48 }, 0, 2.5);
    expect(bounds(body).min.y).toBeGreaterThan(2.48);
    expect(bounds(body).max.y).toBeCloseTo(2.5, 5);
    expect(glow.at.y).toBeGreaterThan(2.45);
    expect(beam?.aim.y).toBe(-1);
    expect(beam?.spread).toBeLessThan(0.8);
  });

  // Seen from above, a lens under a closed trim was never lit.
  it("keeps a downlight's lens above its trim, so the camera sees it lit", () => {
    const { body, glow } = lampFixture("spot", { ...at, y: 2.48 }, 0, 2.5);
    expect(glow.at.y + glow.radii[1]).toBeGreaterThan(bounds(body).max.y);
  });

  // The house has no ceiling: what hangs on it threw its shadow on the floor as a blot.
  it("casts no shadow from what hangs on the ceiling, and a shadow from what stands", () => {
    for (const family of ["pendant", "ceiling", "spot", "bulb"] as const) {
      const { body } = lampFixture(family, { ...at, y: 2.5 }, 0, 2.5);
      expect(body.every((part) => part.castShadow === false)).toBe(true);
    }
    expect(lampFixture("floorLamp", at, 0, 2.5).body.every((part) => part.castShadow === undefined)).toBe(true);
  });

  it("still stands a spot that is not at the ceiling on its surface, aimed up the wall it faces", () => {
    const { body, beam } = lampFixture("spot", at, 0.4, 2.5);
    expect(bounds(body).min.y).toBeCloseTo(0.4, 5);
    expect(beam!.aim.y).toBeGreaterThan(0.3);
    expect(beam!.aim.z).toBeLessThan(-0.5);
  });

  it("hangs a spot too high to stand from the ceiling, aimed down the wall it faces", () => {
    const { body, beam } = lampFixture("spot", { ...at, y: 2.1 }, 0.75, 2.5);
    expect(bounds(body).min.y).toBeGreaterThan(2);
    expect(bounds(body).max.y).toBeCloseTo(2.5, 5);
    expect(beam!.aim.y).toBeLessThan(-0.3);
    expect(beam!.aim.z).toBeLessThan(-0.5);
  });

  // Each fixture lit from a point at its middle, all round or tilted up where the real one is not.
  describe("lets its light out as the fixture does", () => {
    it("lights a Play bar's and a Signe's whole height, level toward the wall", () => {
      for (const [family, length] of [["playBar", 0.24], ["signe", 1.35]] as const) {
        const { glow, beam } = lampFixture(family, at, 0, 2.5);
        expect(glow.radii[1] * 2).toBeGreaterThan(length);
        expect(beam!.aim.y).toBeCloseTo(0, 5);
      }
    });

    it("draws a strip and a tube at their real length", () => {
      expect(lampFixture("lightstrip", at, 0, 2.5).glow.radii[0] * 2).toBeCloseTo(2);
      expect(lampFixture("tube", at, 0, 2.5).glow.radii[0] * 2).toBeCloseTo(1.377);
    });

    it("throws a ceiling light down, not all round", () => {
      expect(lampFixture("ceiling", { ...at, y: 2.5 }, 0, 2.5).beam!.aim.y).toBeCloseTo(-1);
    });

    it("lights a wall light up and down the wall it faces", () => {
      const { beam, back } = lampFixture("wall", { ...at, y: 1.8 }, 0, 2.5);
      expect(beam!.aim.y).toBeGreaterThan(0.9);
      expect(back!.aim.y).toBeLessThan(-0.9);
    });
  });

  it("hangs a bulb at the ceiling from a socket on a short cord", () => {
    const { body, glow } = lampFixture("bulb", { ...at, y: 2.5 }, 0, 2.5);
    expect(body.length).toBeGreaterThan(0);
    expect(bounds(body).max.y).toBeCloseTo(2.5, 5);
    expect(glow.at.y).toBeLessThan(2.3);
    expect(glow.at.y).toBeGreaterThan(2.0);
  });

  it("draws an unknown light as a bare bulb with no body", () => {
    const { body, glow } = lampFixture("bulb", at, 0, 2.5);
    expect(body).toHaveLength(0);
    expect(glow.at).toEqual(at);
  });
});
