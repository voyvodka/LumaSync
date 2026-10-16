import { furnitureObjectId, TV_ANCHOR_OBJECT_ID } from "@/features/room-map/model/objectId";
import { type RoomMapConfig, resolveFurnitureType } from "@/shared/contracts/roomMap";

import { roomToScene } from "./roomSpace";

/** A piece of one room, where it stands in that room's scene. */
export interface MorphPiece {
  objectId: string;
  kind: string;
  x: number;
  z: number;
  width: number;
  /** Degrees, as the plan stores it. */
  rotation: number;
}

export interface MorphPlan {
  /** The same kind of piece in both rooms: it slides from one place to the other. */
  matched: { from: MorphPiece; to: MorphPiece }[];
  leaving: MorphPiece[];
  /** Nearest the room's middle first, the order they rise in. */
  arriving: MorphPiece[];
}

function piecesOf(config: RoomMapConfig): MorphPiece[] {
  const dims = config.dimensions;
  const at = (x: number, y: number, width: number, depth: number) => roomToScene(x + width / 2, y + depth / 2, 0, dims);
  const pieces: MorphPiece[] = config.furniture.map((f) => {
    const centre = at(f.x, f.y, f.width, f.height);
    return { objectId: furnitureObjectId(f.id), kind: resolveFurnitureType(f.type), x: centre.x, z: centre.z, width: f.width, rotation: f.rotation ?? 0 };
  });
  const tv = config.tvAnchor;
  if (tv) {
    const centre = at(tv.x, tv.y, tv.width, tv.height);
    pieces.push({ objectId: TV_ANCHOR_OBJECT_ID, kind: "tv", x: centre.x, z: centre.z, width: tv.width, rotation: 0 });
  }
  return pieces;
}

/** How one room's furniture becomes another's: each kind paired off nearest first, the rest going
 *  or coming. Both rooms are centred on the scene's origin, so a different size still pairs. */
export function planMorph(from: RoomMapConfig, to: RoomMapConfig): MorphPlan {
  const before = piecesOf(from);
  const after = piecesOf(to);
  const pairs = before
    .flatMap((a, i) => after.map((b, j) => ({ i, j, d: a.kind === b.kind ? Math.hypot(a.x - b.x, a.z - b.z) : Number.POSITIVE_INFINITY })))
    .filter((pair) => Number.isFinite(pair.d))
    .sort((p, q) => p.d - q.d);
  const usedFrom = new Set<number>();
  const usedTo = new Set<number>();
  const matched: MorphPlan["matched"] = [];
  for (const { i, j } of pairs) {
    if (usedFrom.has(i) || usedTo.has(j)) continue;
    usedFrom.add(i);
    usedTo.add(j);
    matched.push({ from: before[i]!, to: after[j]! });
  }
  return {
    matched,
    leaving: before.filter((_, i) => !usedFrom.has(i)),
    arriving: after.filter((_, j) => !usedTo.has(j)).sort((a, b) => Math.hypot(a.x, a.z) - Math.hypot(b.x, b.z)),
  };
}
