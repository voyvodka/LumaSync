// The lights the room's View face lists and can select: the shown area's Hue channels, the USB
// strips and the screen. Pure, so the dock and its tests read the same list.
import type { TFunction } from "i18next";

import { lampColourCss } from "@/features/room-view/model/lampColours";
import type { LampFamily } from "@/features/room-view/model/lampFamily";
import type { HueAreaChannelInfo } from "@/shared/contracts/hue";
import type { HueChannelPlacement, HueZone, RoomMapConfig } from "@/shared/contracts/roomMap";

import { hueChannelName } from "./hueChannelLabel";
import { hueChannelObjectId, TV_ANCHOR_OBJECT_ID, usbStripObjectId } from "./objectId";
import { resolveInspectorTarget } from "./resolveInspectorTarget";
import { getZoneColor } from "./zoneColor";

export type ViewLightKind = "hue" | "usb" | "tv";

export interface ViewLight {
  /** The room map's object id (`hue-3`, `usb-<id>`, `tv`). */
  id: string;
  kind: ViewLightKind;
  name: string;
  /** Hue only: the zone the channel is bound to. */
  zone: { name: string; colour: string } | null;
  /** Hue only, and only once the bridge has said what the fixture is — never guessed. */
  family: LampFamily | null;
  /** Hue only: how many lights the channel drives; null when not known. */
  lightCount: number | null;
  /** What identify blinks; empty when the channel is not matched to the bridge. */
  lightIds: readonly string[];
  /** The bridge no longer reports this channel in the area. */
  ghost: boolean;
  /** Never matched to a bridge channel. */
  unmatched: boolean;
  /** USB only: the strip's own id. */
  stripId: string | null;
  /** Hue only: the colour its lamp glows in the 3D room, so its chip can be told from the others. */
  glow: string | null;
}

export interface ViewLightSources {
  config: RoomMapConfig;
  zones: readonly HueZone[];
  areaChannels: readonly HueAreaChannelInfo[];
  /** The channel ids the bridge reports in the area, or null before it has been read. */
  liveChannelIds: ReadonlySet<number> | null;
  families: ReadonlyMap<number, LampFamily>;
}

function hueLight(channel: HueChannelPlacement, sources: ViewLightSources, t: TFunction): ViewLight {
  const { config, zones, areaChannels, liveChannelIds, families } = sources;
  const zoneIndex = channel.zoneId ? zones.findIndex((z) => z.id === channel.zoneId) : -1;
  const zone = zoneIndex >= 0 ? zones[zoneIndex] : undefined;
  const info = channel.channelId == null ? undefined : areaChannels.find((c) => c.channelId === channel.channelId);
  return {
    id: hueChannelObjectId(channel.channelIndex),
    kind: "hue",
    name: hueChannelName(channel, t),
    zone: zone ? { name: zone.name, colour: getZoneColor(zone, zoneIndex) } : null,
    family: families.get(channel.channelIndex) ?? null,
    lightCount: info ? info.lightCount : null,
    lightIds: info?.lightIds ?? [],
    ghost: liveChannelIds !== null && channel.channelId != null && !liveChannelIds.has(channel.channelId),
    unmatched: channel.channelId == null,
    stripId: null,
    glow: lampColourCss(config.hueChannels.indexOf(channel)),
  };
}

/** Hue channels by index, then the strips, then the screen. */
export function buildViewLights(sources: ViewLightSources, t: TFunction): ViewLight[] {
  const { config } = sources;
  const hue = [...config.hueChannels].sort((a, b) => a.channelIndex - b.channelIndex).map((c) => hueLight(c, sources, t));
  const usb = config.usbStrips.map<ViewLight>((strip) => ({
    id: usbStripObjectId(strip.stripId),
    kind: "usb",
    name: t("roomMap:objectPanel.ledLabel", { count: String(strip.ledCount) }),
    zone: null,
    family: null,
    lightCount: null,
    lightIds: [],
    ghost: false,
    unmatched: false,
    stripId: strip.stripId,
    glow: null,
  }));
  const tv: ViewLight[] = config.tvAnchor
    ? [
        {
          id: TV_ANCHOR_OBJECT_ID,
          kind: "tv",
          name: t("roomMap:objectPanel.tvLabel"),
          zone: null,
          family: null,
          lightCount: null,
          lightIds: [],
          ghost: false,
          unmatched: false,
          stripId: null,
          glow: null,
        },
      ]
    : [];
  return [...hue, ...usb, ...tv];
}

/** What View shows as selected. A piece of furniture or an image chosen in Edit is not a light:
 *  View shows nothing for it, and leaves the stored selection alone for the way back. */
export function resolveViewSelection(config: RoomMapConfig, selectedId: string | null): string | null {
  const target = resolveInspectorTarget(config, selectedId, null);
  return target.kind === "hueChannel" || target.kind === "usb" || target.kind === "tv" ? selectedId : null;
}
