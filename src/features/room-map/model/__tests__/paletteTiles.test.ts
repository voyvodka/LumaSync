import { describe, expect, it } from "vitest";

import { FURNITURE_TILES, furnitureTile } from "../paletteTiles";

describe("FURNITURE_TILES", () => {
  it("reads each type alone at its default size as the 3D room would", () => {
    expect(FURNITURE_TILES.map((tile) => [tile.type, tile.model])).toEqual([
      ["sofa", { kind: "upholstered", seats: 3, arms: true, corner: null }],
      ["table", { kind: "diningTable" }],
      ["chair", { kind: "diningChair" }],
      ["bed", { kind: "bed" }],
      ["storage", { kind: "cabinet", doors: 3 }],
      ["plant", { kind: "plant", style: "topiary" }],
      ["rug", { kind: "rug", round: false }],
      ["other", { kind: "box" }],
    ]);
  });

  it("finds a tile by its type", () => {
    expect(furnitureTile("bed").piece).toMatchObject({ width: 1.6, height: 2.05 });
  });
});
