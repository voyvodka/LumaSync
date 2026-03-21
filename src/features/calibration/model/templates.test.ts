import { describe, expect, it } from "vitest";

import { applyTemplate, CALIBRATION_TEMPLATES, resetToManual } from "./templates";

describe("calibration templates", () => {
  it("contains at least five hardcoded monitor templates", () => {
    expect(CALIBRATION_TEMPLATES.length).toBeGreaterThanOrEqual(5);
  });

  it("applies 27-inch 16:9 template with expected defaults", () => {
    const config = applyTemplate("monitor-27-16-9");

    expect(config.templateId).toBe("monitor-27-16-9");
    expect(config.counts).toEqual({
      top: 36,
      right: 22,
      bottom: 34,
      left: 22,
    });
    expect(config.bottomMissing).toBe(0);
    expect(config.cornerOwnership).toBe("horizontal");
    expect(config.visualPreset).toBe("vivid");
    expect(config.startAnchor).toBe("top-start");
    expect(config.direction).toBe("cw");
    expect(config.totalLeds).toBe(114);
  });

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
