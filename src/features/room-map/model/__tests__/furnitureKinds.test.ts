import { describe, expect, it } from "vitest";

import { FURNITURE_TYPES, type FurniturePlacement } from "@/shared/contracts/roomMap";

import { FURNITURE_DEFAULT_SIZE, retypeFurniture } from "../furnitureKinds";

const table: FurniturePlacement = { id: "t", type: "table", x: 0, y: 0, width: 1, height: 0.6, variant: "dining", tone: "oak" };

describe("retypeFurniture", () => {
  it("clears a variant and a tone the new type does not take", () => {
    // `dining` is a chair's variant too, but oak is no chair's tone.
    expect(retypeFurniture(table, "chair")).toEqual({ type: "chair", variant: "dining", tone: undefined });
    expect(retypeFurniture(table, "bed")).toEqual({ type: "bed", variant: undefined, tone: undefined });
  });

  it("keeps what still fits", () => {
    expect(retypeFurniture(table, "storage")).toEqual({ type: "storage", variant: undefined, tone: "oak" });
  });
});

describe("FURNITURE_DEFAULT_SIZE", () => {
  it("gives every type a real footprint, a sofa wider than deep and a bed deeper than wide", () => {
    for (const type of Object.values(FURNITURE_TYPES)) {
      expect(FURNITURE_DEFAULT_SIZE[type].width).toBeGreaterThan(0);
      expect(FURNITURE_DEFAULT_SIZE[type].depth).toBeGreaterThan(0);
    }
    expect(FURNITURE_DEFAULT_SIZE.sofa.width).toBeGreaterThan(FURNITURE_DEFAULT_SIZE.sofa.depth);
    expect(FURNITURE_DEFAULT_SIZE.bed.depth).toBeGreaterThan(FURNITURE_DEFAULT_SIZE.bed.width);
  });
});
