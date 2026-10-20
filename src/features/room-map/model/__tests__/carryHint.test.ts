import { describe, expect, it } from "vitest";

import { DEFAULT_ROOM_MAP, type RoomMapConfig } from "@/shared/contracts/roomMap";

import { carryHint } from "../carryHint";

const ctx = { hueAreaId: null };
const room: RoomMapConfig = {
  ...DEFAULT_ROOM_MAP,
  tvAnchor: { x: 2, y: 0, width: 1.2, height: 0.1 },
  furniture: [{ id: "sofa", type: "sofa", x: 1, y: 2, width: 2, height: 0.9 }],
  usbStrips: [{ stripId: "s1", startX: 1, startY: 1, endX: 3, endY: 1, ledCount: 60 }],
  hueChannels: [{ channelIndex: 0, x: 0, y: 0, z: 0 }],
};

describe("carryHint", () => {
  it("turns furniture, and raises the TV and a Hue light", () => {
    expect(carryHint(room, "furniture-sofa", ctx)).toBe("turn");
    expect(carryHint(room, "tv", ctx)).toBe("rise");
    expect(carryHint(room, "hue-0", ctx)).toBe("rise");
  });

  it("has nothing for a strip, a locked piece, a missing one or no selection", () => {
    expect(carryHint(room, "usb-s1", ctx)).toBeNull();
    expect(carryHint({ ...room, tvAnchor: { ...room.tvAnchor!, locked: true } }, "tv", ctx)).toBeNull();
    expect(carryHint({ ...room, furniture: [{ ...room.furniture[0]!, locked: true }] }, "furniture-sofa", ctx)).toBeNull();
    expect(carryHint(room, "furniture-gone", ctx)).toBeNull();
    expect(carryHint(room, "hue-7", ctx)).toBeNull();
    expect(carryHint(room, null, ctx)).toBeNull();
  });
});
