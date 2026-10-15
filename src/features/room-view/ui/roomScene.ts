// The 3D room's scene, built from the room map. Everything here runs only while the view is on
// screen and is torn down with it (`disposeScene`). Lamp colours are placeholders until the live
// feed reaches the view.
import { lampColour } from "../model/lampColours";
import {
  AdditiveBlending,
  type BufferGeometry,
  Color,
  DoubleSide,
  InstancedMesh,
  Light,
  type Material,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  type Quaternion,
  Scene,
  Vector3,
} from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

import { furnitureObjectId, hueChannelObjectId, TV_ANCHOR_OBJECT_ID, usbStripObjectId } from "@/features/room-map/model/objectId";
import { isBacklightStrip } from "@/features/room-map/model/backlight";
import { ledsPerLeg, stripLegs } from "@/features/room-map/model/stripCorners";
import { defaultStripHeight } from "@/features/room-map/model/stripWall";
import { outsideOutline } from "@/features/room-map/model/roomFootprint";
import {
  type RoomMapConfig,
  resolveFurnitureTop,
  resolveHueFacing,
  resolveHueFixture,
  resolveRoomFootprint,
  resolveRoomSurfaces,
  resolveStripCorners,
  resolveStripMountHeight,
  stripCentre,
  stripPoints,
  stripRunLength,
} from "@/shared/contracts/roomMap";

import type { PickLeg, Pickable } from "../model/picking";
import { nearestWallFacing, roomEdges } from "../model/roomOutline";
import { hueChannelScenePoint, roomToScene, tvMountHeight } from "../model/roomSpace";
import { contactShadow, floorParts, roomLights, WALL_THICKNESS, wallFootShade, wallGeometry } from "./scene/environment";
import { classifyFurniture, contactShade, modelTop, surfaceTop } from "../model/furnitureModel";
import { type LampFamily, ONE_SIDED } from "../model/lampFamily";
import { type MoodLevels, paletteColour } from "../model/roomMood";
import { furnitureParts } from "./scene/furniture";
import { buildGlow, type Lamp, poolTexture, rimTexture, type WallPlane } from "./scene/glow";
import { PALETTE } from "./scene/palette";
import { type FinishKind, finishMaterial } from "./scene/finishes";
import { mergeParts, type Part, transformParts } from "./scene/parts";
import { lampFixture } from "./scene/lamps";
import { lampLights } from "./scene/lampLights";
import { buildScreen } from "./scene/screen";
import { buildSelectionMark } from "./scene/selection";
import { type LedTape, ledTape, TAPE_DEPTH as STRIP_DEPTH, TAPE_WIDTH as STRIP_WIDTH } from "./scene/ledTape";

const STRIP_GLOW = 0xffc46b;
const BACKLIGHT_GAIN = 1.6;
const LAMP_BOUNCE = 0.35;
const PALETTE_BOUNCE_SATURATION = 0.5;
const UNLIT_STRIP = new Color(0x2a2a2e);
/** A wall between the camera and the room drops to this, so the room reads as a cutaway. */
const WALL_CUT_HEIGHT = 0.2;
/** At full height the walls hid the far half of the floor from a raised view. */
const WALL_STANDING_SHARE = 0.7;
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
  setPixelsPerMetre(ppm: number): void;
  /** What a click can land on: every light, piece of furniture and the screen. */
  pickables: readonly Pickable[];
  /** Marks the object with this id, or nothing; true when the mark changed. */
  select(objectId: string | null): boolean;
  /** Turns what faces the camera (the selection's ring) to it; call before each draw. */
  faceCamera(cameraQuaternion: Quaternion): void;
  /** `null` keeps each lamp's own colour; a palette gives lamp i stop i mod n. */
  setMood(lampColour: number | null, levels: MoodLevels, palette?: readonly number[]): void;
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

  // The rectangle is drawn as no outline at all.
  const footprint = resolveRoomFootprint(config);
  const corners = footprint.length > 4 ? footprint : null;
  const edges = roomEdges(W, D, corners);
  const finish = resolveRoomSurfaces(config);
  const floor = mergeParts(floorParts(W, D, corners, edges, finish.floor), solid(finish.floor === "carpet" ? 0.95 : 0.72), false);
  if (floor) {
    floor.castShadow = false;
    scene.add(floor);
  }

  const models = classifyFurniture(config);
  const byFinish = new Map<FinishKind, Part[]>();
  const shadows: BufferGeometry[] = [wallFootShade(edges)];
  const surfaces: Surface[] = [];
  const pickables: Pickable[] = [];
  const sort = (parts: readonly Part[]) => {
    for (const part of parts) {
      const kind = part.finish ?? (SATIN.has(part.color) ? "satin" : "matte");
      const list = byFinish.get(kind);
      if (list) list.push(part);
      else byFinish.set(kind, [part]);
    }
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
    const height = Math.max(modelTop(model) * scale, 0.02);
    pickables.push({
      id: furnitureObjectId(item.id),
      kind: "furniture",
      centre: { x: centre.x, y: height / 2, z: centre.z },
      half: [item.width / 2, height / 2, item.height / 2],
      angle: ((item.rotation ?? 0) * Math.PI) / 180,
    });
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
    const family = resolveHueFixture(channel) ?? options.lampFamilies?.get(channel.channelIndex) ?? "bulb";
    const stored = resolveHueFacing(channel);
    const facing = !ONE_SIDED.has(family) ? 0 : stored !== undefined ? (stored * Math.PI) / 180 : nearestWallFacing(point.x, point.z, edges);
    const fixture = lampFixture(family, point, surfaceUnder(point.x, point.z, point.y, surfaces), H, facing);
    sort(fixture.body);
    const [rx, ry, rz] = fixture.glow.radii;
    pickables.push({
      id: hueChannelObjectId(channel.channelIndex),
      kind: "light",
      centre: fixture.glow.at,
      half: [rx, ry, rz],
      angle: 0,
    });
    const outside = corners !== null && outsideOutline(fixture.glow.at.x + W / 2, fixture.glow.at.z + D / 2, corners);
    return {
      at: fixture.glow.at,
      radii: fixture.glow.radii,
      shape: fixture.glow.shape,
      rotation: fixture.glow.rotation,
      beam: fixture.beam,
      color: lampColour(i),
      outside,
    };
  });

  const screen = buildScreen(config, models);
  if (screen) {
    sort(screen.parts);
    const { centre, width, height } = screen.layout;
    pickables.push({ id: TV_ANCHOR_OBJECT_ID, kind: "tv", centre, half: [width / 2, height / 2, 0.06], angle: 0 });
    for (const f of screen.footprints) shadows.push(contactShadow(f.hw, f.hd, f.shade, new Matrix4().makeTranslation(f.x, 0, f.z)));
    scene.add(new Mesh(screen.panel, new MeshBasicMaterial({ vertexColors: true })));
  }
  // The USB strips: one behind the screen is its backlight, picked there; any other runs as a lit line
  // a centimetre wide at its height. A strip was listed in the dock and drawn nowhere.
  const stripMaterials: MeshBasicMaterial[] = [];
  const tapes: LedTape[] = [];
  for (const strip of config.usbStrips) {
    const id = usbStripObjectId(strip.stripId);
    if (config.tvAnchor && screen && isBacklightStrip(strip, config.tvAnchor)) {
      const { centre, width, height } = screen.layout;
      pickables.push({ id, kind: "light", centre, half: [width / 2 + 0.05, height / 2 + 0.05, 0.08], angle: 0 });
      continue;
    }
    // A leg under a millimetre is a corner dragged onto its neighbour: nothing to draw, and no LEDs
    // lost to it.
    const legs = stripLegs(strip).filter((leg) => leg.length >= 1e-3);
    if (stripRunLength(strip) < 0.05) continue;
    const height = Math.min(resolveStripMountHeight(strip) ?? defaultStripHeight(config, strip), dims.heightMeters - STRIP_WIDTH);
    // Away from a wall a strip lies taped flat to the floor; on one it stands flat against it.
    const lying = height < STRIP_WIDTH;
    const at = (x: number, y: number) => roomToScene(x, y, lying ? STRIP_DEPTH / 2 + 0.001 : height, dims);
    const barMaterial = new MeshBasicMaterial({ color: STRIP_GLOW, toneMapped: false });
    stripMaterials.push(barMaterial);
    // A bent strip is a tape per leg, its LEDs shared out by length so the pitch holds round a corner.
    const counts = ledsPerLeg(legs, strip.ledCount);
    const picked: PickLeg[] = [];
    legs.forEach((leg, i) => {
      if (counts[i]! < 1) return;
      const angle = Math.atan2(leg.b.y - leg.a.y, leg.b.x - leg.a.x);
      const centre = at((leg.a.x + leg.b.x) / 2, (leg.a.y + leg.b.y) / 2);
      const tape = ledTape(leg.length, counts[i]!, lying, barMaterial);
      tape.group.position.set(centre.x, centre.y, centre.z);
      tape.group.rotation.y = -angle;
      scene.add(tape.group);
      tapes.push(tape);
      const half: [number, number, number] = lying ? [leg.length / 2, STRIP_DEPTH / 2, STRIP_WIDTH / 2] : [leg.length / 2, STRIP_WIDTH / 2, STRIP_DEPTH / 2];
      picked.push({ centre, half, angle });
    });
    // A bent strip is carried from the middle of the box round its points, as the plan moves it.
    if (picked.length === 1 && resolveStripCorners(strip).length === 0) {
      pickables.push({ id, kind: "light", ...picked[0]!, line: true });
    } else if (picked.length > 0) {
      const points = stripPoints(strip);
      const xs = points.map((p) => p.x);
      const ys = points.map((p) => p.y);
      const middle = stripCentre(strip);
      const across = lying ? STRIP_DEPTH / 2 : STRIP_WIDTH / 2;
      const half: [number, number, number] = [(Math.max(...xs) - Math.min(...xs)) / 2, across, (Math.max(...ys) - Math.min(...ys)) / 2];
      pickables.push({ id, kind: "light", centre: at(middle.x, middle.y), half, angle: 0, line: true, legs: picked });
    }
  }

  // One mesh per material: a room is still a handful of draws.
  const defines = options.coldKey !== undefined ? { SPIKE_COLD_KEY: options.coldKey } : undefined;
  for (const [kind, parts] of byFinish) {
    const mesh = mergeParts(parts, finishMaterial(kind, { lambert: options.lambert, defines }));
    if (mesh) scene.add(mesh);
  }
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

  // Walls: one mesh per edge of the outline, so a cut is a scale change rather than a rebuild.
  // `outward` points away from the room; a wall whose outward side faces the camera is the one to
  // cut. A wall along x wraps each corner the room bulges out at, so the walls meet there; at a
  // corner it turns in at, the next wall already covers the joint from outside, and a wrap would
  // poke into the room.
  const wallMaterial = solid(0.95);
  // Never below a mounted screen's top edge.
  const screenTop = screen ? screen.layout.centre.y + screen.layout.height / 2 + 0.12 : 0;
  const standing = Math.min(H, Math.max(H * WALL_STANDING_SHARE, screenTop));
  const walls = edges.map((e) => {
    const alongX = e.outwardZ !== 0;
    const wrapA = alongX && e.convexA ? WALL_THICKNESS : 0;
    const wrapB = alongX && e.convexB ? WALL_THICKNESS : 0;
    const dx = (e.bx - e.ax) / e.length;
    const dz = (e.bz - e.az) / e.length;
    const mesh = new Mesh(wallGeometry(alongX, e.length + wrapA + wrapB, finish.walls), wallMaterial);
    mesh.position.set(
      (e.ax + e.bx) / 2 + (dx * (wrapB - wrapA)) / 2 + (e.outwardX * WALL_THICKNESS) / 2,
      0,
      (e.az + e.bz) / 2 + (dz * (wrapB - wrapA)) / 2 + (e.outwardZ * WALL_THICKNESS) / 2,
    );
    mesh.scale.y = standing;
    mesh.receiveShadow = true;
    scene.add(mesh);
    return { mesh, outward: new Vector3(e.outwardX, 0, e.outwardZ) };
  });
  const planes: WallPlane[] = edges.map((e) => ({
    normal: new Vector3(-e.outwardX, 0, -e.outwardZ),
    offset: e.ax * e.outwardX + e.az * e.outwardZ,
    centre: e.outwardZ !== 0 ? (e.ax + e.bx) / 2 : (e.az + e.bz) / 2,
    halfLength: e.length / 2,
  }));

  const lampLit = lamps.some((lamp) => !lamp.outside);
  const real = lampLit ? lampLights(lamps, Math.max(W, D) * 1.1, options.shadows) : null;
  if (real) scene.add(...real.objects);

  const surface = poolTexture(128);
  const glow = buildGlow(lamps, planes, H, surface);
  if (glow) scene.add(...glow.objects);
  else surface.dispose();

  const backlight = screen?.layout.backlight;
  let spill: MeshBasicMaterial | null = null;
  if (backlight) {
    const texture = rimTexture(128, backlight.screenWidth / backlight.width, backlight.screenHeight / backlight.height);
    spill = new MeshBasicMaterial({
      map: texture,
      transparent: true,
      depthWrite: false,
      toneMapped: false,
      blending: AdditiveBlending,
    });
    const plane = new Mesh(new PlaneGeometry(backlight.width, backlight.height), spill);
    plane.position.set(backlight.x, backlight.y, backlight.z);
    scene.add(plane);
  }

  const mark = buildSelectionMark(pickables);
  scene.add(mark.group);

  // A room with no lamps keeps its evening light whatever the mode.
  const evening = { sky: lights.hemisphere.color.clone(), ground: lights.hemisphere.groundColor.clone(), hemi: lights.hemisphere.intensity, key: lights.key.intensity, keyColour: lights.key.color.clone(), fill: lights.fill.intensity };
  const rigs = {
    // Far apart so the lamps going out reads, yet Off keeps a cool moonlight that holds walls and floor.
    lit: { sky: new Color(0xffe4c8), ground: new Color(0x6a4c38), hemi: 0.68, key: 0.6, keyColour: evening.keyColour, fill: 0.22 },
    night: { sky: new Color(0x8d9ccc), ground: new Color(0x1c1a26), hemi: 0.25, key: 0.4, keyColour: new Color(0x9fb4ff), fill: 0.08 },
  };
  const litSky = new Color();
  const bounce = new Color();
  const hsl = { h: 0, s: 0, l: 0 };
  const setMood = (lampColour: number | null, { level, ambient, strip }: MoodLevels, palette?: readonly number[]) => {
    const from = lampLit ? rigs.night : evening;
    const to = lampLit ? rigs.lit : evening;
    const k = lampLit ? ambient : 1;
    // The bounce takes some of the lamps' colour, so a red room is not lit by a peach sky.
    // An effect's mean is a pure-RGB average: at full strength its teal washed the wood out.
    if (lampColour !== null) bounce.set(lampColour);
    if (palette && palette.length > 1) {
      bounce.getHSL(hsl);
      bounce.setHSL(hsl.h, hsl.s * PALETTE_BOUNCE_SATURATION, hsl.l);
    }
    const sky = to === rigs.lit && lampColour !== null ? litSky.copy(to.sky).lerp(bounce, LAMP_BOUNCE) : to.sky;
    lights.hemisphere.color.lerpColors(from.sky, sky, k);
    lights.hemisphere.groundColor.lerpColors(from.ground, to.ground, k);
    lights.hemisphere.intensity = from.hemi + (to.hemi - from.hemi) * k;
    lights.key.color.lerpColors(from.keyColour, to.keyColour, k);
    lights.key.intensity = from.key + (to.key - from.key) * k;
    lights.fill.intensity = from.fill + (to.fill - from.fill) * k;
    real?.paint(lampColour, level, palette);
    glow?.paint(lampColour, level, palette);
    spill?.color.set(lampColour ?? STRIP_GLOW).multiplyScalar(strip * BACKLIGHT_GAIN);
    stripMaterials.forEach((material, i) =>
      material.color.set(paletteColour(palette, i + 1) ?? lampColour ?? STRIP_GLOW).lerp(UNLIT_STRIP, 1 - strip),
    );
  };
  setMood(null, { level: 1, ambient: 1, strip: 1 });

  return {
    scene,
    pickables,
    select: mark.select,
    faceCamera: mark.orient,
    setMood,
    target: new Vector3(0, H * 0.3, 0),
    radius: Math.hypot(W, D, H) / 2,
    cutWalls(direction: Vector3) {
      let changed = false;
      const cut = walls.map(({ mesh, outward }) => {
        // Its outer side faces the camera, or it stands on the camera's side of the room's middle:
        // a U's or T's inner wall faces away from the camera yet still hid the room behind it.
        const nearSide = mesh.position.x * direction.x + mesh.position.z * direction.z > 0.15;
        const isCut = outward.dot(direction) > 0.05 || (nearSide && outward.dot(direction) < -0.05);
        const height = isCut ? WALL_CUT_HEIGHT : standing;
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
      mark.setPixelsPerMetre(ppm);
      for (const tape of tapes) tape.setPixelsPerMetre(ppm);
    },
  };
}

/** Frees every geometry, material, texture, instance buffer and shadow map the scene holds; the
 *  renderer is the caller's. */
export function disposeScene(scene: Scene): void {
  const seen = new Set<object>();
  scene.traverse((object) => {
    if (object instanceof InstancedMesh || object instanceof Light) object.dispose();
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
