import { describe, expect, it } from "vitest";

import { stripCentre, type TvAnchorPlacement, type UsbStripPlacement } from "@/shared/contracts/roomMap";

import { backlightBinding, isBacklightStrip, moveTvWithBacklight, seatBacklight } from "../backlight";

const tv: TvAnchorPlacement = { x: 2, y: 0, width: 1.2, height: 0.1 };
const behind: UsbStripPlacement = { stripId: "bl", startX: 2, startY: 0.1, endX: 3.2, endY: 0.1, ledCount: 40 };
const across: UsbStripPlacement = { stripId: "far", startX: 0, startY: 3, endX: 1, endY: 3, ledCount: 60 };
const strips = [behind, across];
const same = (s: UsbStripPlacement) => s;

describe("backlightBinding", () => {
  it("reads absent and a missing strip as proximity, null as none, a strip id as that strip", () => {
    expect(backlightBinding({ tvAnchor: tv, usbStrips: strips })).toBe("near");
    expect(backlightBinding({ tvAnchor: { ...tv, backlightStripId: "gone" }, usbStrips: strips })).toBe("near");
    expect(backlightBinding({ tvAnchor: { ...tv, backlightStripId: null }, usbStrips: strips })).toBe("none");
    expect(backlightBinding({ tvAnchor: { ...tv, backlightStripId: "far" }, usbStrips: strips })).toEqual({ strip: across });
  });
});

describe("isBacklightStrip", () => {
  it("is every strip near the screen unbound, and the bound one alone once bound", () => {
    expect(isBacklightStrip(behind, { tvAnchor: tv, usbStrips: strips })).toBe(true);
    expect(isBacklightStrip(across, { tvAnchor: tv, usbStrips: strips })).toBe(false);
    const bound = { tvAnchor: { ...tv, backlightStripId: "far" }, usbStrips: strips };
    expect(isBacklightStrip(across, bound)).toBe(true);
    expect(isBacklightStrip(behind, bound)).toBe(false);
    expect(isBacklightStrip(behind, { tvAnchor: { ...tv, backlightStripId: null }, usbStrips: strips })).toBe(false);
    expect(isBacklightStrip(behind, { usbStrips: strips })).toBe(false);
  });
});

describe("moveTvWithBacklight", () => {
  it("carries the strips near the screen by the move, and leaves a bound one to its seat", () => {
    const moved = moveTvWithBacklight(strips, tv, { ...tv, x: 2.5 }, same);
    expect(moved?.[0]).toMatchObject({ startX: 2.5, endX: 3.7 });
    expect(moved?.[1]).toBe(across);
    expect(moveTvWithBacklight(strips, { ...tv, backlightStripId: "far" }, { ...tv, x: 2.5, backlightStripId: "far" }, same)).toBeNull();
  });
});

describe("seatBacklight", () => {
  it("puts the bound strip's middle on the screen's, its shape kept", () => {
    const seated = seatBacklight({ tvAnchor: { ...tv, backlightStripId: "far" }, usbStrips: strips }, same);
    const far = seated?.find((s) => s.stripId === "far");
    expect(stripCentre(far!)).toEqual({ x: 2.6, y: 0.05 });
    expect(far!.endX - far!.startX).toBeCloseTo(1);
    expect(seated?.[0]).toBe(behind);
  });

  it("seats a locked strip too, since it would still be drawn as the backlight", () => {
    const seated = seatBacklight({ tvAnchor: { ...tv, backlightStripId: "far" }, usbStrips: [{ ...across, locked: true }] }, same);
    expect(stripCentre(seated![0])).toEqual({ x: 2.6, y: 0.05 });
  });

  it("writes nothing when it already sits there or nothing is bound", () => {
    const sitting = { ...across, startX: 2.1, startY: 0.05, endX: 3.1, endY: 0.05 };
    expect(seatBacklight({ tvAnchor: { ...tv, backlightStripId: "far" }, usbStrips: [sitting] }, same)).toBeNull();
    expect(seatBacklight({ tvAnchor: tv, usbStrips: strips }, same)).toBeNull();
  });
});
