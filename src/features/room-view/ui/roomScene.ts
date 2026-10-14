// The 3D room's scene, built from the room map. Everything here runs only while the view is on
// screen and is torn down with it (`disposeScene`). Lamp colours are placeholders until the live
// feed reaches the view.
import {
  AdditiveBlending,
  type BufferGeometry,
  DirectionalLight,
  DoubleSide,
  InstancedMesh,
  type Material,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  Scene,
  Vector3,
} from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

import { type RoomMapConfig, resolveFurnitureTop } from "@/shared/contracts/roomMap";

import { hueChannelScenePoint, roomToScene, tvMountHeight } from "../model/roomSpace";
import { contactShadow, floorParts, roomLights, WALL_THICKNESS, wallFootShade, wallGeometry } from "./scene/environment";
import { classifyFurniture, contactShade, modelTop, surfaceTop } from "../model/furnitureModel";
import type { LampFamily } from "../model/lampFamily";
import { furnitureParts } from "./scene/furniture";
import { buildGlow, type Lamp, poolTexture, radialTexture, type WallPlane } from "./scene/glow";
import { PALETTE } from "./scene/palette";
import { mergeParts, type Part, transformParts } from "./scene/parts";
import { lampFixture } from "./scene/lamps";
import { buildScreen } from "./scene/screen";

const LAMP_COLOURS = [0xffb347, 0x4fd1c5, 0xb388ff, 0xff7a59, 0x7aa2ff];
/** A wall between the camera and the room drops to this, so the room reads as a cutaway. */
const WALL_CUT_HEIGHT = 0.2;
/** Parts in these colours are metal or glass: a satin finish instead of the matte one. */
const SATIN = new Set<number>([PALETTE.metal, PALETTE.metalSoft, PALETTE.bezel, PALETTE.keyboard, PALETTE.handle]);

export interface RoomSceneOptions {
  /** The key light casts a shadow map; off leaves only the contact shadows. */
  shadows: boolean;
  /** Lambert shading instead of the standard (PBR) material — a smaller shader to compile. */
  lambert: boolean;
  /** Measuring only: a define that makes the shaders new to WebKit's cache, so they compile cold. */
  coldKey?: number;
  /** Each Hue channel's fixture by channel index; one not listed draws as a bulb. */
  lampFamilies?: ReadonlyMap<number, LampFamily>;
}

/** A piece's top as something stands on it, in the scene frame. */
interface Surface {
  x: number;
  z: number;
  /** The rotation the piece was placed with (radians), undone to test a point against it. */
  angle: number;
  hw: number;
  hd: number;
  top: number;
}

/** The highest surface under a point that is not above it: a lamp on a desk stands on the desk, one
 *  over an empty floor on the floor. */
function surfaceUnder(x: number, z: number, y: number, surfaces: readonly Surface[]): number {
  let best = 0;
  for (const s of surfaces) {
    const dx = x - s.x;
    const dz = z - s.z;
    const lx = dx * Math.cos(s.angle) + dz * Math.sin(s.angle);
    const lz = -dx * Math.sin(s.angle) + dz * Math.cos(s.angle);
    if (Math.abs(lx) <= s.hw && Math.abs(lz) <= s.hd && s.top <= y + 0.02 && s.top > best) best = s.top;
  }
  return best;
}

export interface RoomScene {
  scene: Scene;
  /** Lowers the walls standing between the camera and the room; true when anything changed. */
  cutWalls(cameraDirection: Vector3): boolean;
  /** Keeps the halos a fixed size in the room as the view zooms. */
  setPixelsPerMetre(ppm: number): void;
  /** Where to aim and how far the room reaches from it. */
  target: Vector3;
  radius: number;
}

export function buildRoomScene(config: RoomMapConfig, options: RoomSceneOptions): RoomScene {
  const dims = config.dimensions;
  const W = dims.widthMeters;
  const D = dims.depthMeters;
  const H = dims.heightMeters;
  // No background: the view's own backdrop shows through the canvas.
  const scene = new Scene();

  const lights = roomLights(W, D, H, options.shadows);
  scene.add(lights.hemisphere, lights.key, lights.fill);

  const solid = (roughness: number, metalness = 0): Material => {
    const material = options.lambert
      ? new MeshLambertMaterial({ vertexColors: true })
      : new MeshStandardMaterial({ vertexColors: true, roughness, metalness });
    if (options.coldKey !== undefined) material.defines = { SPIKE_COLD_KEY: options.coldKey };
    return material;
  };

  const floor = mergeParts(floorParts(W, D), solid(0.72), false);
  if (floor) {
    floor.castShadow = false;
    scene.add(floor);
  }

  const models = classifyFurniture(config);
  const matte: Part[] = [];
  const satin: Part[] = [];
  const shadows: BufferGeometry[] = [wallFootShade(W, D)];
  const surfaces: Surface[] = [];
  const sort = (parts: readonly Part[]) => {
    for (const part of parts) (SATIN.has(part.color) ? satin : matte).push(part);
  };
  for (const item of config.furniture) {
    const model = models.get(item.id);
    if (!model) continue;
    const centre = roomToScene(item.x + item.width / 2, item.y + item.height / 2, 0, dims);
    const place = new Matrix4()
      .makeTranslation(centre.x, 0, centre.z)
      .multiply(new Matrix4().makeRotationY(-((item.rotation ?? 0) * Math.PI) / 180));
    const parts = furnitureParts(item, model);
    transformParts(parts, place);
    sort(parts);
    shadows.push(contactShadow(item.width / 2, item.height / 2, contactShade(model), place));
    const storedTop = resolveFurnitureTop(item);
    const scale = storedTop !== undefined ? storedTop / modelTop(model) : 1;
    const top = surfaceTop(model) * scale;
    if (top > 0) {
      surfaces.push({
        x: centre.x,
        z: centre.z,
        angle: ((item.rotation ?? 0) * Math.PI) / 180,
        hw: item.width / 2,
        hd: item.height / 2,
        top,
      });
    }
  }

  // Hue lights as their fixtures; the bodies join the furniture's meshes, the lit parts the glow.
  const mount = tvMountHeight(config.tvAnchor, dims);
  const lamps: Lamp[] = config.hueChannels.map((channel, i) => {
    const point = hueChannelScenePoint(channel, config.zones, dims, mount);
    const family = options.lampFamilies?.get(channel.channelIndex) ?? "bulb";
    const fixture = lampFixture(family, point, surfaceUnder(point.x, point.z, point.y, surfaces), H);
    sort(fixture.body);
    return { at: fixture.glow.at, radii: fixture.glow.radii, color: LAMP_COLOURS[i % LAMP_COLOURS.length] ?? 0xffb347 };
  });

  const screen = buildScreen(config, models);
  if (screen) {
    sort(screen.parts);
    for (const f of screen.footprints) shadows.push(contactShadow(f.hw, f.hd, f.shade, new Matrix4().makeTranslation(f.x, 0, f.z)));
    scene.add(new Mesh(screen.panel, new MeshBasicMaterial({ vertexColors: true })));
  }
  const matteMesh = mergeParts(matte, solid(0.82));
  if (matteMesh) scene.add(matteMesh);
  const satinMesh = mergeParts(satin, solid(0.38, 0.25));
  if (satinMesh) scene.add(satinMesh);
  {
    const merged = mergeGeometries(shadows);
    for (const g of shadows) g.dispose();
    if (merged) {
      scene.add(
        new Mesh(
          merged,
          new MeshBasicMaterial({
            vertexColors: true,
            transparent: true,
            depthWrite: false,
            polygonOffset: true,
            polygonOffsetFactor: -2,
            side: DoubleSide,
          }),
        ),
      );
    }
  }

  // Walls: one mesh each, so a cut is a scale change rather than a rebuild. `outward` points away
  // from the room; a wall whose outward side faces the camera is the one to cut.
  const wallMaterial = solid(0.95);
  const sides = [
    { length: W, outward: new Vector3(0, 0, -1) },
    { length: W, outward: new Vector3(0, 0, 1) },
    { length: D, outward: new Vector3(-1, 0, 0) },
    { length: D, outward: new Vector3(1, 0, 0) },
  ];
  const walls = sides.map(({ length, outward }) => {
    const alongX = outward.z !== 0;
    const mesh = new Mesh(wallGeometry(alongX, alongX ? length + WALL_THICKNESS * 2 : length), wallMaterial);
    mesh.position.set(outward.x * (W / 2 + WALL_THICKNESS / 2), 0, outward.z * (D / 2 + WALL_THICKNESS / 2));
    mesh.scale.y = H;
    mesh.receiveShadow = true;
    scene.add(mesh);
    return { mesh, outward };
  });
  const planes: WallPlane[] = sides.map(({ length, outward }) => ({
    normal: outward.clone().negate(),
    offset: outward.z !== 0 ? D / 2 : W / 2,
    halfLength: length / 2,
  }));

  const texture = radialTexture(256, "rgba(255,255,255,1)", "rgba(255,255,255,0)");
  const surface = poolTexture(128);
  const glow = buildGlow(lamps, planes, H, texture, surface);
  if (glow) scene.add(...glow.objects);
  else surface.dispose();

  const backlight = screen?.layout.backlight;
  if (backlight) {
    const plane = new Mesh(
      new PlaneGeometry(backlight.width, backlight.height),
      new MeshBasicMaterial({
        map: texture,
        color: 0xffb347,
        transparent: true,
        depthWrite: false,
        toneMapped: false,
        blending: AdditiveBlending,
      }),
    );
    plane.position.set(backlight.x, backlight.y, backlight.z);
    scene.add(plane);
  } else if (!glow) {
    texture.dispose();
  }

  return {
    scene,
    target: new Vector3(0, H * 0.3, 0),
    radius: Math.hypot(W, D, H) / 2,
    cutWalls(direction: Vector3) {
      let changed = false;
      const cut = walls.map(({ mesh, outward }) => {
        const isCut = outward.dot(direction) > 0.05;
        const height = isCut ? WALL_CUT_HEIGHT : H;
        if (mesh.scale.y !== height) {
          mesh.scale.y = height;
          changed = true;
        }
        return isCut;
      });
      if (glow?.setCutWalls(cut)) changed = true;
      return changed;
    },
    setPixelsPerMetre(ppm: number) {
      glow?.setPixelsPerMetre(ppm);
    },
  };
}

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
