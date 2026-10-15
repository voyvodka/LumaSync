import { BoxGeometry, type BufferGeometry, DirectionalLight, InstancedMesh, type Material, Matrix4, Mesh, type MeshBasicMaterial, type Scene, type Texture, Vector3 } from "three";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_ROOM_MAP, type RoomMapConfig, type UsbStripPlacement } from "@/shared/contracts/roomMap";

import { LAMP_LIGHTS } from "../scene/lampLights";
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

describe("buildRoomScene — draw budget", () => {
  const drawables = (config: RoomMapConfig) => {
    const { scene } = buildRoomScene(config, OPTIONS);
    let count = 0;
    scene.traverse((object) => {
      if ((object as { isMesh?: boolean }).isMesh || (object as { isPoints?: boolean }).isPoints) count += 1;
    });
    disposeScene(scene);
    return count;
  };

  it("adds no draw for a light drawn as its fixture", () => {
    const lamps = [0, 1].map((i) => ({ channelIndex: i, x: -0.2 + i * 0.4, y: 0, z: 0.3, zOrigin: "bridge" as const }));
    const bulbs = drawables({ ...furnished, hueChannels: lamps });
    const scene = buildRoomScene({ ...furnished, hueChannels: lamps }, { ...OPTIONS, lampFamilies: new Map([[0, "floorLamp"], [1, "playBar"]]) });
    let fixtures = 0;
    scene.scene.traverse((object) => {
      if ((object as { isMesh?: boolean }).isMesh || (object as { isPoints?: boolean }).isPoints) fixtures += 1;
    });
    disposeScene(scene.scene);
    expect(fixtures).toBe(bulbs);
  });

  it("draws the same number of objects for two lamps as for twelve", () => {
    // Lamps near no wall, so neither set adds a wall wash the other lacks.
    const lamp = (i: number) => ({ channelIndex: i, x: (i % 4) * 0.1 - 0.15, y: Math.floor(i / 4) * 0.1 - 0.1, z: 0.3, zOrigin: "bridge" as const });
    const two = drawables({ ...furnished, hueChannels: [0, 1].map(lamp) });
    const twelve = drawables({ ...furnished, hueChannels: Array.from({ length: 12 }, (_, i) => lamp(i)) });
    expect(twelve).toBe(two);
  });
});

describe("buildRoomScene — wall washes", () => {
  it("hides a wall's wash while that wall is cut, and shows it again after", () => {
    // Only a lamp past the real lights' count washes a wall: the seventh, against the TV wall.
    const middle = Array.from({ length: LAMP_LIGHTS }, (_, i) => ({ channelIndex: i, x: i * 0.05, y: 0, z: 0, zOrigin: "bridge" as const }));
    const hueChannels = [...middle, { channelIndex: LAMP_LIGHTS, x: 0, y: 0.95, z: 0, zOrigin: "bridge" as const }];
    const room = buildRoomScene({ ...DEFAULT_ROOM_MAP, hueChannels }, OPTIONS);
    // Pools and washes are both instanced planes, the pool added first.
    const instances: InstancedMesh[] = [];
    room.scene.traverse((object) => {
      if (object instanceof InstancedMesh && object.geometry.type === "PlaneGeometry") instances.push(object);
    });
    const scaleOf = (mesh: InstancedMesh) => {
      const m = new Matrix4();
      mesh.getMatrixAt(0, m);
      return new Vector3().setFromMatrixScale(m).x;
    };
    expect(instances).toHaveLength(2);
    const wash = instances[1] as InstancedMesh;
    const visible = scaleOf(wash);
    expect(visible).toBeGreaterThan(0);

    // The camera on the TV wall's outer side looks through it: that wall is cut.
    expect(room.cutWalls(new Vector3(0, 0, -1))).toBe(true);
    expect(scaleOf(wash)).toBe(0);
    expect(room.cutWalls(new Vector3(0, 0, 1))).toBe(true);
    expect(scaleOf(wash)).toBeCloseTo(visible, 6);
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

describe("buildRoomScene — an outline that is not a rectangle", () => {
  // A 4 × 4 m room with its back-right quarter cut away.
  const L = [
    { x: 0, y: 0 },
    { x: 4, y: 0 },
    { x: 4, y: 2 },
    { x: 2, y: 2 },
    { x: 2, y: 4 },
    { x: 0, y: 4 },
  ];
  const room: RoomMapConfig = { ...DEFAULT_ROOM_MAP, dimensions: { widthMeters: 4, depthMeters: 4, heightMeters: 2.5 } };
  const walls = (scene: { traverse: (fn: (o: unknown) => void) => void }) => {
    const found: Mesh[] = [];
    scene.traverse((o) => {
      if (o instanceof Mesh && o.geometry instanceof BoxGeometry) found.push(o);
    });
    return found;
  };

  it("stands a wall on every edge, and none inside the room at the corner it turns in at", () => {
    const rectangle = buildRoomScene(room, OPTIONS);
    expect(walls(rectangle.scene)).toHaveLength(4);
    disposeScene(rectangle.scene);

    const shaped = buildRoomScene({ ...room, footprint: L }, OPTIONS);
    const built = walls(shaped.scene);
    expect(built).toHaveLength(6);
    // The inner corner is the scene's origin; the wall along x that ends there must not reach past
    // it into the room (x < 0 at z just above 0).
    for (const wall of built) {
      wall.geometry.computeBoundingBox();
      const box = wall.geometry.boundingBox!.clone().translate(wall.position);
      const intoRoom = box.min.x < -0.001 && box.max.x > -0.001 && box.min.z < 0.05 && box.max.z > 0.0005 && box.max.z < 0.2;
      expect(intoRoom).toBe(false);
    }
    disposeScene(shaped.scene);
  });
});

describe("buildRoomScene — picking and the selection mark", () => {
  it("offers every light, piece and the screen to a click, by its room map id", () => {
    const room = buildRoomScene(furnished, OPTIONS);
    expect(room.pickables.map((p) => p.id).sort()).toEqual(["furniture-chair", "furniture-sofa", "hue-0", "hue-1", "tv"]);
    expect(room.pickables.find((p) => p.id === "furniture-chair")?.angle).toBeCloseTo(Math.PI / 2);
    disposeScene(room.scene);
  });

  // A strip was listed in the dock and could be picked nowhere in the room.
  it("offers a strip behind the screen at the screen, and one along a wall where it runs", () => {
    const strips = [
      { stripId: "behind", startX: furnished.tvAnchor!.x, startY: furnished.tvAnchor!.y, endX: furnished.tvAnchor!.x + furnished.tvAnchor!.width, endY: furnished.tvAnchor!.y, ledCount: 60 },
      { stripId: "wall", startX: 0.2, startY: 3.5, endX: 2.2, endY: 3.5, ledCount: 60 },
    ];
    const room = buildRoomScene({ ...furnished, usbStrips: strips }, OPTIONS);
    const ids = room.pickables.map((p) => p.id);
    expect(ids).toContain("usb-behind");
    expect(ids).toContain("usb-wall");
    const behind = room.pickables.find((p) => p.id === "usb-behind")!;
    const tv = room.pickables.find((p) => p.id === "tv")!;
    expect(behind.centre).toEqual(tv.centre);
    disposeScene(room.scene);
  });

  it("moves the mark without adding to the scene, and reports only a change", () => {
    const room = buildRoomScene(furnished, OPTIONS);
    const count = () => {
      let n = 0;
      room.scene.traverse(() => (n += 1));
      return n;
    };
    expect(room.select("hue-0")).toBe(true);
    const marked = count();
    expect(room.select("hue-0")).toBe(false);
    expect(room.select("furniture-sofa")).toBe(true);
    expect(count()).toBe(marked);
    expect(room.select("furniture-gone")).toBe(true);
    expect(room.select(null)).toBe(false);
    disposeScene(room.scene);
  });

  it("frees the floor outline a selection made, with the scene", () => {
    const room = buildRoomScene(furnished, OPTIONS);
    room.select("furniture-sofa");
    const outlines: BufferGeometry[] = [];
    room.scene.traverse((o) => {
      if (o instanceof Mesh && o.geometry.type === "ShapeGeometry") outlines.push(o.geometry);
    });
    expect(outlines).toHaveLength(1);
    const dispose = vi.spyOn(outlines[0]!, "dispose");
    disposeScene(room.scene);
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});

describe("buildRoomScene — mood", () => {
  // The TV's backlight went dark with the lights while a strip along a wall stayed lit.
  it("puts a strip along a wall out with the lamps, and lights it in their colour", () => {
    const config: RoomMapConfig = {
      ...DEFAULT_ROOM_MAP,
      tvAnchor: undefined,
      usbStrips: [{ stripId: "wall", startX: 0.5, startY: 3.5, endX: 3.5, endY: 3.5, ledCount: 60 }],
    };
    const room = buildRoomScene(config, OPTIONS);
    const bar = stripBar(room.scene);
    expect(bar).toBeDefined();
    const colour = () => (bar!.material as MeshBasicMaterial).color;
    room.setMood(0xff0000, { level: 1, ambient: 1, strip: 1 });
    expect(colour().getHex()).toBe(0xff0000);
    room.setMood(0xff0000, { level: 0, ambient: 0, strip: 0 });
    expect(colour().r).toBeLessThan(0.1);
    disposeScene(room.scene);
  });

  // A strip read as a 2 cm beam with a ring round half the room; the tape is a centimetre wide.
  it("draws a strip a centimetre wide: at the skirting on a wall, flat on the floor away from one, at its own height when set", () => {
    const at = (strip: Partial<UsbStripPlacement>) => {
      const room = buildRoomScene(
        { ...DEFAULT_ROOM_MAP, tvAnchor: undefined, usbStrips: [{ stripId: "s", startX: 1, startY: 0.05, endX: 3, endY: 0.05, ledCount: 60, ...strip }] },
        OPTIONS,
      );
      const bar = stripBar(room.scene)!;
      const { height, depth } = (bar.geometry as BoxGeometry).parameters;
      const result = { y: bar.getWorldPosition(new Vector3()).y, thickest: Math.max(height, depth) };
      disposeScene(room.scene);
      return result;
    };
    expect(at({})).toEqual({ y: 0.08, thickest: 0.012 });
    expect(at({ startY: 2, endY: 2 }).y).toBeLessThan(0.01);
    expect(at({ mountHeightMeters: 2.2 }).y).toBeCloseTo(2.2);
    expect(at({ mountHeightMeters: 9 }).y).toBeLessThan(DEFAULT_ROOM_MAP.dimensions.heightMeters);
  });
});

describe("buildRoomScene — bent strips", () => {
  // A strip folded round a desk corner was drawn straight from its start to its end.
  it("draws a tape per leg with the LEDs shared out by length, and picks it as one strip on its legs", () => {
    const strip: UsbStripPlacement = { stripId: "bent", startX: 1, startY: 2, endX: 2, endY: 3, corners: [{ x: 3, y: 2 }], ledCount: 90 };
    const room = buildRoomScene({ ...DEFAULT_ROOM_MAP, tvAnchor: undefined, usbStrips: [strip] }, OPTIONS);
    const chips: InstancedMesh[] = [];
    room.scene.traverse((o) => {
      if (o instanceof InstancedMesh && (o.material as MeshBasicMaterial).toneMapped === false) chips.push(o);
    });
    // 2 m then √2 m: 90 LEDs at a 3.41 m run fall 53 and 37.
    expect(chips.map((c) => c.count)).toEqual([53, 37]);
    const picked = room.pickables.filter((p) => p.id === "usb-bent");
    expect(picked).toHaveLength(1);
    expect(picked[0]!.legs).toHaveLength(2);
    disposeScene(room.scene);
  });
});

/** The strip's lit line, the far view's whole strip. */
function stripBar(scene: Scene): Mesh | undefined {
  let found: Mesh | undefined;
  scene.updateMatrixWorld(true);
  scene.traverse((object) => {
    if (found || !(object instanceof Mesh) || object instanceof InstancedMesh || !(object.geometry instanceof BoxGeometry)) return;
    const { width, height } = object.geometry.parameters;
    if (width >= 1 && height <= 0.02 && (object.material as MeshBasicMaterial).toneMapped === false) found = object;
  });
  return found;
}
