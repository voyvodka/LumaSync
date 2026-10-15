import { describe, expect, it } from "vitest";

import { DEFAULT_ROOM_MAP, type RoomMapConfig } from "@/shared/contracts/roomMap";

import { landCarried } from "../carryLanding";

const ctx = { hueAreaId: null };
const base: RoomMapConfig = {
  ...DEFAULT_ROOM_MAP,
  dimensions: { widthMeters: 5, depthMeters: 4, heightMeters: 2.5 },
  tvAnchor: { x: 2, y: 0, width: 1.2, height: 0.1 },
  furniture: [{ id: "sofa", type: "sofa", x: 1, y: 2, width: 2, height: 0.9 }],
  usbStrips: [{ stripId: "s1", startX: 1, startY: 1, endX: 3, endY: 1, ledCount: 60 }],
  hueChannels: [{ channelIndex: 0, x: 0, y: 0, z: 0 }],
};

describe("landCarried", () => {
  it("puts the TV down with its middle where it was let go, inside the walls", () => {
    expect(landCarried(base, "tv", 1, 2, 0, ctx)?.tvAnchor).toMatchObject({ x: 0.4, y: 1.95 });
    expect(landCarried(base, "tv", 9, 2, 0, ctx)?.tvAnchor?.x).toBeCloseTo(3.8);
  });

  // Left behind, the backlight stopped being the screen's and was drawn as a wall line.
  it("takes the TV's backlight strip with it, and leaves any other strip", () => {
    const backlight = { stripId: "bl", startX: 2, startY: 0.1, endX: 3.2, endY: 0.1, ledCount: 40 };
    const patch = landCarried({ ...base, usbStrips: [...base.usbStrips, backlight] }, "tv", 1.6, 0.05, 0, ctx);
    expect(patch?.usbStrips?.find((s) => s.stripId === "bl")).toMatchObject({ startX: 1, endX: 2.2 });
    expect(patch?.usbStrips?.find((s) => s.stripId === "s1")).toEqual(base.usbStrips[0]);
  });

  it("puts a Hue light down at the plan point in the bridge's cube", () => {
    const ch = landCarried(base, "hue-0", 0, 0, 0, ctx)?.hueChannels?.[0];
    // The room's top-left corner is the cube's left wall and TV wall.
    expect(ch).toMatchObject({ x: -1, y: 1 });
  });

  it("slides a strip whole so its middle lands there", () => {
    const strip = landCarried(base, "usb-s1", 2.5, 3, 0, ctx)?.usbStrips?.[0];
    expect(strip).toMatchObject({ startX: 1.5, endX: 3.5, startY: 3, endY: 3 });
  });

  it("turns only furniture, and moves nothing locked", () => {
    expect(landCarried(base, "furniture-sofa", 2.5, 2, 15, ctx)?.furniture?.[0]?.rotation).toBe(15);
    expect(landCarried({ ...base, tvAnchor: { ...base.tvAnchor!, locked: true } }, "tv", 1, 1, 0, ctx)).toBeNull();
  });
});
