import { type ConeGeometry, type Mesh, type MeshBasicMaterial, Vector3 } from "three";
import { describe, expect, it } from "vitest";

import { buildBeams } from "../beams";
import type { Lamp } from "../glow";

const lamp = (patch: Partial<Lamp> = {}): Lamp => ({ at: { x: 1, y: 0.5, z: -1 }, radii: [0.1, 0.1, 0.1], color: 0xff0000, ...patch });
const SIDEWAYS = { aim: new Vector3(0, 0, -1), spread: 0.8 };
const DOWNWARD = { aim: new Vector3(0, -1, 0), spread: 1.05 };
const throws = (lamps: Lamp[]) => buildBeams(lamps, { w: 5, d: 4, h: 2.5 });

describe("buildBeams", () => {
  it("throws a cone only from a one-sided light inside the room, never the house's own", () => {
    expect(throws([lamp(), lamp({ beam: SIDEWAYS, outside: true }), lamp({ beam: SIDEWAYS, own: true })])).toBeNull();
    const beams = throws([lamp(), lamp({ beam: SIDEWAYS })])!;
    expect(beams.group.children).toHaveLength(1);
  });

  it("opens from the lit part along the light's aim, as far as the wall it meets", () => {
    const cone = throws([lamp({ beam: SIDEWAYS })])!.group.children[0] as Mesh<ConeGeometry>;
    expect(cone.position.toArray()).toEqual([1, 0.5, -1]);
    const axis = new Vector3(0, -1, 0).applyQuaternion(cone.quaternion);
    expect(axis.z).toBeCloseTo(-1);
    cone.geometry.computeBoundingBox();
    expect(cone.geometry.boundingBox!.max.y).toBeCloseTo(0);
    // A metre in front of the wall behind it, at z = -2.
    expect(cone.geometry.boundingBox!.min.y).toBeCloseTo(-1);
  });

  it("reaches the floor from a light thrown down", () => {
    const cone = throws([lamp({ at: { x: 0, y: 2, z: 0 }, beam: DOWNWARD })])!.group.children[0] as Mesh<ConeGeometry>;
    cone.geometry.computeBoundingBox();
    expect(cone.geometry.boundingBox!.min.y).toBeCloseTo(-2);
  });

  it("fades out toward its mouth", () => {
    const cone = throws([lamp({ beam: SIDEWAYS })])!.group.children[0] as Mesh<ConeGeometry>;
    const position = cone.geometry.getAttribute("position");
    const alpha = cone.geometry.getAttribute("color");
    for (let i = 0; i < position.count; i++) {
      if (position.getY(i) === 0) expect(alpha.getW(i)).toBe(1);
      if (position.getY(i) <= -1 + 1e-6) expect(alpha.getW(i)).toBeCloseTo(0);
    }
  });

  it("takes the lamp's colour and dims with its level, still showing when off", () => {
    const beams = throws([lamp({ beam: SIDEWAYS })])!;
    const material = (beams.group.children[0] as Mesh<ConeGeometry, MeshBasicMaterial>).material;
    beams.paint(0x00ff00, 1);
    expect(material.color.getHex()).toBe(0x00ff00);
    const full = material.opacity;
    beams.paint(null, 0);
    expect(material.color.getHex()).toBe(0xff0000);
    expect(material.opacity).toBeGreaterThan(0);
    expect(material.opacity).toBeLessThan(full);
  });
});
