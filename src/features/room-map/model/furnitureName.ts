import type { TFunction } from "i18next";

import type { TranslationKey } from "@/features/i18n/catalogue";
import { I18N_SUPPORTED_LANGUAGES } from "@/features/i18n/i18n";
import { FURNITURE_CATALOGUE, type FurniturePlacement, type FurnitureType, resolveFurnitureType, resolveFurnitureVariant } from "@/shared/contracts/roomMap";

type Named = Pick<FurniturePlacement, "type" | "variant" | "label">;

/** A name the app gave the piece in some language: its type's or one of its models'. Maps saved
 *  before names followed the language stored these, so they read as no name of the user's. */
function isGivenName(label: string, type: FurnitureType, t: TFunction): boolean {
  const keys: TranslationKey[] = [`roomMap:furniture.type.${type}`, ...FURNITURE_CATALOGUE[type].variants.map((v): TranslationKey => `roomMap:furniture.variant.${v}`)];
  return I18N_SUPPORTED_LANGUAGES.some((lng) => keys.some((key) => t(key, { lng }) === label));
}

export function furnitureOwnName(item: Named, t: TFunction): string | null {
  const label = item.label?.trim();
  return label && !isGivenName(label, resolveFurnitureType(item.type), t) ? label : null;
}

export function furnitureName(item: Named, t: TFunction): string {
  const own = furnitureOwnName(item, t);
  if (own) return own;
  const variant = resolveFurnitureVariant(item);
  return variant ? t(`roomMap:furniture.variant.${variant}`) : t(`roomMap:furniture.type.${resolveFurnitureType(item.type)}`);
}
