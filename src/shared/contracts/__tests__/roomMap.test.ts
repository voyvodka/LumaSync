import { describe, expect, it } from "vitest";

import {
  findHueChannel,
  nextHueChannelIndex,
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
