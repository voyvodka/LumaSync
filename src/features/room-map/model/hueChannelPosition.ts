import type { HueChannelPlacement, HueZone } from "@/shared/contracts/roomMap";

/** A channel carries two positions and only one is live: once `zoneId` is set,
 *  `zoneRelativePosition` wins and absolute `x`/`y` are leftovers the canvas
 *  ignores. Read and write through here. See docs/architecture/room-map.md. */

function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(-1, Math.min(1, value));
}

/** The zone a channel is bound to, or `null` when it uses absolute placement. */
export function findBoundZone(
  channel: HueChannelPlacement,
  zones: readonly HueZone[],
): HueZone | null {
  if (!channel.zoneId) return null;
  return zones.find((z) => z.id === channel.zoneId) ?? null;
}

/** The position the canvas paints — zone-derived when bound, absolute otherwise. */
export function resolveHueChannelWorld(
  channel: HueChannelPlacement,
  zones: readonly HueZone[],
): { x: number; y: number } {
  const zone = findBoundZone(channel, zones);
  if (!zone || !channel.zoneRelativePosition) {
    return { x: channel.x, y: channel.y };
  }
  return {
    x: clampUnit(zone.centerX + zone.scaleX * channel.zoneRelativePosition.x),
    y: clampUnit(zone.centerY + zone.scaleY * channel.zoneRelativePosition.y),
  };
}

/** Move a channel to a world position, writing whichever field is live. A zero
 *  zone scale falls through to absolute rather than dividing into `Infinity`. */
export function moveHueChannelToWorld(
  channel: HueChannelPlacement,
  zones: readonly HueZone[],
  worldX: number,
  worldY: number,
): HueChannelPlacement {
  const x = clampUnit(worldX);
  const y = clampUnit(worldY);
  const zone = findBoundZone(channel, zones);
  if (!zone || !channel.zoneRelativePosition || zone.scaleX === 0 || zone.scaleY === 0) {
    return { ...channel, x, y };
  }
  return {
    ...channel,
    // Keep the absolute pair in step so a later detach lands where the dot is.
    x,
    y,
    zoneRelativePosition: {
      ...channel.zoneRelativePosition,
      x: clampUnit((x - zone.centerX) / zone.scaleX),
      y: clampUnit((y - zone.centerY) / zone.scaleY),
    },
  };
}

/** Height the runtime reads. Rust resolves `center_z + scale_z * relative.z`
 *  for a bound channel, so the absolute `z` is a leftover there too. */
export function resolveHueChannelWorldZ(
  channel: HueChannelPlacement,
  zones: readonly HueZone[],
): number {
  const zone = findBoundZone(channel, zones);
  if (!zone || !channel.zoneRelativePosition) return channel.z;
  return clampUnit(zone.centerZ + zone.scaleZ * channel.zoneRelativePosition.z);
}

/** Set the height, writing whichever field is live. */
export function setHueChannelWorldZ(
  channel: HueChannelPlacement,
  zones: readonly HueZone[],
  worldZ: number,
): HueChannelPlacement {
  const z = clampUnit(worldZ);
  const zone = findBoundZone(channel, zones);
  if (!zone || !channel.zoneRelativePosition || zone.scaleZ === 0) {
    return { ...channel, z };
  }
  return {
    ...channel,
    z,
    zoneRelativePosition: {
      ...channel.zoneRelativePosition,
      z: clampUnit((z - zone.centerZ) / zone.scaleZ),
    },
  };
}

/** Nudge by a world-space delta, applied to whichever position is live. */
export function nudgeHueChannel(
  channel: HueChannelPlacement,
  zones: readonly HueZone[],
  dx: number,
  dy: number,
): HueChannelPlacement {
  const world = resolveHueChannelWorld(channel, zones);
  return moveHueChannelToWorld(channel, zones, world.x + dx, world.y + dy);
}
