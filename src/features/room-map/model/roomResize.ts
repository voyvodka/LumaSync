import { type RoomCorner, type RoomDimensions, resolveRoomFootprint } from "@/shared/contracts/roomMap";

import type { FootprintSide } from "./roomFootprint";

/** The smallest and largest a room's side can be: a cupboard and a hall. */
export const ROOM_SIDE_MIN_M = 1;
export const ROOM_SIDE_MAX_M = 30;

export interface RoomSideResize {
  dimensions: RoomDimensions;
  /** Undefined for the rectangle, as the writer stores it. */
  footprint: RoomCorner[] | undefined;
  /** What everything in the room moves by so it stays where it stands: the far wall stays put. */
  shift: { x: number; y: number };
}

const cm = (v: number) => Math.round(v * 100) / 100;

/**
 * The room after one wall is pulled `delta` metres out (negative pulls it in): the opposite wall
 * stays where it is, and so does everything in the room. A shaped room's corners on the moved wall
 * go with it; the rest keep their place. Null when the outline would no longer hold.
 */
export function resizeRoomFromSide(
  dims: RoomDimensions,
  footprint: RoomCorner[] | undefined,
  side: FootprintSide,
  delta: number,
): RoomSideResize | null {
  const horizontal = side === "left" || side === "right";
  const span = horizontal ? dims.widthMeters : dims.depthMeters;
  const next = cm(Math.min(Math.max(span + delta, ROOM_SIDE_MIN_M), ROOM_SIDE_MAX_M));
  const grown = cm(next - span);
  const dimensions = horizontal ? { ...dims, widthMeters: next } : { ...dims, depthMeters: next };
  const shift = { x: side === "left" ? grown : 0, y: side === "top" ? grown : 0 };
  const corners = resolveRoomFootprint({ dimensions: dims, footprint });
  if (corners.length === 4) return { dimensions, footprint: undefined, shift };
  const moved = corners.map((c) => {
    if (horizontal) {
      if (side === "right") return { x: c.x === dims.widthMeters ? next : c.x, y: c.y };
      return { x: c.x === 0 ? 0 : cm(c.x + grown), y: c.y };
    }
    if (side === "bottom") return { x: c.x, y: c.y === dims.depthMeters ? next : c.y };
    return { x: c.x, y: c.y === 0 ? 0 : cm(c.y + grown) };
  });
  const resolved = resolveRoomFootprint({ dimensions, footprint: moved });
  return resolved.length === corners.length ? { dimensions, footprint: resolved, shift } : null;
}
