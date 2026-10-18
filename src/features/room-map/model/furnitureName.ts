import type { TFunction } from "i18next";

import { type FurniturePlacement, resolveFurnitureType, resolveFurnitureVariant } from "@/shared/contracts/roomMap";

type Named = Pick<FurniturePlacement, "type" | "variant" | "label">;

// Earlier builds stored a piece's type or model name, in English or Turkish, as its label. Kept as a
// frozen list rather than read from the catalogues: only the active language's is loaded.
const NAMES_STORED_BEFORE = new Set([
  "Sofa", "Table", "Chair", "Bed", "Storage", "Plant", "Rug", "Kitchen", "Other", "Straight", "Corner, left",
  "Corner, right", "Dining", "Office", "Armchair", "Bench", "Desk", "Coffee", "Side", "Sideboard",
  "Bookshelf", "Wardrobe", "Nightstand", "TV unit", "Topiary", "Leafy", "Palm", "Rectangle", "Round",
  "Stool", "Beanbag", "Dresser", "Counter", "Island", "Fridge", "Kanepe", "Masa", "Sandalye", "Yatak",
  "Dolap", "Bitki", "Halı", "Mutfak", "Diğer", "Düz", "Köşe, sol", "Köşe, sağ", "Yemek", "Ofis", "Koltuk",
  "Bank", "Çalışma", "Sehpa", "Yan", "Konsol", "Kitaplık", "Gardırop", "Komodin", "TV ünitesi", "Top",
  "Yapraklı", "Palmiye", "Dikdörtgen", "Yuvarlak", "Tabure", "Armut koltuk", "Şifonyer", "Tezgâh", "Ada",
  "Buzdolabı",
]);

export function furnitureOwnName(item: Named): string | null {
  const label = item.label?.trim();
  return label && !NAMES_STORED_BEFORE.has(label) ? label : null;
}

export function furnitureName(item: Named, t: TFunction): string {
  const own = furnitureOwnName(item);
  if (own) return own;
  const variant = resolveFurnitureVariant(item);
  return variant ? t(`roomMap:furniture.variant.${variant}`) : t(`roomMap:furniture.type.${resolveFurnitureType(item.type)}`);
}
