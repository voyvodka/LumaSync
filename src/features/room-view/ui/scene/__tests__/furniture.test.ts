import { Box3 } from "three";
import { describe, expect, it } from "vitest";

import type { FurniturePlacement } from "@/shared/contracts/roomMap";

import type { FurnitureModel } from "../../../model/furnitureModel";
import { furnitureParts } from "../furniture";

const piece = (id: string, type: FurniturePlacement["type"], x: number, y: number, width: number, height: number, rotation = 0): FurniturePlacement => ({
  id,
  type,
  x,
  y,
  width,
  height,
  rotation,
});

describe("furnitureParts — every model stays inside its footprint", () => {
  const MODELS: FurnitureModel[] = [
    { kind: "upholstered", seats: 1, arms: false, corner: null },
    { kind: "upholstered", seats: 1, arms: true, corner: null },
    { kind: "upholstered", seats: 3, arms: true, corner: null },
    { kind: "upholstered", seats: 3, arms: true, corner: "left" },
    { kind: "upholstered", seats: 3, arms: true, corner: "right" },
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
    { kind: "bookshelf" },
    { kind: "wardrobe" },
    { kind: "nightstand" },
    { kind: "tvUnit" },
    { kind: "bed" },
    { kind: "plant", style: "topiary" },
    { kind: "plant", style: "leafy" },
    { kind: "plant", style: "palm" },
    { kind: "rug", round: false },
    { kind: "rug", round: true },
    { kind: "stool" },
    { kind: "beanbag" },
    { kind: "dresser" },
    { kind: "counter" },
    { kind: "island" },
    { kind: "fridge" },
    { kind: "box" },
  ];
  // Including the maintainer's own 3.81 × 0.17 m piece, a shape no template makes.
  const SIZES: Array<[number, number]> = [
    [0.4, 0.4],
    [0.55, 0.5],
    [0.9, 0.85],
    [2.1, 0.9],
    [2.8, 1.7],
    [1.6, 2.05],
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
        expect(box.max.y).toBeLessThanOrEqual(2.05);
      });
    }
  }
});
