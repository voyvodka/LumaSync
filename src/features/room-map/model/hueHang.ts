// Where an overhead light hangs. The 3D room draws a ceiling light on the ceiling whatever its
// height says, and the stream samples the height, so the two are kept together here.
import type { LampFamily } from "@/features/room-view/model/lampFamily";
import { type HueChannelPlacement, type RoomMapConfig, resolveHueFixture } from "@/shared/contracts/roomMap";

import { hueToMetres, resolveHueChannelWorldZ } from "./hueChannelPosition";

/** A pendant's shade below its canopy: about where one hangs over a table. */
export const PENDANT_DROP_M = 0.75;
/** Within this of the ceiling, a spot or a bulb is mounted on it. */
export const AT_CEILING_M = 0.1;
/** The reach `lamps.ts` gives a pendant's cord, from head height to just under the canopy. */
const PENDANT_LOWEST_M = 1.2;
const PENDANT_CLEARANCE_M = 0.3;

/** Fixtures that only ever hang: choosing one moves the light up to where it hangs. */
export const HANGING_FIXTURES: ReadonlySet<LampFamily> = new Set<LampFamily>(["ceiling", "pendant"]);

/** The height in metres a fixture hangs at, or null for one that stands. A spot or a bulb can do
 *  either, so it has one too. */
export function hangHeight(family: LampFamily, ceiling: number): number | null {
  switch (family) {
    case "ceiling":
    case "spot":
    case "bulb":
      return ceiling;
    case "pendant":
      return ceiling - PENDANT_DROP_M;
    default:
      return null;
  }
}

export function isHung(family: LampFamily, metres: number, ceiling: number): boolean {
  if (family === "pendant") return metres >= PENDANT_LOWEST_M && metres <= ceiling - PENDANT_CLEARANCE_M + 0.005;
  return hangHeight(family, ceiling) !== null && metres >= ceiling - AT_CEILING_M;
}

/** Channels that hang overhead, by index: a ceiling light or pendant where it hangs, any other light
 *  at the ceiling. */
export function hueOverhead(
  channels: readonly HueChannelPlacement[],
  config: RoomMapConfig,
  bridgeFixtures: ReadonlyMap<number, LampFamily>,
): ReadonlySet<number> {
  const ceiling = config.dimensions.heightMeters;
  const overhead = new Set<number>();
  for (const ch of channels) {
    const family = resolveHueFixture(ch) ?? bridgeFixtures.get(ch.channelIndex) ?? "bulb";
    const metres = hueToMetres(resolveHueChannelWorldZ(ch, config.zones), ceiling);
    if ((HANGING_FIXTURES.has(family) && isHung(family, metres, ceiling)) || metres >= ceiling - AT_CEILING_M) overhead.add(ch.channelIndex);
  }
  return overhead;
}
