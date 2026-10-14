import { describe, expect, it } from "vitest";

import { hueChannelScenePoint, roomToScene, tvScreenCentre } from "../roomSpace";

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
