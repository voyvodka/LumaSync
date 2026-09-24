import { describe, expect, it } from "vitest";

import type { HueChannelPlacementOverride } from "@/shared/contracts/hue";
import type { RoomMapConfig } from "@/shared/contracts/roomMap";
import { toRoomGeometry } from "@/features/room-map/model/roomGeometry";

import { toChannelPlacements } from "../hueStartConfig";
import fixture from "./fixtures/channelPlacements.parity.json";

// The same file drives `hue_config.rs`'s tests (`include_str!`), so the Rust
// start path and this projection cannot drift apart without one suite failing.

interface PlacementCase {
  name: string;
  roomMap: unknown;
  areaId: string;
  expected: HueChannelPlacementOverride[] | null;
}

interface GeometryCase {
  name: string;
  state: unknown;
  expected: {
    dimensions: unknown;
    tv: unknown;
    huePlacements: HueChannelPlacementOverride[];
  } | null;
}

function expectPlacements(
  actual: HueChannelPlacementOverride[] | undefined,
  expected: HueChannelPlacementOverride[] | null,
): void {
  if (expected === null) {
    expect(actual).toBeUndefined();
    return;
  }
  expect(actual).toHaveLength(expected.length);
  expected.forEach((want, index) => {
    const got = actual?.[index];
    expect(got?.channelId).toBe(want.channelId);
    expect(got?.positionX).toBeCloseTo(want.positionX, 6);
    expect(got?.positionY).toBeCloseTo(want.positionY, 6);
    if (want.positionZ === undefined) {
      expect(got).not.toHaveProperty("positionZ");
    } else {
      expect(got?.positionZ).toBeCloseTo(want.positionZ, 6);
    }
  });
}

describe("channel placements parity fixture", () => {
  it.each((fixture.placements as PlacementCase[]).map((c) => [c.name, c] as const))(
    "%s",
    (_name, testCase) => {
      const roomMap = (testCase.roomMap ?? undefined) as RoomMapConfig | undefined;
      expectPlacements(toChannelPlacements(roomMap, testCase.areaId), testCase.expected);
    },
  );

  it.each((fixture.roomGeometry as GeometryCase[]).map((c) => [c.name, c] as const))(
    "room geometry: %s",
    (_name, testCase) => {
      const geometry = toRoomGeometry(testCase.state as Parameters<typeof toRoomGeometry>[0]);
      if (testCase.expected === null) {
        expect(geometry).toBeUndefined();
        return;
      }
      expect(geometry?.dimensions).toEqual(testCase.expected.dimensions);
      expect(geometry?.tv).toEqual(testCase.expected.tv);
      expectPlacements(geometry?.huePlacements, testCase.expected.huePlacements);
    },
  );
});
