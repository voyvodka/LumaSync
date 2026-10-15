import { describe, expect, it } from "vitest";

import type { TvAnchorPlacement, UsbStripPlacement } from "@/shared/contracts/roomMap";

import { refitRetapedStrip, stripFitOffer } from "../stripFit";

const strip: UsbStripPlacement = { stripId: "s", ledCount: 60, ledsPerMeter: 60, startX: 1, startY: 2, endX: 2, endY: 2 };
const tv: TvAnchorPlacement = { x: 1, y: 0, width: 1.2, height: 0.1 };

describe("refitRetapedStrip", () => {
  it("refits to a new LED count or a new density", () => {
    expect(refitRetapedStrip(strip, { ...strip, ledCount: 90 }, {})).toMatchObject({ endX: 2.5 });
    expect(refitRetapedStrip(strip, { ...strip, ledsPerMeter: 30 }, {})).toMatchObject({ endX: 3 });
  });

  // Onto the wall sends the whole strip, LED count and all; it changed the length of a strip
  // whose run did not match its density.
  it("leaves the run alone when the count and density came back unchanged", () => {
    const long = { ...strip, endX: 4 };
    const moved = { ...long, startY: 0.01, endY: 0.01 };
    expect(refitRetapedStrip(long, moved, {})).toBe(moved);
  });

  // The backlight's count is the screen's perimeter: refit, its middle left the screen.
  it("never refits the TV's backlight", () => {
    const backlight = { ...strip, startX: 1, startY: 0.1, endX: 2.2, endY: 0.1, ledCount: 100 };
    const retaped = { ...backlight, ledsPerMeter: 30 };
    expect(refitRetapedStrip(backlight, retaped, { tvAnchor: tv })).toBe(retaped);
  });
});

describe("stripFitOffer", () => {
  it("offers its LEDs' length when the run is more than a centimetre off it", () => {
    expect(stripFitOffer({ ...strip, endX: 2.5 }, {})).toBe(1);
    expect(stripFitOffer({ ...strip, endX: 2.005 }, {})).toBeUndefined();
    expect(stripFitOffer({ ...strip, ledsPerMeter: null, endX: 3 }, {})).toBeUndefined();
  });

  it("offers nothing a strip could not take: locked, the backlight, or no run to follow", () => {
    expect(stripFitOffer({ ...strip, endX: 3, locked: true }, {})).toBeUndefined();
    expect(stripFitOffer({ ...strip, startX: 1.2, startY: 0.1, endX: 2, endY: 0.1, ledCount: 100 }, { tvAnchor: tv })).toBeUndefined();
    expect(stripFitOffer({ ...strip, endX: 1 }, {})).toBeUndefined();
  });

  it("measures a bent strip along its corners", () => {
    expect(stripFitOffer({ ...strip, endX: 1.5, endY: 2.5, corners: [{ x: 1.5, y: 2 }] }, {})).toBeUndefined();
  });
});
