import type { TFunction } from "i18next";
import type { RoomMapConfig } from "@/shared/contracts/roomMap";

export type RoomObjectType = "tv" | "furniture" | "usb" | "hue" | "image";

export interface ObjectRowEntry {
  id: string;
  type: RoomObjectType;
  label: string;
  locked?: boolean;
  zoneId?: string;
}

export function buildObjectList(
  config: RoomMapConfig,
  t: TFunction,
): ObjectRowEntry[] {
  const rows: ObjectRowEntry[] = [];
  for (const layer of config.imageLayers) {
    rows.push({
      id: `img-${layer.id}`,
      type: "image",
      label: layer.label,
      locked: layer.locked,
    });
  }
  if (config.tvAnchor) {
    rows.push({
      id: "tv",
      type: "tv",
      label: t("roomMap:objectPanel.tvLabel"),
      locked: config.tvAnchor.locked,
    });
  }
  for (const f of config.furniture) {
    rows.push({
      id: `furniture-${f.id}`,
      type: "furniture",
      label: f.label ?? t(`roomMap:furniture.type.${f.type}`),
      locked: f.locked,
    });
  }
  for (const s of config.usbStrips) {
    rows.push({
      id: `usb-${s.stripId}`,
      type: "usb",
      label: t("roomMap:objectPanel.ledLabel", { count: String(s.ledCount) }),
      locked: s.locked,
    });
  }
  for (const ch of config.hueChannels) {
    rows.push({
      id: `hue-${ch.channelIndex}`,
      type: "hue",
      label: ch.label ?? t("roomMap:objectPanel.hueLabel", { index: String(ch.channelIndex + 1) }),
      locked: ch.locked,
      zoneId: ch.zoneId,
    });
  }
  return rows;
}
