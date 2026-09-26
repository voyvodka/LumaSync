import type { TFunction } from "i18next";
import { describe, expect, it } from "vitest";

import type { DisplayInfo } from "@/shared/contracts/display";

import { displayName } from "../displayName";

const t = ((key: string, options?: { n?: number }) => (options?.n ? `${key}:${options.n}` : key)) as unknown as TFunction;
const display = (id: string, label: string, x: number, isPrimary = false): DisplayInfo => ({
  id,
  label,
  width: 1920,
  height: 1080,
  x,
  y: 0,
  scaleFactor: 1,
  isPrimary,
});

describe("displayName", () => {
  it("keeps a real name", () => {
    const d = display("a", "Built-in Retina Display", 0, true);
    expect(displayName(d, [d], t)).toBe("Built-in Retina Display");
  });

  it("calls a generated primary name the main display", () => {
    const d = display("a", "Monitor #41057", 0, true);
    expect(displayName(d, [d], t)).toBe("calibration:setup.displayMain");
  });

  it("numbers the others from 2, left to right, the main display being 1", () => {
    const main = display("a", "Monitor #1", 0, true);
    const right = display("b", "Monitor #2", 1920);
    const left = display("c", "Monitor #3", -1920);
    expect(displayName(left, [main, right, left], t)).toBe("calibration:setup.displayN:2");
    expect(displayName(right, [main, right, left], t)).toBe("calibration:setup.displayN:3");
  });
});
