/**
 * Each preset claims to be a specific shape the editor has to handle. A
 * preset that quietly stops being that shape is worse than not having it:
 * the developer believes they exercised the gapped-index path or the
 * mixed-zone path and did not.
 */

import { describe, expect, it } from "vitest";

import { ROOM_MAP_PRESETS, ROOM_MAP_PRESET_IDS } from "../roomMaps";

describe("room map presets", () => {
  it("every id in the list builds", () => {
    for (const id of ROOM_MAP_PRESET_IDS) {
      expect(ROOM_MAP_PRESETS[id].id).toBe(id);
      expect(ROOM_MAP_PRESETS[id].summary.length).toBeGreaterThan(0);
    }
  });

  it("\"none\" is absent state, not an empty map", () => {
    // `roomMap: {}` and `roomMap: undefined` take different branches: the
    // first is a map with nothing in it, the second is a user who never
    // opened the editor.
    expect(ROOM_MAP_PRESETS.none.build()).toBeUndefined();
  });

  it("the simple preset places every channel absolutely, with no zone", () => {
    const map = ROOM_MAP_PRESETS.simple.build();
    expect(map?.zones).toEqual([]);
    for (const channel of map?.hueChannels ?? []) {
      expect(channel.zoneId).toBeUndefined();
      expect(channel.entertainmentAreaId).toBe("area-living");
    }
  });

  it("the zoned preset leaves one channel outside the zone", () => {
    const map = ROOM_MAP_PRESETS.zoned.build();
    const inZone = map?.hueChannels.filter((c) => c.zoneId !== undefined) ?? [];
    const outside = map?.hueChannels.filter((c) => c.zoneId === undefined) ?? [];

    // A map where every channel is a member never exercises the branch that
    // resolves zone-relative against absolute coordinates.
    expect(inZone.length).toBeGreaterThan(0);
    expect(outside.length).toBeGreaterThan(0);
  });

  it("zone-relative positions resolve back to the absolute ones", () => {
    const map = ROOM_MAP_PRESETS.zoned.build();
    const zone = map?.zones[0];
    expect(zone).toBeDefined();
    if (zone === undefined || map === undefined) return;

    for (const channel of map.hueChannels) {
      if (channel.zoneRelativePosition == null) continue;
      const { x, y, z } = channel.zoneRelativePosition;
      expect(zone.centerX + zone.scaleX * x).toBeCloseTo(channel.x, 10);
      expect(zone.centerY + zone.scaleY * y).toBeCloseTo(channel.y, 10);
      expect(zone.centerZ + zone.scaleZ * z).toBeCloseTo(channel.z, 10);
    }
  });

  it("the zone lists exactly the channels that reference it", () => {
    const map = ROOM_MAP_PRESETS.zoned.build();
    const zone = map?.zones[0];
    const members = (map?.hueChannels ?? [])
      .filter((c) => c.zoneId === zone?.id)
      .map((c) => c.channelIndex);
    expect([...(zone?.channelIndices ?? [])].sort()).toEqual([...members].sort());
  });

  it("the legacy preset really is gapped and unscoped", () => {
    const map = ROOM_MAP_PRESETS["legacy-gapped"].build();
    const indices = map?.hueChannels.map((c) => c.channelIndex) ?? [];

    // The whole point: array position and channelIndex disagree, so a consumer
    // that indexes by position silently reads the wrong channel.
    expect(indices).toEqual([0, 2, 5]);
    expect(indices).not.toEqual(indices.map((_, i) => i));
    for (const channel of map?.hueChannels ?? []) {
      expect(channel.entertainmentAreaId).toBeUndefined();
    }
    expect(map?.usbStrips[0]?.portName).toBeUndefined();
  });
});
