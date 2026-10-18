import { classifyFurniture, type FurnitureModel } from "@/features/room-view/model/furnitureModel";
import { DEFAULT_ROOM_MAP, FURNITURE_TYPES, type FurniturePlacement, type FurnitureType } from "@/shared/contracts/roomMap";

import { FURNITURE_DEFAULT_SIZE } from "./furnitureKinds";

/** One type as the palette offers it: the piece a press adds, and how it reads before anything
 *  stands beside it. */
export interface FurnitureTile {
  type: FurnitureType;
  /** The piece as added, at the type's default size, for drawing the tile. */
  piece: FurniturePlacement;
  model: FurnitureModel;
}

/** Every furniture type at its default size with nothing around it, read the way the 3D room reads
 *  a piece. A table alone is a dining table and storage alone a cabinet: what stands beside them
 *  later is what makes them a coffee table or a TV unit. */
export const FURNITURE_TILES: readonly FurnitureTile[] = Object.values(FURNITURE_TYPES).map((type) => {
  const { width, depth } = FURNITURE_DEFAULT_SIZE[type];
  const piece: FurniturePlacement = { id: `tile-${type}`, type, x: 0, y: 0, width, height: depth };
  const model = classifyFurniture({ ...DEFAULT_ROOM_MAP, furniture: [piece] }).get(piece.id) ?? { kind: "box" };
  return { type, piece, model };
});

export function furnitureTile(type: FurnitureType): FurnitureTile {
  return FURNITURE_TILES.find((tile) => tile.type === type) ?? FURNITURE_TILES[FURNITURE_TILES.length - 1]!;
}
