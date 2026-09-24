import type {
  FurniturePlacement,
  HueChannelPlacement,
  HueZone,
  ImageLayer,
  RoomMapConfig,
  TvAnchorPlacement,
  UsbStripPlacement,
} from "@/shared/contracts/roomMap";
import { parseObjectId } from "./objectId";
import { roomObjectAdapter } from "./roomObjectKinds";

/**
 * Resolve the active selection from the dock's `selectedId` shape and
 * the active Hue-zone id.
 *
 * Priority swap: a concrete object selection wins over `activeHueZoneId`
 * so clicking a TV / furniture / strip / channel / image row in the Objects list
 * routes its inspector into the dock even when a Hue zone is the
 * current zone selection. The Hue zone inspector is reserved for
 * the case where the user picks a zone (no concrete object selected).
 *
 * Logical zones were dropped (docs/architecture/hue.md), so
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
  const ref = selectedId ? parseObjectId(selectedId) : null;
  const target = ref ? roomObjectAdapter(ref).inspect(config, ref) : null;
  if (target) return target;
  // No concrete object selected — fall back to the active Hue zone.
  if (activeHueZoneId) {
    const zone = config.zones.find((z) => z.id === activeHueZoneId);
    if (zone) return { kind: "hueZone", zone };
  }
  return { kind: "empty" };
}
