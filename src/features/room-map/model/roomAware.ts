import type { HueRuntimeTarget } from "@/shared/contracts/hue";
import {
  DEFAULT_TV_MOUNT_HEIGHT_FRACTION,
  type TvAnchorPlacement,
} from "@/shared/contracts/roomMap";

/** Room-aware Hue sampling is on whenever the room map has a TV and Hue is an
 * output — the same gate the worker applies. Geometry the worker later rejects
 * still reads "on" here; that case is logged, not surfaced. */
export function isRoomAwareActive(
  tvAnchor: TvAnchorPlacement | undefined | null,
  outputTargets: readonly HueRuntimeTarget[],
): boolean {
  return tvAnchor != null && outputTargets.includes("hue");
}

/** The mount height the worker resolves when the TV carries none. */
export function defaultTvMountHeight(roomHeightMeters: number): number {
  return roomHeightMeters * DEFAULT_TV_MOUNT_HEIGHT_FRACTION;
}
