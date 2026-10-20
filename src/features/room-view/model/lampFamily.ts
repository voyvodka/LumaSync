// What a Hue light looks like in the room, from the bridge's own word for it. Free of three.js.

import type { HueFixture } from "@/shared/contracts/roomMap";

/** The shapes the room draws a light as: the contract's fixtures, which the map can also store. */
export type LampFamily = HueFixture;

/** CLIP v2 archetypes grouped by shape. The set is open: a word not listed here draws as a bulb,
 *  the shape that claims least about the fixture. */
const FAMILY_OF: Readonly<Record<string, LampFamily>> = {
  hue_play: "playBar",
  hue_play_wallwasher: "playBar",
  hue_lightstrip: "lightstrip",
  hue_lightstrip_tv: "lightstrip",
  hue_lightstrip_pc: "lightstrip",
  string_light: "lightstrip",
  floor_shade: "floorLamp",
  floor_lantern: "floorLamp",
  up_and_down: "floorLamp",
  up_and_down_up: "floorLamp",
  up_and_down_down: "floorLamp",
  bollard: "floorLamp",
  hue_signe: "signe",
  table_shade: "tableLamp",
  table_wash: "tableLamp",
  flexible_lamp: "tableLamp",
  twilight: "tableLamp",
  twilight_front: "tableLamp",
  twilight_back: "tableLamp",
  pendant_round: "pendant",
  pendant_long: "pendant",
  pendant_spot: "pendant",
  ceiling_round: "ceiling",
  ceiling_square: "ceiling",
  ceiling_horizontal: "ceiling",
  ceiling_tube: "ceiling",
  recessed_ceiling: "ceiling",
  hue_centris: "ceiling",
  hue_go: "go",
  hue_iris: "iris",
  hue_bloom: "bloom",
  single_spot: "spot",
  double_spot: "spot",
  ground_spot: "spot",
  wall_spot: "spot",
  recessed_floor: "spot",
  wall_lantern: "wall",
  wall_shade: "wall",
  wall_washer: "wall",
  hue_tube: "tube",
};

/** Within this of the ceiling, a spot or a bulb is drawn mounted on it rather than standing. */
export const CEILING_MOUNT_M = 0.1;

/** Fixtures that light one side only, so the room turns them to a wall or to the stored facing. */
export const ONE_SIDED: ReadonlySet<LampFamily> = new Set<LampFamily>(["playBar", "signe", "iris", "bloom"]);

/** Every fixture in the order a picker lists them: standing, on surfaces, overhead, strips, bulbs. */
export const FIXTURE_ORDER: readonly LampFamily[] = [
  "floorLamp",
  "signe",
  "playBar",
  "tableLamp",
  "go",
  "iris",
  "bloom",
  "pendant",
  "ceiling",
  "spot",
  "wall",
  "lightstrip",
  "tube",
  "bulb",
];

export function lampFamily(archetype: string | null | undefined): LampFamily {
  return (archetype && FAMILY_OF[archetype]) || "bulb";
}

/** A channel's shape from its lights' archetypes: the first that names a fixture, since a channel's
 *  lights are usually one product; a bulb only when none does. */
export function channelLampFamily(lightIds: readonly string[], archetypes: Readonly<Record<string, string | null>>): LampFamily {
  for (const id of lightIds) {
    const family = lampFamily(archetypes[id]);
    if (family !== "bulb") return family;
  }
  return "bulb";
}
