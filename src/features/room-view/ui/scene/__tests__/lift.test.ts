import { BufferAttribute, BufferGeometry, Mesh, MeshBasicMaterial, Scene, Vector3 } from "three";
import { describe, expect, it } from "vitest";

import { type Liftable, liftPiece, spansOf } from "../lift";

const liftable = (): Liftable => ({ spans: [], extras: [], pivot: { x: 0, z: 0 } });

describe("spansOf", () => {
  it("joins an owner's neighbouring parts and splits them round another's", () => {
    const mesh = new Mesh(new BufferGeometry());
    const a = liftable();
    const b = liftable();
    const owners = new Map([["a", a], ["b", b]]);
    spansOf(mesh, [3, 6, 9, 3], ["a", "a", "b", "a"], (id) => owners.get(id));
    expect(a.spans.map(({ start, count }) => [start, count])).toEqual([[0, 9], [18, 3]]);
    expect(b.spans.map(({ start, count }) => [start, count])).toEqual([[9, 9]]);
  });
});

describe("liftPiece", () => {
  // Two quads in one indexed mesh, as the merged contact shadows are: the second one is lifted.
  const quads = () => {
    const geometry = new BufferGeometry();
    const positions = new Float32Array(8 * 3).map((_, i) => i + 1);
    geometry.setAttribute("position", new BufferAttribute(positions, 3));
    geometry.setIndex([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]);
    return new Mesh(geometry, new MeshBasicMaterial());
  };

  it("copies only the span's own triangles out, and collapses exactly its vertices", () => {
    const scene = new Scene();
    const mesh = quads();
    scene.add(mesh);
    const piece: Liftable = { spans: [{ mesh, start: 4, count: 4 }], extras: [], pivot: { x: 0, z: 0 } };
    const lifted = liftPiece(scene, piece);
    const copy = scene.children[1]!.children[0]!.children[0]!.children[0] as Mesh;
    expect(Array.from(copy.geometry.index!.array)).toEqual([0, 1, 2, 0, 2, 3]);
    expect(copy.geometry.getAttribute("position").count).toBe(4);
    const position = mesh.geometry.getAttribute("position").array as Float32Array;
    expect(Array.from(position.slice(0, 12)).every((v) => v !== 0)).toBe(true);
    expect(Array.from(position.slice(12)).every((v) => v === 0)).toBe(true);
    lifted.restore();
    expect(Array.from(position)).toEqual(Array.from(new Float32Array(24).map((_, i) => i + 1)));
  });

  it("moves a rider by as far as the piece, without turning it", () => {
    const scene = new Scene();
    const rider: Liftable = { spans: [], extras: [new Mesh()], pivot: { x: 1, z: -2 } };
    scene.add(rider.extras[0]!);
    const lifted = liftPiece(scene, { spans: [], extras: [], pivot: { x: 0, z: 0 } }, new Map([["tv", rider]]));
    expect(lifted.riders).toEqual(["tv"]);
    lifted.moveTo(0.5, 0.25);
    lifted.turnTo(Math.PI / 2);
    const riderPivot = rider.extras[0]!.parent!.parent!.parent!;
    expect([riderPivot.position.x, riderPivot.position.z]).toEqual([1.5, -1.75]);
    expect(riderPivot.rotation.y).toBe(0);
  });

  it("reshapes a piece about a height: across and up from its centre there, then raised", () => {
    const scene = new Scene();
    const point = new Mesh();
    point.position.set(2.5, 1.5, -1);
    const lifted = liftPiece(scene, { spans: [], extras: [point], pivot: { x: 2, z: -1 } });
    lifted.reshape(2, 2, 1, 0.25);
    scene.updateMatrixWorld(true);
    expect(point.getWorldPosition(new Vector3()).toArray()).toEqual([3, 2.25, -1]);
    lifted.reshape(1, 1, 0, 0);
    scene.updateMatrixWorld(true);
    expect(point.getWorldPosition(new Vector3()).toArray()).toEqual([2.5, 1.5, -1]);
  });
});
