import type { RoomMapConfig } from "@/shared/contracts/roomMap";
import { clamp } from "@/shared/lib/math";

import { moveTvWithBacklight } from "./backlight";
import { planMetresToHue } from "./hueChannelPosition";
import { parseObjectId } from "./objectId";
import { keepStripInside, landCarriedPiece, roomBoxOf } from "./pieceGeometry";
import { ROOM_OBJECT_KINDS, type RoomObjectContext } from "./roomObjectKinds";

/**
 * What the map becomes when the 3D room puts `objectId` down with its middle at (`cx`, `cy`) on the
 * plan, in metres. Furniture also takes the turn it was given while carried; the TV, a strip and a
 * Hue light keep their own axes. Each kind lands through the same adapter typed positions use, so it
 * stops at the walls and a zone-bound light stays in its zone. Null for what cannot move or is locked.
 */
export function landCarried(
  config: RoomMapConfig,
  objectId: string,
  cx: number,
  cy: number,
  turnDeg: number,
  ctx: RoomObjectContext,
): Partial<RoomMapConfig> | null {
  const ref = parseObjectId(objectId);
  if (!ref) return null;
  switch (ref.kind) {
    case "furniture": {
      const item = config.furniture.find((f) => f.id === ref.furnitureId);
      if (!item || item.locked) return null;
      const room = roomBoxOf(config);
      return { furniture: config.furniture.map((f) => (f === item ? landCarriedPiece(f, cx, cy, turnDeg, room) : f)) };
    }
    case "tv": {
      const tv = config.tvAnchor;
      if (!tv || tv.locked) return null;
      const moved = ROOM_OBJECT_KINDS.tv.moveTo(config, ref, cx - tv.width / 2, cy - tv.height / 2)?.tvAnchor;
      if (!moved) return null;
      // Its backlight goes with it: left behind, the strip stopped being the screen's.
      const room = roomBoxOf(config);
      const strips = moveTvWithBacklight(config.usbStrips, tv, moved, (s) => keepStripInside(s, room));
      return strips ? { tvAnchor: moved, usbStrips: strips } : { tvAnchor: moved };
    }
    case "usb": {
      const strip = config.usbStrips.find((s) => s.stripId === ref.stripId);
      if (!strip || strip.locked) return null;
      const dx = cx - (strip.startX + strip.endX) / 2;
      const dy = cy - (strip.startY + strip.endY) / 2;
      return ROOM_OBJECT_KINDS.usb.moveTo(config, ref, strip.startX + dx, strip.startY + dy);
    }
    case "hue": {
      if (ROOM_OBJECT_KINDS.hue.isLocked(config, ref, ctx)) return null;
      const { widthMeters, depthMeters } = config.dimensions;
      const p = planMetresToHue(cx, cy, widthMeters, depthMeters);
      return ROOM_OBJECT_KINDS.hue.moveTo(config, ref, clamp(p.x, -1, 1), clamp(p.y, -1, 1), ctx);
    }
    default:
      return null;
  }
}
