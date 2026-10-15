// A Hue light set down on the plan sits on what is there: moved onto a desk it stands on the desk,
// moved off it, back on the floor. The 3D room draws a lamp on the piece under it; this keeps the
// stored height, which the stream and room-aware sampling read, in step with it.
import { classifyFurniture, type FurnitureModel, modelTop, surfaceTop } from "@/features/room-view/model/furnitureModel";
import { type FurniturePlacement, type HueChannelPlacement, type RoomMapConfig, resolveFurnitureTop } from "@/shared/contracts/roomMap";

import { hueToPlanMetres, resolveHueChannelWorld, resolveHueChannelWorldZ, setHueChannelWorldZ } from "./hueChannelPosition";

/** How far above a top a light still counts as standing on it: a Play bar's middle, a Go's dome. */
const SITTING_METRES = 0.15;
/** A rug, a bed's frame edge: too low to stand a lamp on as a surface of its own. */
const LOWEST_SEAT = 0.05;

export interface Seat {
  item: FurniturePlacement;
  top: number;
}

/** The highest piece top under a plan point, in metres, or `null` over the floor. */
export function pieceUnder(
  config: RoomMapConfig,
  x: number,
  y: number,
  models: ReadonlyMap<string, FurnitureModel> = classifyFurniture(config),
): Seat | null {
  let best: Seat | null = null;
  for (const item of config.furniture) {
    const model = models.get(item.id);
    if (!model) continue;
    const stored = resolveFurnitureTop(item);
    const top = surfaceTop(model) * (stored !== undefined ? stored / modelTop(model) : 1);
    if (top < LOWEST_SEAT || (best && top <= best.top)) continue;
    const angle = ((item.rotation ?? 0) * Math.PI) / 180;
    const dx = x - (item.x + item.width / 2);
    const dy = y - (item.y + item.height / 2);
    const lx = dx * Math.cos(angle) + dy * Math.sin(angle);
    const ly = -dx * Math.sin(angle) + dy * Math.cos(angle);
    if (Math.abs(lx) <= item.width / 2 && Math.abs(ly) <= item.height / 2) best = { item, top };
  }
  return best;
}

/** The light's height in metres above the floor. */
export function lightHeightMetres(channel: HueChannelPlacement, config: RoomMapConfig): number {
  return ((resolveHueChannelWorldZ(channel, config.zones) + 1) / 2) * config.dimensions.heightMeters;
}

/** `channel` at `metres` above the floor, written to whichever height field is live. */
export function atHeightMetres(channel: HueChannelPlacement, config: RoomMapConfig, metres: number): HueChannelPlacement {
  return setHueChannelWorldZ(channel, config.zones, (metres / config.dimensions.heightMeters) * 2 - 1);
}

function seatOf(channel: HueChannelPlacement, config: RoomMapConfig, models: ReadonlyMap<string, FurnitureModel>): number {
  const { widthMeters, depthMeters } = config.dimensions;
  const plan = hueToPlanMetres(resolveHueChannelWorld(channel, config.zones), widthMeters, depthMeters);
  return pieceUnder(config, plan.x, plan.y, models)?.top ?? 0;
}

/** `after` — `before` moved on the plan — at the height it lands at: one standing on a surface goes on
 *  standing on the new one, the same distance up; one the new piece would swallow rises onto its top.
 *  A light hung in the air above both keeps its height. */
export function seatMovedLight(before: HueChannelPlacement, after: HueChannelPlacement, config: RoomMapConfig): HueChannelPlacement {
  const models = classifyFurniture(config);
  const from = seatOf(before, config, models);
  const to = seatOf(after, config, models);
  if (from === to) return after;
  const height = lightHeightMetres(before, config);
  const above = height - from;
  if (above <= SITTING_METRES) return atHeightMetres(after, config, to + Math.max(above, 0));
  if (height < to) return atHeightMetres(after, config, to);
  return after;
}
