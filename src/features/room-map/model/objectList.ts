import type { TFunction } from "i18next";
import type { RoomMapConfig } from "@/shared/contracts/roomMap";

import { decorLightNames, listDecorLights } from "./decorLight";
import { furnitureName } from "./furnitureName";
import {
  decorLightObjectId,
  furnitureObjectId,
  hueChannelObjectId,
  imageLayerObjectId,
  TV_ANCHOR_OBJECT_ID,
  usbStripObjectId,
  type RoomObjectKind,
} from "./objectId";
import { hueChannelName } from "./hueChannelLabel";

export interface ObjectRowEntry {
  id: string;
  type: RoomObjectKind;
  label: string;
  locked?: boolean;
  zoneId?: string | null;
}

export function buildObjectList(
  config: RoomMapConfig,
  t: TFunction,
): ObjectRowEntry[] {
  const rows: ObjectRowEntry[] = [];
  for (const layer of config.imageLayers) {
    rows.push({
      id: imageLayerObjectId(layer.id),
      type: "image",
      label: layer.label,
      locked: layer.locked,
    });
  }
  if (config.tvAnchor) {
    rows.push({
      id: TV_ANCHOR_OBJECT_ID,
      type: "tv",
      label: t("roomMap:objectPanel.tvLabel"),
      locked: config.tvAnchor.locked,
    });
  }
  for (const f of config.furniture) {
    rows.push({
      id: furnitureObjectId(f.id),
      type: "furniture",
      label: furnitureName(f, t),
      locked: f.locked,
    });
  }
  for (const s of config.usbStrips) {
    rows.push({
      id: usbStripObjectId(s.stripId),
      type: "usb",
      label: t("roomMap:objectPanel.ledLabel", { count: String(s.ledCount) }),
      locked: s.locked,
    });
  }
  const decorNames = decorLightNames(config, t);
  for (const light of listDecorLights(config)) {
    rows.push({
      id: decorLightObjectId(light.id),
      type: "decor",
      label: decorNames.get(light.id)!,
      locked: light.locked,
    });
  }
  for (const ch of config.hueChannels) {
    rows.push({
      id: hueChannelObjectId(ch.channelIndex),
      type: "hue",
      label: hueChannelName(ch, t),
      locked: ch.locked ?? undefined,
      zoneId: ch.zoneId,
    });
  }
  return rows;
}
