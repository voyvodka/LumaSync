import { describe, expect, it } from "vitest";

import type { UsbStripPlacement } from "@/shared/contracts/roomMap";

import { stripForCalibration } from "../calibrationStrip";

function strip(stripId: string, portName?: string, ledCount = 60): UsbStripPlacement {
  return { stripId, startX: 0, startY: 0, endX: 2, endY: 0, ledCount, portName };
}

describe("stripForCalibration", () => {
  it("picks the strip on the connected port", () => {
    const strips = [strip("a", "/dev/a"), strip("b", "/dev/b")];
    expect(stripForCalibration(strips, "/dev/b")?.stripId).toBe("b");
  });

  it("falls back to the only strip, and to nothing when there are several", () => {
    expect(stripForCalibration([strip("a")], null)?.stripId).toBe("a");
    expect(stripForCalibration([strip("a"), strip("b")], null)).toBeNull();
  });
});
