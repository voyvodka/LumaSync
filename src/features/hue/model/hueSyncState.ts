// Whether the bridge's stored arrangement matches ours. From a snapshot of what
// we last pushed, never a live read: while streaming, `get_hue_area_channels`
// serves channels that already carry our placements. See docs/architecture/hue.md.

import type { HueChannelPlacementOverride } from "@/shared/contracts/hue";
import type { HueChannelPlacement } from "@/shared/contracts/roomMap";

export const HUE_SYNC_STATE = {
  /** Nothing has been pushed from here, so the bridge holds whatever it holds. */
  NEVER_PUSHED: "never-pushed",
  IN_SYNC: "in-sync",
  /** Our arrangement differs from the bridge's copy. **Not a fault**: the
   *  runtime samples the local placement, so the lights already follow this. */
  LOCAL_AHEAD: "local-ahead",
} as const;

export type HueSyncState = (typeof HUE_SYNC_STATE)[keyof typeof HUE_SYNC_STATE];

/** Wide enough to absorb a zone-relative round-trip, tight enough that a real
 *  nudge still counts as a change. */
const POSITION_EPSILON = 0.005;

/** The wire shape of what a push sends, so the snapshot and the payload cannot
 *  drift. A placement with no bridge id is omitted — the write-back refuses it
 *  too, so recording it would make an unpushable channel look pushed. A height
 *  of unknown origin is left off: its `0` may be a seeding placeholder. */
export function toSyncSnapshot(
  placements: readonly HueChannelPlacement[],
): HueChannelPlacementOverride[] {
  return placements
    .filter((p) => p.channelId != null)
    .map((p) => {
      const entry: HueChannelPlacementOverride = {
        channelId: p.channelId!,
        positionX: p.x,
        positionY: p.y,
      };
      if (p.zOrigin) entry.positionZ = p.z;
      return entry;
    });
}

/** Height counts only when both sides carry one. A snapshot from before height
 *  was recorded, or a local height of unknown origin, falls back to x/y —
 *  otherwise every upgraded install would read as local-ahead. */
function differs(
  current: HueChannelPlacementOverride,
  pushed: HueChannelPlacementOverride,
): boolean {
  if (
    Math.abs(current.positionX - pushed.positionX) > POSITION_EPSILON ||
    Math.abs(current.positionY - pushed.positionY) > POSITION_EPSILON
  ) {
    return true;
  }
  return (
    current.positionZ != null &&
    pushed.positionZ != null &&
    Math.abs(current.positionZ - pushed.positionZ) > POSITION_EPSILON
  );
}

export function deriveHueSyncState(
  placements: readonly HueChannelPlacement[],
  snapshot: readonly HueChannelPlacementOverride[] | undefined,
): HueSyncState {
  if (!snapshot) return HUE_SYNC_STATE.NEVER_PUSHED;

  const current = toSyncSnapshot(placements);
  if (current.length !== snapshot.length) return HUE_SYNC_STATE.LOCAL_AHEAD;

  const pushed = new Map(snapshot.map((s) => [s.channelId, s]));
  for (const c of current) {
    const was = pushed.get(c.channelId);
    // A channel the snapshot never mentioned is a difference, not a match.
    if (!was) return HUE_SYNC_STATE.LOCAL_AHEAD;
    if (differs(c, was)) return HUE_SYNC_STATE.LOCAL_AHEAD;
  }
  return HUE_SYNC_STATE.IN_SYNC;
}
