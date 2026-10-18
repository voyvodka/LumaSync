import type { RoomMapConfig } from "@/shared/contracts/roomMap";
import { replaceHueChannel, translateStrip } from "@/shared/contracts/roomMap";

import { moveTvWithBacklight } from "./backlight";
import { nudgeHueChannel } from "./hueChannelPosition";
import { scopeHueChannels } from "./hueChannelScope";
import { furnitureObjectId, hueChannelObjectId, TV_ANCHOR_OBJECT_ID, usbStripObjectId } from "./objectId";
import { keepPlacedInside, keepStripInside, roomBoxOf } from "./pieceGeometry";

const round = (v: number) => Math.round(v * 100) / 100;

/** A ⇧-picked group dropped `dx`/`dy` metres away, each member moved as its own drag would move it. */
export function moveGroup(
  cfg: RoomMapConfig,
  members: ReadonlySet<string>,
  hueAreaId: string | null,
  dx: number,
  dy: number,
): Pick<RoomMapConfig, "furniture" | "usbStrips" | "hueChannels"> & Partial<Pick<RoomMapConfig, "tvAnchor">> {
  const room = roomBoxOf(cfg);
  const { widthMeters, depthMeters } = cfg.dimensions;

  let hueChannels = cfg.hueChannels;
  for (const ch of scopeHueChannels(cfg.hueChannels, hueAreaId)) {
    if (!members.has(hueChannelObjectId(ch.channelIndex)) || ch.locked) continue;
    // No re-seating: a lamp on a table that moves with it keeps its height.
    hueChannels = replaceHueChannel(hueChannels, nudgeHueChannel(ch, cfg.zones, (2 * dx) / widthMeters, (-2 * dy) / depthMeters));
  }

  const tv = cfg.tvAnchor;
  const tvMoves = tv && members.has(TV_ANCHOR_OBJECT_ID) && !tv.locked;
  const tvAnchor = tvMoves ? keepPlacedInside({ ...tv, x: round(tv.x + dx), y: round(tv.y + dy) }, room) : tv;
  const carried = tvMoves && tvAnchor ? moveTvWithBacklight(cfg.usbStrips, tv, tvAnchor, (s) => keepStripInside(s, room)) : null;

  return {
    furniture: cfg.furniture.map((f) =>
      members.has(furnitureObjectId(f.id)) && !f.locked ? keepPlacedInside({ ...f, x: round(f.x + dx), y: round(f.y + dy) }, room) : f,
    ),
    ...(tvMoves ? { tvAnchor } : {}),
    usbStrips: cfg.usbStrips.map((st, i) =>
      members.has(usbStripObjectId(st.stripId)) && !st.locked ? keepStripInside(translateStrip(st, dx, dy), room) : (carried?.[i] ?? st),
    ),
    hueChannels,
  };
}
