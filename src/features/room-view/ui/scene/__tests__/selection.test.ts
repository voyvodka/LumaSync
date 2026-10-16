import { Box3, Mesh, type Object3D, RingGeometry } from "three";
import { describe, expect, it } from "vitest";

import type { Pickable } from "../../../model/picking";
import { PLUMB_NAME } from "../plumb";
import { buildSelectionMark } from "../selection";

const frameOf = (pickable: Pickable) => {
  const mark = buildSelectionMark([pickable]);
  mark.select(pickable.id);
  const isHalo = (o: Object3D) => o instanceof Mesh && o.geometry instanceof RingGeometry;
  const halo = mark.group.children.filter(isHalo);
  const frame = mark.group.children.find((o) => !isHalo(o) && o.name !== PLUMB_NAME)!;
  frame.updateMatrixWorld(true);
  const frames: Mesh[] = [];
  frame.traverse((o) => {
    if (o instanceof Mesh) frames.push(o);
  });
  const plumb = mark.group.children.find((o) => o.name === PLUMB_NAME)!;
  return { haloShown: halo.some((m) => m.visible), box: new Box3().setFromObject(frame), frames, plumb, floorShown: frame.visible };
};

describe("buildSelectionMark", () => {
  // A selected strip drew a ring half its length across and a square on the floor that size.
  it("marks a strip with a thin frame round its line, not a ring", () => {
    const { haloShown, box } = frameOf({ id: "usb-s", kind: "light", centre: { x: 0, y: 1.2, z: -1.9 }, half: [1, 0.006, 0.002], angle: 0, line: true });
    expect(haloShown).toBe(false);
    expect(box.max.x - box.min.x).toBeCloseTo(2.05, 2);
    expect(box.max.y - box.min.y).toBeLessThan(0.07);
    expect(box.min.y).toBeGreaterThan(1.1);
  });

  it("lays the frame flat for a strip on the floor", () => {
    const { box } = frameOf({ id: "usb-s", kind: "light", centre: { x: 0, y: 0.003, z: 0 }, half: [1, 0.002, 0.006], angle: Math.PI / 2, line: true });
    expect(box.max.y - box.min.y).toBeLessThan(0.01);
    expect(box.max.z - box.min.z).toBeCloseTo(2.05, 2);
  });

  // A strip bent round a corner was framed as one box across the corner's open side.
  it("frames a bent strip leg by leg", () => {
    const legs = [
      { centre: { x: -0.5, y: 1.2, z: -1.9 }, half: [0.5, 0.006, 0.002] as const, angle: 0 },
      { centre: { x: 0, y: 1.2, z: -1.4 }, half: [0.5, 0.006, 0.002] as const, angle: Math.PI / 2 },
    ];
    const { frames, box } = frameOf({ id: "usb-s", kind: "light", centre: { x: -0.25, y: 1.2, z: -1.65 }, half: [0.5, 0.006, 0.5], angle: 0, line: true, legs });
    expect(frames).toHaveLength(2);
    expect(box.max.x - box.min.x).toBeCloseTo(1.05, 1);
    expect(box.max.z - box.min.z).toBeCloseTo(1.05, 1);
  });

  it("still rings a lamp", () => {
    expect(frameOf({ id: "hue-1", kind: "light", centre: { x: 0, y: 1, z: 0 }, half: [0.1, 0.1, 0.1], angle: 0 }).haloShown).toBe(true);
  });

  // A ceiling light's outline on the floor read as a stray ring with nothing linking it to the light.
  it("drops a line from a light high in the room to a ring on the floor under it", () => {
    const { plumb, floorShown } = frameOf({ id: "hue-1", kind: "light", centre: { x: 0.4, y: 2.46, z: -0.3 }, half: [0.19, 0.025, 0.19], angle: 0 });
    expect(floorShown).toBe(false);
    expect(plumb.visible).toBe(true);
    plumb.updateMatrixWorld(true);
    const box = new Box3().setFromObject(plumb);
    expect(box.max.y).toBeCloseTo(2.435, 3);
    expect(box.min.y).toBeLessThan(0.01);
    expect((box.min.x + box.max.x) / 2).toBeCloseTo(0.4, 3);
  });

  it("keeps the floor outline and no line for a light within reach of the floor", () => {
    const { plumb, floorShown } = frameOf({ id: "hue-1", kind: "light", centre: { x: 0, y: 0.8, z: 0 }, half: [0.1, 0.1, 0.1], angle: 0 });
    expect(floorShown).toBe(true);
    expect(plumb.visible).toBe(false);
  });
});
