import type { HueChannelPlacement } from "@/shared/contracts/roomMap";
import { findHueChannel, hueChannelsForArea, replaceHueChannel } from "@/shared/contracts/roomMap";

/** A `hue-<index>` object id carries no area, so every read and write keyed on
 *  it has to go through the area the editor is showing — `channelIndex` alone
 *  also matches the same-numbered channel of every other area. See
 *  docs/architecture/room-map.md. `null` means no area is known yet. */
export function scopeHueChannels(
  channels: HueChannelPlacement[],
  areaId: string | null,
): HueChannelPlacement[] {
  return areaId ? hueChannelsForArea(channels, areaId) : channels;
}

export function findScopedHueChannel(
  channels: HueChannelPlacement[],
  areaId: string | null,
  channelIndex: number,
): HueChannelPlacement | undefined {
  return findHueChannel(scopeHueChannels(channels, areaId), channelIndex);
}

/** Rewrite one channel of the viewed area, leaving every other area's alone. */
export function updateScopedHueChannel(
  channels: HueChannelPlacement[],
  areaId: string | null,
  channelIndex: number,
  update: (channel: HueChannelPlacement) => HueChannelPlacement,
): HueChannelPlacement[] {
  const target = findScopedHueChannel(channels, areaId, channelIndex);
  return target ? replaceHueChannel(channels, update(target)) : channels;
}
