import { describe, expect, it } from "vitest";

import { hueChannelScenePoint, roomToScene, tvScreenCentre, zoneSceneBox } from "../roomSpace";

const dims = { widthMeters: 5, depthMeters: 4, heightMeters: 2.5 };

describe("roomSpace", () => {
  it("puts the origin at the floor's centre", () => {
    expect(roomToScene(2.5, 2, 0, dims)).toEqual({ x: 0, y: 0, z: 0 });
  });

  it("puts a Hue channel at the TV wall's left corner near the ceiling where the bridge says", () => {
    const point = hueChannelScenePoint({ channelIndex: 0, x: -1, y: 1, z: 1, zOrigin: "bridge" }, [], dims, 1);
    expect(point).toEqual({ x: -2.5, y: 2.5, z: -2 });
  });

  it("draws a height of unknown origin at the given mount height, not at the stored z", () => {
    const point = hueChannelScenePoint({ channelIndex: 0, x: 1, y: -1, z: 0 }, [], dims, 1);
    expect(point).toEqual({ x: 2.5, y: 1, z: 2 });
  });

  it("resolves a zone-bound channel through its zone", () => {
    const zone = {
      id: "z", name: "Z", centerX: 0.5, centerY: 0, centerZ: 0,
      scaleX: 0.25, scaleY: 0.25, scaleZ: 0.5, channelIndices: [0],
    } as never;
    const point = hueChannelScenePoint(
      {
        channelIndex: 0, x: -1, y: -1, z: -1, zOrigin: "user",
        zoneId: "z", zoneRelativePosition: { x: 0, y: 0, z: 0 },
      },
      [zone],
      dims,
      0,
    );
    expect(point.x).toBeCloseTo(1.25);
    expect(point.y).toBeCloseTo(1.25);
    expect(point.z).toBeCloseTo(0);
  });

  it("centres the screen on its footprint at the default mount height", () => {
    const centre = tvScreenCentre({ x: 1.75, y: 0, width: 1.5, height: 0.1 }, dims);
    expect(centre.x).toBeCloseTo(0);
    expect(centre.y).toBeCloseTo(1);
    expect(centre.z).toBeCloseTo(-1.95);
  });
});

describe("zoneSceneBox", () => {
  const zone = { id: "z", name: "Z", entertainmentAreaId: "a", centerX: 0.5, centerY: 0.5, centerZ: 0, scaleX: 0.2, scaleY: 0.25, scaleZ: 0.4, channelIndices: [] };

  it("is the zone's span of the bridge cube in metres, +y toward the TV wall", () => {
    const { centre, size } = zoneSceneBox(zone, dims);
    expect(size.x).toBeCloseTo(1);
    expect(size.z).toBeCloseTo(1);
    expect(size.y).toBeCloseTo(1);
    // x 0.3..0.7 of a 5 m room is 3.25..4.25 m; y 0.25..0.75 is 0.5..1.5 m from the TV wall.
    expect(centre.x).toBeCloseTo(3.75 - 2.5);
    expect(centre.z).toBeCloseTo(1 - 2);
    expect(centre.y).toBeCloseTo(1.25);
  });

  it("stops at the room, as the plan clips it", () => {
    const { size } = zoneSceneBox({ ...zone, centerX: 0.9, scaleX: 0.5 }, dims);
    expect(size.x).toBeCloseTo(((1 - 0.4) / 2) * 5);
  });
});
