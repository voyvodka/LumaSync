import type { HueZone } from "@/shared/contracts/roomMap";
import { clamp } from "@/shared/lib/math";

import { hueToPlanMetres, planMetresToHue } from "./hueChannelPosition";

/** A zone's floor on the plan, in metres from the room's top-left corner. */
export interface ZoneRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export type ZoneHandle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

export const ZONE_HANDLES: readonly ZoneHandle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

// Mirrors `HUE_ZONE_SCALE_MIN` in `commands/room_map/hue_zone.rs`.
export const ZONE_SCALE_MIN = 0.05;

type Footprint = Pick<HueZone, "centerX" | "centerY" | "scaleX" | "scaleY">;

export function zoneRect(zone: Footprint, widthM: number, depthM: number): ZoneRect {
  const a = hueToPlanMetres({ x: zone.centerX - Math.abs(zone.scaleX), y: zone.centerY + Math.abs(zone.scaleY) }, widthM, depthM);
  const b = hueToPlanMetres({ x: zone.centerX + Math.abs(zone.scaleX), y: zone.centerY - Math.abs(zone.scaleY) }, widthM, depthM);
  return { x0: clamp(a.x, 0, widthM), y0: clamp(a.y, 0, depthM), x1: clamp(b.x, 0, widthM), y1: clamp(b.y, 0, depthM) };
}

/** The smallest a zone may be along each side, in metres. */
export function zoneMinSize(widthM: number, depthM: number): { w: number; d: number } {
  return { w: ZONE_SCALE_MIN * widthM, d: ZONE_SCALE_MIN * depthM };
}

/** A rectangle as the cube centre and half-scales the bridge's frame stores, inside the room and
 *  no smaller than the Rust band allows, so the backend never refuses it. */
export function rectToZone(rect: ZoneRect, widthM: number, depthM: number): Footprint {
  const min = zoneMinSize(widthM, depthM);
  const side = (a: number, b: number, size: number, least: number) => {
    let lo = clamp(Math.min(a, b), 0, size);
    let hi = clamp(Math.max(a, b), 0, size);
    if (hi - lo < least) {
      const mid = clamp((lo + hi) / 2, least / 2, size - least / 2);
      lo = mid - least / 2;
      hi = mid + least / 2;
    }
    return [lo, hi] as const;
  };
  const [x0, x1] = side(rect.x0, rect.x1, widthM, min.w);
  const [y0, y1] = side(rect.y0, rect.y1, depthM, min.d);
  const centre = planMetresToHue((x0 + x1) / 2, (y0 + y1) / 2, widthM, depthM);
  return {
    centerX: centre.x,
    centerY: centre.y,
    scaleX: clamp((x1 - x0) / widthM, ZONE_SCALE_MIN, 1),
    scaleY: clamp((y1 - y0) / depthM, ZONE_SCALE_MIN, 1),
  };
}

/** `start` with the edges `handle` holds moved by (`dx`, `dy`) metres and kept inside the room.
 *  `square` keeps the start's proportions, measured in metres. */
export function resizeZoneRect(
  start: ZoneRect,
  handle: ZoneHandle,
  dx: number,
  dy: number,
  widthM: number,
  depthM: number,
  square = false,
): ZoneRect {
  const min = zoneMinSize(widthM, depthM);
  const west = handle.includes("w");
  const east = handle.includes("e");
  const north = handle.includes("n");
  const south = handle.includes("s");
  let { x0, y0, x1, y1 } = start;
  if (west) x0 = clamp(x0 + dx, 0, x1 - min.w);
  if (east) x1 = clamp(x1 + dx, x0 + min.w, widthM);
  if (north) y0 = clamp(y0 + dy, 0, y1 - min.d);
  if (south) y1 = clamp(y1 + dy, y0 + min.d, depthM);
  if (!square) return { x0, y0, x1, y1 };

  const ratio = (start.x1 - start.x0) / Math.max(start.y1 - start.y0, 1e-6);
  const horizontal = west || east;
  const vertical = north || south;
  let w = x1 - x0;
  let d = y1 - y0;
  if (horizontal && vertical) {
    // The side the pointer pulled further sets the size.
    if (w / ratio > d) d = w / ratio;
    else w = d * ratio;
  } else if (horizontal) d = w / ratio;
  else w = d * ratio;
  // Grown from the held corner or the middle of the held side; shrunk to what the walls leave.
  const ax = west ? start.x1 : east ? start.x0 : (start.x0 + start.x1) / 2;
  const ay = north ? start.y1 : south ? start.y0 : (start.y0 + start.y1) / 2;
  const roomW = west ? ax : east ? widthM - ax : 2 * Math.min(ax, widthM - ax);
  const roomD = north ? ay : south ? depthM - ay : 2 * Math.min(ay, depthM - ay);
  const fit = Math.min(1, roomW / w, roomD / d);
  w = Math.max(w * fit, min.w);
  d = Math.max(d * fit, min.d);
  const nx0 = west ? ax - w : east ? ax : ax - w / 2;
  const ny0 = north ? ay - d : south ? ay : ay - d / 2;
  return { x0: nx0, y0: ny0, x1: nx0 + w, y1: ny0 + d };
}

/** The rectangle a press-and-drag from `from` to `to` draws; `square` makes it square in metres. */
export function drawnZoneRect(
  from: { x: number; y: number },
  to: { x: number; y: number },
  widthM: number,
  depthM: number,
  square = false,
): ZoneRect {
  const x = clamp(to.x, 0, widthM);
  const y = clamp(to.y, 0, depthM);
  if (!square) return { x0: Math.min(from.x, x), y0: Math.min(from.y, y), x1: Math.max(from.x, x), y1: Math.max(from.y, y) };
  const room = { x: x >= from.x ? widthM - from.x : from.x, y: y >= from.y ? depthM - from.y : from.y };
  const side = Math.min(Math.max(Math.abs(x - from.x), Math.abs(y - from.y)), room.x, room.y);
  const ex = x >= from.x ? from.x + side : from.x - side;
  const ey = y >= from.y ? from.y + side : from.y - side;
  return { x0: Math.min(from.x, ex), y0: Math.min(from.y, ey), x1: Math.max(from.x, ex), y1: Math.max(from.y, ey) };
}

/** A click without a drag: half the room each way, the size Add zone always made. */
export function clickedZoneRect(at: { x: number; y: number }, widthM: number, depthM: number): ZoneRect {
  const w = widthM / 2;
  const d = depthM / 2;
  const x0 = clamp(at.x - w / 2, 0, widthM - w);
  const y0 = clamp(at.y - d / 2, 0, depthM - d);
  return { x0, y0, x1: x0 + w, y1: y0 + d };
}
