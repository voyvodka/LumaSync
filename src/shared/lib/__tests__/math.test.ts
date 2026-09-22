import { describe, expect, it } from "vitest";

import { roundTo } from "../math";

describe("roundTo", () => {
  it("removes f32 noise from a value that crossed the IPC boundary", () => {
    expect(roundTo(Math.fround(2.1), 3)).toBe(2.1);
    expect(String(roundTo(Math.fround(2.1), 3))).toBe("2.1");
  });

  it("rounds to the requested precision", () => {
    expect(roundTo(1.23456, 2)).toBe(1.23);
    expect(roundTo(-0.456, 1)).toBe(-0.5);
    expect(roundTo(3, 2)).toBe(3);
  });
});
