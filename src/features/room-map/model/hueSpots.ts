import { HUE_CHANNEL_HEIGHT_ORIGIN, type HueChannelPlacement, type RoomMapConfig } from "@/shared/contracts/roomMap";
import { clamp } from "@/shared/lib/math";

import { planMetresToHue } from "./hueChannelPosition";
import { scopeHueChannels } from "./hueChannelScope";

/** Where a template would put a Hue light, in plan metres and metres above the floor; the first two
 *  flank the screen, where a light follows the picture best. */
export interface HueSpot {
  x: number;
  y: number;
  heightMeters: number;
}

/**
 * The area's lights put on the spots in channel order, one each; lights past the last spot stay
 * where they are. A light moved onto a spot leaves its zone, since the spot is a place in the room.
 */
export function lightsOnSpots(config: RoomMapConfig, spots: readonly HueSpot[], hueAreaId: string | null): RoomMapConfig {
  const area = [...scopeHueChannels(config.hueChannels, hueAreaId)].sort((a, b) => a.channelIndex - b.channelIndex);
  const { widthMeters, depthMeters, heightMeters } = config.dimensions;
  const moved = new Map<HueChannelPlacement, HueChannelPlacement>();
  area.slice(0, spots.length).forEach((channel, i) => {
    const spot = spots[i]!;
    const at = planMetresToHue(spot.x, spot.y, widthMeters, depthMeters);
    const { zoneId: _zone, zoneRelativePosition: _rel, ...rest } = channel;
    moved.set(channel, {
      ...rest,
      x: clamp(at.x, -1, 1),
      y: clamp(at.y, -1, 1),
      z: clamp((spot.heightMeters / heightMeters) * 2 - 1, -1, 1),
      zOrigin: HUE_CHANNEL_HEIGHT_ORIGIN.USER,
    });
  });
  if (moved.size === 0) return config;
  const unbound = new Set([...moved.keys()].map((channel) => `${channel.entertainmentAreaId ?? ""}:${channel.channelIndex}`));
  return {
    ...config,
    hueChannels: config.hueChannels.map((channel) => moved.get(channel) ?? channel),
    zones: (config.zones ?? []).map((zone) => ({
      ...zone,
      channelIndices: zone.channelIndices.filter((index) => !unbound.has(`${zone.entertainmentAreaId ?? ""}:${index}`)),
    })),
  };
}
