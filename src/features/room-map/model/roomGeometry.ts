import { toChannelPlacements } from "@/features/hue/model/hueStartConfig";
import type { RoomGeometry, RoomMapConfig, TvAnchorPlacement } from "@/shared/contracts/roomMap";

/** The ambilight worker's room-aware input, or `undefined` without a TV anchor —
 * the gate that keeps a room map with no TV on the legacy sampling path. The
 * placements reuse the stream start's projection so zone resolution and the
 * unknown-height rule have one owner. See docs/architecture/room-map.md. */
export function toRoomGeometry(state: {
  roomMap?: RoomMapConfig;
  lastHueAreaId?: string;
}): RoomGeometry | undefined {
  const roomMap = state.roomMap;
  const anchor = roomMap?.tvAnchor;
  if (!roomMap || !anchor) return undefined;

  const tv: TvAnchorPlacement = {
    x: anchor.x,
    y: anchor.y,
    width: anchor.width,
    height: anchor.height,
  };
  if (anchor.mountHeightMeters !== undefined) tv.mountHeightMeters = anchor.mountHeightMeters;

  const areaId = state.lastHueAreaId?.trim();
  return {
    dimensions: {
      widthMeters: roomMap.dimensions.widthMeters,
      depthMeters: roomMap.dimensions.depthMeters,
      heightMeters: roomMap.dimensions.heightMeters,
    },
    tv,
    huePlacements: (areaId ? toChannelPlacements(roomMap, areaId) : undefined) ?? [],
  };
}
