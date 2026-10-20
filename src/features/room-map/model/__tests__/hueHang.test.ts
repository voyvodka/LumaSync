import { describe, expect, it } from "vitest";

import { DEFAULT_ROOM_MAP, type HueChannelPlacement, type RoomMapConfig } from "@/shared/contracts/roomMap";

import { hangHeight, hueOverhead, isHung, PENDANT_DROP_M } from "../hueHang";

const ROOM: RoomMapConfig = { ...DEFAULT_ROOM_MAP, dimensions: { widthMeters: 5, depthMeters: 4, heightMeters: 2.5 } };
const at = (channelIndex: number, z: number, fixture?: HueChannelPlacement["fixture"]): HueChannelPlacement => ({
  channelIndex,
  x: 0,
  y: 0,
  z,
  ...(fixture ? { fixture } : {}),
});

describe("hangHeight", () => {
  it("puts a ceiling light, a spot and a bulb at the ceiling and a pendant's shade below it", () => {
    expect(hangHeight("ceiling", 2.5)).toBe(2.5);
    expect(hangHeight("spot", 2.5)).toBe(2.5);
    expect(hangHeight("bulb", 2.5)).toBe(2.5);
    expect(hangHeight("pendant", 2.5)).toBe(2.5 - PENDANT_DROP_M);
  });

  it("has no height for a light that stands", () => {
    expect(hangHeight("floorLamp", 2.5)).toBeNull();
    expect(hangHeight("tableLamp", 2.5)).toBeNull();
  });
});

describe("isHung", () => {
  it("takes a pendant anywhere its cord reaches, and the rest only at the ceiling", () => {
    expect(isHung("pendant", 1.5, 2.5)).toBe(true);
    expect(isHung("pendant", 0.4, 2.5)).toBe(false);
    expect(isHung("pendant", 2.45, 2.5)).toBe(false);
    expect(isHung("ceiling", 2.45, 2.5)).toBe(true);
    expect(isHung("ceiling", 1.2, 2.5)).toBe(false);
    expect(isHung("floorLamp", 2.5, 2.5)).toBe(false);
  });
});

describe("hueOverhead", () => {
  it("marks a ceiling light or pendant where it hangs, and any light at the ceiling", () => {
    const channels = [at(0, 1, "ceiling"), at(1, -1), at(2, 1), at(3, 0), at(4, 0.2), at(5, -1, "ceiling")];
    const overhead = hueOverhead(channels, ROOM, new Map([[4, "pendant"]]));
    // A ceiling light a zone holds at the floor is not overhead, whatever the 3D room draws.
    expect([...overhead].sort()).toEqual([0, 2, 4]);
  });
});
