import { describe, expect, it } from "vitest";

import type { HueZone } from "@/shared/contracts/roomMap";

import { dropZones, zoneDrop } from "../zoneDrop";

const zone = (id: string, centerX: number, scale: number, area = "a"): HueZone => ({
  id,
  name: id,
  entertainmentAreaId: area,
  centerX,
  centerY: 0,
  centerZ: 0,
  scaleX: scale,
  scaleY: scale,
  scaleZ: 0.5,
  channelIndices: [],
});

describe("zoneDrop", () => {
  it("joins a loose light to the zone it was put down in, where it lies in it", () => {
    const into = zoneDrop({ channelIndex: 1, x: 0.6, y: -0.2, z: 0.25, entertainmentAreaId: "a" }, [zone("z", 0.4, 0.4)]);
    expect(into?.zoneId).toBe("z");
    expect(into?.at.x).toBeCloseTo(0.5);
    expect(into?.at.y).toBeCloseTo(-0.5);
    expect(into?.at.z).toBeCloseTo(0.5);
  });

  it("takes the smallest of the zones it is inside", () => {
    const into = zoneDrop({ channelIndex: 1, x: 0.1, y: 0, z: 0 }, [zone("big", 0, 0.9), zone("small", 0.1, 0.2)]);
    expect(into?.zoneId).toBe("small");
  });

  it("leaves a light outside every zone, already in one, or of another area", () => {
    expect(zoneDrop({ channelIndex: 1, x: 0.9, y: 0, z: 0 }, [zone("z", 0, 0.3)])).toBeNull();
    // Over its floor but above its cube: joining would cut the light's height to the cube's top.
    expect(zoneDrop({ channelIndex: 1, x: 0, y: 0, z: 0.9 }, [zone("z", 0, 0.3)])).toBeNull();
    expect(zoneDrop({ channelIndex: 1, x: 0, y: 0, z: 0, zoneId: "other" }, [zone("z", 0, 0.3)])).toBeNull();
    expect(zoneDrop({ channelIndex: 1, x: 0, y: 0, z: 0, entertainmentAreaId: "b" }, [zone("z", 0, 0.3)])).toBeNull();
  });
});

describe("dropZones", () => {
  const zones = [zone("a", 0, 0.3), zone("b", 0.5, 0.3)];

  it("is every zone with the zones toggle, and only the one being edited without it", () => {
    expect(dropZones(zones, null, true)).toEqual(zones);
    expect(dropZones(zones, "b", false).map((z) => z.id)).toEqual(["b"]);
    expect(dropZones(zones, null, false)).toEqual([]);
  });
});
