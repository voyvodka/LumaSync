import { describe, expect, it } from "vitest";

import { applyTemplate, CALIBRATION_TEMPLATES, deriveDefaultCounts, resetToManual } from "../templates";

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

  it("derives sensible default counts from monitor resolution", () => {
    const fullHd = deriveDefaultCounts({ width: 1920, height: 1080 });
    expect(fullHd.top).toBeGreaterThan(0);
    expect(fullHd.top).toBe(fullHd.bottom);
    expect(fullHd.left).toBe(fullHd.right);

    const qhd = deriveDefaultCounts({ width: 2560, height: 1440 });
    expect(qhd.top).toBeGreaterThan(fullHd.top);

    const ultrawide = deriveDefaultCounts({ width: 3440, height: 1440 });
    expect(ultrawide.top).toBeGreaterThan(qhd.top);
    expect(ultrawide.top / ultrawide.left).toBeGreaterThan(qhd.top / qhd.left);
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
