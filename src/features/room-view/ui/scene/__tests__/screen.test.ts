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

describe("buildScreen — the picture", () => {
  const build = () => {
    const config: RoomMapConfig = { ...DEFAULT_ROOM_MAP, dimensions: dims, tvAnchor: { x: 1, y: 0.05, width: 1.4, height: 0.05 }, furniture: [] };
    return buildScreen(config, classifyFurniture(config))!;
  };
  const colours = (built: ReturnType<typeof build>) => Array.from(built.panel.getAttribute("color").array as Float32Array);

  it("shows the lamps' colours while a mode runs and the dark glass again once it stops", () => {
    const built = build();
    const glass = colours(built);
    built.paint(0xff2000, 1);
    const lit = colours(built);
    const red = (a: number[]) => a.filter((_, i) => i % 3 === 0).reduce((n, v) => n + v, 0);
    const blue = (a: number[]) => a.filter((_, i) => i % 3 === 2).reduce((n, v) => n + v, 0);
    expect(red(lit)).toBeGreaterThan(red(glass) * 3);
    expect(blue(lit)).toBeLessThan(blue(glass));
    built.paint(null, 1);
    expect(colours(built)).toEqual(glass);
  });

  it("runs a palette across the picture and dims it with the mode's level", () => {
    const built = build();
    built.paint(0x00ff00, 1, [0xff0000, 0x0000ff]);
    const full = colours(built);
    const uv = built.panel.getAttribute("uv");
    const at = (u: number) => [...Array(uv.count).keys()].find((i) => Math.abs(uv.getX(i) - u) < 1e-6 && Math.abs(uv.getY(i) - 0.5) < 0.1)!;
    expect(full[at(0) * 3]!).toBeGreaterThan(full[at(0) * 3 + 2]!);
    expect(full[at(1) * 3 + 2]!).toBeGreaterThan(full[at(1) * 3]!);
    built.paint(0x00ff00, 0.3, [0xff0000, 0x0000ff]);
    expect(colours(built)[at(0) * 3]!).toBeLessThan(full[at(0) * 3]!);
  });
});
