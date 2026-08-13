import type { RoomObjectType } from "./objectList";

export const ZONE_TOKENS = [
  "var(--lm-zone-1)",
  "var(--lm-zone-2)",
  "var(--lm-zone-3)",
  "var(--lm-zone-4)",
  "var(--lm-zone-5)",
  "var(--lm-zone-6)",
];

export const TYPE_DOT_COLOR: Record<RoomObjectType, string> = {
  tv: "var(--lm-zone-3)", // purple
  furniture: "var(--lm-amber)",
  usb: "var(--lm-zone-6)", // cyan
  hue: "var(--lm-ink-dim)",
  image: "var(--lm-ink-faint)",
};

export function getZoneColor(zone: { borderColor?: string | null }, index: number): string {
  if (zone.borderColor) return zone.borderColor;
  return ZONE_TOKENS[index % ZONE_TOKENS.length];
}
