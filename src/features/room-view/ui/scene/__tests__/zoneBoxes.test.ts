import { type LineSegments, type Mesh, type MeshBasicMaterial, OrthographicCamera, Quaternion, Vector3 } from "three";
import { describe, expect, it } from "vitest";

import type { HueZone } from "@/shared/contracts/roomMap";

import { buildZoneBoxes } from "../zoneBoxes";

const dims = { widthMeters: 5, depthMeters: 4, heightMeters: 2.5 };
const zone = (id: string): HueZone => ({ id, name: `Zone ${id}`, entertainmentAreaId: "x", centerX: 0, centerY: 0, centerZ: 0, scaleX: 0.5, scaleY: 0.5, scaleZ: 0.5, channelIndices: [] });

const parts = (boxes: ReturnType<typeof buildZoneBoxes>, i: number) => {
  const one = boxes.group.children[i]!;
  const [fill, edges, foot, label] = one.children as [Mesh, LineSegments, Mesh, Mesh];
  return { one, fill, edges, foot, label };
};

describe("buildZoneBoxes", () => {
  it("shows nothing until a zone is marked", () => {
    const boxes = buildZoneBoxes([zone("a"), zone("b")], dims);
    expect(boxes.group.visible).toBe(false);
    expect(boxes.mark(null)).toBe(false);
  });

  it("draws the zone being edited named and as its cube, the others as their footprint alone", () => {
    const boxes = buildZoneBoxes([zone("a"), zone("b"), zone("c")], dims);
    expect(boxes.mark({ active: "a", held: null, others: ["b"] })).toBe(true);
    const a = parts(boxes, 0);
    const b = parts(boxes, 1);
    expect(boxes.group.visible).toBe(true);
    expect([a.one.visible, b.one.visible, parts(boxes, 2).one.visible]).toEqual([true, true, false]);
    expect(a.label.visible).toBe(true);
    expect(b.label.visible).toBe(false);
    expect([a.fill.visible, a.edges.visible, b.fill.visible, b.edges.visible]).toEqual([true, true, false, false]);
    expect((a.foot.material as MeshBasicMaterial).opacity).toBeGreaterThan((b.foot.material as MeshBasicMaterial).opacity);
    expect(boxes.mark({ active: "a", held: null, others: ["b"] })).toBe(false);
  });

  it("keeps the name one size on screen, over the top corner highest on screen", () => {
    const boxes = buildZoneBoxes([zone("a")], dims);
    boxes.mark({ active: "a", held: null, others: [] });
    const { label } = parts(boxes, 0);
    boxes.setPixelsPerMetre(100);
    const near = label.scale.y;
    boxes.setPixelsPerMetre(50);
    expect(label.scale.y).toBeCloseTo(near * 2);
    // Looking down from the +x +z corner: the far corner (-x, -z) of the 2.5 × 2 m cube's top is highest.
    const q = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), -0.6);
    q.premultiply(new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 4));
    boxes.orient(q);
    expect(label.position.x).toBeLessThan(-1.2);
    expect(label.position.z).toBeLessThan(-0.9);
    expect(label.position.y).toBeGreaterThan(1.875);
  });

  it("takes a lower corner when the highest would put the name past the view's top", () => {
    const boxes = buildZoneBoxes([zone("a")], dims);
    boxes.mark({ active: "a", held: null, others: [] });
    boxes.setPixelsPerMetre(100);
    const { one, label } = parts(boxes, 0);
    // Close in, so the cube's far top corner is above the frame.
    const camera = new OrthographicCamera(-1.5, 1.5, 1, -1, 0.1, 50);
    camera.position.set(6, 6, 6);
    camera.lookAt(0, 0.6, 0);
    camera.updateMatrixWorld();
    boxes.orient(camera.quaternion);
    const free = label.position.clone();
    boxes.orient(camera.quaternion, camera);
    expect(label.position.equals(free)).toBe(false);
    expect(label.position.clone().add(one.position).project(camera).y).toBeLessThan(0.72);
  });

  it("draws its whole cube, all four sides, from its base to its top", () => {
    const boxes = buildZoneBoxes([zone("a")], dims);
    const { one, fill, edges } = parts(boxes, 0);
    expect(one.position.y).toBe(0);
    edges.geometry.computeBoundingBox();
    // A 1.25 m cube standing 0.625 m up, round a centre 1.25 m up.
    expect(edges.position.y).toBeCloseTo(1.25);
    expect(edges.geometry.boundingBox!.max.y).toBeCloseTo(0.625);
    expect(edges.geometry.boundingBox!.max.x).toBeCloseTo(1.25);
    expect(fill.position.y).toBe(edges.position.y);
  });

  it("reads its base and top by its outermost upright edge on screen, with the ceiling over it", () => {
    const boxes = buildZoneBoxes([zone("a")], dims);
    const reach = boxes.group.getObjectByName("zone-reach")!;
    const ceiling = boxes.group.getObjectByName("zone-ceiling")!;
    boxes.mark({ active: "a", held: null, others: [] });
    expect([reach.visible, ceiling.visible]).toEqual([true, true]);
    boxes.setPixelsPerMetre(100);
    // Seen from the +x +z corner, the screen's right runs toward +x -z: the (+x, -z) edge is outermost.
    const q = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), -0.6);
    q.premultiply(new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 4));
    boxes.orient(q);
    const [base, top] = reach.children;
    expect(base!.position.x).toBeGreaterThan(1.25);
    expect(base!.position.z).toBeLessThan(-1);
    expect(base!.position.y).toBeCloseTo(0.625);
    expect(top!.position.y).toBeCloseTo(1.875);
    boxes.mark(null);
    expect([reach.visible, ceiling.visible]).toEqual([false, false]);
  });

  it("carries the held zone's lights with it, where each sits in the cube", () => {
    const light = { zoneId: "a", rel: { x: 0.5, y: 0.5, z: -1 }, half: [0.1, 0.1, 0.1] as const, offset: { x: 0, y: 0.05, z: 0 } };
    const boxes = buildZoneBoxes([zone("a"), zone("b")], dims, { lights: [light, { ...light, zoneId: "b" }] });
    const [mine, other] = boxes.group.children.filter((c) => c.name === "zone-light");
    boxes.mark({ active: "a", held: "a", others: [] });
    boxes.hold("a", { x0: 0, y0: 0, x1: 2, y1: 2 }, 0);
    expect([mine!.visible, other!.visible]).toEqual([true, false]);
    // The 2 m cube's centre is 1.5 m from the left wall, 1 m from the screen's, 1.25 m up.
    expect(mine!.position.toArray().map((v) => Number(v.toFixed(3)))).toEqual([-1, 0.3, -1.5]);
    boxes.hold("a", null);
    expect(mine!.visible).toBe(false);
  });

  it("offers its grips only on the zone that is itself the selection", () => {
    const boxes = buildZoneBoxes([zone("a"), zone("b")], dims);
    const grips = boxes.group.children[2]!;
    boxes.mark({ active: "a", held: null, others: ["b"] });
    expect(grips.visible).toBe(false);
    boxes.mark({ active: "a", held: "a", others: ["b"] });
    expect(grips.visible).toBe(true);
    expect(grips.children).toHaveLength(8);
    // The zone spans 2.5 × 2 m round the middle: its corners are 1.25 and 1 m out.
    expect(grips.children.map((g) => [g.position.x, g.position.z])).toContainEqual([-1.25, -1]);
    boxes.setPixelsPerMetre(100);
    expect(grips.children[0]!.scale.x).toBeCloseTo(0.1);
  });

  it("draws a held zone as its box where it is being put, and puts it back after", () => {
    const boxes = buildZoneBoxes([zone("a")], dims);
    boxes.mark({ active: "a", held: "a", others: [] });
    const { one } = parts(boxes, 0);
    const [grips, ghost] = boxes.group.children.slice(1);
    expect(boxes.hold("a", { x0: 0, y0: 0, x1: 2, y1: 2 })).toBe(true);
    expect([one.visible, grips!.visible, ghost!.visible]).toEqual([false, false, true]);
    // A 2 m cube, as high as it is wide, and a centimetre off the two walls it touches.
    const [gw, gh, gd] = ghost!.scale.toArray();
    expect([gw, gh, gd].map((v) => Number(v.toFixed(3)))).toEqual([1.99, 2, 1.99]);
    expect(ghost!.position.toArray().map((v) => Number(v.toFixed(3)))).toEqual([-1.495, 1.25, -0.995]);
    boxes.hold("a", { x0: 0, y0: 0, x1: 2, y1: 2 }, 0.2);
    expect(ghost!.position.y).toBeCloseTo(1.5);
    boxes.hold("a", { x0: 0, y0: 0, x1: 2, y1: 2 }, -0.2);
    const bottom = ghost!.position.y - ghost!.scale.y / 2;
    expect(bottom).toBeGreaterThan(0.004);
    expect(bottom).toBeLessThan(0.01);
    expect(ghost!.position.y + ghost!.scale.y / 2).toBeCloseTo(2);
    boxes.mark({ active: "a", held: "a", others: [] });
    expect(one.visible).toBe(false);
    expect(boxes.hold("a", null)).toBe(true);
    expect([one.visible, grips!.visible, ghost!.visible]).toEqual([true, true, false]);
    expect(boxes.hold("a", null)).toBe(false);
  });

  it("rests raised where it is, its footprint on the floor under it", () => {
    const boxes = buildZoneBoxes([{ ...zone("a"), centerZ: 0.5 }], dims);
    boxes.mark({ active: "a", held: null, others: [] });
    const { edges, foot } = parts(boxes, 0);
    expect(edges.position.y).toBeCloseTo(1.875);
    expect(foot.position.y).toBeLessThan(0.01);
  });

  it("stands a zone on the floor just clear of it", () => {
    const boxes = buildZoneBoxes([{ ...zone("a"), centerZ: -0.5 }], dims);
    boxes.mark({ active: "a", held: null, others: [] });
    const { edges } = parts(boxes, 0);
    edges.geometry.computeBoundingBox();
    const bottom = edges.position.y + edges.geometry.boundingBox!.min.y;
    expect(bottom).toBeGreaterThan(0.004);
    expect(bottom).toBeLessThan(0.01);
  });

  it("keeps a zone that fills the room a centimetre inside its walls", () => {
    const boxes = buildZoneBoxes([{ ...zone("a"), scaleX: 1, scaleY: 1, scaleZ: 1 }], dims);
    boxes.mark({ active: "a", held: "a", others: [] });
    const [grips] = boxes.group.children.slice(1);
    const xs = grips!.children.map((rim) => rim.position.x + grips!.position.x);
    expect(Math.min(...xs)).toBeCloseTo(-2.49);
    expect(Math.max(...xs)).toBeCloseTo(2.49);
  });

  it("is outlined in the zone's colour", () => {
    const boxes = buildZoneBoxes([{ ...zone("a"), borderColor: "var(--lm-zone-2)" }], dims);
    const { foot } = parts(boxes, 0);
    expect((foot.material as MeshBasicMaterial).color.getHexString()).toBe("10b981");
  });
});
