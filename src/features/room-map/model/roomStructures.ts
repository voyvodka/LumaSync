// Where a room's structures stand. A window, door or niche stores only a point and a width; the wall
// it is set in is read here, at draw time, so a reshaped room keeps it on a wall.
import { type RoomCorner, type RoomMapConfig, resolveRoomFootprint, STRUCTURE_KINDS, type WallStructure } from "@/shared/contracts/roomMap";

export interface WallAnchor {
  /** The outline's edge, corner `edge` to the next. */
  edge: number;
  /** The wall runs along x (the TV or back wall) rather than along y. */
  alongX: boolean;
  /** Its y when along x, its x when along y. */
  at: number;
  /** The item's middle along the wall, moved in so the whole width fits. */
  centre: number;
  /** Cut to the wall's length when longer. */
  width: number;
  /** +1 or -1: which way from the wall the room is, on the axis across it. */
  inward: 1 | -1;
}

/** The wall an item is set in: the nearest wall it stands in front of, or else the nearest wall at
 *  all, measured to its ends. */
export function anchorWallItem(item: Pick<WallStructure, "x" | "y" | "width">, config: Pick<RoomMapConfig, "footprint" | "dimensions">): WallAnchor | null {
  const corners = resolveRoomFootprint(config);
  let best: { edge: number; alongX: boolean; at: number; lo: number; hi: number; distance: number } | null = null;
  for (let i = 0; i < corners.length; i++) {
    const a = corners[i]!;
    const b = corners[(i + 1) % corners.length]!;
    const alongX = a.y === b.y;
    const lo = alongX ? Math.min(a.x, b.x) : Math.min(a.y, b.y);
    const hi = alongX ? Math.max(a.x, b.x) : Math.max(a.y, b.y);
    if (hi - lo < 1e-6) continue;
    const at = alongX ? a.y : a.x;
    const along = alongX ? item.x : item.y;
    const across = Math.abs((alongX ? item.y : item.x) - at);
    const past = along < lo ? lo - along : along > hi ? along - hi : 0;
    const distance = Math.hypot(across, past);
    if (!best || distance < best.distance - 1e-9) best = { edge: i, alongX, at, lo, hi, distance };
  }
  if (!best) return null;
  const width = Math.min(item.width, best.hi - best.lo);
  const along = best.alongX ? item.x : item.y;
  const centre = Math.min(Math.max(along, best.lo + width / 2), best.hi - width / 2);
  // A hair to one side of the wall's middle: that side is the room's when it is inside the outline.
  const probe = 0.05;
  const px = best.alongX ? centre : best.at + probe;
  const py = best.alongX ? best.at + probe : centre;
  const inward = inside(px, py, corners) ? 1 : -1;
  return { edge: best.edge, alongX: best.alongX, at: best.at, centre, width, inward };
}

function inside(x: number, y: number, corners: readonly RoomCorner[]): boolean {
  let within = false;
  for (let i = 0, j = corners.length - 1; i < corners.length; j = i++) {
    const a = corners[i]!;
    const b = corners[j]!;
    if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) within = !within;
  }
  return within;
}

const SHIFTED_KEYS = ["x", "y", "x1", "y1", "x2", "y2"] as const;
const WALL_KINDS: ReadonlySet<unknown> = new Set([STRUCTURE_KINDS.WINDOW, STRUCTURE_KINDS.DOOR, STRUCTURE_KINDS.NICHE]);

type Outline = Pick<RoomMapConfig, "footprint" | "dimensions">;

/** A wall item goes back on its own wall: shifted alone, a moved wall left it nearer another. */
export function moveStructures(stored: unknown, shift: { x: number; y: number }, from: Outline, to: Outline): unknown[] | undefined {
  if (!Array.isArray(stored)) return undefined;
  const before = resolveRoomFootprint(from);
  const after = resolveRoomFootprint(to);
  return stored.map((entry: unknown) => {
    if (typeof entry !== "object" || entry === null) return entry;
    const was = entry as Record<string, unknown>;
    const next: Record<string, unknown> = { ...was };
    for (const key of SHIFTED_KEYS) {
      const value = next[key];
      if (typeof value === "number" && Number.isFinite(value)) next[key] = value + (key.startsWith("x") ? shift.x : shift.y);
    }
    const { x, y, width } = was;
    if (!WALL_KINDS.has(was.kind) || !finite(x) || !finite(y) || !finite(width) || width <= 0 || before.length !== after.length) return next;
    const anchor = anchorWallItem({ x, y, width }, from);
    if (!anchor) return next;
    const a = after[anchor.edge]!;
    const b = after[(anchor.edge + 1) % after.length]!;
    if ((a.y === b.y) !== anchor.alongX) return next;
    if (anchor.alongX) next.y = a.y;
    else next.x = a.x;
    return next;
  });
}

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
