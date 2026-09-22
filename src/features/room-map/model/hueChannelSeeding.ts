// Where a live bridge channel meets its persisted placement. Two surfaces do
// this now — the Devices panel and the room map — and a second implementation
// is how they would start disagreeing about which channel is which.

import type { HueAreaChannelInfo } from "@/shared/contracts/hue";
import type { HueChannelPlacement, HueZone } from "@/shared/contracts/roomMap";
import { HUE_CHANNEL_HEIGHT_ORIGIN, findHueChannel } from "@/shared/contracts/roomMap";

import {
  moveHueChannelToWorld,
  resolveHueChannelWorld,
  resolveHueChannelWorldZ,
  setHueChannelWorldZ,
} from "./hueChannelPosition";

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
      ...(ch.positionZ !== null
        ? { z: ch.positionZ, zOrigin: HUE_CHANNEL_HEIGHT_ORIGIN.BRIDGE }
        : { z: 0, zOrigin: null }),
    };
  }
  // Editors work in world coordinates, so a bound channel's absolute pair is
  // refreshed from its zone before it is shown.
  return {
    ...saved,
    channelId: ch.channelId,
    ...resolveHueChannelWorld(saved, zones),
    z: resolveHueChannelWorldZ(saved, zones),
    ...legacyHeight(saved, ch),
  };
}

/** Take the bridge's position for a channel, height included when the bridge
 *  reports one, writing whichever fields are live — a zone-bound channel's
 *  `zoneRelativePosition` is re-derived, and clamps where its zone cannot
 *  reach the bridge's position. The height is stamped as the bridge's. */
export function adoptBridgePlacement(
  placement: HueChannelPlacement,
  ch: HueAreaChannelInfo,
  zones: readonly HueZone[],
): HueChannelPlacement {
  const moved = moveHueChannelToWorld(placement, zones, ch.positionX, ch.positionY);
  const placed =
    ch.positionZ === null
      ? moved
      : setHueChannelWorldZ(moved, zones, ch.positionZ, HUE_CHANNEL_HEIGHT_ORIGIN.BRIDGE);
  return { ...placed, channelId: ch.channelId };
}

/** Provenance for a record saved before heights were tracked. Seeding wrote
 *  `z: 0` for every channel, so a legacy `0` is a placeholder the bridge's own
 *  height may replace, while any other value was set by hand. A zone-bound
 *  record is left alone: its height is the zone's, not a seeded default.
 *  See docs/architecture/room-map.md. */
function legacyHeight(
  saved: HueChannelPlacement,
  ch: HueAreaChannelInfo,
): Pick<HueChannelPlacement, "z" | "zOrigin"> | null {
  if (saved.zOrigin || saved.zoneId) return null;
  if (saved.z !== 0) return { z: saved.z, zOrigin: HUE_CHANNEL_HEIGHT_ORIGIN.USER };
  if (ch.positionZ === null) return null;
  return { z: ch.positionZ, zOrigin: HUE_CHANNEL_HEIGHT_ORIGIN.BRIDGE };
}

export interface ChannelSeedResult {
  resolved: HueChannelPlacement[];
  /** True when the store is behind the bridge — a channel it has never seen,
   *  one saved before placements carried the bridge's id, or one whose height
   *  provenance was just settled. */
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
    return (
      !stored ||
      stored.channelId !== p.channelId ||
      (stored.zOrigin ?? null) !== (p.zOrigin ?? null)
    );
  });
  return { resolved, needsWrite };
}

/** Bridge ids the area currently reports. A stored placement whose `channelId`
 *  is missing here is a ghost — the light has left the area. */
export function liveChannelIdSet(channels: readonly HueAreaChannelInfo[]): Set<number> {
  return new Set(channels.map((ch) => ch.channelId));
}
