import { describe, expect, it } from "vitest";

import { DEFAULT_ROOM_MAP, type RoomMapConfig, type TvAnchorPlacement } from "@/shared/contracts/roomMap";

import { classifyFurniture, DESK_TOP } from "../../../model/furnitureModel";
import { buildScreen } from "../screen";

const dims = { widthMeters: 4, depthMeters: 4, heightMeters: 2.7 };
const desk = { id: "desk", type: "table" as const, variant: "desk" as const, x: 1, y: 0, width: 1.6, height: 0.7, rotation: 0, label: "Desk" };

function layoutOf(tv: TvAnchorPlacement, furniture: RoomMapConfig["furniture"] = [desk]) {
  const config: RoomMapConfig = { ...DEFAULT_ROOM_MAP, dimensions: dims, tvAnchor: tv, furniture };
  const built = buildScreen(config, classifyFurniture(config));
  if (!built) throw new Error("no screen");
  const { centre, height } = built.layout;
  return { bottom: centre.y - height / 2, z: centre.z + dims.depthMeters / 2, centre };
}

describe("buildScreen — a monitor on a desk", () => {
  // At 40% of a 2.7 m room a 1.4 m monitor's foot sank under the desk top; a small one floated.
  it("stands a monitor with no height of its own on the desk, wide or small", () => {
    for (const width of [1.4, 0.6]) {
      const { bottom } = layoutOf({ x: 1.1, y: 0.05, width, height: 0.05 });
      expect(bottom).toBeGreaterThan(DESK_TOP);
      expect(bottom).toBeLessThan(DESK_TOP + 0.2);
    }
  });

  it("keeps a set height, but never through the desk top", () => {
    expect(layoutOf({ x: 1.1, y: 0.05, width: 0.6, height: 0.05, mountHeightMeters: 1.3 }).centre.y).toBeCloseTo(1.3);
    expect(layoutOf({ x: 1.1, y: 0.05, width: 1.4, height: 0.05, mountHeightMeters: 0.5 }).bottom).toBeGreaterThan(DESK_TOP);
  });

  it("stands the monitor on the top near its back, not over its edge", () => {
    const { z } = layoutOf({ x: 1.1, y: 0, width: 0.6, height: 0.05 });
    expect(z).toBeGreaterThan(desk.y + 0.1);
    expect(z).toBeLessThan(desk.y + desk.height / 2);
  });

  it("leaves a TV with no desk at the room's default height", () => {
    const { centre } = layoutOf({ x: 1.1, y: 0.05, width: 1.4, height: 0.05 }, []);
    expect(centre.y).toBeCloseTo(dims.heightMeters * 0.4);
  });
});
