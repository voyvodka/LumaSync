import { describe, expect, it } from "vitest";

import type { HueChannelPlacement } from "@/shared/contracts/roomMap";

import { HUE_SYNC_STATE, deriveHueSyncState, toSyncSnapshot } from "../hueSyncState";

/** Gapped bridge ids — an ordinal standing in for one shows up immediately. */
function placements(): HueChannelPlacement[] {
  return [0, 2, 5].map((channelId, i) => ({
    channelIndex: i,
    channelId,
    x: i - 1,
    y: 0,
    z: 0,
  }));
}

describe("toSyncSnapshot", () => {
  it("records the bridge id and the position, nothing else", () => {
    expect(toSyncSnapshot(placements())).toEqual([
      { channelId: 0, positionX: -1, positionY: 0 },
      { channelId: 2, positionX: 0, positionY: 0 },
      { channelId: 5, positionX: 1, positionY: 0 },
    ]);
  });

  it("omits a placement with no bridge id, because the push omits it too", () => {
    const p = placements();
    p[1] = { ...p[1]!, channelId: undefined };
    expect(toSyncSnapshot(p).map((s) => s.channelId)).toEqual([0, 5]);
  });

  it("keeps channel #0 rather than dropping a falsy id", () => {
    expect(toSyncSnapshot(placements()).some((s) => s.channelId === 0)).toBe(true);
  });
});

describe("deriveHueSyncState", () => {
  it("says never-pushed when nothing has been written from here", () => {
    expect(deriveHueSyncState(placements(), undefined)).toBe(HUE_SYNC_STATE.NEVER_PUSHED);
  });

  it("says in-sync when the snapshot matches", () => {
    const p = placements();
    expect(deriveHueSyncState(p, toSyncSnapshot(p))).toBe(HUE_SYNC_STATE.IN_SYNC);
  });

  it("notices a moved channel", () => {
    const p = placements();
    const snapshot = toSyncSnapshot(p);
    p[1] = { ...p[1]!, x: 0.5 };
    expect(deriveHueSyncState(p, snapshot)).toBe(HUE_SYNC_STATE.LOCAL_AHEAD);
  });

  it("notices a channel added since the push", () => {
    const p = placements();
    const snapshot = toSyncSnapshot(p.slice(0, 2));
    expect(deriveHueSyncState(p, snapshot)).toBe(HUE_SYNC_STATE.LOCAL_AHEAD);
  });

  it("notices a channel removed since the push", () => {
    const p = placements();
    const snapshot = toSyncSnapshot(p);
    expect(deriveHueSyncState(p.slice(0, 2), snapshot)).toBe(HUE_SYNC_STATE.LOCAL_AHEAD);
  });

  it("matches on the bridge id, not on list order", () => {
    const p = placements();
    const snapshot = [...toSyncSnapshot(p)].reverse();
    expect(deriveHueSyncState(p, snapshot)).toBe(HUE_SYNC_STATE.IN_SYNC);
  });

  it("notices a swap that keeps every id and every position present", () => {
    const p = placements();
    const snapshot = toSyncSnapshot(p);
    // Same three positions, different owners — a count or a set comparison
    // alone would call this in sync.
    const swapped = [...p];
    swapped[0] = { ...p[0]!, x: p[2]!.x };
    swapped[2] = { ...p[2]!, x: p[0]!.x };
    expect(deriveHueSyncState(swapped, snapshot)).toBe(HUE_SYNC_STATE.LOCAL_AHEAD);
  });

  it("ignores float noise a zone round-trip adds", () => {
    const p = placements();
    const snapshot = toSyncSnapshot(p);
    p[1] = { ...p[1]!, x: 0.004, y: -0.004 };
    expect(deriveHueSyncState(p, snapshot)).toBe(HUE_SYNC_STATE.IN_SYNC);
  });

  it("still counts a deliberate nudge as a change", () => {
    const p = placements();
    const snapshot = toSyncSnapshot(p);
    p[1] = { ...p[1]!, x: 0.05 };
    expect(deriveHueSyncState(p, snapshot)).toBe(HUE_SYNC_STATE.LOCAL_AHEAD);
  });

  it("says in-sync for an empty area that was pushed empty", () => {
    expect(deriveHueSyncState([], [])).toBe(HUE_SYNC_STATE.IN_SYNC);
  });
});
