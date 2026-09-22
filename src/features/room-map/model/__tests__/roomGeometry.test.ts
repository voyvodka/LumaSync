import { describe, expect, it } from "vitest";

import { toChannelPlacements } from "@/features/hue/model/hueStartConfig";
import { DEFAULT_ROOM_MAP, type RoomMapConfig } from "@/shared/contracts/roomMap";

import { toRoomGeometry } from "../roomGeometry";

const zones = [
  { id: "z1", name: "Z", entertainmentAreaId: "area-1", channelIndices: [1],
    centerX: 0.5, centerY: 0, centerZ: 0, scaleX: 0.25, scaleY: 0.25, scaleZ: 0.25 },
] as RoomMapConfig["zones"];

function roomWith(overrides: Partial<RoomMapConfig>): RoomMapConfig {
  return { ...DEFAULT_ROOM_MAP, ...overrides };
}

const tvAnchor = { x: 1.5, y: 0, width: 2, height: 0.3, locked: true };

describe("toRoomGeometry", () => {
  it("is undefined without a TV anchor, so the worker keeps the legacy path", () => {
    expect(toRoomGeometry({ roomMap: undefined, lastHueAreaId: "area-1" })).toBeUndefined();
    expect(
      toRoomGeometry({
        roomMap: roomWith({
          hueChannels: [{ channelIndex: 0, channelId: 3, x: 0, y: 0, z: 0, entertainmentAreaId: "area-1" }],
        }),
        lastHueAreaId: "area-1",
      }),
    ).toBeUndefined();
  });

  it("projects dimensions and the TV without the editor-only lock", () => {
    const geometry = toRoomGeometry({
      roomMap: roomWith({ tvAnchor: { ...tvAnchor, mountHeightMeters: 1.1 } }),
      lastHueAreaId: "area-1",
    });

    expect(geometry).toEqual({
      dimensions: { widthMeters: 5, depthMeters: 4, heightMeters: 2.5 },
      tv: { x: 1.5, y: 0, width: 2, height: 0.3, mountHeightMeters: 1.1 },
      huePlacements: [],
    });
    expect(geometry?.tv).not.toHaveProperty("locked");
  });

  it("leaves an unset mount height absent so the runtime default follows the room", () => {
    const geometry = toRoomGeometry({ roomMap: roomWith({ tvAnchor }), lastHueAreaId: "area-1" });
    expect(geometry?.tv).not.toHaveProperty("mountHeightMeters");
  });

  it("carries exactly the stream start's placements, zone-bound and unknown-height alike", () => {
    const roomMap = roomWith({
      tvAnchor,
      zones,
      hueChannels: [
        // Zone-bound: the zone-relative position is authoritative.
        {
          channelIndex: 1, channelId: 7, x: 0, y: 0, z: 0, zOrigin: "user",
          entertainmentAreaId: "area-1", zoneId: "z1", zoneRelativePosition: { x: 1, y: 0, z: 1 },
        },
        // Unknown origin: the stored `0` may be a placeholder, so no positionZ.
        { channelIndex: 2, channelId: 8, x: -0.4, y: 0.2, z: 0, entertainmentAreaId: "area-1" },
        // Another area's channel stays out.
        { channelIndex: 0, channelId: 9, x: 0.1, y: 0.1, z: 0.1, zOrigin: "user", entertainmentAreaId: "area-2" },
      ],
    });

    const geometry = toRoomGeometry({ roomMap, lastHueAreaId: "area-1" });

    expect(geometry?.huePlacements).toEqual(toChannelPlacements(roomMap, "area-1"));
    expect(geometry?.huePlacements).toEqual([
      { channelId: 7, positionX: 0.75, positionY: 0, positionZ: 0.25 },
      { channelId: 8, positionX: -0.4, positionY: 0.2 },
    ]);
  });

  it("sends no placements without an area, leaving the stream's own positions", () => {
    const roomMap = roomWith({
      tvAnchor,
      hueChannels: [{ channelIndex: 0, channelId: 3, x: 0, y: 0, z: 0, zOrigin: "user" }],
    });
    expect(toRoomGeometry({ roomMap, lastHueAreaId: undefined })?.huePlacements).toEqual([]);
    expect(toRoomGeometry({ roomMap, lastHueAreaId: "  " })?.huePlacements).toEqual([]);
  });
});
