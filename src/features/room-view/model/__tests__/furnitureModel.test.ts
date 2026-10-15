import { describe, expect, it } from "vitest";

import { DEFAULT_ROOM_MAP, type FurniturePlacement, type RoomMapConfig } from "@/shared/contracts/roomMap";

import { autoVariant, classifyFurniture, toneCss } from "../furnitureModel";

const piece = (
  id: string,
  type: string,
  x: number,
  y: number,
  width: number,
  height: number,
  extra: Partial<FurniturePlacement> = {},
): FurniturePlacement => ({ id, type: type as FurniturePlacement["type"], x, y, width, height, ...extra });

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
    expect(modelOf(room([piece("s", "sofa", 1, 2, width, 0.9)]), "s")).toEqual({ kind: "upholstered", corner: null, ...expected });
  });

  it("reads a small chair as a dining chair, a wide shallow one as a bench and a wide deep one as an armchair", () => {
    const config = room([
      piece("dining", "chair", 0.5, 3, 0.48, 0.5),
      piece("bench", "chair", 2, 3, 1.6, 0.35),
      piece("arm", "chair", 3.5, 2.5, 0.8, 0.8),
    ]);
    expect(modelOf(config, "dining")).toEqual({ kind: "diningChair" });
    expect(modelOf(config, "bench")).toEqual({ kind: "bench" });
    expect(modelOf(config, "arm")).toEqual({ kind: "upholstered", seats: 1, arms: true, corner: null });
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

  it("leaves a screen too low for a desk off the table under it — unless the user calls it a monitor", () => {
    const tv = { x: 0.6, y: 0.1, width: 0.7, height: 0.05, mountHeightMeters: 0.3 };
    expect(modelOf(room([piece("t", "table", 0.3, 0, 1.4, 0.7)], tv), "t")?.kind).not.toBe("desk");
    expect(modelOf(room([piece("t", "table", 0.3, 0, 1.4, 0.7)], { ...tv, screenKind: "monitor" }), "t")?.kind).toBe("desk");
  });
});

describe("classifyFurniture — the user's pick wins over the reading", () => {
  it("draws a table the user called a dining table as one, though it stands before a sofa", () => {
    const living = room([piece("sofa", "sofa", 1.5, 2.5, 2, 0.9), piece("table", "table", 2, 1.6, 1, 0.6, { variant: "dining" })]);
    expect(modelOf(living, "table")).toEqual({ kind: "diningTable" });
  });

  it("makes a chair an armchair and a sofa a corner sectional on request", () => {
    const config = room([
      piece("c", "chair", 0, 0, 0.5, 0.5, { variant: "armchair" }),
      piece("s", "sofa", 1, 1, 2.6, 1.6, { variant: "cornerRight" }),
    ]);
    expect(modelOf(config, "c")).toEqual({ kind: "upholstered", seats: 1, arms: true, corner: null });
    expect(modelOf(config, "s")).toMatchObject({ kind: "upholstered", corner: "right" });
  });

  it("ignores a variant the type does not take, and keeps reading the piece", () => {
    expect(modelOf(room([piece("t", "table", 1, 1, 0.5, 0.5, { variant: "bookshelf" })]), "t")).toEqual({ kind: "sideTable", round: true });
  });
});

describe("classifyFurniture — the new kinds", () => {
  it("reads storage from its shape and place: a nightstand when small, a bookshelf when shallow, a TV unit under the screen", () => {
    const config = room(
      [
        piece("night", "storage", 0, 3, 0.45, 0.4),
        piece("books", "storage", 4, 1, 1.2, 0.32),
        piece("unit", "storage", 1.4, 0, 1.8, 0.45),
        piece("side", "storage", 3, 3, 1.4, 0.5),
      ],
      { x: 1.6, y: 0.05, width: 1.4, height: 0.08, mountHeightMeters: 1.25 },
    );
    expect(modelOf(config, "night")).toEqual({ kind: "nightstand" });
    expect(modelOf(config, "books")).toEqual({ kind: "bookshelf" });
    expect(modelOf(config, "unit")).toEqual({ kind: "tvUnit" });
    expect(modelOf(config, "side")).toEqual({ kind: "cabinet", doors: 3 });
  });

  // A 4.6 m run of storage drew as one long sideboard, a console the length of the wall.
  it("reads a run of storage longer than a sideboard as wardrobes", () => {
    expect(modelOf(room([piece("run", "storage", 0, 0, 4.6, 0.6)]), "run")).toEqual({ kind: "wardrobe" });
  });

  it("draws a bed, a plant by its habit, a rug round when square, and an unknown type as a plain box", () => {
    const config = room([
      piece("bed", "bed", 0, 0, 1.6, 2.05),
      piece("palm", "plant", 3, 0, 0.6, 0.6, { variant: "palm" }),
      piece("rug", "rug", 1, 1, 1.6, 1.6),
      piece("new", "hammock", 3, 3, 1, 1),
    ]);
    expect(modelOf(config, "bed")).toEqual({ kind: "bed" });
    expect(modelOf(config, "palm")).toEqual({ kind: "plant", style: "palm" });
    expect(modelOf(config, "rug")).toEqual({ kind: "rug", round: true });
    expect(modelOf(config, "new")).toEqual({ kind: "box" });
  });
});

describe("autoVariant", () => {
  it("names what Auto reads as in the type's own choices", () => {
    expect(autoVariant({ kind: "upholstered", seats: 1, arms: true, corner: null })).toBe("armchair");
    expect(autoVariant({ kind: "upholstered", seats: 3, arms: true, corner: null })).toBe("straight");
    expect(autoVariant({ kind: "coffeeTable" })).toBe("coffee");
    expect(autoVariant({ kind: "cabinet", doors: 2 })).toBe("sideboard");
    expect(autoVariant({ kind: "box" })).toBeNull();
  });
});

describe("toneCss", () => {
  it("writes a tone as a six-digit CSS colour", () => {
    expect(toneCss("black")).toMatch(/^#[0-9a-f]{6}$/);
    expect(toneCss("slate")).toBe(`#${(0x55657d).toString(16)}`);
  });
});
