import { describe, expect, it } from "vitest";

import type { Lamp } from "../glow";
import { LAMP_LIGHTS, lampLights } from "../lampLights";

const lamp = (x: number, outside?: boolean): Lamp => ({ at: { x, y: 1, z: 0 }, radii: [0.1, 0.1, 0.1], color: 0xffd6ad, outside });

describe("lampLights", () => {
  // A count that followed the lamps changed the shader programs, and adding a lamp recompiled the room.
  it("adds the same number of lights for one lamp as for ten", () => {
    expect(lampLights([lamp(0)], 5, false).lights).toHaveLength(LAMP_LIGHTS);
    expect(lampLights(Array.from({ length: 10 }, (_, i) => lamp(i)), 5, false).lights).toHaveLength(LAMP_LIGHTS);
  });

  it("lights the lamps in the room, leaves the spare lights dark, and marks who has one", () => {
    const lamps = [lamp(0, true), lamp(1), lamp(2)];
    const { lights } = lampLights(lamps, 5, false);
    expect(lights.filter((l) => l.intensity > 0).map((l) => l.position.x)).toEqual([1, 2]);
    expect(lamps.map((l) => l.litByLight ?? false)).toEqual([false, true, true]);
  });

  it("gives a light to the first lamps only, so the rest keep their pools", () => {
    const lamps = Array.from({ length: LAMP_LIGHTS + 2 }, (_, i) => lamp(i));
    lampLights(lamps, 5, false);
    expect(lamps.filter((l) => l.litByLight)).toHaveLength(LAMP_LIGHTS);
    expect(lamps[lamps.length - 1]?.litByLight).toBeUndefined();
  });
});
