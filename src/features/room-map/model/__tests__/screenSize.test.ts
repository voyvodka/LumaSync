import { describe, expect, it } from "vitest";

import { screenDiagonal, widthForDiagonal } from "../screenSize";

describe("screen size", () => {
  it("reads a 55-inch 16:9 screen from its width and back", () => {
    const width = widthForDiagonal(55, 9 / 16, "inch");
    expect(width).toBeCloseTo(1.2176, 4);
    expect(Math.round(screenDiagonal(width, 9 / 16, "inch"))).toBe(55);
    expect(Math.round(screenDiagonal(width, 9 / 16, "cm"))).toBe(140);
  });

  it("keeps the diagonal across a change of shape: an ultrawide of the same size is wider", () => {
    expect(widthForDiagonal(34, 9 / 21, "inch")).toBeGreaterThan(widthForDiagonal(34, 9 / 16, "inch"));
  });
});
