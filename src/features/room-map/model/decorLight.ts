import type { TFunction } from "i18next";

import {
  type HueChannelPlacement,
  type DecorLightFixture,
  type LightStructure,
  replaceHueChannel,
  type RoomMapConfig,
  type RoomStructure,
  STRUCTURE_KINDS,
} from "@/shared/contracts/roomMap";
import { resolveRoomStructures } from "@/shared/contracts/roomStructureResolver";

import {
  detachHueChannel,
  moveHueChannelToWorld,
  planMetresToHue,
  resolveHueChannelWorld,
  resolveHueChannelWorldZ,
  setHueChannelWorldZ,
} from "./hueChannelPosition";
import { hangHeight } from "./hueHang";

type StructuresPatch = Pick<RoomMapConfig, "structures">;

const NAME_KEY = {
  pendant: "roomMap:view.family.pendant",
  ceiling: "roomMap:view.family.ceiling",
  spot: "roomMap:view.family.spot",
  bulb: "roomMap:view.family.bulb",
} as const satisfies Record<DecorLightFixture, string>;

export function decorLightName(light: Pick<LightStructure, "label" | "fixture">, t: TFunction): string {
  return light.label || t(NAME_KEY[light.fixture]);
}

export const DECOR_LOWEST_M = 0.3;

export function findDecorLight(config: Pick<RoomMapConfig, "structures">, structureId: string): LightStructure | null {
  const found = resolveRoomStructures(config).find((s) => s.id === structureId);
  return found?.kind === STRUCTURE_KINDS.LIGHT ? found : null;
}

export function listDecorLights(config: Pick<RoomMapConfig, "structures">): LightStructure[] {
  return resolveRoomStructures(config).filter((s): s is LightStructure => s.kind === STRUCTURE_KINDS.LIGHT);
}

export function decorLightHeight(light: Pick<LightStructure, "fixture" | "dropMeters">, ceiling: number): number {
  if (light.dropMeters !== undefined) return Math.max(ceiling - light.dropMeters, DECOR_LOWEST_M);
  return hangHeight(light.fixture, ceiling) ?? ceiling;
}

// By id on the stored array, spreading the stored entry: a newer build's fields and kinds survive.
function editStored(
  config: Pick<RoomMapConfig, "structures">,
  structureId: string,
  edit: (stored: RoomStructure) => RoomStructure | null,
): StructuresPatch | null {
  if (!findDecorLight(config, structureId) || !Array.isArray(config.structures)) return null;
  let done = false;
  const structures: RoomStructure[] = [];
  for (const entry of config.structures) {
    // The first of a repeated id is the one the resolver draws.
    if (done || (entry as { id?: unknown }).id !== structureId) {
      structures.push(entry);
      continue;
    }
    done = true;
    const next = edit(entry);
    if (next) structures.push(next);
  }
  return { structures };
}

export function updateDecorLight(
  config: Pick<RoomMapConfig, "structures">,
  structureId: string,
  patch: Partial<Omit<LightStructure, "id" | "kind">>,
): StructuresPatch | null {
  return editStored(config, structureId, (stored) => ({ ...stored, ...patch }) as RoomStructure);
}

export function removeDecorLight(config: Pick<RoomMapConfig, "structures">, structureId: string): StructuresPatch | null {
  return editStored(config, structureId, () => null);
}

export function moveDecorLight(
  config: Pick<RoomMapConfig, "structures" | "dimensions">,
  structureId: string,
  x: number,
  y: number,
): StructuresPatch | null {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const { widthMeters, depthMeters } = config.dimensions;
  return updateDecorLight(config, structureId, {
    x: Math.min(Math.max(x, 0), widthMeters),
    y: Math.min(Math.max(y, 0), depthMeters),
  });
}

export function setDecorLightHeight(
  config: Pick<RoomMapConfig, "structures" | "dimensions">,
  structureId: string,
  height: number,
): StructuresPatch | null {
  if (!Number.isFinite(height)) return null;
  const ceiling = config.dimensions.heightMeters;
  const at = Math.min(Math.max(height, DECOR_LOWEST_M), ceiling);
  return updateDecorLight(config, structureId, { dropMeters: ceiling - at });
}

const CLOSE = 1e-6;

/** One patch, so one undo step puts the lamp and the channel back. Null for a locked channel. */
export function driveDecorWithHue(
  config: RoomMapConfig,
  structureId: string,
  channel: HueChannelPlacement,
): Partial<RoomMapConfig> | null {
  const light = findDecorLight(config, structureId);
  const removed = removeDecorLight(config, structureId);
  if (!light || !removed || channel.locked) return null;
  const { widthMeters, depthMeters, heightMeters } = config.dimensions;
  const at = planMetresToHue(light.x, light.y, widthMeters, depthMeters);
  const z = (decorLightHeight(light, heightMeters) / heightMeters) * 2 - 1;
  const place = (from: HueChannelPlacement) =>
    setHueChannelWorldZ({ ...moveHueChannelToWorld(from, config.zones, at.x, at.y), fixture: light.fixture }, config.zones, z);
  let placed = place(channel);
  const world = resolveHueChannelWorld(placed, config.zones);
  // A zone holds its lights inside it; a lamp outside it takes the light out rather than stopping it at the edge.
  if (Math.abs(world.x - at.x) > CLOSE || Math.abs(world.y - at.y) > CLOSE || Math.abs(resolveHueChannelWorldZ(placed, config.zones) - z) > CLOSE) {
    placed = place(detachHueChannel(channel, config.zones));
  }
  return { hueChannels: replaceHueChannel(config.hueChannels, placed), ...removed };
}
