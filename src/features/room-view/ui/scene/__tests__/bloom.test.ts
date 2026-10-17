import { BufferGeometry, Line, LineSegments, Mesh, Points } from "three";
import { describe, expect, it } from "vitest";

import { glowPassHides, OVERLAY } from "../bloom";

describe("glowPassHides", () => {
  it("leaves out points and every line, the plumb's dashed one too, and keeps meshes to draw black", () => {
    expect(glowPassHides(new Line(new BufferGeometry()))).toBe(true);
    expect(glowPassHides(new LineSegments(new BufferGeometry()))).toBe(true);
    expect(glowPassHides(new Points(new BufferGeometry()))).toBe(true);
    expect(glowPassHides(new Mesh())).toBe(false);
    const overlay = new Mesh();
    overlay.userData[OVERLAY] = true;
    expect(glowPassHides(overlay)).toBe(true);
  });
});
