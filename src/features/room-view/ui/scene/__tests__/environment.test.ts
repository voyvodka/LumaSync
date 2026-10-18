import { type Box3, Color } from "three";
import { describe, expect, it } from "vitest";

import { FLOOR_FINISHES, WALL_COLORS } from "@/shared/contracts/roomMap";

import { floorSwatchCss, wallSwatchCss } from "../../../model/surfaceColours";
import { floorParts } from "../environment";

/** The floor's top layer: the planks or slabs, not the grout bed under them or the skirting. */
const tops = (finish: (typeof FLOOR_FINISHES)[keyof typeof FLOOR_FINISHES], w = 3, d = 2) =>
  floorParts(w, d, null, [], finish).flatMap((part) => {
    part.geometry.computeBoundingBox();
    const box = part.geometry.boundingBox as Box3;
    return box.max.y <= 0.001 && box.min.y >= -0.021 ? [{ box, color: part.color }] : [];
  });

describe("floorParts", () => {
  // A herringbone lattice off by a plank would overlap its rows or leave the floor's bed showing.
  it("lays herringbone planks that cover the floor without overlapping, all inside the room", () => {
    const planks = tops(FLOOR_FINISHES.HERRINGBONE);
    expect(planks.length).toBeGreaterThan(140);
    let covered = 0;
    let doubled = 0;
    for (let x = -1.49; x < 1.5; x += 0.031) {
      for (let z = -0.99; z < 1; z += 0.029) {
        const under = planks.filter(({ box }) => x >= box.min.x && x <= box.max.x && z >= box.min.z && z <= box.max.z).length;
        if (under > 0) covered++;
        if (under > 1) doubled++;
      }
    }
    const samples = Math.ceil(2.98 / 0.031) * Math.ceil(1.98 / 0.029);
    expect(doubled).toBe(0);
    expect(covered / samples).toBeGreaterThan(0.85);
    for (const { box } of planks) {
      expect(box.min.x).toBeGreaterThanOrEqual(-1.5 - 1e-6);
      expect(box.max.x).toBeLessThanOrEqual(1.5 + 1e-6);
      expect(box.min.z).toBeGreaterThanOrEqual(-1 - 1e-6);
      expect(box.max.z).toBeLessThanOrEqual(1 + 1e-6);
    }
  });

  it("alternates a checkerboard's squares, light beside dark", () => {
    const squares = tops(FLOOR_FINISHES.CHECKER, 1.6, 0.8);
    expect(squares).toHaveLength(8);
    const light = squares.map(({ color }) => new Color(color).getHSL({ h: 0, s: 0, l: 0 }).l > 0.5);
    expect(light.filter(Boolean)).toHaveLength(4);
    const at = (x: number, z: number) => light[squares.findIndex(({ box }) => x > box.min.x && x < box.max.x && z > box.min.z && z < box.max.z)];
    expect(at(-0.6, -0.2)).not.toBe(at(-0.2, -0.2));
    expect(at(-0.6, -0.2)).not.toBe(at(-0.6, 0.2));
  });
});

describe("floorSwatchCss", () => {
  it("draws every floor's disc in a pattern of its own", () => {
    const swatches = Object.values(FLOOR_FINISHES).map(floorSwatchCss);
    expect(new Set(swatches).size).toBe(swatches.length);
    expect(floorSwatchCss(FLOOR_FINISHES.CHECKER)).toContain("conic-gradient");
    expect(floorSwatchCss(FLOOR_FINISHES.CARPET)).toMatch(/^#[0-9a-f]{6}$/);
  });
});

describe("wallSwatchCss", () => {
  it("gives every paint a colour of its own", () => {
    const swatches = Object.values(WALL_COLORS).map(wallSwatchCss);
    expect(new Set(swatches).size).toBe(swatches.length);
    for (const swatch of swatches) expect(swatch).toMatch(/^#[0-9a-f]{6}$/);
  });
});
