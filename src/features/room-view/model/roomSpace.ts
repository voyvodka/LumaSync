import {
  hueToMetres,
  resolveHueChannelWorld,
  resolveHueChannelWorldZ,
} from "@/features/room-map/model/hueChannelPosition";
import type { HueChannelPlacement, HueZone, RoomDimensions, TvAnchorPlacement } from "@/shared/contracts/roomMap";
import { DEFAULT_TV_MOUNT_HEIGHT_FRACTION } from "@/shared/contracts/roomMap";

/** A point in the 3D view: metres, x to the right, y up, z away from the TV wall, origin at the
 *  floor's centre. The room map's metres put the origin where the TV wall meets the left wall. */
export interface ScenePoint {
  x: number;
  y: number;
  z: number;
}

export function roomToScene(xM: number, yM: number, heightM: number, dims: RoomDimensions): ScenePoint {
  return { x: xM - dims.widthMeters / 2, y: heightM, z: yM - dims.depthMeters / 2 };
}

export function tvMountHeight(tv: TvAnchorPlacement | null | undefined, dims: RoomDimensions): number {
  return tv?.mountHeightMeters ?? dims.heightMeters * DEFAULT_TV_MOUNT_HEIGHT_FRACTION;
}

/** Where a Hue channel stands: the bridge cube in metres, through its zone when it is bound to one,
 *  as the runtime resolves it. A height of unknown origin is drawn at `unknownHeightM`, the mount
 *  height room-aware sampling assumes for it, rather than as a measured floor-level `z`. */
export function hueChannelScenePoint(
  channel: HueChannelPlacement,
  zones: readonly HueZone[],
  dims: RoomDimensions,
  unknownHeightM: number,
): ScenePoint {
  const { x, y } = resolveHueChannelWorld(channel, zones);
  const height = channel.zOrigin
    ? hueToMetres(resolveHueChannelWorldZ(channel, zones), dims.heightMeters)
    : unknownHeightM;
  return roomToScene(hueToMetres(x, dims.widthMeters), hueToMetres(-y, dims.depthMeters), height, dims);
}

/** The screen's centre, from the anchor's top-left footprint corner and its mount height. */
export function tvScreenCentre(tv: TvAnchorPlacement, dims: RoomDimensions): ScenePoint {
  return roomToScene(tv.x + tv.width / 2, tv.y + tv.height / 2, tvMountHeight(tv, dims), dims);
}
