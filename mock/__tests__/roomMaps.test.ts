/**
 * Each preset claims to be a specific shape the editor has to handle. A
 * preset that quietly stops being that shape is worse than not having it:
 * the developer believes they exercised the gapped-index path or the
 * mixed-zone path and did not.
 */

import { describe, expect, it } from "vitest";

import { HUE_CHANNEL_HEIGHT_ORIGIN, type RoomMapConfig } from "../../src/shared/contracts/roomMap";
import { ROOM_MAP_PRESETS, ROOM_MAP_PRESET_IDS } from "../roomMaps";

/**
 * Every rectangle this file places is documented as living in the editor's
 * room-metre frame (`TvAnchorPlacement`'s doc comment): origin at the
 * TV-wall/left-wall floor corner, x/y is the top-left corner, not the
 * centre. A preset placed in a different frame (e.g. a Hue-native `[-1, 1]`
 * origin-at-centre value) reads as off the grid or behind a wall the moment
 * the editor draws it — this is exactly the #392 TV-anchor mistake.
 */
function assertWithinRoom(
  dims: RoomMapConfig["dimensions"],
  rect: { x: number; y: number; width: number; height: number },
  label: string,
) {
  expect(rect.x, `${label}.x`).toBeGreaterThanOrEqual(0);
  expect(rect.y, `${label}.y`).toBeGreaterThanOrEqual(0);
  expect(rect.x + rect.width, `${label} right edge`).toBeLessThanOrEqual(dims.widthMeters);
  expect(rect.y + rect.height, `${label} bottom edge`).toBeLessThanOrEqual(dims.depthMeters);
}

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

  it("every preset's TV anchor, furniture and strips stay inside the room bounds", () => {
    for (const id of ROOM_MAP_PRESET_IDS) {
      const map = ROOM_MAP_PRESETS[id].build();
      if (map === undefined) continue;

      if (map.tvAnchor) {
        assertWithinRoom(map.dimensions, map.tvAnchor, `${id}.tvAnchor`);
      }
      for (const item of map.furniture) {
        assertWithinRoom(map.dimensions, item, `${id}.furniture[${item.id}]`);
      }
      for (const strip of map.usbStrips) {
        const zeroSize = { width: 0, height: 0 };
        assertWithinRoom(map.dimensions, { x: strip.startX, y: strip.startY, ...zeroSize }, `${id}.usbStrips[${strip.stripId}].start`);
        assertWithinRoom(map.dimensions, { x: strip.endX, y: strip.endY, ...zeroSize }, `${id}.usbStrips[${strip.stripId}].end`);
      }
    }
  });

  it("the tv-anchored preset carries an explicit mount height and known z-origins", () => {
    const map = ROOM_MAP_PRESETS["tv-anchored"].build();
    expect(map?.tvAnchor?.mountHeightMeters).toBeTypeOf("number");

    const origins = map?.hueChannels.map((c) => c.zOrigin) ?? [];
    // Mixed on purpose: a map where every channel shares one origin never
    // exercises the branch that trusts a user-set height over a
    // bridge-reported one (#389's bridge-sync comparison).
    expect(origins).toContain(HUE_CHANNEL_HEIGHT_ORIGIN.USER);
    expect(origins).toContain(HUE_CHANNEL_HEIGHT_ORIGIN.BRIDGE);
    expect(origins.every((o) => o != null)).toBe(true);

    // And floor/mid/ceiling, not four channels clustered at one height.
    const zs = map?.hueChannels.map((c) => c.z) ?? [];
    expect(zs.some((z) => z < -0.5)).toBe(true);
    expect(zs.some((z) => z > -0.3 && z < 0.3)).toBe(true);
    expect(zs.some((z) => z > 0.5)).toBe(true);
  });
});
