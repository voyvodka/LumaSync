import { describe, expect, it } from "vitest";

import { resetToManual } from "../templates";

describe("calibration templates", () => {
  it("resets manual config to zeroed values", () => {
    const config = resetToManual();

    expect(config.templateId).toBeUndefined();
    expect(config.counts).toEqual({
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
    });
    expect(config.bottomMissing).toBe(0);
    expect(config.cornerOwnership).toBe("horizontal");
    expect(config.visualPreset).toBe("vivid");
    expect(config.totalLeds).toBe(0);
  });
});
