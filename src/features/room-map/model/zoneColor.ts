import type { RoomObjectKind } from "./objectId";

export const ZONE_TOKENS = [
  "var(--lm-zone-1)",
  "var(--lm-zone-2)",
  "var(--lm-zone-3)",
  "var(--lm-zone-4)",
  "var(--lm-zone-5)",
  "var(--lm-zone-6)",
];

/** The palette's colours by name, in token order. */
export const ZONE_SWATCH_NAMES = ["blue", "emerald", "purple", "amber", "rose", "cyan"] as const;
export type ZoneSwatchName = (typeof ZONE_SWATCH_NAMES)[number];

// What each token stood for when the zone inspector stored hex, so a zone saved then still reads as
// its swatch.
const ZONE_TOKEN_HEX = ["#3b82f6", "#10b981", "#a855f7", "#f59e0b", "#f43f5e", "#06b6d4"];

/** The palette swatch a stored colour is, or -1 for a colour of the user's own. */
export function zoneSwatchIndex(colour: string | null | undefined): number {
  if (!colour) return -1;
  const token = ZONE_TOKENS.indexOf(colour);
  return token >= 0 ? token : ZONE_TOKEN_HEX.indexOf(colour.toLowerCase());
}

export const TYPE_DOT_COLOR: Record<RoomObjectKind, string> = {
  tv: "var(--lm-zone-3)", // purple
  furniture: "var(--lm-amber)",
  usb: "var(--lm-zone-6)", // cyan
  hue: "var(--lm-ink-dim)",
  image: "var(--lm-ink-faint)",
  decor: "var(--lm-amber-2)",
};

/** Hex for what cannot read a CSS variable; anything unrecognised is the `index`th swatch. */
export function zoneHex(colour: string | null | undefined, index: number): string {
  const swatch = zoneSwatchIndex(colour);
  if (swatch >= 0) return ZONE_TOKEN_HEX[swatch]!;
  return colour && /^#[0-9a-f]{6}$/i.test(colour) ? colour : ZONE_TOKEN_HEX[index % ZONE_TOKEN_HEX.length]!;
}

/** The palette colour of the `index`th zone, wrapping round the palette. */
export function zoneToken(index: number): string {
  return ZONE_TOKENS[index % ZONE_TOKENS.length] ?? "var(--lm-zone-1)";
}

export function getZoneColor(zone: { borderColor?: string | null }, index: number): string {
  if (zone.borderColor) return zone.borderColor;
  return zoneToken(index);
}
