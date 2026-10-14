import { Box3 } from "three";
import { describe, expect, it } from "vitest";

import { DEFAULT_ROOM_MAP, type FurniturePlacement, type RoomMapConfig } from "@/shared/contracts/roomMap";

import { classifyFurniture, type FurnitureModel, furnitureParts } from "../furniture";

const piece = (id: string, type: FurniturePlacement["type"], x: number, y: number, width: number, height: number, rotation = 0): FurniturePlacement => ({
  id,
  type,
  x,
  y,
  width,
  height,
  rotation,
});

const room = (furniture: FurniturePlacement[], tvAnchor?: RoomMapConfig["tvAnchor"]): RoomMapConfig => ({
  ...DEFAULT_ROOM_MAP,
  dimensions: { widthMeters: 5, depthMeters: 4, heightMeters: 2.5 },
  furniture,
  tvAnchor,
});

const modelOf = (config: RoomMapConfig, id: string) => classifyFurniture(config).get(id);

describe("classifyFurniture — a seat grows with its width", () => {
  it.each([
    [0.55, { seats: 1, arms: false }],
    [0.85, { seats: 1, arms: true }],
    [1.5, { seats: 2, arms: true }],
    [2.1, { seats: 3, arms: true }],
    [2.7, { seats: 4, arms: true }],
  ])("reads a %s m sofa as %o", (width, expected) => {
    expect(modelOf(room([piece("s", "sofa", 1, 2, width, 0.9)]), "s")).toEqual({ kind: "upholstered", ...expected });
  });

  it("reads a small chair as a dining chair, a wide shallow one as a bench and a wide deep one as an armchair", () => {
    const config = room([
      piece("dining", "chair", 0.5, 3, 0.48, 0.5),
      piece("bench", "chair", 2, 3, 1.6, 0.35),
      piece("arm", "chair", 3.5, 2.5, 0.8, 0.8),
    ]);
    expect(modelOf(config, "dining")).toEqual({ kind: "diningChair" });
    expect(modelOf(config, "bench")).toEqual({ kind: "bench" });
    expect(modelOf(config, "arm")).toEqual({ kind: "upholstered", seats: 1, arms: true });
  });
});

describe("classifyFurniture — a table is read from what stands around it", () => {
  // The L-desk template: a monitor over the main desk, a return touching it, a chair in front.
  const desk = room(
    [
      piece("desk", "table", 0.3, 0, 1.4, 0.7),
      piece("return", "table", 0, 0, 0.3, 1.2),
      piece("chair", "chair", 0.7, 0.9, 0.5, 0.5),
    ],
    { x: 0.6, y: 0.1, width: 0.7, height: 0.05 },
  );

  it("puts the screen on the desk under it, with the keyboard under the screen", () => {
    const model = modelOf(desk, "desk");
    expect(model?.kind).toBe("desk");
    expect(model?.kind === "desk" && model.screenX).toBeCloseTo(0.6 + 0.35 - (0.3 + 0.7), 5);
  });

  it("carries a table touching the desk on as its return, at desk height", () => {
    expect(modelOf(desk, "return")).toEqual({ kind: "desk", screenX: null });
  });

  it("turns the chair at the desk into an office chair", () => {
    expect(modelOf(desk, "chair")).toEqual({ kind: "officeChair" });
  });

  it("reads a low table in front of a sofa as its coffee table, and one alone as a dining table", () => {
    const living = room([piece("sofa", "sofa", 1.5, 2.5, 2, 0.9), piece("table", "table", 2, 1.6, 1, 0.6)]);
    expect(modelOf(living, "table")).toEqual({ kind: "coffeeTable" });
    expect(modelOf(room([piece("table", "table", 2, 1.6, 1.6, 0.9)]), "table")).toEqual({ kind: "diningTable" });
  });

  it("reads a small table as a side table, round when it is square", () => {
    expect(modelOf(room([piece("t", "table", 1, 1, 0.5, 0.5)]), "t")).toEqual({ kind: "sideTable", round: true });
    expect(modelOf(room([piece("t", "table", 1, 1, 0.6, 0.4)]), "t")).toEqual({ kind: "sideTable", round: false });
  });

  it("leaves a screen too low for a desk off the table under it", () => {
    const low = room([piece("t", "table", 0.3, 0, 1.4, 0.7)], { x: 0.6, y: 0.1, width: 0.7, height: 0.05, mountHeightMeters: 0.3 });
    expect(modelOf(low, "t")?.kind).not.toBe("desk");
  });
});

describe("furnitureParts — every model stays inside its footprint", () => {
  const MODELS: FurnitureModel[] = [
    { kind: "upholstered", seats: 1, arms: false },
    { kind: "upholstered", seats: 1, arms: true },
    { kind: "upholstered", seats: 3, arms: true },
    { kind: "diningChair" },
    { kind: "officeChair" },
    { kind: "bench" },
    { kind: "desk", screenX: 0.2 },
    { kind: "desk", screenX: null },
    { kind: "coffeeTable" },
    { kind: "sideTable", round: true },
    { kind: "sideTable", round: false },
    { kind: "diningTable" },
    { kind: "cabinet", doors: 3 },
  ];
  // Including the maintainer's own 3.81 × 0.17 m piece, a shape no template makes.
  const SIZES: Array<[number, number]> = [
    [0.4, 0.4],
    [0.55, 0.5],
    [0.9, 0.85],
    [2.1, 0.9],
    [3.81, 0.17],
  ];
  const EPS = 0.0015;

  for (const model of MODELS) {
    for (const [w, d] of SIZES) {
      it(`${JSON.stringify(model)} at ${w} × ${d} m`, () => {
        const parts = furnitureParts(piece("p", "other", 0, 0, w, d), model);
        expect(parts.length).toBeGreaterThan(0);
        const box = new Box3();
        for (const part of parts) {
          part.geometry.computeBoundingBox();
          if (part.geometry.boundingBox) box.union(part.geometry.boundingBox);
          part.geometry.dispose();
        }
        expect(box.min.x).toBeGreaterThanOrEqual(-w / 2 - EPS);
        expect(box.max.x).toBeLessThanOrEqual(w / 2 + EPS);
        expect(box.min.z).toBeGreaterThanOrEqual(-d / 2 - EPS);
        expect(box.max.z).toBeLessThanOrEqual(d / 2 + EPS);
        expect(box.min.y).toBeGreaterThanOrEqual(-EPS);
        expect(box.max.y).toBeLessThanOrEqual(1.1);
      });
    }
  }
});
