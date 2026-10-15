import { type RoomMapConfig, resolveRoomFootprint, resolveStripCorners, stripCentre, type UsbStripPlacement } from "@/shared/contracts/roomMap";

/** A strip stuck to a wall runs this far in from it: the strip's own depth and its tape. */
export const WALL_INSET_M = 0.01;
/** Within this of a wall, a strip with no height of its own runs at the skirting; further out it lies
 *  on the floor. */
export const NEAR_WALL_M = 0.25;
const SKIRTING_M = 0.08;

export interface WallLine {
  /** The wall runs along x (a TV or back wall) rather than along y. */
  alongX: boolean;
  /** Its y when along x, its x when along y. */
  at: number;
  lo: number;
  hi: number;
  distance: number;
}

const mm = (v: number) => Math.round(v * 1000) / 1000;

/** The wall nearest a plan point among those it stands in front of, or `null` when it is in front of
 *  none (outside the outline's spans). */
export function nearestWall(config: Pick<RoomMapConfig, "footprint" | "dimensions">, x: number, y: number): WallLine | null {
  const corners = resolveRoomFootprint(config);
  let best: WallLine | null = null;
  for (let i = 0; i < corners.length; i++) {
    const a = corners[i]!;
    const b = corners[(i + 1) % corners.length]!;
    const alongX = a.y === b.y;
    const lo = alongX ? Math.min(a.x, b.x) : Math.min(a.y, b.y);
    const hi = alongX ? Math.max(a.x, b.x) : Math.max(a.y, b.y);
    const along = alongX ? x : y;
    if (along < lo || along > hi) continue;
    const at = alongX ? a.y : a.x;
    const distance = Math.abs((alongX ? y : x) - at);
    if (!best || distance < best.distance) best = { alongX, at, lo, hi, distance };
  }
  return best;
}

/**
 * The strip laid along its nearest wall, just inside it: kept at its length (cut to the wall's when
 * longer), centred where it was along the wall, running the way it ran. `null` when there is no wall
 * in front of it, it is already there, or it is bent: its corners are where the user put it.
 */
export function stickStripToWall<T extends UsbStripPlacement>(strip: T, config: Pick<RoomMapConfig, "footprint" | "dimensions">): T | null {
  if (resolveStripCorners(strip).length > 0) return null;
  const mx = (strip.startX + strip.endX) / 2;
  const my = (strip.startY + strip.endY) / 2;
  const wall = nearestWall(config, mx, my);
  if (!wall) return null;
  const span = wall.hi - wall.lo;
  const length = Math.min(Math.hypot(strip.endX - strip.startX, strip.endY - strip.startY), span);
  const along = Math.min(Math.max(wall.alongX ? mx : my, wall.lo + length / 2), wall.hi - length / 2);
  const cross = wall.alongX ? my : mx;
  const roomMiddle = wall.alongX ? config.dimensions.depthMeters / 2 : config.dimensions.widthMeters / 2;
  // Inward is toward the strip; one exactly on the wall line takes the room's middle as its side.
  const side = Math.sign(cross - wall.at) || Math.sign(roomMiddle - wall.at) || 1;
  const line = wall.at + side * WALL_INSET_M;
  const run = Math.sign(wall.alongX ? strip.endX - strip.startX : strip.endY - strip.startY) || 1;
  const a = mm(along - (run * length) / 2);
  const b = mm(along + (run * length) / 2);
  const next = wall.alongX
    ? { startX: a, endX: b, startY: mm(line), endY: mm(line) }
    : { startX: mm(line), endX: mm(line), startY: a, endY: b };
  if (next.startX === strip.startX && next.startY === strip.startY && next.endX === strip.endX && next.endY === strip.endY) return null;
  return { ...strip, ...next };
}

/** The height a strip with none of its own is drawn at: the skirting along a wall, else the floor. */
export function defaultStripHeight(config: Pick<RoomMapConfig, "footprint" | "dimensions">, strip: UsbStripPlacement): number {
  const { x, y } = stripCentre(strip);
  const wall = nearestWall(config, x, y);
  return wall && wall.distance <= NEAR_WALL_M ? SKIRTING_M : 0;
}
