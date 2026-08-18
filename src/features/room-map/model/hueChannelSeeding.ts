// Where a live bridge channel meets its persisted placement. Two surfaces do
// this now — the Devices panel and the room map — and a second implementation
// is how they would start disagreeing about which channel is which.

import type { HueAreaChannelInfo } from "@/shared/contracts/hue";
import type { HueChannelPlacement, HueZone } from "@/shared/contracts/roomMap";
import { findHueChannel } from "@/shared/contracts/roomMap";

import { resolveHueChannelWorld, resolveHueChannelWorldZ } from "./hueChannelPosition";

/** The saved record for a bridge channel, or a fresh one seeded from the bridge.
 *  Returning the whole record is the point — handing back a `{x,y,z}` triple is
 *  what let callers rebuild a four-field literal and drop `zoneId`. */
export function resolveChannelPlacement(
  ch: HueAreaChannelInfo,
  placements: readonly HueChannelPlacement[],
  zones: readonly HueZone[],
): HueChannelPlacement {
  const saved = findHueChannel(placements, ch.index);
  // Stamped on both branches: this is the only place a placement meets the live
  // channel it belongs to, so it is the only place the bridge's own id can be
  // learned. Without it the write-back has nothing to address and refuses.
  if (!saved) {
    return {
      channelIndex: ch.index,
      channelId: ch.channelId,
      x: ch.positionX,
      y: ch.positionY,
      z: 0,
    };
  }
  // Editors work in world coordinates, so a bound channel's absolute pair is
  // refreshed from its zone before it is shown.
  return {
    ...saved,
    channelId: ch.channelId,
    ...resolveHueChannelWorld(saved, zones),
    z: resolveHueChannelWorldZ(saved, zones),
  };
}

export interface ChannelSeedResult {
  resolved: HueChannelPlacement[];
  /** True when the store is behind the bridge — a channel it has never seen, or
   *  one saved before placements carried the bridge's id. */
  needsWrite: boolean;
}

/** Reconcile the bridge's channel list against what is stored. */
export function seedChannelPlacements(
  channels: readonly HueAreaChannelInfo[],
  placements: readonly HueChannelPlacement[],
  zones: readonly HueZone[],
): ChannelSeedResult {
  const resolved = channels.map((ch) => resolveChannelPlacement(ch, placements, zones));
  const needsWrite = resolved.some((p) => {
    const stored = findHueChannel(placements, p.channelIndex);
    return !stored || stored.channelId !== p.channelId;
  });
  return { resolved, needsWrite };
}

/** Bridge ids the area currently reports. A stored placement whose `channelId`
 *  is missing here is a ghost — the light has left the area. */
export function liveChannelIdSet(channels: readonly HueAreaChannelInfo[]): Set<number> {
  return new Set(channels.map((ch) => ch.channelId));
}
