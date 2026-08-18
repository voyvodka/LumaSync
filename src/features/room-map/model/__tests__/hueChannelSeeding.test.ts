import { describe, expect, it } from "vitest";

import type { HueAreaChannelInfo } from "@/shared/contracts/hue";
import type { HueChannelPlacement, HueZone } from "@/shared/contracts/roomMap";

import {
  liveChannelIdSet,
  resolveChannelPlacement,
  seedChannelPlacements,
} from "../hueChannelSeeding";

/** Gapped on purpose: a contiguous fixture passes whether or not the code keeps
 *  the ordinal and the bridge id apart. */
const CHANNELS: HueAreaChannelInfo[] = [0, 2, 5].map((channelId, i) => ({
  index: i,
  channelId,
  lightIds: [`light-${channelId}`],
  positionX: i - 1,
  positionY: 0,
  lightCount: 2,
  autoRegion: "center",
}));

const ZONE: HueZone = {
  id: "zone-1",
  name: "TV wall",
  entertainmentAreaId: "area-1",
  centerX: 0,
  centerY: 0,
  centerZ: 0,
  scaleX: 1,
  scaleY: 1,
  scaleZ: 0.5,
  channelIndices: [0],
};

describe("resolveChannelPlacement", () => {
  it("seeds an unseen channel from the bridge, stamped with the bridge's id", () => {
    const p = resolveChannelPlacement(CHANNELS[2]!, [], []);
    expect(p).toEqual({ channelIndex: 2, channelId: 5, x: 1, y: 0, z: 0 });
  });

  it("keeps everything the stored record carries instead of rebuilding it", () => {
    const saved: HueChannelPlacement = {
      channelIndex: 0,
      x: 0.2,
      y: 0.3,
      z: 0,
      label: "Sofa lamp",
      locked: true,
    };
    const p = resolveChannelPlacement(CHANNELS[0]!, [saved], []);
    expect(p.label).toBe("Sofa lamp");
    expect(p.locked).toBe(true);
  });

  it("stamps the bridge id onto a record saved before ids existed", () => {
    const saved: HueChannelPlacement = { channelIndex: 1, x: 0, y: 0, z: 0 };
    expect(resolveChannelPlacement(CHANNELS[1]!, [saved], []).channelId).toBe(2);
  });

  it("reports a zone-bound channel where its zone puts it, not at its stale pair", () => {
    const bound: HueChannelPlacement = {
      channelIndex: 0,
      channelId: 0,
      x: -0.9,
      y: -0.9,
      z: 0,
      zoneId: "zone-1",
      zoneRelativePosition: { x: 1, y: 0, z: 1 },
    };
    const p = resolveChannelPlacement(CHANNELS[0]!, [bound], [ZONE]);
    expect(p.x).toBeCloseTo(1, 6);
    expect(p.y).toBeCloseTo(0, 6);
    // centerZ 0 + scaleZ 0.5 * relative 1 ⇒ 0.5
    expect(p.z).toBeCloseTo(0.5, 6);
  });
});

describe("seedChannelPlacements", () => {
  it("asks for a write when the store has never seen a channel", () => {
    expect(seedChannelPlacements(CHANNELS, [], []).needsWrite).toBe(true);
  });

  it("asks for a write when a stored record predates bridge ids", () => {
    const stored = CHANNELS.map((ch) => ({ channelIndex: ch.index, x: 0, y: 0, z: 0 }));
    expect(seedChannelPlacements(CHANNELS, stored, []).needsWrite).toBe(true);
  });

  it("stays quiet once every channel is stored with its own bridge id", () => {
    const stored = CHANNELS.map((ch) => ({
      channelIndex: ch.index,
      channelId: ch.channelId,
      x: ch.positionX,
      y: ch.positionY,
      z: 0,
    }));
    expect(seedChannelPlacements(CHANNELS, stored, []).needsWrite).toBe(false);
  });

  it("returns one record per live channel, in the bridge's order", () => {
    const { resolved } = seedChannelPlacements(CHANNELS, [], []);
    expect(resolved.map((p) => p.channelId)).toEqual([0, 2, 5]);
  });
});

describe("liveChannelIdSet", () => {
  it("collects the bridge ids, not our ordinals", () => {
    expect([...liveChannelIdSet(CHANNELS)].sort((a, b) => a - b)).toEqual([0, 2, 5]);
  });
});
