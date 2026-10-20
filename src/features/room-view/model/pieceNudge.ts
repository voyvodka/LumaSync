import { furnitureObjectId, TV_ANCHOR_OBJECT_ID, usbStripObjectId } from "@/features/room-map/model/objectId";
import type { RoomMapConfig, TvAnchorPlacement } from "@/shared/contracts/roomMap";

import { tvMountHeight } from "./roomSpace";

export interface PieceNudge {
  objectId: string;
  /** Plan metres, which are scene metres along x and z. */
  dx: number;
  dy: number;
  reshape?: { scaleX: number; scaleY: number; aboutY: number; raise: number };
}

// Past this a stretched copy reads as wrong, not as the step it is: the room is built again instead.
const RESHAPE_REACH = 0.15;
const RAISE_REACH_M = 0.15;
const TV_RESHAPED = new Set<keyof TvAnchorPlacement>(["x", "y", "width", "mountHeightMeters"]);

const NUDGED_KEYS = new Set<keyof RoomMapConfig>(["furniture", "tvAnchor", "usbStrips"]);

function shiftOf<T extends object>(prev: T, next: T, moved: readonly [keyof T, keyof T][]): { dx: number; dy: number } | null {
  const keys = new Set([...Object.keys(prev), ...Object.keys(next)] as (keyof T)[]);
  const [[ax, ay]] = moved as [[keyof T, keyof T]];
  const dx = (next[ax] as number) - (prev[ax] as number);
  const dy = (next[ay] as number) - (prev[ay] as number);
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return null;
  for (const [kx, ky] of moved) {
    keys.delete(kx);
    keys.delete(ky);
    if (Math.abs((next[kx] as number) - (prev[kx] as number) - dx) > 1e-9) return null;
    if (Math.abs((next[ky] as number) - (prev[ky] as number) - dy) > 1e-9) return null;
  }
  for (const key of keys) if (prev[key] !== next[key]) return null;
  return { dx, dy };
}

/** `next` as one piece of `built` slid across the floor, as the inspector's X and Y step it; else null. */
export function pieceNudge(built: RoomMapConfig, next: RoomMapConfig): PieceNudge | null {
  const keys = new Set([...Object.keys(built), ...Object.keys(next)] as (keyof RoomMapConfig)[]);
  const changed = [...keys].filter((key) => built[key] !== next[key]);
  if (changed.length !== 1 || !NUDGED_KEYS.has(changed[0]!)) return null;
  // A step back to where it was built is a nudge of nothing, not a rebuild.
  const nudge = (objectId: string, shift: { dx: number; dy: number } | null) => (shift ? { objectId, ...shift } : null);

  if (changed[0] === "tvAnchor") {
    if (!built.tvAnchor || !next.tvAnchor) return null;
    return tvNudge(built, built.tvAnchor, next.tvAnchor);
  }
  const [before, after] = changed[0] === "furniture" ? [built.furniture, next.furniture] : [built.usbStrips, next.usbStrips];
  if (before.length !== after.length) return null;
  const moved = after.flatMap((item, i) => (item === before[i] ? [] : [i]));
  if (moved.length !== 1) return null;
  const i = moved[0]!;
  if (changed[0] === "furniture") {
    const [was, now] = [built.furniture[i]!, next.furniture[i]!];
    return was.id === now.id ? nudge(furnitureObjectId(now.id), shiftOf(was, now, [["x", "y"]])) : null;
  }
  const [was, now] = [built.usbStrips[i]!, next.usbStrips[i]!];
  return was.stripId === now.stripId
    ? nudge(
        usbStripObjectId(now.stripId),
        shiftOf(was, now, [
          ["startX", "startY"],
          ["endX", "endY"],
        ]),
      )
    : null;
}

function tvNudge(built: RoomMapConfig, was: TvAnchorPlacement, now: TvAnchorPlacement): PieceNudge | null {
  const keys = new Set([...Object.keys(was), ...Object.keys(now)] as (keyof TvAnchorPlacement)[]);
  for (const key of keys) if (!TV_RESHAPED.has(key) && was[key] !== now[key]) return null;
  if (!(now.width > 0) || !Number.isFinite(now.x) || !Number.isFinite(now.y)) return null;
  const dx = now.x + now.width / 2 - (was.x + was.width / 2);
  const dy = now.y - was.y;
  if (!Number.isFinite(dx)) return null;
  const aboutY = tvMountHeight(was, built.dimensions);
  const raise = tvMountHeight(now, built.dimensions) - aboutY;
  // One scale for both: an aspect change is not in TV_RESHAPED, so the shape is the built one.
  const scale = now.width / was.width;
  if (!Number.isFinite(raise) || Math.abs(raise) > RAISE_REACH_M || Math.abs(scale - 1) > RESHAPE_REACH) return null;
  const reshaped = scale !== 1 || raise !== 0;
  return { objectId: TV_ANCHOR_OBJECT_ID, dx, dy, ...(reshaped ? { reshape: { scaleX: scale, scaleY: scale, aboutY, raise } } : {}) };
}
