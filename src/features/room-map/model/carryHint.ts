import type { RoomMapConfig } from "@/shared/contracts/roomMap";

import { parseObjectId } from "./objectId";
import { ROOM_OBJECT_KINDS, type RoomObjectContext } from "./roomObjectKinds";

export type CarryHint = "turn" | "rise";

export function carryHint(config: RoomMapConfig, selectedId: string | null, ctx: RoomObjectContext): CarryHint | null {
  const ref = selectedId ? parseObjectId(selectedId) : null;
  if (!ref) return null;
  switch (ref.kind) {
    case "furniture":
      return ROOM_OBJECT_KINDS.furniture.isLocked(config, ref) || !config.furniture.some((f) => f.id === ref.furnitureId) ? null : "turn";
    case "tv":
      return config.tvAnchor && !ROOM_OBJECT_KINDS.tv.isLocked(config) ? "rise" : null;
    case "hue":
      return config.hueChannels.some((ch) => ch.channelIndex === ref.channelIndex) && !ROOM_OBJECT_KINDS.hue.isLocked(config, ref, ctx) ? "rise" : null;
    default:
      return null;
  }
}
