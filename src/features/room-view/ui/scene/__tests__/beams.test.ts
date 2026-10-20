import { type BufferGeometry, type Mesh, type MeshBasicMaterial, Vector3 } from "three";
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
    const cone = throws([lamp({ beam: SIDEWAYS })])!.group.children[0] as Mesh<BufferGeometry>;
    expect(cone.position.toArray()).toEqual([1, 0.5, -1]);
    const axis = new Vector3(0, -1, 0).applyQuaternion(cone.quaternion);
    expect(axis.z).toBeCloseTo(-1);
    cone.geometry.computeBoundingBox();
    expect(cone.geometry.boundingBox!.max.y).toBeCloseTo(0);
    // A metre in front of the wall behind it, at z = -2.
    expect(cone.geometry.boundingBox!.min.y).toBeCloseTo(-1);
  });

  // A Play bar's cone opened from a point at its middle.
  it("opens from the lit part's whole face: a Play bar's height, a bulb's small disc", () => {
    const startSpan = (radii: [number, number, number]) => {
      const cone = throws([lamp({ radii, beam: SIDEWAYS })])!.group.children[0] as Mesh;
      cone.updateMatrixWorld();
      const position = cone.geometry.getAttribute("position");
      const ys: number[] = [];
      const p = new Vector3();
      for (let i = 0; i < position.count; i++) {
        if (Math.abs(position.getY(i)) > 1e-6) continue;
        ys.push(p.fromBufferAttribute(position, i).applyMatrix4(cone.matrixWorld).y);
      }
      return Math.max(...ys) - Math.min(...ys);
    };
    expect(startSpan([0.017, 0.126, 0.004])).toBeCloseTo(0.252, 2);
    expect(startSpan([0.03, 0.03, 0.03])).toBeLessThan(0.07);
  });

  it("draws a wall light's second throw the other way", () => {
    const beams = throws([lamp({ beam: { aim: new Vector3(0, 1, 0), spread: 0.7 }, back: { aim: new Vector3(0, -1, 0), spread: 0.7 } })])!;
    expect(beams.group.children).toHaveLength(2);
  });

  it("reaches the floor from a light thrown down", () => {
    const cone = throws([lamp({ at: { x: 0, y: 2, z: 0 }, beam: DOWNWARD })])!.group.children[0] as Mesh<BufferGeometry>;
    cone.geometry.computeBoundingBox();
    expect(cone.geometry.boundingBox!.min.y).toBeCloseTo(-2);
  });

  it("fades out toward its mouth", () => {
    const cone = throws([lamp({ beam: SIDEWAYS })])!.group.children[0] as Mesh<BufferGeometry>;
    const position = cone.geometry.getAttribute("position");
    const alpha = cone.geometry.getAttribute("color");
    for (let i = 0; i < position.count; i++) {
      if (position.getY(i) === 0) expect(alpha.getW(i)).toBe(1);
      if (position.getY(i) <= -1 + 1e-6) expect(alpha.getW(i)).toBeCloseTo(0);
    }
  });

  it("takes the lamp's colour and dims with its level, still showing when off", () => {
    const beams = throws([lamp({ beam: SIDEWAYS })])!;
    const material = (beams.group.children[0] as Mesh<BufferGeometry, MeshBasicMaterial>).material;
    beams.paint(0x00ff00, 1);
    expect(material.color.getHex()).toBe(0x00ff00);
    const full = material.opacity;
    beams.paint(null, 0);
    expect(material.color.getHex()).toBe(0xff0000);
    expect(material.opacity).toBeGreaterThan(0);
    expect(material.opacity).toBeLessThan(full);
  });
});
