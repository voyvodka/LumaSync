import { type BufferGeometry, DirectionalLight, InstancedMesh, type Material, type Texture, Vector3 } from "three";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_ROOM_MAP, type RoomMapConfig } from "@/shared/contracts/roomMap";

import { buildRoomScene, disposeScene } from "../roomScene";

const OPTIONS = { shadows: true, lambert: false };

const furnished: RoomMapConfig = {
  ...DEFAULT_ROOM_MAP,
  furniture: [
    { id: "sofa", type: "sofa", x: 1, y: 2.5, width: 2, height: 0.9 },
    { id: "chair", type: "chair", x: 3.5, y: 1, width: 0.5, height: 0.5, rotation: 90 },
  ],
  tvAnchor: { x: 1.5, y: 0, width: 1.4, height: 0.1 },
  hueChannels: [
    { channelIndex: 0, x: -0.8, y: 0.8, z: 0.2, zOrigin: "bridge" },
    { channelIndex: 1, x: 0.8, y: 0.8, z: 0 },
  ],
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("buildRoomScene", () => {
  it("builds without a warning from three", () => {
    const warn = vi.spyOn(console, "warn");
    disposeScene(buildRoomScene(furnished, OPTIONS).scene);
    expect(warn).not.toHaveBeenCalled();
  });

  it("builds an empty room with no decals or lamps", () => {
    const { scene } = buildRoomScene(DEFAULT_ROOM_MAP, OPTIONS);
    let instanced = 0;
    scene.traverse((object) => {
      if (object instanceof InstancedMesh) instanced += 1;
    });
    expect(instanced).toBe(0);
    disposeScene(scene);
  });

  it("reports a wall cut only when the walls change", () => {
    const room = buildRoomScene(furnished, OPTIONS);
    const towardBack = new Vector3(0, 0, 1);
    expect(room.cutWalls(towardBack)).toBe(true);
    expect(room.cutWalls(towardBack)).toBe(false);
    expect(room.cutWalls(new Vector3(1, 0, 0))).toBe(true);
    disposeScene(room.scene);
  });
});

describe("disposeScene", () => {
  it("frees every geometry, material, texture, instance buffer and shadow map once", () => {
    const { scene } = buildRoomScene(furnished, OPTIONS);
    const geometries = new Set<BufferGeometry>();
    const materials = new Set<Material>();
    const textures = new Set<Texture>();
    const instanced: InstancedMesh[] = [];
    const lights: DirectionalLight[] = [];
    scene.traverse((object) => {
      const { geometry, material } = object as { geometry?: BufferGeometry; material?: Material };
      if (geometry) geometries.add(geometry);
      if (material) {
        materials.add(material);
        const map = (material as { map?: Texture | null }).map;
        if (map) textures.add(map);
      }
      if (object instanceof InstancedMesh) instanced.push(object);
      if (object instanceof DirectionalLight) lights.push(object);
    });
    const spies = [...geometries, ...materials, ...textures].map((item) => vi.spyOn(item, "dispose"));
    const instanceSpies = instanced.map((mesh) => vi.spyOn(mesh, "dispose"));
    const shadowSpies = lights.map((light) => vi.spyOn(light.shadow, "dispose"));

    disposeScene(scene);

    expect(instanced.length).toBeGreaterThan(0);
    expect(lights.length).toBeGreaterThan(0);
    for (const spy of [...spies, ...instanceSpies, ...shadowSpies]) expect(spy).toHaveBeenCalledTimes(1);
    expect(scene.children).toHaveLength(0);
  });
});
