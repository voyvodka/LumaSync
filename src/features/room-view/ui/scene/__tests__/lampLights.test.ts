import { Light, SpotLight, Vector3 } from "three";
import { describe, expect, it } from "vitest";

import type { Lamp } from "../glow";
import { LAMP_LIGHTS, LAMP_SPOTS, lampLights } from "../lampLights";

const lightsOf = (lamps: Lamp[]) => lampLights(lamps, 5, false).objects.filter((o): o is Light => o instanceof Light);
const coned = (x: number): Lamp => ({ ...lamp(x), beam: { aim: new Vector3(0, 0, -1), spread: 1 } });

const lamp = (x: number, outside?: boolean): Lamp => ({ at: { x, y: 1, z: 0 }, radii: [0.1, 0.1, 0.1], color: 0xffd6ad, outside });

describe("lampLights", () => {
  it("gives each lit lamp its stop of a palette, counted over every lamp", () => {
    const lamps = [lamp(0, true), lamp(1), lamp(2)];
    const lit = lampLights(lamps, 5, false);
    lit.paint(null, 1, [0xff0000, 0x00ff00, 0x0000ff]);
    const lights = lit.objects.filter((o): o is Light => o instanceof Light && o.intensity > 0);
    expect(lights.map((l) => l.color.getHex())).toEqual([0x00ff00, 0x0000ff]);
  });

  // A count that followed the lamps changed the shader programs, and adding a lamp recompiled the room.
  it("adds the same number of lights for one lamp as for ten", () => {
    expect(lightsOf([lamp(0)])).toHaveLength(LAMP_LIGHTS + LAMP_SPOTS);
    expect(lightsOf(Array.from({ length: 10 }, (_, i) => (i % 2 ? lamp(i) : coned(i))))).toHaveLength(LAMP_LIGHTS + LAMP_SPOTS);
  });

  it("lights the lamps in the room, leaves the spare lights dark, and marks who has one", () => {
    const lamps = [lamp(0, true), lamp(1), lamp(2)];
    const lights = lightsOf(lamps);
    expect(lights.filter((l) => l.intensity > 0).map((l) => l.position.x)).toEqual([1, 2]);
    expect(lamps.map((l) => l.litByLight ?? false)).toEqual([false, true, true]);
  });

  it("gives a light to the first lamps only, so the rest keep their pools", () => {
    const lamps = Array.from({ length: LAMP_LIGHTS + 2 }, (_, i) => lamp(i));
    lampLights(lamps, 5, false);
    expect(lamps.filter((l) => l.litByLight)).toHaveLength(LAMP_LIGHTS);
    expect(lamps[lamps.length - 1]?.litByLight).toBeUndefined();
  });

  // A Play bar turned to the wall lit the room all round, as if it had no back.
  it("throws a one-sided lamp's light as a cone along its aim", () => {
    const lights = lightsOf([coned(1), lamp(2)]);
    const spot = lights.find((l): l is SpotLight => l instanceof SpotLight && l.intensity > 0);
    expect(spot?.position.x).toBeCloseTo(1);
    expect(spot!.target.position.z).toBeLessThan(spot!.position.z);
    expect(lights.filter((l) => !(l instanceof SpotLight) && l.intensity > 0).map((l) => l.position.x)).toEqual([2]);
  });
});
