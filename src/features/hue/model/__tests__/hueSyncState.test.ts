import { describe, expect, it } from "vitest";

import type { HueAreaChannelInfo } from "@/shared/contracts/hue";
import type { HueChannelPlacement } from "@/shared/contracts/roomMap";

import {
  HUE_SYNC_STATE,
  bridgeSnapshot,
  deriveHueSyncState,
  differingChannelIds,
  sameSnapshot,
  snapshotAfterPush,
  toSyncSnapshot,
} from "../hueSyncState";

function channel(
  channelId: number,
  positionX: number,
  positionY: number,
  positionZ: number | null,
): HueAreaChannelInfo {
  return {
    index: channelId,
    channelId,
    lightIds: [`light-${channelId}`],
    positionX,
    positionY,
    positionZ,
    lightCount: 1,
    autoRegion: "center",
  };
}

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

  it("records a height only when its origin is known", () => {
    const p = placements();
    p[0] = { ...p[0]!, z: 0.4, zOrigin: "bridge" };
    p[1] = { ...p[1]!, z: -0.3, zOrigin: "user" };
    p[2] = { ...p[2]!, z: 0, zOrigin: null };
    expect(toSyncSnapshot(p)).toEqual([
      { channelId: 0, positionX: -1, positionY: 0, positionZ: 0.4 },
      { channelId: 2, positionX: 0, positionY: 0, positionZ: -0.3 },
      { channelId: 5, positionX: 1, positionY: 0 },
    ]);
  });

  it("keeps channel #0 rather than dropping a falsy id", () => {
    expect(toSyncSnapshot(placements()).some((s) => s.channelId === 0)).toBe(true);
  });
});

describe("deriveHueSyncState", () => {
  it("says unknown when the bridge's arrangement was never read or written", () => {
    expect(deriveHueSyncState(placements(), undefined)).toBe(HUE_SYNC_STATE.UNKNOWN);
  });

  it("compares against a fresh bridge read the same way as a snapshot", () => {
    const bridge = bridgeSnapshot([
      channel(0, -1, 0, null),
      channel(2, 0, 0, null),
      channel(5, 0.7, 0, null),
    ]);
    expect(deriveHueSyncState(placements(), bridge)).toBe(HUE_SYNC_STATE.LOCAL_AHEAD);
    expect(differingChannelIds(placements(), bridge)).toEqual([5]);
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

  describe("height", () => {
    function withKnownHeights(): HueChannelPlacement[] {
      return placements().map((p, i) => ({ ...p, z: i * 0.2, zOrigin: "bridge" as const }));
    }

    it("notices a changed height when both sides carry one", () => {
      const p = withKnownHeights();
      const snapshot = toSyncSnapshot(p);
      p[1] = { ...p[1]!, z: 0.6, zOrigin: "user" };
      expect(deriveHueSyncState(p, snapshot)).toBe(HUE_SYNC_STATE.LOCAL_AHEAD);
    });

    it("says in-sync when both heights match", () => {
      const p = withKnownHeights();
      expect(deriveHueSyncState(p, toSyncSnapshot(p))).toBe(HUE_SYNC_STATE.IN_SYNC);
    });

    it("ignores height float noise within the x/y tolerance", () => {
      const p = withKnownHeights();
      const snapshot = toSyncSnapshot(p);
      p[1] = { ...p[1]!, z: p[1]!.z + 0.004 };
      expect(deriveHueSyncState(p, snapshot)).toBe(HUE_SYNC_STATE.IN_SYNC);
    });

    it("compares x/y only against a snapshot written before height was recorded", () => {
      const p = withKnownHeights();
      // What an upgraded install has on disk: the same push, no positionZ.
      const legacy = toSyncSnapshot(placements());
      expect(legacy.every((s) => s.positionZ === undefined)).toBe(true);
      expect(deriveHueSyncState(p, legacy)).toBe(HUE_SYNC_STATE.IN_SYNC);
    });

    it("compares x/y only when the local height's origin is unknown", () => {
      const snapshot = toSyncSnapshot(withKnownHeights());
      const p = withKnownHeights();
      p[1] = { ...p[1]!, z: 0.9, zOrigin: undefined };
      p[2] = { ...p[2]!, z: -0.9, zOrigin: null };
      expect(deriveHueSyncState(p, snapshot)).toBe(HUE_SYNC_STATE.IN_SYNC);
    });

    it("still notices a moved channel when height is ignored", () => {
      const p = withKnownHeights();
      const legacy = toSyncSnapshot(placements());
      p[1] = { ...p[1]!, x: 0.5 };
      expect(deriveHueSyncState(p, legacy)).toBe(HUE_SYNC_STATE.LOCAL_AHEAD);
    });
  });
});

describe("bridgeSnapshot", () => {
  it("carries the bridge's height only when it reported one", () => {
    expect(bridgeSnapshot([channel(0, 0.168, 1, -0.524), channel(1, -0.5, 1, null)])).toEqual([
      { channelId: 0, positionX: 0.168, positionY: 1, positionZ: -0.524 },
      { channelId: 1, positionX: -0.5, positionY: 1 },
    ]);
  });
});

describe("snapshotAfterPush", () => {
  it("records what was sent when the bridge took every channel", () => {
    expect(snapshotAfterPush(placements(), undefined, [])).toEqual(toSyncSnapshot(placements()));
  });

  it("keeps the bridge's previous position for a channel it skipped", () => {
    const before = bridgeSnapshot([
      channel(0, -1, 0, null),
      channel(2, 0, 0, null),
      channel(5, 0.3, 0.3, null),
    ]);
    const sent = placements();
    sent[2] = { ...sent[2]!, x: 0.9 };

    const after = snapshotAfterPush(sent, before, [5]);

    expect(after.find((s) => s.channelId === 5)).toEqual({
      channelId: 5,
      positionX: 0.3,
      positionY: 0.3,
    });
    expect(deriveHueSyncState(sent, after)).toBe(HUE_SYNC_STATE.LOCAL_AHEAD);
  });

  it("leaves a skipped channel out rather than inventing its position", () => {
    const after = snapshotAfterPush(placements(), undefined, [2]);
    expect(after.map((s) => s.channelId)).toEqual([0, 5]);
    expect(deriveHueSyncState(placements(), after)).toBe(HUE_SYNC_STATE.LOCAL_AHEAD);
  });
});

describe("sameSnapshot", () => {
  it("treats a height appearing as a change worth recording", () => {
    const a = bridgeSnapshot([channel(0, 0, 0, null)]);
    const b = bridgeSnapshot([channel(0, 0, 0, 0.2)]);
    expect(sameSnapshot(a, b)).toBe(false);
    expect(sameSnapshot(b, bridgeSnapshot([channel(0, 0, 0, 0.2)]))).toBe(true);
  });

  it("ignores order, and never matches an absent snapshot", () => {
    const a = bridgeSnapshot([channel(0, 0, 0, null), channel(1, 1, 1, null)]);
    expect(sameSnapshot(a, [...a].reverse())).toBe(true);
    expect(sameSnapshot(a, undefined)).toBe(false);
  });
});
