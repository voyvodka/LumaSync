import {
  BufferGeometry,
  Line,
  LineSegments,
  type Material,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  OrthographicCamera,
  Points,
  Scene,
  type Vector2,
  type WebGLRenderer,
  type WebGLRenderTarget,
} from "three";
import { describe, expect, it, vi } from "vitest";

import { createBloom, glowPassHides, OVERLAY } from "../bloom";

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

describe("createBloom().compile", () => {
  it("compiles the room as both passes draw it, then puts the renderer back", async () => {
    const wood = new MeshStandardMaterial();
    const mesh = new Mesh(new BufferGeometry(), wood);
    const scene = new Scene().add(mesh);
    const seen: { target: WebGLRenderTarget | null; shadows: boolean; material: Material }[] = [];
    let target: WebGLRenderTarget | null = null;
    const renderer = {
      shadowMap: { enabled: true },
      getPixelRatio: () => 1,
      getSize: (size: Vector2) => size.set(1, 1),
      getRenderTarget: () => target,
      setRenderTarget: (next: WebGLRenderTarget | null) => {
        target = next;
      },
      compileAsync: vi.fn(async () => {
        seen.push({ target, shadows: renderer.shadowMap.enabled, material: mesh.material as Material });
      }),
    };

    await createBloom(renderer as unknown as WebGLRenderer, false).compile(scene, new OrthographicCamera());

    expect(seen).toHaveLength(2);
    expect(seen[0]).toMatchObject({ shadows: true, material: wood });
    expect(seen[0]!.target).not.toBeNull();
    expect(seen[1]!.target).not.toBeNull();
    expect(seen[1]!.shadows).toBe(false);
    expect(seen[1]!.material).toBeInstanceOf(MeshBasicMaterial);
    expect(target).toBeNull();
    expect(renderer.shadowMap.enabled).toBe(true);
    expect(mesh.material).toBe(wood);
  });
});
