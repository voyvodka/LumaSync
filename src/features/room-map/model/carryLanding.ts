import { type RoomMapConfig, stripCentre } from "@/shared/contracts/roomMap";
import { tvMountHeight } from "@/features/room-view/model/roomSpace";
import { clamp } from "@/shared/lib/math";

import { moveTvWithBacklight } from "./backlight";
import { hueToMetres, planMetresToHue, resolveHueChannelWorldZ, setHueChannelWorldZ } from "./hueChannelPosition";
import { parseObjectId } from "./objectId";
import { keepStripInside, landCarriedPiece, roomBoxOf } from "./pieceGeometry";
import { ROOM_OBJECT_KINDS, type RoomObjectContext } from "./roomObjectKinds";

/**
 * What the map becomes when the 3D room puts `objectId` down with its middle at (`cx`, `cy`) on the
 * plan, in metres. Furniture also takes the turn it was given while carried; the TV, a strip and a
 * Hue light keep their own axes. Each kind lands through the same adapter typed positions use, so it
 * stops at the walls and a zone-bound light stays in its zone. Null for what cannot move or is locked.
 * `raised` takes the TV or a Hue light up or down as well: the TV's centre to `centreY`, a light by
 * `rise` metres from the height it was drawn at.
 */
export function landCarried(
  config: RoomMapConfig,
  objectId: string,
  cx: number,
  cy: number,
  turnDeg: number,
  ctx: RoomObjectContext,
  raised?: Raised,
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
      const slid = ROOM_OBJECT_KINDS.tv.moveTo(config, ref, cx - tv.width / 2, cy - tv.height / 2)?.tvAnchor;
      if (!slid) return null;
      const moved = raised ? { ...slid, mountHeightMeters: centimetres(clamp(raised.centreY, 0, config.dimensions.heightMeters)) } : slid;
      // Its backlight goes with it: left behind, the strip stopped being the screen's.
      const room = roomBoxOf(config);
      const strips = moveTvWithBacklight(config.usbStrips, tv, moved, (s) => keepStripInside(s, room));
      return strips ? { tvAnchor: moved, usbStrips: strips } : { tvAnchor: moved };
    }
    case "usb": {
      const strip = config.usbStrips.find((s) => s.stripId === ref.stripId);
      if (!strip || strip.locked) return null;
      const centre = stripCentre(strip);
      const dx = cx - centre.x;
      const dy = cy - centre.y;
      return ROOM_OBJECT_KINDS.usb.moveTo(config, ref, strip.startX + dx, strip.startY + dy);
    }
    case "hue": {
      if (ROOM_OBJECT_KINDS.hue.isLocked(config, ref, ctx)) return null;
      const { widthMeters, depthMeters } = config.dimensions;
      const p = planMetresToHue(cx, cy, widthMeters, depthMeters);
      const moved = ROOM_OBJECT_KINDS.hue.moveTo(config, ref, clamp(p.x, -1, 1), clamp(p.y, -1, 1), ctx);
      if (!moved?.hueChannels || !raised) return moved;
      const H = config.dimensions.heightMeters;
      const hueChannels = moved.hueChannels.map((ch) => {
        if (ch.channelIndex !== ref.channelIndex) return ch;
        // Drawn at the TV's height until its own is known, so that is where the rise starts from.
        const from = ch.zOrigin ? hueToMetres(resolveHueChannelWorldZ(ch, config.zones), H) : tvMountHeight(config.tvAnchor, config.dimensions);
        return setHueChannelWorldZ(ch, config.zones, (clamp(from + raised.rise, 0, H) / H) * 2 - 1);
      });
      return { ...moved, hueChannels };
    }
    default:
      return null;
  }
}

export interface Raised {
  rise: number;
  centreY: number;
}

const centimetres = (m: number) => Math.round(m * 100) / 100;

function centreOf(config: RoomMapConfig, objectId: string): { x: number; y: number } | null {
  const ref = parseObjectId(objectId);
  const box =
    ref?.kind === "furniture" ? config.furniture.find((f) => f.id === ref.furnitureId) : ref?.kind === "tv" ? config.tvAnchor : null;
  return box ? { x: box.x + box.width / 2, y: box.y + box.height / 2 } : null;
}

/**
 * `landCarried`, with what rode on the piece — a desk's monitor — moved by as far as the piece landed
 * from where it stood, each through its own landing. One patch, so one undo step takes both back.
 */
export function landCarriedWith(
  config: RoomMapConfig,
  objectId: string,
  cx: number,
  cy: number,
  turnDeg: number,
  riders: readonly string[],
  ctx: RoomObjectContext,
  raised?: Raised,
): Partial<RoomMapConfig> | null {
  const landed = landCarried(config, objectId, cx, cy, turnDeg, ctx, raised);
  if (!landed || riders.length === 0) return landed;
  const before = centreOf(config, objectId);
  let next: RoomMapConfig = { ...config, ...landed };
  const after = centreOf(next, objectId);
  if (!before || !after) return landed;
  let patch = landed;
  for (const rider of riders) {
    const at = centreOf(next, rider);
    if (!at) continue;
    const moved = landCarried(next, rider, at.x + after.x - before.x, at.y + after.y - before.y, 0, ctx);
    if (!moved) continue;
    next = { ...next, ...moved };
    patch = { ...patch, ...moved };
  }
  return patch;
}
