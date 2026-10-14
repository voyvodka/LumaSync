import {
  FURNITURE_CATALOGUE,
  type FurniturePlacement,
  type FurnitureType,
} from "@/shared/contracts/roomMap";

/** What a new piece of each kind starts as, in metres: a real one's footprint, so a sofa added from
 *  the toolbar is a sofa and not a 0.6 m square. */
export const FURNITURE_DEFAULT_SIZE = {
  sofa: { width: 2.0, depth: 0.9 },
  table: { width: 1.2, depth: 0.7 },
  chair: { width: 0.55, depth: 0.55 },
  bed: { width: 1.6, depth: 2.05 },
  storage: { width: 1.2, depth: 0.45 },
  plant: { width: 0.5, depth: 0.5 },
  rug: { width: 2.0, depth: 1.4 },
  other: { width: 0.6, depth: 0.6 },
} satisfies Record<FurnitureType, { width: number; depth: number }>;

/** The patch that turns a piece into another type. A variant or tone the new type does not take is
 *  cleared: `dining` means a table and a chair alike, and a spread would carry it across silently. */
export function retypeFurniture(item: FurniturePlacement, type: FurnitureType): Partial<FurniturePlacement> {
  const spec = FURNITURE_CATALOGUE[type];
  const keepsVariant = item.variant !== undefined && (spec.variants as readonly string[]).includes(item.variant);
  const keepsTone = item.tone !== undefined && (spec.tones as readonly string[]).includes(item.tone);
  return {
    type,
    variant: keepsVariant ? item.variant : undefined,
    tone: keepsTone ? item.tone : undefined,
  };
}
