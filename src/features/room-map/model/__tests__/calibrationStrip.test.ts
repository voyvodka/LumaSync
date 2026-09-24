// "LED counts from the map" shared out `usbStrips[0].ledCount`, stamped once
// at connect — so a strip re-set in LED Setup to 164 still derived from 60.
import { describe, expect, it } from "vitest";

import type { UsbStripPlacement } from "@/shared/contracts/roomMap";

import { deriveSource, stripForCalibration } from "../calibrationStrip";

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

describe("deriveSource", () => {
  it("shares out the saved LED Setup total, not the strip's stale count", () => {
    expect(deriveSource([strip("a", "/dev/a", 60)], "/dev/a", 164)).toEqual({
      strip: expect.objectContaining({ stripId: "a" }),
      totalLeds: 164,
    });
  });

  it("uses the strip's own count before LED Setup has been saved", () => {
    expect(deriveSource([strip("a", undefined, 72)], null, null)?.totalLeds).toBe(72);
  });

  it("prefers the connected strip over the first one", () => {
    const source = deriveSource([strip("a", "/dev/a"), strip("b", "/dev/b")], "/dev/b", 100);
    expect(source?.strip.stripId).toBe("b");
  });

  it("has nothing to derive from without a strip", () => {
    expect(deriveSource([], null, 100)).toBeNull();
  });
});
