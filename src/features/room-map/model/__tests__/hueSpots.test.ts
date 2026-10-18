import { describe, expect, it } from "vitest";

import { DEFAULT_ROOM_MAP, type HueChannelPlacement, type RoomMapConfig } from "@/shared/contracts/roomMap";

import { lightsOnSpots } from "../hueSpots";

const light = (channelIndex: number, patch: Partial<HueChannelPlacement> = {}): HueChannelPlacement => ({
  channelIndex,
  entertainmentAreaId: "area-1",
  x: 0,
  y: 0,
  z: 0,
  ...patch,
});
const room = (patch: Partial<RoomMapConfig>): RoomMapConfig => ({
  ...DEFAULT_ROOM_MAP,
  dimensions: { widthMeters: 4, depthMeters: 4, heightMeters: 2 },
  ...patch,
});

describe("lightsOnSpots", () => {
  it("puts the area's lights on the spots in channel order, in the Hue frame", () => {
    const config = room({ hueChannels: [light(1), light(0), light(2, { x: 0.3 })] });
    const next = lightsOnSpots(config, [{ x: 1, y: 0, heightMeters: 1 }, { x: 4, y: 4, heightMeters: 2 }], "area-1");
    const byIndex = new Map(next.hueChannels.map((c) => [c.channelIndex, c]));
    expect(byIndex.get(0)).toMatchObject({ x: -0.5, y: 1, z: 0, zOrigin: "user" });
    expect(byIndex.get(1)).toMatchObject({ x: 1, y: -1, z: 1 });
    // Past the last spot: left where it is.
    expect(byIndex.get(2)!.x).toBe(0.3);
  });

  it("takes a moved light out of its zone and leaves another area's lights alone", () => {
    const config = room({
      hueChannels: [light(0, { zoneId: "z", zoneRelativePosition: { x: 0, y: 0, z: 0 } }), light(0, { entertainmentAreaId: "area-2", x: 0.9 })],
      zones: [{ id: "z", name: "z", entertainmentAreaId: "area-1", centerX: 0, centerY: 0, centerZ: 0, scaleX: 0.5, scaleY: 0.5, scaleZ: 1, channelIndices: [0], borderColor: "#fff" }],
    });
    const next = lightsOnSpots(config, [{ x: 2, y: 2, heightMeters: 1 }], "area-1");
    expect(next.hueChannels[0]).not.toHaveProperty("zoneId");
    expect(next.zones[0]!.channelIndices).toEqual([]);
    expect(next.hueChannels[1]!.x).toBe(0.9);
  });

  it("changes nothing without spots or lights", () => {
    const config = room({ hueChannels: [] });
    expect(lightsOnSpots(config, [{ x: 1, y: 1, heightMeters: 1 }], "area-1")).toBe(config);
  });
});
