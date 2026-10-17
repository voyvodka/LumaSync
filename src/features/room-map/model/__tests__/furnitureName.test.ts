import type { TFunction } from "i18next";
import { describe, expect, it } from "vitest";

import { retypeFurniture } from "../furnitureKinds";
import { furnitureName, furnitureOwnName } from "../furnitureName";

// Only the active language's catalogue is loaded, as in the app.
const TR: Record<string, string> = {
  "roomMap:furniture.type.sofa": "Kanepe",
  "roomMap:furniture.type.chair": "Sandalye",
  "roomMap:furniture.variant.cornerLeft": "Köşe, sol",
};
const t = ((key: string) => TR[key] ?? key) as unknown as TFunction;

describe("furnitureName", () => {
  it("calls a piece with no name of its own by its model, then its type, in the app's language", () => {
    expect(furnitureName({ type: "sofa", variant: "cornerLeft" }, t)).toBe("Köşe, sol");
    expect(furnitureName({ type: "sofa" }, t)).toBe("Kanepe");
  });

  // Maps saved before names followed the language stored the type's name in the language of the day.
  it("reads a name an earlier build stored, in either language, as no name", () => {
    expect(furnitureName({ type: "sofa", label: "Sofa" }, t)).toBe("Kanepe");
    expect(furnitureName({ type: "sofa", variant: "cornerLeft", label: "Corner, left" }, t)).toBe("Köşe, sol");
    expect(furnitureOwnName({ type: "sofa", label: "Kanepe" })).toBeNull();
  });

  it("drops an old stored name when the piece becomes another type", () => {
    const sofa = { id: "f", type: "sofa" as const, label: "Sofa", x: 0, y: 0, width: 2, height: 1 };
    expect(furnitureName({ ...sofa, ...retypeFurniture(sofa, "chair") }, t)).toBe("Sandalye");
  });

  it("keeps the user's own name as written", () => {
    expect(furnitureName({ type: "sofa", label: "Grandma's couch" }, t)).toBe("Grandma's couch");
    expect(furnitureOwnName({ type: "sofa", label: "  " })).toBeNull();
  });
});
