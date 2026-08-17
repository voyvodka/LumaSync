import { describe, expect, it } from "vitest";

import {
  findHueChannel,
  hueChannelsForArea,
  mergeHueChannels,
  nextHueChannelIndex,
  replaceHueChannel,
  type HueChannelPlacement,
} from "@/shared/contracts/roomMap";

function channel(channelIndex: number): HueChannelPlacement {
  return { channelIndex, x: 0, y: 0, z: 0 };
}

describe("nextHueChannelIndex", () => {
  it("counts past the highest index rather than the array length", () => {
    // The bug this replaces: `channels.length` on a gapped map is 2, which is
    // already taken. Room maps written by v1.4.0 and earlier are gapped.
    expect(nextHueChannelIndex([channel(0), channel(2)])).toBe(3);
  });

  it("never returns an index that already exists", () => {
    for (const existing of [[], [channel(0)], [channel(0), channel(2)], [channel(7)], [channel(3), channel(1)]]) {
      const minted = nextHueChannelIndex(existing);
      expect(findHueChannel(existing, minted)).toBeUndefined();
    }
  });

  it("starts at zero for an empty map", () => {
    expect(nextHueChannelIndex([])).toBe(0);
  });
});

describe("findHueChannel", () => {
  it("matches on channelIndex, not on array position", () => {
    const channels = [channel(0), channel(2)];

    expect(findHueChannel(channels, 2)).toBe(channels[1]);
    expect(findHueChannel(channels, 1)).toBeUndefined();
  });
});

describe("mergeHueChannels", () => {
  it("keeps placements the editor never saw", () => {
    // The Hue panel only ever emits the channels one bridge is reporting, so
    // assigning its output straight onto the config deleted the rest.
    const stored = [channel(0), channel(1), channel(2)];
    const edited = [{ ...channel(1), x: 0.7 }];

    const merged = mergeHueChannels(stored, edited);

    expect(merged.map((c) => c.channelIndex).sort()).toEqual([0, 1, 2]);
    expect(findHueChannel(merged, 1)!.x).toBe(0.7);
  });

  it("replaces rather than duplicates an edited channel", () => {
    const merged = mergeHueChannels([channel(0)], [{ ...channel(0), x: -0.4 }]);

    expect(merged).toHaveLength(1);
    expect(merged[0].x).toBe(-0.4);
  });

  it("keeps everything when the bridge reports nothing", () => {
    const stored = [channel(0), channel(3)];
    expect(mergeHueChannels(stored, [])).toEqual(stored);
  });

  it("accepts a channel the stored list does not have yet", () => {
    const merged = mergeHueChannels([channel(0)], [channel(5)]);
    expect(merged.map((c) => c.channelIndex)).toEqual([0, 5]);
  });
});

describe("entertainment-area scoping", () => {
  function inArea(channelIndex: number, entertainmentAreaId: string): HueChannelPlacement {
    return { ...channel(channelIndex), entertainmentAreaId };
  }

  it("keeps two areas' identically-numbered channels apart", () => {
    // The whole point of the field: before it, both were `channelIndex: 0` and
    // the second area's placement replaced the first's.
    const stored = [inArea(0, "ea-a")];
    const merged = mergeHueChannels(stored, [{ ...inArea(0, "ea-b"), x: 0.9 }]);

    expect(merged).toHaveLength(2);
    expect(merged.find((c) => c.entertainmentAreaId === "ea-a")!.x).toBe(0);
    expect(merged.find((c) => c.entertainmentAreaId === "ea-b")!.x).toBe(0.9);
  });

  it("still replaces rather than duplicates within one area", () => {
    const merged = mergeHueChannels([inArea(0, "ea-a")], [{ ...inArea(0, "ea-a"), x: -0.5 }]);

    expect(merged).toHaveLength(1);
    expect(merged[0].x).toBe(-0.5);
  });

  it("absorbs an unscoped record instead of leaving a pre-adoption copy", () => {
    // `hueChannelsForArea` lends unscoped records to the viewed area, so they
    // come back stamped; a strict area match would keep both.
    const merged = mergeHueChannels([channel(0)], [{ ...inArea(0, "ea-a"), x: 0.3 }]);

    expect(merged).toHaveLength(1);
    expect(merged[0].entertainmentAreaId).toBe("ea-a");
  });

  it("shows one area's channels plus the unscoped ones", () => {
    const stored = [inArea(0, "ea-a"), inArea(1, "ea-b"), channel(2)];

    expect(hueChannelsForArea(stored, "ea-a").map((c) => c.channelIndex)).toEqual([0, 2]);
    expect(hueChannelsForArea(stored, "ea-b").map((c) => c.channelIndex)).toEqual([1, 2]);
  });

  it("replaces in place without touching the same index in another area", () => {
    const stored = [inArea(0, "ea-a"), inArea(0, "ea-b"), inArea(1, "ea-a")];
    const next = replaceHueChannel(stored, { ...inArea(0, "ea-b"), x: 0.7 });

    expect(next.map((c) => c.entertainmentAreaId)).toEqual(["ea-a", "ea-b", "ea-a"]);
    expect(next[0].x).toBe(0);
    expect(next[1].x).toBe(0.7);
  });
});
