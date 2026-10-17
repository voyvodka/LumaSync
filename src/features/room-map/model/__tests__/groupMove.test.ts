import { describe, expect, it } from "vitest";

import { DEFAULT_ROOM_MAP, type HueZone, type RoomMapConfig } from "@/shared/contracts/roomMap";

import { moveGroup } from "../groupMove";
import { resolveHueChannelWorld } from "../hueChannelPosition";
import { furnitureObjectId, hueChannelObjectId, TV_ANCHOR_OBJECT_ID, usbStripObjectId } from "../objectId";

const zone: HueZone = {
  id: "z",
  name: "z",
  entertainmentAreaId: "a",
  centerX: 0,
  centerY: 0,
  centerZ: 0,
  scaleX: 0.5,
  scaleY: 0.5,
  scaleZ: 1,
  channelIndices: [0],
  borderColor: "#fff",
};
const room = (patch: Partial<RoomMapConfig>): RoomMapConfig => ({
  ...DEFAULT_ROOM_MAP,
  dimensions: { widthMeters: 4, depthMeters: 4, heightMeters: 2.6 },
  ...patch,
});

describe("moveGroup", () => {
  it("moves a zone-bound light where it is drawn, and only the viewed area's", () => {
    const cfg = room({
      zones: [zone],
      hueChannels: [
        { channelIndex: 0, entertainmentAreaId: "a", x: 0.9, y: 0.9, z: 0, zoneId: "z", zoneRelativePosition: { x: 0, y: 0, z: 0 } },
        { channelIndex: 0, entertainmentAreaId: "b", x: 0, y: 0, z: 0 },
      ],
    });
    const next = moveGroup(cfg, new Set([hueChannelObjectId(0)]), "a", 0.5, 0);
    expect(resolveHueChannelWorld(next.hueChannels[0]!, cfg.zones).x).toBeCloseTo(0.25);
    expect(next.hueChannels[1]).toBe(cfg.hueChannels[1]);
  });

  it("keeps pieces inside the walls", () => {
    const cfg = room({ furniture: [{ id: "sofa", type: "sofa", x: 1.5, y: 1, width: 2, height: 1 }] });
    expect(moveGroup(cfg, new Set([furnitureObjectId("sofa")]), null, 1, 0).furniture[0]!.x).toBe(2);
  });

  it("takes the screen's backlight with it, once", () => {
    const behind = { stripId: "bl", startX: 1, startY: 0.1, endX: 2.2, endY: 0.1, ledCount: 40 };
    const cfg = room({ tvAnchor: { x: 1, y: 0, width: 1.2, height: 0.1 }, usbStrips: [behind] });
    expect(moveGroup(cfg, new Set([TV_ANCHOR_OBJECT_ID]), null, 0.5, 0).usbStrips[0]).toMatchObject({ startX: 1.5, endX: 2.7 });
    const both = moveGroup(cfg, new Set([TV_ANCHOR_OBJECT_ID, usbStripObjectId("bl")]), null, 0.5, 0);
    expect(both.usbStrips[0]).toMatchObject({ startX: 1.5, endX: 2.7 });
  });
});
