import type {
  FurniturePlacement,
  HueChannelPlacement,
  HueZone,
  ImageLayer,
  RoomMapConfig,
  TvAnchorPlacement,
  UsbStripPlacement,
} from "@/shared/contracts/roomMap";
import { findHueChannel } from "@/shared/contracts/roomMap";
import { parseObjectId } from "./objectId";

/**
 * Resolve the active selection from the dock's `selectedId` shape and
 * the active Hue-zone id.
 *
 * v1.5 W4-F2 manual-test (2026-04-28) — priority swap: a concrete
 * object selection wins over `activeHueZoneId` so clicking a TV /
 * furniture / strip / channel / image row in the Objects list
 * routes its inspector into the dock even when a Hue zone is the
 * current zone selection. The Hue zone inspector is reserved for
 * the case where the user picks a zone (no concrete object selected).
 *
 * Logical zones were dropped — see RFC §"Direction reversal" — so
 * the dispatcher reads exclusively from `config.zones: HueZone[]`.
 */
export type InspectorTarget =
  | { kind: "hueZone"; zone: HueZone }
  | { kind: "tv"; tv: TvAnchorPlacement }
  | { kind: "furniture"; item: FurniturePlacement }
  | { kind: "usb"; strip: UsbStripPlacement }
  | { kind: "hueChannel"; channel: HueChannelPlacement; zoneName: string | null }
  | { kind: "image"; layer: ImageLayer }
  | { kind: "empty" };

export function resolveInspectorTarget(
  config: RoomMapConfig,
  selectedId: string | null,
  activeHueZoneId: string | null,
): InspectorTarget {
  if (selectedId) {
    const parsed = parseObjectId(selectedId);
    if (parsed?.kind === "tv" && config.tvAnchor) {
      return { kind: "tv", tv: config.tvAnchor };
    }
    if (parsed?.kind === "furniture") {
      const item = config.furniture.find((f) => f.id === parsed.furnitureId);
      if (item) return { kind: "furniture", item };
    }
    if (parsed?.kind === "usb") {
      const strip = config.usbStrips.find((s) => s.stripId === parsed.stripId);
      if (strip) return { kind: "usb", strip };
    }
    if (parsed?.kind === "hue") {
      const channel = findHueChannel(config.hueChannels, parsed.channelIndex);
      if (channel) {
        const zoneName = channel.zoneId
          ? config.zones.find((z) => z.id === channel.zoneId)?.name ?? null
          : null;
        return { kind: "hueChannel", channel, zoneName };
      }
    }
    if (parsed?.kind === "image") {
      const layer = config.imageLayers.find((l) => l.id === parsed.layerId);
      if (layer) return { kind: "image", layer };
    }
  }
  // No concrete object selected — fall back to the active Hue zone.
  if (activeHueZoneId) {
    const zone = config.zones.find((z) => z.id === activeHueZoneId);
    if (zone) return { kind: "hueZone", zone };
  }
  return { kind: "empty" };
}
