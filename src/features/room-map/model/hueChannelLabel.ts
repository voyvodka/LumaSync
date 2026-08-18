// What a Hue channel is called on screen. One implementation because eleven
// sites were each spelling out `channelIndex + 1` — the ordinal, which equals
// the bridge's id only on a contiguous area.

import type { TFunction } from "i18next";

import type { HueChannelPlacement } from "@/shared/contracts/roomMap";

type Named = Pick<HueChannelPlacement, "label" | "channelId">;

/** The bridge's own id, rendered raw — `#0` is a legitimate channel. `null`
 *  when the placement has never been matched to a bridge light. */
export function hueChannelIdLabel(channelId: number | null | undefined): string | null {
  return channelId == null ? null : `#${channelId}`;
}

/** Compact form for the canvas dot, where `#` does not fit. */
export function hueChannelDotText(channelId: number | null | undefined): string {
  return channelId == null ? "?" : String(channelId);
}

/** The user's own name, else the bridge id, else an explicit "unmatched" —
 *  never the ordinal, which would read as an identity it is not. */
export function hueChannelName(channel: Named, t: TFunction): string {
  if (channel.label) return channel.label;
  const id = hueChannelIdLabel(channel.channelId);
  return id === null
    ? t("roomMap:hueChannel.unresolvedLabel")
    : t("roomMap:hueChannel.defaultLabel", { id });
}
