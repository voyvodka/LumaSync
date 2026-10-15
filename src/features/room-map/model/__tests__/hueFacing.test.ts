import { describe, expect, it } from "vitest";

import { DEFAULT_ROOM_MAP, type RoomMapConfig } from "@/shared/contracts/roomMap";

import { hueFacings } from "../hueFacing";

const room: RoomMapConfig = {
  ...DEFAULT_ROOM_MAP,
  hueChannels: [
    { channelIndex: 0, x: -0.95, y: 0, z: 0 },
    { channelIndex: 1, x: 0.95, y: 0, z: 0, facing: 45 },
    { channelIndex: 2, x: 0, y: 0, z: 0 },
  ],
};

describe("hueFacings", () => {
  it("faces a one-sided light at its nearest wall unless one is stored, and gives an all-round light none", () => {
    const facings = hueFacings(room.hueChannels, room, new Map([[0, "playBar"], [1, "iris"], [2, "floorLamp"]]));
    expect(facings.get(0)).toBe(270);
    expect(facings.get(1)).toBe(45);
    expect(facings.has(2)).toBe(false);
  });

  it("follows a model the map stored over the one the bridge names", () => {
    const stored = { ...room, hueChannels: [{ ...room.hueChannels[2]!, fixture: "bloom" as const }] };
    expect(hueFacings(stored.hueChannels, stored, new Map([[2, "floorLamp"]])).has(2)).toBe(true);
  });
});
