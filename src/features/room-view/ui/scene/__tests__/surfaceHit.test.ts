import { BoxGeometry, BufferGeometry, Group, Line, Mesh, type Intersection, type Object3D } from "three";
import { describe, expect, it } from "vitest";

import { firstSurfaceHit } from "../surfaceHit";

const hit = (object: Object3D, distance: number) => ({ object, distance }) as Intersection;

describe("firstSurfaceHit", () => {
  it("passes over lines and anything hidden, itself or by a parent", () => {
    const plumb = new Line(new BufferGeometry());
    const hiddenGroup = new Group();
    hiddenGroup.visible = false;
    const post = new Mesh(new BoxGeometry());
    hiddenGroup.add(post);
    const sofa = new Mesh(new BoxGeometry());
    expect(firstSurfaceHit([hit(plumb, 1), hit(post, 2), hit(sofa, 3)])?.object).toBe(sofa);
  });
});
