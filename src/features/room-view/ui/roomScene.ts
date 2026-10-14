// The 3D room's scene, built from the room map. Everything here runs only while the view is on
// screen and is torn down with it (`disposeScene`). Spike: placeholder lamp colours, no live feed.
import {
  AdditiveBlending,
  BoxGeometry,
  BufferAttribute,
  type BufferGeometry,
  CanvasTexture,
  Color,
  DirectionalLight,
  DoubleSide,
  HemisphereLight,
  InstancedMesh,
  type Material,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  MeshStandardMaterial,
  NormalBlending,
  Object3D,
  PlaneGeometry,
  Scene,
  SphereGeometry,
  Sprite,
  SpriteMaterial,
  type Texture,
  Vector3,
} from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

import type { FurniturePlacement, RoomMapConfig } from "@/shared/contracts/roomMap";

import { hueChannelScenePoint, roomToScene, tvMountHeight, tvScreenCentre } from "../model/roomSpace";

const PALETTE = {
  floor: 0xc9b49a,
  wall: 0xe8e1d8,
  wood: 0xa87c5a,
  fabric: 0x7d8b99,
  cushion: 0x95a3b1,
  dark: 0x2e2b2a,
  screen: 0x15171a,
};
const LAMP_COLOURS = [0xffb347, 0x4fd1c5, 0xb388ff, 0xff7a59, 0x7aa2ff];
const WALL_THICKNESS = 0.08;
/** A wall between the camera and the room drops to this, so the room reads as a cutaway. */
const WALL_CUT_HEIGHT = 0.2;

type Part = { geometry: BufferGeometry; color: number };

/** One piece of furniture as parts in its own frame: x across its width, z across its depth,
 *  origin at its footprint's centre on the floor. Unrotated, a seat faces the TV wall (−z), as the
 *  room templates place it. */
function furnitureParts(item: FurniturePlacement): Part[] {
  const w = Math.max(item.width, 0.2);
  const d = Math.max(item.height, 0.2);
  const box = (bw: number, bh: number, bd: number, x: number, y: number, z: number, color: number): Part => {
    const geometry = new RoundedBoxGeometry(bw, bh, bd, 2, Math.min(0.04, bw / 4, bh / 4, bd / 4));
    geometry.translate(x, y + bh / 2, z);
    return { geometry, color };
  };
  switch (item.type) {
    case "sofa": {
      const arm = Math.min(0.2, w * 0.12);
      const parts = [
        box(w, 0.42, d, 0, 0, 0, PALETTE.fabric),
        box(w, 0.4, Math.min(0.22, d * 0.3), 0, 0.42, d / 2 - Math.min(0.11, d * 0.15), PALETTE.fabric),
        box(arm, 0.22, d, -w / 2 + arm / 2, 0.42, 0, PALETTE.fabric),
        box(arm, 0.22, d, w / 2 - arm / 2, 0.42, 0, PALETTE.fabric),
      ];
      const seats = Math.max(1, Math.round((w - 2 * arm) / 0.7));
      const seatW = (w - 2 * arm) / seats;
      for (let i = 0; i < seats; i++) {
        parts.push(box(seatW * 0.94, 0.12, d * 0.62, -w / 2 + arm + seatW * (i + 0.5), 0.42, -d * 0.12, PALETTE.cushion));
      }
      return parts;
    }
    case "table": {
      const legs = [-1, 1].flatMap((sx) =>
        [-1, 1].map((sz) => box(0.05, 0.7, 0.05, sx * (w / 2 - 0.06), 0, sz * (d / 2 - 0.06), PALETTE.wood)),
      );
      return [box(w, 0.05, d, 0, 0.7, 0, PALETTE.wood), ...legs];
    }
    case "chair": {
      const legs = [-1, 1].flatMap((sx) =>
        [-1, 1].map((sz) => box(0.04, 0.45, 0.04, sx * (w / 2 - 0.04), 0, sz * (d / 2 - 0.04), PALETTE.wood)),
      );
      return [
        box(w, 0.06, d, 0, 0.45, 0, PALETTE.fabric),
        box(w, 0.45, 0.06, 0, 0.51, d / 2 - 0.03, PALETTE.fabric),
        ...legs,
      ];
    }
    default:
      return [box(w, 0.8, d, 0, 0, 0, PALETTE.wood)];
  }
}

/** Parts painted by vertex colour and merged, so the whole room is one draw call. */
function mergedSolid(parts: Part[], material: Material): Mesh | null {
  if (parts.length === 0) return null;
  const prepared = parts.map(({ geometry, color }) => {
    const flat = geometry.index ? geometry.toNonIndexed() : geometry;
    flat.deleteAttribute("uv");
    const c = new Color(color);
    const count = flat.getAttribute("position").count;
    const colors = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) colors.set([c.r, c.g, c.b], i * 3);
    flat.setAttribute("color", new BufferAttribute(colors, 3));
    if (flat !== geometry) geometry.dispose();
    return flat;
  });
  const merged = mergeGeometries(prepared);
  for (const g of prepared) g.dispose();
  if (!merged) return null;
  const mesh = new Mesh(merged, material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

function radialTexture(size: number, inner: string, outer: string): CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    g.addColorStop(0, inner);
    g.addColorStop(1, outer);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
  }
  return new CanvasTexture(canvas);
}

/** Flat quads lying on the floor, one draw call for all of them. */
function decals<T>(
  items: readonly T[],
  texture: Texture,
  additive: boolean,
  opacity: number,
  place: (item: T, m: Matrix4) => void,
  color?: (item: T, index: number) => number,
): InstancedMesh {
  const material = new MeshBasicMaterial({
    map: texture,
    transparent: true,
    depthWrite: false,
    opacity,
    toneMapped: false,
    blending: additive ? AdditiveBlending : NormalBlending,
    color: additive ? 0xffffff : 0x000000,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    side: DoubleSide,
  });
  const mesh = new InstancedMesh(new PlaneGeometry(1, 1), material, items.length);
  const m = new Matrix4();
  items.forEach((item, i) => {
    place(item, m);
    mesh.setMatrixAt(i, m);
    if (color) mesh.setColorAt(i, new Color(color(item, i)));
  });
  return mesh;
}

export interface RoomSceneOptions {
  /** The key light casts a shadow map; off leaves only the contact decals. */
  shadows: boolean;
  /** Lambert shading instead of the standard (PBR) material — a smaller shader to compile. */
  lambert: boolean;
  /** Measuring only: a define that makes the shaders new to WebKit's cache, so they compile cold. */
  coldKey?: number;
}

export interface RoomScene {
  scene: Scene;
  /** Lowers the walls standing between the camera and the room; true when anything changed. */
  cutWalls(cameraDirection: Vector3): boolean;
  /** Where to aim and how far the room reaches from it. */
  target: Vector3;
  radius: number;
}

export function buildRoomScene(config: RoomMapConfig, options: RoomSceneOptions): RoomScene {
  const dims = config.dimensions;
  const W = dims.widthMeters;
  const D = dims.depthMeters;
  const H = dims.heightMeters;
  const scene = new Scene();
  scene.background = new Color(0x1b1a1f);

  scene.add(new HemisphereLight(0xfff4e6, 0x3a3230, 1.2));
  const key = new DirectionalLight(0xffe2c0, 2.0);
  key.position.set(-0.6 * W, 1.2 * H + 2, 0.4 * D);
  key.castShadow = options.shadows;
  key.shadow.mapSize.set(1024, 1024);
  key.shadow.radius = 3;
  key.shadow.bias = -0.0005;
  key.shadow.normalBias = 0.02;
  const half = Math.max(W, D) * 0.75;
  Object.assign(key.shadow.camera, { left: -half, right: half, top: half, bottom: -half, near: 0.1, far: 30 });
  scene.add(key);

  const solid = options.lambert
    ? new MeshLambertMaterial({ vertexColors: true })
    : new MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0 });
  if (options.coldKey !== undefined) solid.defines = { SPIKE_COLD_KEY: options.coldKey };

  const room: Part[] = [{ geometry: new BoxGeometry(W, 0.04, D).translate(0, -0.02, 0), color: PALETTE.floor }];
  const furniture: Part[] = [];
  for (const item of config.furniture) {
    const centre = roomToScene(item.x + item.width / 2, item.y + item.height / 2, 0, dims);
    const turn = new Matrix4().makeRotationY(-((item.rotation ?? 0) * Math.PI) / 180);
    const move = new Matrix4().makeTranslation(centre.x, 0, centre.z);
    for (const part of furnitureParts(item)) {
      part.geometry.applyMatrix4(turn).applyMatrix4(move);
      furniture.push(part);
    }
  }
  const tv = config.tvAnchor;
  let tvCentre: ReturnType<typeof tvScreenCentre> | null = null;
  if (tv) {
    tvCentre = tvScreenCentre(tv, dims);
    const screenH = tv.width * 0.5625;
    furniture.push({
      geometry: new RoundedBoxGeometry(tv.width, screenH, 0.05, 1, 0.01).translate(tvCentre.x, tvCentre.y, tvCentre.z),
      color: PALETTE.screen,
    });
    if (tvCentre.y - screenH / 2 > 0.5) {
      const unit = new RoundedBoxGeometry(tv.width * 1.15, 0.45, 0.4, 2, 0.03);
      furniture.push({ geometry: unit.translate(tvCentre.x, 0.225, tvCentre.z + 0.15), color: PALETTE.wood });
    }
  }
  const roomMesh = mergedSolid(room, solid);
  if (roomMesh) {
    roomMesh.castShadow = false;
    scene.add(roomMesh);
  }
  const furnitureMesh = mergedSolid(furniture, solid);
  if (furnitureMesh) scene.add(furnitureMesh);

  // Walls: one mesh each, so a cut is a scale change rather than a rebuild.
  const wallMaterial = options.lambert
    ? new MeshLambertMaterial({ color: PALETTE.wall })
    : new MeshStandardMaterial({ color: PALETTE.wall, roughness: 0.95 });
  if (options.coldKey !== undefined) wallMaterial.defines = { SPIKE_COLD_KEY: options.coldKey };
  const sides = [
    { length: W, nx: 0, nz: -1 },
    { length: W, nx: 0, nz: 1 },
    { length: D, nx: -1, nz: 0 },
    { length: D, nx: 1, nz: 0 },
  ];
  const walls = sides.map(({ length, nx, nz }) => {
    const acrossX = nz !== 0;
    const span = acrossX ? length + WALL_THICKNESS * 2 : length;
    const geometry = new BoxGeometry(acrossX ? span : WALL_THICKNESS, 1, acrossX ? WALL_THICKNESS : span);
    geometry.translate(0, 0.5, 0);
    const mesh = new Mesh(geometry, wallMaterial);
    mesh.position.set(nx * (W / 2 + WALL_THICKNESS / 2), 0, nz * (D / 2 + WALL_THICKNESS / 2));
    mesh.scale.y = H;
    mesh.receiveShadow = true;
    scene.add(mesh);
    return { mesh, normal: new Vector3(nx, 0, nz) };
  });

  const mount = tvMountHeight(config.tvAnchor, dims);
  const lamps = config.hueChannels.map((channel) => hueChannelScenePoint(channel, config.zones, dims, mount));
  const glow = radialTexture(256, "rgba(255,255,255,1)", "rgba(255,255,255,0)");
  const shade = radialTexture(128, "rgba(0,0,0,1)", "rgba(0,0,0,0)");
  const lampColour = (i: number) => LAMP_COLOURS[i % LAMP_COLOURS.length] ?? 0xffb347;
  if (lamps.length > 0) {
    const bulbs = new InstancedMesh(
      new SphereGeometry(0.06, 16, 12),
      new MeshBasicMaterial({ toneMapped: false }),
      lamps.length,
    );
    const m = new Matrix4();
    lamps.forEach((p, i) => {
      bulbs.setMatrixAt(i, m.makeTranslation(p.x, Math.max(p.y, 0.08), p.z));
      bulbs.setColorAt(i, new Color(lampColour(i)));
    });
    scene.add(bulbs);
    scene.add(
      decals(lamps, glow, true, 0.8, (p, mm) => {
        const size = 0.9 + Math.min(p.y, H) * 0.6;
        mm.compose(new Vector3(p.x, 0.005, p.z), FLAT, new Vector3(size, size, 1));
      }, (_, i) => lampColour(i)),
    );
    lamps.forEach((p, i) => {
      const halo = new Sprite(
        new SpriteMaterial({
          map: glow,
          color: lampColour(i),
          transparent: true,
          depthWrite: false,
          toneMapped: false,
          blending: AdditiveBlending,
        }),
      );
      halo.scale.set(0.5, 0.5, 1);
      halo.position.set(p.x, Math.max(p.y, 0.08), p.z);
      scene.add(halo);
    });
  }
  if (tv && tvCentre) {
    const backlight = new Mesh(
      new PlaneGeometry(tv.width * 1.8, tv.width * 0.5625 * 1.9),
      new MeshBasicMaterial({ map: glow, color: 0xffb347, transparent: true, depthWrite: false, toneMapped: false, blending: AdditiveBlending }),
    );
    backlight.position.set(tvCentre.x, tvCentre.y, -D / 2 + 0.01);
    scene.add(backlight);
  }

  const footprints = config.furniture;
  if (footprints.length > 0) {
    scene.add(
      decals(footprints, shade, false, 0.4, (f, mm) => {
        const c = roomToScene(f.x + f.width / 2, f.y + f.height / 2, 0, dims);
        mm.compose(new Vector3(c.x, 0.004, c.z), FLAT, new Vector3(f.width * 1.3, f.height * 1.3, 1));
      }),
    );
  }

  return {
    scene,
    target: new Vector3(0, H * 0.3, 0),
    radius: Math.hypot(W, D, H) / 2,
    cutWalls(direction: Vector3) {
      let changed = false;
      for (const { mesh, normal } of walls) {
        const height = normal.dot(direction) > 0.05 ? WALL_CUT_HEIGHT : H;
        if (mesh.scale.y !== height) {
          mesh.scale.y = height;
          changed = true;
        }
      }
      return changed;
    },
  };
}

const FLAT = new Object3D().rotateX(-Math.PI / 2).quaternion.clone();

/** Frees every geometry, material, texture, instance buffer and shadow map the scene holds; the
 *  renderer is the caller's. */
export function disposeScene(scene: Scene): void {
  const seen = new Set<object>();
  scene.traverse((object) => {
    if (object instanceof InstancedMesh || object instanceof DirectionalLight) object.dispose();
    const mesh = object as Mesh;
    if (mesh.geometry && !seen.has(mesh.geometry)) {
      seen.add(mesh.geometry);
      mesh.geometry.dispose();
    }
    const materials = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
    for (const material of materials) {
      if (seen.has(material)) continue;
      seen.add(material);
      const map = (material as MeshBasicMaterial).map;
      if (map && !seen.has(map)) {
        seen.add(map);
        map.dispose();
      }
      material.dispose();
    }
  });
  scene.clear();
}

