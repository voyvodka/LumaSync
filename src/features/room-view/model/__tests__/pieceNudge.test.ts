import { describe, expect, it } from "vitest";

import { DEFAULT_ROOM_MAP, type RoomMapConfig } from "@/shared/contracts/roomMap";

import { pieceNudge } from "../pieceNudge";

const sofa = { id: "sofa", type: "sofa" as const, x: 1, y: 2, width: 2, height: 0.9 };
const chair = { id: "chair", type: "chair" as const, x: 3, y: 1, width: 0.5, height: 0.5 };
const strip = { stripId: "s", startX: 0, startY: 1, endX: 0, endY: 3, ledCount: 60 };
const built: RoomMapConfig = {
  ...DEFAULT_ROOM_MAP,
  furniture: [sofa, chair],
  usbStrips: [strip],
  tvAnchor: { x: 1.5, y: 0, width: 1.2, height: 0.08 },
};

describe("pieceNudge", () => {
  it("reads a piece, the TV or a strip slid across the floor", () => {
    expect(pieceNudge(built, { ...built, furniture: [{ ...sofa, x: 1.25, y: 1.9 }, chair] })).toEqual({
      objectId: "furniture-sofa",
      dx: 0.25,
      dy: expect.closeTo(-0.1),
    });
    expect(pieceNudge(built, { ...built, tvAnchor: { ...built.tvAnchor!, x: 2 } })).toEqual({ objectId: "tv", dx: 0.5, dy: 0 });
    expect(pieceNudge(built, { ...built, usbStrips: [{ ...strip, startY: 1.5, endY: 3.5 }] })).toEqual({ objectId: "usb-s", dx: 0, dy: 0.5 });
  });

  // Each needs the scene built again: geometry, not a place, changed.
  it("is nothing for a resize, a turn, a strip's one end, two pieces, or any other key", () => {
    expect(pieceNudge(built, { ...built, furniture: [{ ...sofa, width: 2.2 }, chair] })).toBeNull();
    expect(pieceNudge(built, { ...built, furniture: [{ ...sofa, x: 2, rotation: 90 }, chair] })).toBeNull();
    expect(pieceNudge(built, { ...built, usbStrips: [{ ...strip, endY: 3.5 }] })).toBeNull();
    expect(pieceNudge(built, { ...built, furniture: [{ ...sofa, x: 2 }, { ...chair, x: 4 }] })).toBeNull();
    expect(pieceNudge(built, { ...built, furniture: [{ ...sofa, x: 2 }, chair], usbStrips: [{ ...strip }] })).toBeNull();
    expect(pieceNudge(built, { ...built, furniture: [chair, sofa] })).toBeNull();
    expect(pieceNudge(built, { ...built, furniture: [sofa] })).toBeNull();
    expect(pieceNudge(built, { ...built, hueChannels: [] })).toBeNull();
    expect(pieceNudge(built, built)).toBeNull();
    expect(pieceNudge(built, { ...built, tvAnchor: undefined })).toBeNull();
    expect(pieceNudge({ ...built, tvAnchor: undefined }, built)).toBeNull();
    expect(pieceNudge(built, { ...built, furniture: [{ ...sofa, id: "other", x: 2 }, chair] })).toBeNull();
    expect(pieceNudge(built, { ...built, furniture: [{ ...sofa, x: Number.NaN }, chair] })).toBeNull();
    expect(pieceNudge(built, { ...built, usbStrips: [{ ...strip, startY: 1.5, endY: 3.5, corners: [{ x: 0, y: 2 }] }] })).toBeNull();
  });

  it("reads the screen resized or raised a step as a reshape about its built centre", () => {
    const tv = built.tvAnchor!;
    const aboutY = DEFAULT_ROOM_MAP.dimensions.heightMeters * 0.4;
    expect(pieceNudge(built, { ...built, tvAnchor: { ...tv, width: 1.32 } })).toEqual({
      objectId: "tv",
      dx: expect.closeTo(0.06),
      dy: 0,
      reshape: { scaleX: expect.closeTo(1.1), scaleY: expect.closeTo(1.1), aboutY: expect.closeTo(aboutY), raise: 0 },
    });
    expect(pieceNudge(built, { ...built, tvAnchor: { ...tv, mountHeightMeters: aboutY + 0.05 } })).toEqual({
      objectId: "tv",
      dx: 0,
      dy: 0,
      reshape: { scaleX: 1, scaleY: 1, aboutY: expect.closeTo(aboutY), raise: expect.closeTo(0.05) },
    });
  });

  it("builds again for a screen resized or raised too far to stretch, or changed otherwise", () => {
    const tv = built.tvAnchor!;
    expect(pieceNudge(built, { ...built, tvAnchor: { ...tv, width: 1.8 } })).toBeNull();
    expect(pieceNudge(built, { ...built, tvAnchor: { ...tv, mountHeightMeters: 2 } })).toBeNull();
    expect(pieceNudge(built, { ...built, tvAnchor: { ...tv, height: 0.3 } })).toBeNull();
    expect(pieceNudge(built, { ...built, tvAnchor: { ...tv, screenKind: "monitor" } })).toBeNull();
    expect(pieceNudge(built, { ...built, tvAnchor: { ...tv, width: 0 } })).toBeNull();
  });

  it("reads a piece stepped back to where the room was built as a nudge of nothing", () => {
    expect(pieceNudge(built, { ...built, furniture: [{ ...sofa }, chair] })).toEqual({ objectId: "furniture-sofa", dx: 0, dy: 0 });
  });
});
