import type { HueRuntimeTarget } from "@/shared/contracts/hue";
import {
  DEFAULT_TV_MOUNT_HEIGHT_FRACTION,
  type TvAnchorPlacement,
} from "@/shared/contracts/roomMap";
import {
  hueUnavailableReason,
  type HueUnavailableReason,
} from "@/features/hue/model/hueAvailability";
import type { HueProbeVerdict } from "@/features/hue/state/useHueBridgeReachability";

/** Room-aware Hue sampling is configured whenever the room map has a TV and Hue
 * is an output — the same gate the worker applies. Geometry the worker later
 * rejects still reads "on" here; that case is logged, not surfaced. */
export function isRoomAwareActive(
  tvAnchor: TvAnchorPlacement | undefined | null,
  outputTargets: readonly HueRuntimeTarget[],
): boolean {
  return tvAnchor != null && outputTargets.includes("hue");
}

export interface HueUsability {
  configured: boolean;
  reachable: boolean;
  verdict: HueProbeVerdict | null;
}

export type RoomAwarePausedReason = Exclude<HueUnavailableReason, "notConfigured">;

export type RoomAwareStatus =
  | { state: "active" }
  | { state: "paused"; reason: RoomAwarePausedReason };

/** What the room-aware chip may claim, or `null` for no chip. A paired bridge
 * that cannot stream reads "paused" — the setup still stands and resumes on its
 * own — while an unpaired one shows nothing: there is no Hue light whose
 * sampling could be room-aware. */
export function roomAwareStatus(
  tvAnchor: TvAnchorPlacement | undefined | null,
  outputTargets: readonly HueRuntimeTarget[],
  hue: HueUsability,
): RoomAwareStatus | null {
  if (!isRoomAwareActive(tvAnchor, outputTargets)) return null;
  const reason = hueUnavailableReason(hue.configured, hue.reachable, hue.verdict);
  if (reason === null) return { state: "active" };
  if (reason === "notConfigured") return null;
  return { state: "paused", reason };
}

/** The mount height the worker resolves when the TV carries none. */
export function defaultTvMountHeight(roomHeightMeters: number): number {
  return roomHeightMeters * DEFAULT_TV_MOUNT_HEIGHT_FRACTION;
}
