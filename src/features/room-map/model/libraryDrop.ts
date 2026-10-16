import type { FurnitureType } from "@/shared/contracts/roomMap";
import { clamp } from "@/shared/lib/math";

import { FURNITURE_DEFAULT_SIZE } from "./furnitureKinds";

export type LibraryCard = { kind: "furniture"; type: FurnitureType } | { kind: "tv" };

export const TV_DEFAULT_FOOTPRINT = { width: 1.0, depth: 0.1 } as const;

export interface DropRect {
  /** Top-left, in plan metres. */
  x: number;
  y: number;
  width: number;
  depth: number;
}

export function cardFootprint(card: LibraryCard): { width: number; depth: number } {
  return card.kind === "tv" ? TV_DEFAULT_FOOTPRINT : FURNITURE_DEFAULT_SIZE[card.type];
}

/** The card's piece centred on `centre`, held inside the room's box as a carried piece lands. */
export function dropRect(card: LibraryCard, centre: { x: number; y: number }, room: { width: number; depth: number }): DropRect {
  const { width, depth } = cardFootprint(card);
  return {
    x: clamp(centre.x - width / 2, 0, Math.max(0, room.width - width)),
    y: clamp(centre.y - depth / 2, 0, Math.max(0, room.depth - depth)),
    width,
    depth,
  };
}

export interface LibraryDrop {
  /** Shows where the card would land; false off the stage. */
  hover(card: LibraryCard, clientX: number, clientY: number): boolean;
  /** Adds the card's piece there; false, and nothing added, off the stage or outside the room. */
  land(card: LibraryCard, clientX: number, clientY: number): boolean;
  cancel(): void;
}
