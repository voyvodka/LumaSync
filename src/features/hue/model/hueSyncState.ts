// Whether the bridge's stored arrangement matches ours. The reference is the
// bridge's own channel list when it was read with the runtime idle, and the
// persisted snapshot of the last known bridge arrangement otherwise: while
// lighting is on, `get_hue_area_channels` serves channels that already carry
// our placements. See docs/architecture/hue.md.

import type { HueAreaChannelInfo, HueChannelPlacementOverride } from "@/shared/contracts/hue";
import type { HueChannelPlacement } from "@/shared/contracts/roomMap";

export const HUE_SYNC_STATE = {
  /** Neither a trustworthy read of the bridge nor a snapshot of one exists. */
  UNKNOWN: "unknown",
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

/** What the bridge reports, in the snapshot's shape. Only meaningful for a list
 *  read with the runtime idle; a height the bridge did not report is left off. */
export function bridgeSnapshot(
  channels: readonly HueAreaChannelInfo[],
): HueChannelPlacementOverride[] {
  return channels.map((ch) => {
    const entry: HueChannelPlacementOverride = {
      channelId: ch.channelId,
      positionX: ch.positionX,
      positionY: ch.positionY,
    };
    if (ch.positionZ !== null) entry.positionZ = ch.positionZ;
    return entry;
  });
}

/** The bridge's arrangement after a push. A channel the bridge skipped keeps
 *  whatever it held before — recording our value for it would call a channel
 *  in sync that the push never reached. */
export function snapshotAfterPush(
  sent: readonly HueChannelPlacement[],
  before: readonly HueChannelPlacementOverride[] | undefined,
  skippedChannelIds: readonly number[],
): HueChannelPlacementOverride[] {
  const skipped = new Set(skippedChannelIds);
  const previous = new Map((before ?? []).map((s) => [s.channelId, s]));
  return toSyncSnapshot(sent).flatMap((entry) => {
    if (!skipped.has(entry.channelId)) return [entry];
    const was = previous.get(entry.channelId);
    return was ? [was] : [];
  });
}

/** Exact equality, height presence included — whether a fresh read is worth
 *  persisting, not whether two arrangements match. */
export function sameSnapshot(
  a: readonly HueChannelPlacementOverride[] | undefined,
  b: readonly HueChannelPlacementOverride[] | undefined,
): boolean {
  if (!a || !b) return a === b;
  if (a.length !== b.length) return false;
  const byId = new Map(b.map((s) => [s.channelId, s]));
  return a.every((s) => {
    const o = byId.get(s.channelId);
    return (
      o !== undefined &&
      o.positionX === s.positionX &&
      o.positionY === s.positionY &&
      o.positionZ === s.positionZ
    );
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

/** Bridge ids of our placements that sit somewhere else on the bridge. A
 *  channel the bridge never mentioned is a difference, not a match. */
export function differingChannelIds(
  placements: readonly HueChannelPlacement[],
  bridge: readonly HueChannelPlacementOverride[],
): number[] {
  const held = new Map(bridge.map((s) => [s.channelId, s]));
  return toSyncSnapshot(placements)
    .filter((c) => {
      const was = held.get(c.channelId);
      return !was || differs(c, was);
    })
    .map((c) => c.channelId);
}

/** `bridge` is the bridge's arrangement: a fresh read (`bridgeSnapshot`) or the
 *  persisted snapshot. Absent ⇒ unknown. */
export function deriveHueSyncState(
  placements: readonly HueChannelPlacement[],
  bridge: readonly HueChannelPlacementOverride[] | undefined,
): HueSyncState {
  if (!bridge) return HUE_SYNC_STATE.UNKNOWN;
  if (toSyncSnapshot(placements).length !== bridge.length) return HUE_SYNC_STATE.LOCAL_AHEAD;
  return differingChannelIds(placements, bridge).length > 0
    ? HUE_SYNC_STATE.LOCAL_AHEAD
    : HUE_SYNC_STATE.IN_SYNC;
}
