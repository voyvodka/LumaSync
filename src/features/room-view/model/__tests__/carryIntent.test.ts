import { describe, expect, it } from "vitest";

import { pressStartsCarry } from "../carryIntent";

describe("pressStartsCarry", () => {
  const sofa = { id: "furniture-sofa", kind: "furniture" as const };

  // Turning the room from over the sofa carried the sofa.
  it("leaves a press on a piece that is not selected to turn the room", () => {
    expect(pressStartsCarry(sofa, null)).toBe(false);
    expect(pressStartsCarry(sofa, "furniture-table")).toBe(false);
  });

  it("carries the selected piece", () => {
    expect(pressStartsCarry(sofa, "furniture-sofa")).toBe(true);
  });

  it("carries the TV and the lights too, and nothing on empty floor", () => {
    expect(pressStartsCarry({ id: "hue-0", kind: "light" }, "hue-0")).toBe(true);
    expect(pressStartsCarry({ id: "tv", kind: "tv" }, "tv")).toBe(true);
    expect(pressStartsCarry(undefined, null)).toBe(false);
  });
});
