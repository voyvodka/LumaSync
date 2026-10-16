import { Color, type InstancedMesh, Matrix4, Texture, Vector3 } from "three";
import { describe, expect, it } from "vitest";

import { buildGlow } from "../glow";

const lamp = (x: number, outside?: boolean) => ({ at: { x, y: 1, z: 0 }, radii: [0.1, 0.1, 0.1] as [number, number, number], color: 0xffaa00, outside });

describe("buildGlow", () => {
  // A downlight's wash spread four metres wide; its light falls in a cone.
  it("throws a downlight's pool the size of its cone, narrower than an open lamp's", () => {
    const high = { ...lamp(0), at: { x: 0, y: 2.48, z: 0 } };
    const glow = buildGlow([high, { ...high, beam: { aim: new Vector3(0, -1, 0), spread: 0.55 } }], [], 2.5, new Texture())!;
    const pools = glow.objects.find((mesh) => mesh.geometry.type === "PlaneGeometry") as InstancedMesh;
    const scale = (i: number) => {
      const m = new Matrix4();
      pools.getMatrixAt(i, m);
      return new Vector3().setFromMatrixScale(m).x;
    };
    expect(scale(1)).toBeCloseTo(1.4 * 2.48 * Math.tan(0.55), 3);
    expect(scale(1)).toBeLessThan(scale(0));
  });

  // A lamp standing in an L's cut threw its pool over a floor that is not there.
  it("throws no pool for a lamp outside the room's outline", () => {
    const glow = buildGlow([lamp(0), lamp(1, true)], [], 2.5, new Texture())!;
    const pools = glow.objects.find((mesh) => mesh.geometry.type === "PlaneGeometry") as InstancedMesh;
    const scale = (i: number) => {
      const m = new Matrix4();
      pools.getMatrixAt(i, m);
      return new Vector3().setFromMatrixScale(m).x;
    };
    expect(scale(0)).toBeGreaterThan(1);
    expect(scale(1)).toBe(0);
  });

  // With its pool taken away a real-lit lamp left the dark floor under it an even brown.
  it("keeps a fainter pool under a lamp a real light already lights", () => {
    const glow = buildGlow([lamp(0), { ...lamp(1), litByLight: true }], [], 2.5, new Texture())!;
    const pools = glow.objects.find((mesh) => mesh.geometry.type === "PlaneGeometry") as InstancedMesh;
    const m = new Matrix4();
    pools.getMatrixAt(1, m);
    expect(new Vector3().setFromMatrixScale(m).x).toBeGreaterThan(1);
    const painted = new Color();
    const own = new Color();
    pools.getColorAt(0, own);
    pools.getColorAt(1, painted);
    expect(painted.r).toBeGreaterThan(0);
    expect(painted.r).toBeLessThan(own.r);
  });
});

describe("buildGlow — lit shapes", () => {
  const shaped = (shape: "globe" | "drum" | "bar") => ({ at: { x: 0, y: 1, z: 0 }, radii: [0.1, 0.1, 0.1] as [number, number, number], color: 0xffaa00, shape });
  const shown = (mesh: InstancedMesh, i: number) => {
    const m = new Matrix4();
    mesh.getMatrixAt(i, m);
    return new Vector3().setFromMatrixScale(m).x > 0;
  };

  // A floor lamp's shade read as a ball on a pole: each fixture's lit part has its own shape.
  it("draws each lamp's lit part in its own shape, and only there", () => {
    const glow = buildGlow([shaped("globe"), shaped("drum"), shaped("bar")], [], 2.5, new Texture())!;
    const byGeometry = (type: string) => glow.objects.find((mesh) => mesh.geometry.type === type) as InstancedMesh;
    expect([0, 1, 2].map((i) => shown(byGeometry("SphereGeometry"), i))).toEqual([true, false, false]);
    expect([0, 1, 2].map((i) => shown(byGeometry("BoxGeometry"), i))).toEqual([false, false, true]);
    const drums = glow.objects.filter((mesh) => mesh.geometry.type === "CylinderGeometry") as InstancedMesh[];
    expect(drums.some((mesh) => shown(mesh, 1))).toBe(true);
    expect(drums.some((mesh) => shown(mesh, 0) || shown(mesh, 2))).toBe(false);
  });
});
