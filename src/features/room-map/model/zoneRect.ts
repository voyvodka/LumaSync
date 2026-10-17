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

// Mirrors `HUE_ZONE_SCALE_MIN` in `commands/room_map/hue_zone.rs` — the two must move together.
export const ZONE_SCALE_MIN = 0.05;

type Footprint = Pick<HueZone, "centerX" | "centerY" | "scaleX" | "scaleY">;

/** A cube's floor: its centre on the plan and its one scale. */
export interface CubeFootprint {
  centerX: number;
  centerY: number;
  scale: number;
}

export function zoneRect(zone: Footprint, widthM: number, depthM: number): ZoneRect {
  const a = hueToPlanMetres({ x: zone.centerX - Math.abs(zone.scaleX), y: zone.centerY + Math.abs(zone.scaleY) }, widthM, depthM);
  const b = hueToPlanMetres({ x: zone.centerX + Math.abs(zone.scaleX), y: zone.centerY - Math.abs(zone.scaleY) }, widthM, depthM);
  return { x0: clamp(a.x, 0, widthM), y0: clamp(a.y, 0, depthM), x1: clamp(b.x, 0, widthM), y1: clamp(b.y, 0, depthM) };
}

export function zoneMinSize(widthM: number, depthM: number): { w: number; d: number } {
  return { w: ZONE_SCALE_MIN * widthM, d: ZONE_SCALE_MIN * depthM };
}

/** The cube a rectangle drawn on the plan stands for: its larger side in Hue units, clamped into the
 *  Rust scale band. `withCubeScale` keeps it inside the room. */
export function rectToZone(rect: ZoneRect, widthM: number, depthM: number): CubeFootprint {
  const centre = planMetresToHue((rect.x0 + rect.x1) / 2, (rect.y0 + rect.y1) / 2, widthM, depthM);
  const scale = Math.max(Math.abs(rect.x1 - rect.x0) / widthM, Math.abs(rect.y1 - rect.y0) / depthM);
  return { centerX: centre.x, centerY: centre.y, scale: clamp(Number.isFinite(scale) ? scale : ZONE_SCALE_MIN, ZONE_SCALE_MIN, 1) };
}

/** A zone is a cube in Hue units, so on the plan it keeps the room's proportions as it grows. */
export function resizeZoneRect(start: ZoneRect, handle: ZoneHandle, dx: number, dy: number, widthM: number, depthM: number): ZoneRect {
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

  const ratio = widthM / depthM;
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

/** Drawn from a corner in the room's proportions: the pointer's larger reach, in Hue units, sets the cube. */
export function drawnZoneRect(from: { x: number; y: number }, to: { x: number; y: number }, widthM: number, depthM: number): ZoneRect {
  const x = clamp(to.x, 0, widthM);
  const y = clamp(to.y, 0, depthM);
  const east = x >= from.x;
  const south = y >= from.y;
  const room = Math.min((east ? widthM - from.x : from.x) / widthM, (south ? depthM - from.y : from.y) / depthM);
  const s = Math.min(Math.max(Math.abs(x - from.x) / widthM, Math.abs(y - from.y) / depthM), room);
  const ex = east ? from.x + s * widthM : from.x - s * widthM;
  const ey = south ? from.y + s * depthM : from.y - s * depthM;
  return { x0: Math.min(from.x, ex), y0: Math.min(from.y, ey), x1: Math.max(from.x, ex), y1: Math.max(from.y, ey) };
}

/** A click without a drag: half the room each way, the cube of scale 0.5 Add zone makes. */
export function clickedZoneRect(at: { x: number; y: number }, widthM: number, depthM: number): ZoneRect {
  const w = widthM / 2;
  const d = depthM / 2;
  const x0 = clamp(at.x - w / 2, 0, widthM - w);
  const y0 = clamp(at.y - d / 2, 0, depthM - d);
  return { x0, y0, x1: x0 + w, y1: y0 + d };
}
