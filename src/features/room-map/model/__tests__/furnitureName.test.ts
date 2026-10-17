import type { TFunction } from "i18next";
import { describe, expect, it } from "vitest";

import { furnitureName, furnitureOwnName } from "../furnitureName";

const NAMES: Record<string, Record<string, string>> = {
  en: { "roomMap:furniture.type.sofa": "Sofa", "roomMap:furniture.variant.cornerLeft": "Corner sofa (left)" },
  tr: { "roomMap:furniture.type.sofa": "Kanepe", "roomMap:furniture.variant.cornerLeft": "Köşe kanepe (sol)" },
};
const inLanguage = (current: string) =>
  ((key: string, options?: { lng?: string }) => NAMES[options?.lng ?? current]?.[key] ?? key) as unknown as TFunction;

describe("furnitureName", () => {
  it("calls a piece with no name of its own by its model, then its type, in the app's language", () => {
    expect(furnitureName({ type: "sofa", variant: "cornerLeft" }, inLanguage("tr"))).toBe("Köşe kanepe (sol)");
    expect(furnitureName({ type: "sofa" }, inLanguage("tr"))).toBe("Kanepe");
  });

  // Maps saved before names followed the language stored the type's name in the language of the day.
  it("reads a stored default name from any language as no name, so it follows a switch", () => {
    expect(furnitureName({ type: "sofa", label: "Sofa" }, inLanguage("tr"))).toBe("Kanepe");
    expect(furnitureName({ type: "sofa", variant: "cornerLeft", label: "Corner sofa (left)" }, inLanguage("tr"))).toBe("Köşe kanepe (sol)");
    expect(furnitureOwnName({ type: "sofa", label: "Kanepe" }, inLanguage("en"))).toBeNull();
  });

  it("keeps the user's own name as written", () => {
    expect(furnitureName({ type: "sofa", label: "Grandma's couch" }, inLanguage("tr"))).toBe("Grandma's couch");
    expect(furnitureOwnName({ type: "sofa", label: "  " }, inLanguage("en"))).toBeNull();
  });
});
