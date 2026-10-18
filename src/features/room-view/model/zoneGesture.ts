// On the plan's rectangle in metres, so a landing goes through the plan's own `rectToZone`.
import type { ZoneMarks } from "@/features/room-map/model/zoneMarks";
import { type ZoneHandle, type ZoneRect, zoneRect } from "@/features/room-map/model/zoneRect";
import type { HueZone, RoomDimensions } from "@/shared/contracts/roomMap";

export interface PlanPoint {
  x: number;
  y: number;
}

export function sceneToPlan(x: number, z: number, dims: RoomDimensions): PlanPoint {
  return { x: x + dims.widthMeters / 2, y: z + dims.depthMeters / 2 };
}

export const insideRect = (rect: ZoneRect, p: PlanPoint) => p.x >= rect.x0 && p.x <= rect.x1 && p.y >= rect.y0 && p.y <= rect.y1;

export function zoneAtFloor(point: PlanPoint, zones: readonly HueZone[], marks: ZoneMarks | null, dims: RoomDimensions): string | null {
  if (!marks) return null;
  const drawn = [marks.held, marks.active, ...marks.others].filter((id, i, all): id is string => id != null && all.indexOf(id) === i);
  let best: { id: string; area: number; rank: number } | null = null;
  for (const id of drawn) {
    const zone = zones.find((z) => z.id === id);
    if (!zone) continue;
    const rect = zoneRect(zone, dims.widthMeters, dims.depthMeters);
    if (!insideRect(rect, point)) continue;
    const rank = id === marks.held ? 0 : id === marks.active ? 1 : 2;
    const area = (rect.x1 - rect.x0) * (rect.y1 - rect.y0);
    if (!best || rank < best.rank || (rank === best.rank && area < best.area)) best = { id, area, rank };
  }
  return best?.id ?? null;
}

/** Carried whole: pushed against a wall it stops there, where `rectToZone` would have shrunk it. */
export function moveZoneRect(start: ZoneRect, dx: number, dy: number, dims: RoomDimensions): ZoneRect {
  const shift = (lo: number, hi: number, by: number, size: number) => Math.min(Math.max(by, -lo), size - hi);
  const sx = shift(start.x0, start.x1, dx, dims.widthMeters);
  const sy = shift(start.y0, start.y1, dy, dims.depthMeters);
  return { x0: start.x0 + sx, y0: start.y0 + sy, x1: start.x1 + sx, y1: start.y1 + sy };
}

export function zoneGrips(rect: ZoneRect): readonly { handle: ZoneHandle; at: PlanPoint }[] {
  const mx = (rect.x0 + rect.x1) / 2;
  const my = (rect.y0 + rect.y1) / 2;
  return [
    { handle: "nw", at: { x: rect.x0, y: rect.y0 } },
    { handle: "n", at: { x: mx, y: rect.y0 } },
    { handle: "ne", at: { x: rect.x1, y: rect.y0 } },
    { handle: "e", at: { x: rect.x1, y: my } },
    { handle: "se", at: { x: rect.x1, y: rect.y1 } },
    { handle: "s", at: { x: mx, y: rect.y1 } },
    { handle: "sw", at: { x: rect.x0, y: rect.y1 } },
    { handle: "w", at: { x: rect.x0, y: my } },
  ];
}

export function gripAt(
  onScreen: readonly { handle: ZoneHandle; x: number; y: number }[],
  pointer: { x: number; y: number },
  radius: number,
): ZoneHandle | null {
  let best: { handle: ZoneHandle; d: number } | null = null;
  for (const grip of onScreen) {
    const d = Math.hypot(grip.x - pointer.x, grip.y - pointer.y);
    if (d <= radius && (!best || d < best.d)) best = { handle: grip.handle, d };
  }
  return best?.handle ?? null;
}

export const GRIP_CURSOR: Record<ZoneHandle, string> = {
  nw: "nwse-resize",
  se: "nwse-resize",
  ne: "nesw-resize",
  sw: "nesw-resize",
  n: "ns-resize",
  s: "ns-resize",
  e: "ew-resize",
  w: "ew-resize",
};

export function sameRect(a: ZoneRect, b: ZoneRect): boolean {
  const close = (p: number, q: number) => Math.abs(p - q) < 1e-6;
  return close(a.x0, b.x0) && close(a.y0, b.y0) && close(a.x1, b.x1) && close(a.y1, b.y1);
}
