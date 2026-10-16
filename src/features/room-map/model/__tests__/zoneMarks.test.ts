import { describe, expect, it } from "vitest";

import { DEFAULT_ROOM_MAP, type HueChannelPlacement, type HueZone, type RoomMapConfig } from "@/shared/contracts/roomMap";

import { hueChannelObjectId } from "../objectId";
import { zoneMarks } from "../zoneMarks";

const bound: HueChannelPlacement = { channelIndex: 3, x: 0, y: 0, z: 0, zoneId: "b", zoneRelativePosition: { x: 0, y: 0, z: 0 } };
const zone = (id: string): HueZone => ({ id, name: id, entertainmentAreaId: "x", centerX: 0, centerY: 0, centerZ: 0, scaleX: 0.5, scaleY: 0.5, scaleZ: 0.5, channelIndices: [] });
const config: RoomMapConfig = { ...DEFAULT_ROOM_MAP, zones: [zone("a"), zone("b"), zone("c")], hueChannels: [bound, { channelIndex: 4, x: 0, y: 0, z: 0 }] };
const ids = ["a", "b", "c"];

describe("zoneMarks", () => {
  it("names the zone being edited over the selected light's", () => {
    expect(zoneMarks(config, ids, "a", hueChannelObjectId(3), false)).toEqual({ active: "a", others: [] });
  });

  it("falls back to the zone the selected light is bound to, and to none for a loose one", () => {
    expect(zoneMarks(config, ids, null, hueChannelObjectId(3), false).active).toBe("b");
    expect(zoneMarks(config, ids, null, hueChannelObjectId(4), false).active).toBeNull();
    expect(zoneMarks(config, ids, null, "tv", false).active).toBeNull();
  });

  it("adds the area's other zones only with the zones toggle", () => {
    expect(zoneMarks(config, ids, "b", null, true).others).toEqual(["a", "c"]);
  });
});
