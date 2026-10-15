// Which way a one-sided Hue light faces on the plan, as the 3D room draws it.
import { type LampFamily, ONE_SIDED } from "@/features/room-view/model/lampFamily";
import { nearestWallFacingDegrees } from "@/features/room-view/model/roomOutline";
import { type HueChannelPlacement, type RoomMapConfig, resolveHueFacing, resolveHueFixture, resolveRoomFootprint } from "@/shared/contracts/roomMap";

import { hueToPlanMetres, resolveHueChannelWorld } from "./hueChannelPosition";

/** The facing an unset light takes: toward the wall it stands nearest. */
export function autoHueFacing(channel: HueChannelPlacement, config: RoomMapConfig): number {
  const { widthMeters: w, depthMeters: d } = config.dimensions;
  const plan = hueToPlanMetres(resolveHueChannelWorld(channel, config.zones), w, d);
  const footprint = resolveRoomFootprint(config);
  return nearestWallFacingDegrees(plan.x, plan.y, w, d, footprint.length > 4 ? footprint : null);
}

/** Each one-sided light's facing in degrees, by channel index; a light that lights all round has none. */
export function hueFacings(
  channels: readonly HueChannelPlacement[],
  config: RoomMapConfig,
  bridgeFixtures: ReadonlyMap<number, LampFamily>,
): ReadonlyMap<number, number> {
  const facings = new Map<number, number>();
  for (const ch of channels) {
    const family = resolveHueFixture(ch) ?? bridgeFixtures.get(ch.channelIndex) ?? "bulb";
    if (ONE_SIDED.has(family)) facings.set(ch.channelIndex, resolveHueFacing(ch) ?? autoHueFacing(ch, config));
  }
  return facings;
}
