import { describe, expect, it } from "vitest";

import type { HueZone } from "@/shared/contracts/roomMap";

import { gripAt, moveZoneRect, sameRect, sceneToPlan, zoneAtFloor, zoneGrips } from "../zoneGesture";

const dims = { widthMeters: 5, depthMeters: 4, heightMeters: 2.5 };
// Centred, 2.5 × 2 m: x 1.25–3.75, y 1–3 on the plan.
const zone = (id: string, scale = 0.5): HueZone => ({ id, name: id, entertainmentAreaId: "x", centerX: 0, centerY: 0, centerZ: 0, scaleX: scale, scaleY: scale, scaleZ: 1, channelIndices: [] });

describe("zoneGesture", () => {
  it("reads the scene's floor as the plan, from the room's top-left corner", () => {
    expect(sceneToPlan(-2.5, -2, dims)).toEqual({ x: 0, y: 0 });
    expect(sceneToPlan(1, 1, dims)).toEqual({ x: 3.5, y: 3 });
  });

  it("picks a drawn zone where the floor is inside it, the held one over a smaller one", () => {
    const zones = [zone("big"), zone("small", 0.2)];
    const marks = { active: null, held: null, others: ["big", "small"] };
    expect(zoneAtFloor({ x: 2.5, y: 2 }, zones, marks, dims)).toBe("small");
    expect(zoneAtFloor({ x: 2.5, y: 2 }, zones, { ...marks, held: "big" }, dims)).toBe("big");
    expect(zoneAtFloor({ x: 1.3, y: 1.1 }, zones, marks, dims)).toBe("big");
    expect(zoneAtFloor({ x: 0.5, y: 0.5 }, zones, marks, dims)).toBeNull();
  });

  it("never picks a zone that is not drawn", () => {
    expect(zoneAtFloor({ x: 2.5, y: 2 }, [zone("a")], { active: null, held: null, others: [] }, dims)).toBeNull();
    expect(zoneAtFloor({ x: 2.5, y: 2 }, [zone("a")], null, dims)).toBeNull();
  });

  it("carries a zone whole, stopping it at a wall rather than shrinking it", () => {
    const start = { x0: 1, y0: 1, x1: 3, y1: 2 };
    expect(moveZoneRect(start, 0.5, 0.5, dims)).toEqual({ x0: 1.5, y0: 1.5, x1: 3.5, y1: 2.5 });
    expect(moveZoneRect(start, 9, -9, dims)).toEqual({ x0: 3, y0: 0, x1: 5, y1: 1 });
  });

  it("puts a grip at each corner and side, and takes the nearest within reach", () => {
    const grips = zoneGrips({ x0: 0, y0: 0, x1: 2, y1: 4 });
    expect(grips.find((g) => g.handle === "se")?.at).toEqual({ x: 2, y: 4 });
    expect(grips.find((g) => g.handle === "w")?.at).toEqual({ x: 0, y: 2 });
    const onScreen = [
      { handle: "n" as const, x: 100, y: 100 },
      { handle: "ne" as const, x: 110, y: 100 },
    ];
    expect(gripAt(onScreen, { x: 108, y: 102 }, 16)).toBe("ne");
    expect(gripAt(onScreen, { x: 140, y: 100 }, 16)).toBeNull();
  });

  it("tells a rectangle let go where it was from one moved", () => {
    expect(sameRect({ x0: 1, y0: 1, x1: 2, y1: 2 }, { x0: 1, y0: 1, x1: 2, y1: 2 + 1e-9 })).toBe(true);
    expect(sameRect({ x0: 1, y0: 1, x1: 2, y1: 2 }, { x0: 1, y0: 1, x1: 2, y1: 2.01 })).toBe(false);
  });
});
