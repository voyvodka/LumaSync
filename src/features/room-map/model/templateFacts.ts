import type { TFunction } from "i18next";

import { type RoomMapConfig, resolveScreenAspect, screenHeightPerWidth } from "@/shared/contracts/roomMap";

import { screenDiagonal } from "./screenSize";

/** A template card's second line: the room's floor, and its screen's size where it has one. */
export function templateFacts(config: RoomMapConfig, t: TFunction, language: string | undefined): string {
  const metres = new Intl.NumberFormat(language, { maximumFractionDigits: 1 });
  const w = metres.format(config.dimensions.widthMeters);
  const d = metres.format(config.dimensions.depthMeters);
  const tv = config.tvAnchor;
  if (!tv) return t("roomMap:templates.facts", { w, d });
  const inch = Math.round(screenDiagonal(tv.width, screenHeightPerWidth(resolveScreenAspect(tv.screenAspect)), "inch"));
  return t("roomMap:templates.factsScreen", { w, d, inch });
}
