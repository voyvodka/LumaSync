import { Box3, BoxGeometry, type BufferGeometry, DirectionalLight, HemisphereLight, InstancedMesh, type Material, Matrix4, Mesh, type MeshBasicMaterial, type Scene, type Texture, Vector3 } from "three";
import { afterEach, describe, expect, it, vi } from "vitest";

import { furnitureObjectId, hueChannelObjectId, TV_ANCHOR_OBJECT_ID } from "@/features/room-map/model/objectId";
import { DEFAULT_ROOM_MAP, type RoomMapConfig, type UsbStripPlacement } from "@/shared/contracts/roomMap";

import { hueChannelScenePoint, roomToScene, tvMountHeight } from "../../model/roomSpace";
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

describe("buildRoomScene — structures", () => {
  const built: RoomMapConfig = {
    ...DEFAULT_ROOM_MAP,
    structures: [
      { id: "w", kind: "window", x: 2.5, y: 0, width: 1.2, sillMeters: 0.9, heightMeters: 1.2 },
      { id: "b", kind: "beam", x1: 1, y1: 0, x2: 1, y2: 4, width: 0.2, dropMeters: 0.3 },
      { id: "c", kind: "column", x: 4, y: 3, width: 0.4, depth: 0.4 },
    ],
  };
  const meshes = (scene: Scene) => {
    const out: Mesh[] = [];
    scene.traverse((object) => {
      if (object instanceof Mesh && !(object instanceof InstancedMesh)) out.push(object);
    });
    return out;
  };
  // Points of what is drawn on the TV wall's face above the sill: the window, in the finish meshes.
  const windowPoints = (scene: Scene) =>
    meshes(scene)
      .filter((mesh) => mesh.scale.y === 1)
      .reduce((n, mesh) => {
        const position = mesh.geometry.getAttribute("position");
        for (let i = 0; i < position.count; i++) if (position.getY(i) > 1 && Math.abs(position.getX(i)) < 0.7 && Math.abs(position.getZ(i) + 1.98) < 0.04) n += 1;
        return n;
      }, 0);

  it("hides a cut wall's window and a column in the camera's line, keeps a beam while one wall under it stands, and brings them back", () => {
    const room = buildRoomScene(built, OPTIONS);
    const beam = meshes(room.scene).find((mesh) => {
      const box = new Box3().setFromObject(mesh);
      return box.getSize(new Vector3()).z > 3.9 && box.min.y > 1;
    })!;
    const column = meshes(room.scene).find((mesh) => Math.abs(mesh.position.x - 1.5) < 1e-6 && Math.abs(mesh.position.z - 1) < 1e-6)!;
    const standing = column.scale.y;
    expect(windowPoints(room.scene)).toBeGreaterThan(0);
    expect(beam.visible).toBe(true);

    room.cutWalls(new Vector3(0.3, 0, -1).normalize());
    expect(windowPoints(room.scene)).toBe(0);
    expect(beam.visible).toBe(true);
    expect(column.scale.y).toBe(standing);

    room.cutWalls(new Vector3(1, 0, 1).normalize());
    expect(windowPoints(room.scene)).toBeGreaterThan(0);
    expect(column.scale.y).toBeLessThan(standing);

    // Off the camera's line, a near column stands: cut for being near, it read as a stool.
    room.cutWalls(new Vector3(1, 0, -1).normalize());
    expect(column.scale.y).toBe(standing);
    disposeScene(room.scene);
  });

  it("eases a wall down and up as the camera turns, its window gone for the whole way", () => {
    const room = buildRoomScene(built, OPTIONS);
    const tvWall = meshes(room.scene).find((mesh) => mesh.position.z < -2 && mesh.scale.y > 1)!;
    const standing = tvWall.scale.y;
    const settle = (direction: Vector3) => {
      for (let i = 0; i < 60 && room.settling(); i++) room.cutWalls(direction, 16);
    };
    const front = new Vector3(0.3, 0, -1).normalize();
    room.cutWalls(front, 16);
    expect(tvWall.scale.y).toBeLessThan(standing);
    expect(tvWall.scale.y).toBeGreaterThan(1);
    expect(room.settling()).toBe(true);
    expect(windowPoints(room.scene)).toBe(0);
    settle(front);
    expect(room.settling()).toBe(false);
    expect(tvWall.scale.y).toBeCloseTo(0.2);

    const back = new Vector3(1, 0, 1).normalize();
    room.cutWalls(back, 16);
    expect(tvWall.scale.y).toBeGreaterThan(0.2);
    expect(windowPoints(room.scene)).toBe(0);
    settle(back);
    expect(tvWall.scale.y).toBe(standing);
    expect(windowPoints(room.scene)).toBeGreaterThan(0);
    disposeScene(room.scene);
  });

  it("hides a beam once every wall it rests on is cut", () => {
    const corner: RoomMapConfig = { ...DEFAULT_ROOM_MAP, structures: [{ id: "b", kind: "beam", x1: 0, y1: 1, x2: 2, y2: 0, width: 0.2, dropMeters: 0.3 }] };
    const room = buildRoomScene(corner, OPTIONS);
    const beam = meshes(room.scene).find((mesh) => new Box3().setFromObject(mesh).min.y > 1 && mesh.scale.y === 1 && mesh.geometry.getAttribute("position").count === 24)!;
    room.cutWalls(new Vector3(-1, 0, 0));
    expect(beam.visible).toBe(true);
    room.cutWalls(new Vector3(-1, 0, -1).normalize());
    expect(beam.visible).toBe(false);
    disposeScene(room.scene);
  });

  // The walls stood at 70% of a 2.5 m room, 1.75 m: a window 0.9 + 1.2 m tall ran through their top.
  it("stands the walls above the tallest window, up to 85% of the ceiling", () => {
    const room = buildRoomScene(built, OPTIONS);
    const column = meshes(room.scene).find((mesh) => Math.abs(mesh.position.x - 1.5) < 1e-6)!;
    expect(column.scale.y).toBeCloseTo(2.125);
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

  it("lights an unlit room from night to day by its ambient light, a room with no lamps at its evening by default", () => {
    const off = { level: 0, ambient: 0, strip: 0 };
    const hemi = (config: RoomMapConfig, daylight: number) => {
      const room = buildRoomScene(config, OPTIONS);
      room.setMood(null, { ...off, daylight });
      let intensity = 0;
      room.scene.traverse((object) => {
        if (object instanceof HemisphereLight) intensity = object.intensity;
      });
      disposeScene(room.scene);
      return intensity;
    };
    const bare = { ...furnished, hueChannels: [] };
    expect(hemi(bare, 0.35)).toBeCloseTo(0.8, 5);
    expect(hemi(bare, 0)).toBeLessThan(0.8);
    expect(hemi(bare, 1)).toBeGreaterThan(0.8);
    expect(hemi(furnished, 0)).toBeLessThan(hemi(furnished, 0.35));
    expect(hemi(furnished, 0.35)).toBeLessThan(hemi(bare, 0.35));
    expect(hemi(furnished, 1)).toBeGreaterThan(hemi(furnished, 0.35));
  });

  // The house has no ceiling, so a pendant's canopy threw its shadow on the floor as a blot.
  it("casts no shadow from a ceiling light's canopy, while the furniture still casts one", () => {
    const pendant = { channelIndex: 0, x: 0, y: 0, z: 0.9, zOrigin: "bridge" as const };
    const room = buildRoomScene({ ...furnished, hueChannels: [pendant] }, { ...OPTIONS, lampFamilies: new Map([[0, "pendant"]]) });
    const meshes: Mesh[] = [];
    room.scene.traverse((object) => {
      if (object instanceof Mesh && !(object instanceof InstancedMesh)) meshes.push(object);
    });
    const top = (mesh: Mesh) => new Box3().setFromBufferAttribute(mesh.geometry.getAttribute("position") as never).max.y;
    const ceiling = DEFAULT_ROOM_MAP.dimensions.heightMeters ?? 2.5;
    const canopy = meshes.find((mesh) => !mesh.castShadow && Math.abs(top(mesh) - ceiling) < 0.01);
    expect(canopy).toBeDefined();
    expect(meshes.filter((mesh) => mesh.castShadow && top(mesh) > 0.3 && top(mesh) < 1.5).length).toBeGreaterThan(0);
    disposeScene(room.scene);
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

  // A Play bar's glow sits off its mount: a carry landed at the glow walked it 2 cm a time.
  it("says where a one-sided lamp is stored, apart from the glow it is picked by", () => {
    const bar = [{ channelIndex: 0, x: 0.2, y: 0, z: 0.3, zOrigin: "bridge" as const }];
    const room = buildRoomScene({ ...furnished, hueChannels: bar }, { ...OPTIONS, lampFamilies: new Map([[0, "playBar" as const]]) });
    const lamp = room.pickables.find((p) => p.id === "hue-0")!;
    const point = hueChannelScenePoint(bar[0]!, furnished.zones, furnished.dimensions, tvMountHeight(furnished.tvAnchor, furnished.dimensions));
    expect(lamp.stored?.x).toBeCloseTo(point.x);
    expect(lamp.stored?.z).toBeCloseTo(point.z);
    expect(Math.hypot(lamp.centre.x - point.x, lamp.centre.z - point.z)).toBeGreaterThan(0.01);
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
      if (o instanceof Mesh && o.geometry.name === "floorBand") outlines.push(o.geometry);
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
    room.setMood(0xff0000, { level: 1, ambient: 1, strip: 1, daylight: 0.35 });
    expect(colour().getHex()).toBe(0xff0000);
    room.setMood(0xff0000, { level: 0, ambient: 0, strip: 0, daylight: 0.35 });
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

describe("buildRoomScene — lifting a carried piece", () => {
  const positions = (scene: Scene) => {
    const arrays: Float32Array[] = [];
    scene.traverse((object) => {
      const geometry = (object as Mesh).geometry as BufferGeometry | undefined;
      const position = geometry?.getAttribute("position");
      if (position) arrays.push(Float32Array.from(position.array as Float32Array));
    });
    return arrays;
  };

  it("takes the piece out to follow the pointer, and puts it back as it was", () => {
    const room = buildRoomScene(furnished, OPTIONS);
    const before = positions(room.scene);
    const children = room.scene.children.length;
    const lifted = room.lift(furnitureObjectId("sofa"));
    expect(lifted).not.toBeNull();
    const group = room.scene.children[room.scene.children.length - 1]!;
    const start = new Box3().setFromObject(group).getCenter(new Vector3());
    const centre = roomToScene(2, 2.95, 0, furnished.dimensions);
    expect(start.x).toBeCloseTo(centre.x, 1);
    expect(start.z).toBeCloseTo(centre.z, 1);

    lifted!.moveTo(centre.x + 1, centre.z - 0.5);
    const moved = new Box3().setFromObject(group).getCenter(new Vector3());
    expect(moved.x - start.x).toBeCloseTo(1, 5);
    expect(moved.z - start.z).toBeCloseTo(-0.5, 5);

    lifted!.restore();
    expect(room.scene.children.length).toBe(children);
    expect(positions(room.scene)).toEqual(before);
    disposeScene(room.scene);
  });

  it("carries a desk's monitor with the desk, and a sofa alone", () => {
    const desk = { id: "desk", type: "table" as const, variant: "desk" as const, x: 1, y: 0, width: 1.6, height: 0.7 };
    const config: RoomMapConfig = { ...furnished, furniture: [...furnished.furniture, desk], tvAnchor: { x: 1.5, y: 0.2, width: 0.6, height: 0.05 } };
    const room = buildRoomScene(config, OPTIONS);
    const withDesk = room.lift(furnitureObjectId("desk"));
    expect(withDesk?.riders).toEqual([TV_ANCHOR_OBJECT_ID]);
    withDesk!.restore();
    const sofa = room.lift(furnitureObjectId("sofa"));
    expect(sofa?.riders).toEqual([]);
    sofa!.restore();
    // The inspector slides the desk alone: its monitor stays in the config where it was.
    const alone = room.lift(furnitureObjectId("desk"), false);
    expect(alone?.riders).toEqual([]);
    expect(alone?.pivot).toEqual({ x: expect.any(Number), z: expect.any(Number) });
    alone!.restore();
    disposeScene(room.scene);
  });

  it("moves the screen with its panel, and leaves a lamp to its frame", () => {
    const room = buildRoomScene(furnished, OPTIONS);
    const lifted = room.lift(TV_ANCHOR_OBJECT_ID);
    expect(lifted).not.toBeNull();
    const group = room.scene.children[room.scene.children.length - 1]!;
    let basic = 0;
    group.traverse((object) => {
      if ((object as Mesh).isMesh && ((object as Mesh).material as Material).type === "MeshBasicMaterial") basic += 1;
    });
    expect(basic).toBeGreaterThan(0);
    lifted!.restore();
    expect(room.lift(hueChannelObjectId(0))).toBeNull();
    disposeScene(room.scene);
  });
});
