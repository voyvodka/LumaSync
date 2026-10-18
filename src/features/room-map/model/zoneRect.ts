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

export function zoneRect(zone: Footprint, widthM: number, depthM: number): ZoneRect {
  const a = hueToPlanMetres({ x: zone.centerX - Math.abs(zone.scaleX), y: zone.centerY + Math.abs(zone.scaleY) }, widthM, depthM);
  const b = hueToPlanMetres({ x: zone.centerX + Math.abs(zone.scaleX), y: zone.centerY - Math.abs(zone.scaleY) }, widthM, depthM);
  return { x0: clamp(a.x, 0, widthM), y0: clamp(a.y, 0, depthM), x1: clamp(b.x, 0, widthM), y1: clamp(b.y, 0, depthM) };
}

/** A cube's floor: its centre on the plan in Hue units and its edge in metres. */
export interface CubeFootprint {
  centerX: number;
  centerY: number;
  edge: number;
}

/** The edges every axis's Rust band allows: the room's longest side sets the floor, its shortest (the
 *  ceiling, nearly always) the cap. In a room too long for any cube (30 × 1 m) the cap is the floor,
 *  and `withCubeEdge` holds the scales to the band per axis. */
export function zoneEdgeBounds(widthM: number, depthM: number, heightM: number): { min: number; max: number } {
  const min = ZONE_SCALE_MIN * Math.max(widthM, depthM, heightM);
  return { min, max: Math.max(min, Math.min(widthM, depthM, heightM)) };
}

export function rectToZone(rect: ZoneRect, widthM: number, depthM: number, heightM: number): CubeFootprint {
  const centre = planMetresToHue((rect.x0 + rect.x1) / 2, (rect.y0 + rect.y1) / 2, widthM, depthM);
  const { min, max } = zoneEdgeBounds(widthM, depthM, heightM);
  const edge = Math.max(Math.abs(rect.x1 - rect.x0), Math.abs(rect.y1 - rect.y0));
  return { centerX: centre.x, centerY: centre.y, edge: clamp(Number.isFinite(edge) ? edge : min, min, max) };
}

/** A zone is a cube in metres, so on the plan it stays square as it grows, up to the ceiling's height. */
export function resizeZoneRect(start: ZoneRect, handle: ZoneHandle, dx: number, dy: number, widthM: number, depthM: number, heightM: number): ZoneRect {
  const { min, max } = zoneEdgeBounds(widthM, depthM, heightM);
  const west = handle.includes("w");
  const east = handle.includes("e");
  const north = handle.includes("n");
  const south = handle.includes("s");
  let { x0, y0, x1, y1 } = start;
  if (west) x0 = clamp(x0 + dx, 0, x1 - min);
  if (east) x1 = clamp(x1 + dx, x0 + min, widthM);
  if (north) y0 = clamp(y0 + dy, 0, y1 - min);
  if (south) y1 = clamp(y1 + dy, y0 + min, depthM);

  const horizontal = west || east;
  const vertical = north || south;
  // The side the pointer pulled further sets the size.
  let e = horizontal && vertical ? Math.max(x1 - x0, y1 - y0) : horizontal ? x1 - x0 : y1 - y0;
  // Grown from the held corner or the middle of the held side; shrunk to what the walls leave.
  const ax = west ? start.x1 : east ? start.x0 : (start.x0 + start.x1) / 2;
  const ay = north ? start.y1 : south ? start.y0 : (start.y0 + start.y1) / 2;
  const roomW = west ? ax : east ? widthM - ax : 2 * Math.min(ax, widthM - ax);
  const roomD = north ? ay : south ? depthM - ay : 2 * Math.min(ay, depthM - ay);
  e = Math.max(Math.min(e, roomW, roomD, max), min);
  const nx0 = west ? ax - e : east ? ax : ax - e / 2;
  const ny0 = north ? ay - e : south ? ay : ay - e / 2;
  return { x0: nx0, y0: ny0, x1: nx0 + e, y1: ny0 + e };
}

export function drawnZoneRect(from: { x: number; y: number }, to: { x: number; y: number }, widthM: number, depthM: number, heightM: number): ZoneRect {
  const x = clamp(to.x, 0, widthM);
  const y = clamp(to.y, 0, depthM);
  const east = x >= from.x;
  const south = y >= from.y;
  const room = Math.min(east ? widthM - from.x : from.x, south ? depthM - from.y : from.y, zoneEdgeBounds(widthM, depthM, heightM).max);
  const e = Math.min(Math.max(Math.abs(x - from.x), Math.abs(y - from.y)), room);
  const ex = east ? from.x + e : from.x - e;
  const ey = south ? from.y + e : from.y - e;
  return { x0: Math.min(from.x, ex), y0: Math.min(from.y, ey), x1: Math.max(from.x, ex), y1: Math.max(from.y, ey) };
}

export function clickedZoneRect(at: { x: number; y: number }, widthM: number, depthM: number, heightM: number): ZoneRect {
  const e = defaultZoneEdge(widthM, depthM, heightM);
  const x0 = clamp(at.x - e / 2, 0, widthM - e);
  const y0 = clamp(at.y - e / 2, 0, depthM - e);
  return { x0, y0, x1: x0 + e, y1: y0 + e };
}

export function defaultZoneEdge(widthM: number, depthM: number, heightM: number): number {
  const { min, max } = zoneEdgeBounds(widthM, depthM, heightM);
  return Math.max(min, max / 2);
}
