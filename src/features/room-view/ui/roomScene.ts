// The 3D room's scene, built from the room map. Everything here runs only while the view is on
// screen and is torn down with it (`disposeScene`). Lamp colours are placeholders until the live
// feed reaches the view.
import type { ZoneMarks } from "@/features/room-map/model/zoneMarks";
import type { ZoneRect } from "@/features/room-map/model/zoneRect";
import { lampColour } from "../model/lampColours";
import {
  AdditiveBlending,
  BoxGeometry,
  type BufferGeometry,
  type Camera,
  Color,
  DoubleSide,
  EdgesGeometry,
  InstancedMesh,
  Light,
  LineBasicMaterial,
  LineSegments,
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

import { decorLightObjectId, furnitureObjectId, hueChannelObjectId, TV_ANCHOR_OBJECT_ID, usbStripObjectId } from "@/features/room-map/model/objectId";
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
import { nearestWallFacing, type OutlineEdge, roomEdges } from "../model/roomOutline";
import { hueChannelScenePoint, roomToScene, type ScenePoint, tvMountHeight } from "../model/roomSpace";
import { contactShadow, floorParts, roomLights, WALL_THICKNESS, wallFootShade, wallGeometry } from "./scene/environment";
import { classifyFurniture, contactShade, modelTop, placedSurfaceTop } from "../model/furnitureModel";
import { type LampFamily, ONE_SIDED } from "../model/lampFamily";
import { DUSK_AT, type MoodLevels, paletteColour, pastDusk } from "../model/roomMood";
import { furnitureParts } from "./scene/furniture";
import { buildGlow, type Lamp, poolTexture, rimTexture, type WallPlane } from "./scene/glow";
import { PALETTE } from "./scene/palette";
import { type FinishKind, finishMaterial } from "./scene/finishes";
import { mergeParts, type Part, transformParts } from "./scene/parts";
import { lampFixture } from "./scene/lamps";
import { lampLights } from "./scene/lampLights";
import { type Liftable, type LiftedPiece, liftPiece, spanHider, spansOf } from "./scene/lift";
import { beamGeometry, columnGeometry, decorLights, doorGaps, gappedWallGeometry, openingsTop, planStructures, thresholds } from "./scene/structures";
import { buildScreen } from "./scene/screen";
import { buildSelectionMark } from "./scene/selection";
import { buildBeams } from "./scene/beams";
import { buildZoneBoxes, type ZoneLight } from "./scene/zoneBoxes";
import { type LedTape, ledTape, TAPE_DEPTH as STRIP_DEPTH, TAPE_WIDTH as STRIP_WIDTH } from "./scene/ledTape";

const STRIP_GLOW = 0xffc46b;
/** The carried light's amber, so a dock drag reads as the same gesture. */
const HELD_LIGHT = 0xffb020;
// At 1.6 with a steep fall-off the halo burnt to a white band with a hard edge.
const BACKLIGHT_GAIN = 0.9;
const LAMP_BOUNCE = 0.35;
const PALETTE_BOUNCE_SATURATION = 0.5;
/** Full day still leaves lit lamps half their say in the room's light. */
const DAY_OVER_LAMPS = 0.5;

interface Rig {
  sky: Color;
  ground: Color;
  hemi: number;
  key: number;
  keyColour: Color;
  fill: number;
}

function scratchRig(): Rig {
  return { sky: new Color(), ground: new Color(), hemi: 0, key: 0, keyColour: new Color(), fill: 0 };
}

/** `out` may be `a`: setMood runs every frame of an ease, so nothing is allocated here. */
function lerpRig(out: Rig, a: Rig, b: Rig, t: number): void {
  out.sky.lerpColors(a.sky, b.sky, t);
  out.ground.lerpColors(a.ground, b.ground, t);
  out.keyColour.lerpColors(a.keyColour, b.keyColour, t);
  out.hemi = a.hemi + (b.hemi - a.hemi) * t;
  out.key = a.key + (b.key - a.key) * t;
  out.fill = a.fill + (b.fill - a.fill) * t;
}
const UNLIT_STRIP = new Color(0x2a2a2e);
/** A wall between the camera and the room drops to this, so the room reads as a cutaway. */
const WALL_CUT_HEIGHT = 0.2;
/** How quickly a wall eases to its new height as the camera turns: most of the way in about 0.2 s. */
const CUT_EASE_MS = 70;
/** At full height the walls hid the far half of the floor from a raised view. */
const WALL_STANDING_SHARE = 0.7;
const WALL_OPENINGS_SHARE = 0.85;
const COLUMN_SIGHT = 0.3;
/** A beam's end within this of a wall rests on it. */
const BEAM_REST = 0.3;

const wallItemsId = (edge: number) => `wall-items:${edge}`;

function distanceToEdge(x: number, z: number, e: OutlineEdge): number {
  const t = Math.min(Math.max(((x - e.ax) * (e.bx - e.ax) + (z - e.az) * (e.bz - e.az)) / (e.length * e.length), 0), 1);
  return Math.hypot(x - (e.ax + (e.bx - e.ax) * t), z - (e.az + (e.bz - e.az) * t));
}

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
  /** The room is being edited: each one-sided Hue light shows which way it throws (`scene/beams.ts`). */
  beams?: boolean;
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
  /** Lowers the walls standing between the camera and the room, eased over `dtMs` since the last
   *  call (omitted: at once); true when anything changed. */
  cutWalls(cameraDirection: Vector3, dtMs?: number): boolean;
  /** A wall or column is still on its way to the height the last cut asked for. */
  settling(): boolean;
  setPixelsPerMetre(ppm: number): void;
  /** What a click can land on: every light, piece of furniture and the screen. */
  pickables: readonly Pickable[];
  /** Marks the object with this id, or nothing; true when the mark changed. */
  select(objectId: string | null): boolean;
  /** Outlines the Hue zones being edited, or none; true when that changed. */
  markZones(marks: ZoneMarks | null): boolean;
  /** A zone carried or resized, as its whole box on the plan rectangle; null sets it down. */
  holdZone(zoneId: string, rect: ZoneRect | null, centerZ?: number): boolean;
  /** A light's dock fields while dragged: its box where they put its stored point, as a carried light
   *  shows it; null hides it. The lamp moves when the room is built again. */
  holdLight(objectId: string, at: ScenePoint | null): boolean;
  /** Turns what faces the camera (the selection's ring, a zone's name) to it; call before each draw. */
  faceCamera(cameraQuaternion: Quaternion, camera?: Camera): void;
  /** `null` keeps each lamp's own colour; a palette gives lamp i stop i mod n. */
  setMood(lampColour: number | null, levels: MoodLevels, palette?: readonly number[]): void;
  /** Null for a lamp: its light and glow are built into the scene. Without riders a desk leaves its
   *  monitor, as an inspector edit does. */
  lift(objectId: string, withRiders?: boolean): LiftedPiece | null;
  /** Shifts the selection's mark by this much in the scene, as a piece slid in place moves. */
  shiftMark(dx: number, dz: number): void;
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
  const gaps = doorGaps(config, edges);
  const floor = mergeParts([...floorParts(W, D, corners, edges, finish.floor, gaps), ...thresholds(gaps, edges)], solid(finish.floor === "carpet" ? 0.95 : 0.72), false);
  if (floor) {
    floor.castShadow = false;
    scene.add(floor);
  }

  const models = classifyFurniture(config);
  const byFinish = new Map<string, { kind: FinishKind; castShadow: boolean; parts: Part[]; owners: (string | null)[] }>();
  const shadows: BufferGeometry[] = [wallFootShade(edges, gaps)];
  const shadowOwners: (string | null)[] = [null];
  const liftables = new Map<string, Liftable>();
  const liftable = (id: string, x: number, z: number) => {
    const entry: Liftable = { spans: [], extras: [], pivot: { x, z } };
    liftables.set(id, entry);
    return entry;
  };
  const surfaces: Surface[] = [];
  const pickables: Pickable[] = [];
  const sort = (parts: readonly Part[], owner: string | null = null) => {
    for (const part of parts) {
      const kind = part.finish ?? (SATIN.has(part.color) ? "satin" : "matte");
      const castShadow = part.castShadow !== false;
      const key = castShadow ? kind : `${kind}:overhead`;
      const list = byFinish.get(key);
      if (list) {
        list.parts.push(part);
        list.owners.push(owner);
      } else byFinish.set(key, { kind, castShadow, parts: [part], owners: [owner] });
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
    const id = furnitureObjectId(item.id);
    liftable(id, centre.x, centre.z).turn = -((item.rotation ?? 0) * Math.PI) / 180;
    sort(parts, id);
    shadows.push(contactShadow(item.width / 2, item.height / 2, contactShade(model), place));
    shadowOwners.push(id);
    const storedTop = resolveFurnitureTop(item);
    const scale = storedTop !== undefined ? storedTop / modelTop(model) : 1;
    const top = placedSurfaceTop(model, storedTop);
    const height = Math.max(modelTop(model) * scale, 0.02);
    pickables.push({
      id,
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
      // A downlight's lens is a centimetre thick: as thin, it was hard to click.
      half: [rx, Math.max(ry, 0.04), rz],
      angle: 0,
      rises: true,
      stored: point,
    });
    const outside = corners !== null && outsideOutline(fixture.glow.at.x + W / 2, fixture.glow.at.z + D / 2, corners);
    return {
      at: fixture.glow.at,
      radii: fixture.glow.radii,
      shape: fixture.glow.shape,
      rotation: fixture.glow.rotation,
      beam: fixture.beam,
      back: fixture.back,
      color: lampColour(i),
      outside,
    };
  });

  // The house's own lights after the Hue ones, so a palette's stops still fall on the Hue lights by index.
  const hueLamps = lamps.length;
  for (const light of decorLights(config, H)) {
    const point = roomToScene(light.x, light.y, light.height, dims);
    const fixture = lampFixture(light.fixture, point, surfaceUnder(point.x, point.z, point.y, surfaces), H, 0);
    sort(fixture.body);
    const [rx, ry, rz] = fixture.glow.radii;
    pickables.push({
      id: decorLightObjectId(light.id),
      kind: "light",
      centre: fixture.glow.at,
      half: [rx, Math.max(ry, 0.04), rz],
      angle: 0,
      rises: true,
      stored: point,
    });
    const outside = corners !== null && outsideOutline(fixture.glow.at.x + W / 2, fixture.glow.at.z + D / 2, corners);
    lamps.push({
      at: fixture.glow.at,
      radii: fixture.glow.radii,
      shape: fixture.glow.shape,
      rotation: fixture.glow.rotation,
      beam: fixture.beam,
      back: fixture.back,
      color: light.colour,
      own: true,
      outside,
    });
  }

  const screen = buildScreen(config, models);
  if (screen) {
    sort(screen.parts, TV_ANCHOR_OBJECT_ID);
    const { centre, width, height } = screen.layout;
    pickables.push({ id: TV_ANCHOR_OBJECT_ID, kind: "tv", centre, half: [width / 2, height / 2, 0.06], angle: 0, rises: true });
    for (const f of screen.footprints) {
      shadows.push(contactShadow(f.hw, f.hd, f.shade, new Matrix4().makeTranslation(f.x, 0, f.z)));
      shadowOwners.push(TV_ANCHOR_OBJECT_ID);
    }
    const panel = new Mesh(screen.panel, new MeshBasicMaterial({ vertexColors: true }));
    scene.add(panel);
    liftable(TV_ANCHOR_OBJECT_ID, centre.x, centre.z).extras.push(panel);
  }
  // The USB strips: one behind the screen is its backlight, picked there; any other runs as a lit line
  // a centimetre wide at its height. A strip was listed in the dock and drawn nowhere.
  const stripMaterials: MeshBasicMaterial[] = [];
  const tapes: LedTape[] = [];
  for (const strip of config.usbStrips) {
    const id = usbStripObjectId(strip.stripId);
    if (screen && isBacklightStrip(strip, config)) {
      const { centre, width, height } = screen.layout;
      pickables.push({ id, kind: "light", centre, half: [width / 2 + 0.05, height / 2 + 0.05, 0.08], angle: 0, around: TV_ANCHOR_OBJECT_ID });
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
    const pivot = at(stripCentre(strip).x, stripCentre(strip).y);
    const own = liftable(id, pivot.x, pivot.z);
    legs.forEach((leg, i) => {
      if (counts[i]! < 1) return;
      const angle = Math.atan2(leg.b.y - leg.a.y, leg.b.x - leg.a.x);
      const centre = at((leg.a.x + leg.b.x) / 2, (leg.a.y + leg.b.y) / 2);
      const tape = ledTape(leg.length, counts[i]!, lying, barMaterial);
      tape.group.position.set(centre.x, centre.y, centre.z);
      tape.group.rotation.y = -angle;
      scene.add(tape.group);
      own.extras.push(tape.group);
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

  // Never below a mounted screen's top edge, nor so low a window's top would notch it.
  const screenTop = screen ? screen.layout.centre.y + screen.layout.height / 2 + 0.12 : 0;
  // Past 85% of the ceiling a window's head is cut instead: the walls would no longer read as cut away.
  const standing = Math.min(H, Math.max(H * WALL_STANDING_SHARE, screenTop, Math.min(openingsTop(config), H * WALL_OPENINGS_SHARE)));
  const build = planStructures(config, edges, finish.walls, standing);
  for (const [edge, parts] of build.wallParts) {
    liftable(wallItemsId(edge), 0, 0);
    sort(parts, wallItemsId(edge));
  }

  // One mesh per material: a room is still a handful of draws.
  const defines = options.coldKey !== undefined ? { SPIKE_COLD_KEY: options.coldKey } : undefined;
  // Counted before merging: a part goes in unindexed, a shadow as it is.
  const into = (owner: string) => liftables.get(owner);
  const materials = new Map<FinishKind, Material>();
  for (const { kind, castShadow, parts, owners } of byFinish.values()) {
    const counts = parts.map(({ geometry }) => geometry.index?.count ?? geometry.getAttribute("position").count);
    let material = materials.get(kind);
    if (!material) {
      material = finishMaterial(kind, { lambert: options.lambert, defines });
      materials.set(kind, material);
    }
    const mesh = mergeParts(parts, material);
    if (!mesh) continue;
    mesh.castShadow = castShadow;
    scene.add(mesh);
    spansOf(mesh, counts, owners, into);
  }
  {
    const counts = shadows.map((g) => g.getAttribute("position").count);
    const merged = mergeGeometries(shadows);
    for (const g of shadows) g.dispose();
    if (merged) {
      const mesh = new Mesh(
        merged,
        new MeshBasicMaterial({
          vertexColors: true,
          transparent: true,
          depthWrite: false,
          polygonOffset: true,
          polygonOffsetFactor: -2,
          side: DoubleSide,
        }),
      );
      scene.add(mesh);
      spansOf(mesh, counts, shadowOwners, into);
    }
  }

  // Walls: one mesh per edge of the outline, so a cut is a scale change rather than a rebuild.
  // `outward` points away from the room; a wall whose outward side faces the camera is the one to
  // cut. A wall along x wraps each corner the room bulges out at, so the walls meet there; at a
  // corner it turns in at, the next wall already covers the joint from outside, and a wrap would
  // poke into the room.
  const wallMaterial = solid(0.95);
  const walls = edges.map((e, i) => {
    const alongX = e.outwardZ !== 0;
    const wrapA = alongX && e.convexA ? WALL_THICKNESS : 0;
    const wrapB = alongX && e.convexB ? WALL_THICKNESS : 0;
    const dx = (e.bx - e.ax) / e.length;
    const dz = (e.bz - e.az) / e.length;
    const x = (e.ax + e.bx) / 2 + (dx * (wrapB - wrapA)) / 2 + (e.outwardX * WALL_THICKNESS) / 2;
    const z = (e.az + e.bz) / 2 + (dz * (wrapB - wrapA)) / 2 + (e.outwardZ * WALL_THICKNESS) / 2;
    const span = e.length + wrapA + wrapB;
    const gapsHere = build.gaps.get(i);
    const geometry = gapsHere ? gappedWallGeometry(alongX, span, alongX ? x : z, gapsHere, WALL_THICKNESS, finish.walls) : wallGeometry(alongX, span, finish.walls);
    const mesh = new Mesh(geometry ?? wallGeometry(alongX, 0.01, finish.walls), wallMaterial);
    mesh.position.set(x, 0, z);
    mesh.scale.y = standing;
    mesh.receiveShadow = true;
    scene.add(mesh);
    const items = liftables.get(wallItemsId(i));
    return { mesh, outward: new Vector3(e.outwardX, 0, e.outwardZ), items: items ? spanHider(items.spans) : null, lowered: false };
  });
  // A column is cut only in the camera's line to the room: cut for merely being near, it read as a stool.
  const columns = build.columns.map((column) => {
    const mesh = new Mesh(columnGeometry(column, finish.walls), wallMaterial);
    const at = roomToScene(column.x, column.y, 0, dims);
    mesh.position.set(at.x, 0, at.z);
    mesh.rotation.y = -((column.rotation ?? 0) * Math.PI) / 180;
    mesh.scale.y = standing;
    // Walls cast none, so a column's 2 m shadow was the heaviest shape on the floor.
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    scene.add(mesh);
    return { mesh, reach: Math.hypot(column.width, column.depth) / 2 + COLUMN_SIGHT };
  });
  const beams = build.beams.map((beam) => {
    const mesh = new Mesh(beamGeometry(beam, dims, standing, finish.walls), wallMaterial);
    mesh.receiveShadow = true;
    scene.add(mesh);
    const ends = [roomToScene(beam.x1, beam.y1, 0, dims), roomToScene(beam.x2, beam.y2, 0, dims)];
    const restsOn = edges.flatMap((e, i) => (ends.some((end) => distanceToEdge(end.x, end.z, e) <= BEAM_REST) ? [i] : []));
    return { mesh, restsOn };
  });
  let settling = false;
  const planes: WallPlane[] = edges.map((e) => ({
    normal: new Vector3(-e.outwardX, 0, -e.outwardZ),
    offset: e.ax * e.outwardX + e.az * e.outwardZ,
    centre: e.outwardZ !== 0 ? (e.ax + e.bx) / 2 : (e.az + e.bz) / 2,
    halfLength: e.length / 2,
  }));

  // Only the Hue lights get the few real lights and set the rig; the house's own are a glow.
  const lampLit = lamps.slice(0, hueLamps).some((lamp) => !lamp.outside);
  const real = lampLit ? lampLights(lamps.slice(0, hueLamps), Math.max(W, D) * 1.1, options.shadows) : null;
  if (real) scene.add(...real.objects);

  const surface = poolTexture(128);
  const glow = buildGlow(lamps, planes, H, surface, standing);
  const throws = options.beams ? buildBeams(lamps.slice(0, hueLamps), { w: W, d: D, h: H }) : null;
  if (throws) scene.add(throws.group);
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
    liftables.get(TV_ANCHOR_OBJECT_ID)?.extras.push(plane);
  }

  const mark = buildSelectionMark(pickables);
  scene.add(mark.group);
  const zoneLights: ZoneLight[] = config.hueChannels.flatMap((channel) => {
    const pick = pickables.find((p) => p.id === hueChannelObjectId(channel.channelIndex));
    if (!channel.zoneId || !channel.zoneRelativePosition || !pick?.stored) return [];
    const { centre, stored } = pick;
    return [{ zoneId: channel.zoneId, rel: channel.zoneRelativePosition, half: pick.half, offset: { x: centre.x - stored.x, y: centre.y - stored.y, z: centre.z - stored.z } }];
  });
  const zoneBoxes = buildZoneBoxes(config.zones, dims, { lights: zoneLights, outline: corners });
  scene.add(zoneBoxes.group);
  const heldLight = new LineSegments(new EdgesGeometry(new BoxGeometry(1, 1, 1)), new LineBasicMaterial({ color: HELD_LIGHT }));
  heldLight.visible = false;
  scene.add(heldLight);

  // A room with no lamps keeps its evening light whatever the mode; the Ambient light moves it
  // toward night or day. A lamp-lit room's unlit end is a dusk, so the lamps going out reads.
  const evening: Rig = { sky: lights.hemisphere.color.clone(), ground: lights.hemisphere.groundColor.clone(), hemi: lights.hemisphere.intensity, key: lights.key.intensity, keyColour: lights.key.color.clone(), fill: lights.fill.intensity };
  const rigs = {
    lit: { sky: new Color(0xffe4c8), ground: new Color(0x6a4c38), hemi: 0.68, key: 0.6, keyColour: evening.keyColour, fill: 0.22 },
    // Off at night keeps a cool moonlight that holds walls and floor.
    night: { sky: new Color(0x8d9ccc), ground: new Color(0x1c1a26), hemi: 0.25, key: 0.4, keyColour: new Color(0x9fb4ff), fill: 0.08 },
    dusk: { sky: new Color(0xb4bbdc), ground: new Color(0x2c2422), hemi: 0.5, key: 0.75, keyColour: new Color(0xd8d6f2), fill: 0.18 },
    day: { sky: new Color(0xf2f5ff), ground: new Color(0x6e5c4a), hemi: 1.15, key: 1.7, keyColour: new Color(0xfff6ea), fill: 0.5 },
  } satisfies Record<string, Rig>;
  const unlit = scratchRig();
  const target = scratchRig();
  const bounce = new Color();
  const hsl = { h: 0, s: 0, l: 0 };
  const setMood = (lampColour: number | null, { level, ambient, strip, daylight }: MoodLevels, palette?: readonly number[]) => {
    const middle = lampLit ? rigs.dusk : evening;
    if (daylight <= DUSK_AT) lerpRig(unlit, rigs.night, middle, daylight / DUSK_AT);
    else lerpRig(unlit, middle, rigs.day, pastDusk(daylight));
    if (lampLit) {
      lerpRig(target, rigs.lit, rigs.day, pastDusk(daylight) * DAY_OVER_LAMPS);
      // The bounce takes some of the lamps' colour, so a red room is not lit by a peach sky.
      // An effect's mean is a pure-RGB average: at full strength its teal washed the wood out.
      if (lampColour !== null) {
        bounce.set(lampColour);
        if (palette && palette.length > 1) {
          bounce.getHSL(hsl);
          bounce.setHSL(hsl.h, hsl.s * PALETTE_BOUNCE_SATURATION, hsl.l);
        }
        target.sky.lerp(bounce, LAMP_BOUNCE);
      }
      lerpRig(unlit, unlit, target, ambient);
    }
    lights.hemisphere.color.copy(unlit.sky);
    lights.hemisphere.groundColor.copy(unlit.ground);
    lights.hemisphere.intensity = unlit.hemi;
    lights.key.color.copy(unlit.keyColour);
    lights.key.intensity = unlit.key;
    lights.fill.intensity = unlit.fill;
    real?.paint(lampColour, level, palette);
    glow?.paint(lampColour, level, palette);
    throws?.paint(lampColour, level, palette);
    // By the strip's level: Ambilight keeps the lamps at a fifth, which left the picture all but gone.
    screen?.paint(lampColour, strip, palette);
    spill?.color.set(lampColour ?? STRIP_GLOW).multiplyScalar(strip * BACKLIGHT_GAIN);
    stripMaterials.forEach((material, i) =>
      material.color.set(paletteColour(palette, i + 1) ?? lampColour ?? STRIP_GLOW).lerp(UNLIT_STRIP, 1 - strip),
    );
  };
  setMood(null, { level: 1, ambient: 1, strip: 1, daylight: DUSK_AT });

  return {
    scene,
    pickables,
    select: mark.select,
    markZones: zoneBoxes.mark,
    holdZone: zoneBoxes.hold,
    holdLight(objectId, at) {
      const item = at && pickables.find((p) => p.id === objectId && p.kind === "light");
      if (!at || !item) {
        if (!heldLight.visible) return false;
        heldLight.visible = false;
        return true;
      }
      const [hx, hy, hz] = item.half;
      const from = item.stored ?? item.centre;
      heldLight.scale.set(hx * 2, Math.max(hy * 2, 0.05), hz * 2);
      heldLight.position.set(at.x + item.centre.x - from.x, Math.max(at.y + item.centre.y - from.y, 0.025), at.z + item.centre.z - from.z);
      heldLight.visible = true;
      return true;
    },
    faceCamera(q, camera) {
      mark.orient(q);
      zoneBoxes.orient(q, camera);
    },
    lift(objectId: string, withRiders = true) {
      const piece = liftables.get(objectId);
      if (!piece || (piece.spans.length === 0 && piece.extras.length === 0)) return null;
      const tv = liftables.get(TV_ANCHOR_OBJECT_ID);
      const riders = new Map<string, Liftable>();
      if (withRiders && tv && screen?.deskId != null && furnitureObjectId(screen.deskId) === objectId) riders.set(TV_ANCHOR_OBJECT_ID, tv);
      return liftPiece(scene, piece, riders);
    },
    shiftMark: mark.shift,
    setMood,
    target: new Vector3(0, H * 0.3, 0),
    radius: Math.hypot(W, D, H) / 2,
    settling: () => settling,
    cutWalls(direction: Vector3, dtMs = Number.POSITIVE_INFINITY) {
      let changed = false;
      settling = false;
      const ease = (from: number, to: number) => {
        const next = from + (to - from) * (1 - Math.exp(-dtMs / CUT_EASE_MS));
        const height = Math.abs(to - next) < 0.004 ? to : next;
        if (height !== to) settling = true;
        return height;
      };
      const cut = walls.map((wall) => {
        const { mesh, outward, items } = wall;
        // Its outer side faces the camera, or it stands on the camera's side of the room's middle:
        // a U's or T's inner wall faces away from the camera yet still hid the room behind it.
        const nearSide = mesh.position.x * direction.x + mesh.position.z * direction.z > 0.15;
        const isCut = outward.dot(direction) > 0.05 || (nearSide && outward.dot(direction) < -0.05);
        const height = ease(mesh.scale.y, isCut ? WALL_CUT_HEIGHT : standing);
        if (mesh.scale.y !== height) {
          mesh.scale.y = height;
          changed = true;
        }
        // What is on its face goes as it starts down and comes back once it stands again: drawn on a
        // moving wall, it floated over the wall's top.
        const lowered = isCut || height < standing;
        if (wall.lowered !== lowered) {
          wall.lowered = lowered;
          items?.(lowered);
          changed = true;
        }
        return lowered;
      });
      const flat = Math.hypot(direction.x, direction.z) || 1;
      for (const { mesh: column, reach } of columns) {
        const toward = (column.position.x * direction.x + column.position.z * direction.z) / flat;
        const aside = Math.abs(column.position.x * direction.z - column.position.z * direction.x) / flat;
        const height = ease(column.scale.y, toward > 0.15 && aside <= reach ? WALL_CUT_HEIGHT : standing);
        if (column.scale.y !== height) {
          column.scale.y = height;
          changed = true;
        }
      }
      for (const beam of beams) {
        const shown = beam.restsOn.length === 0 || !beam.restsOn.every((i) => cut[i]);
        if (beam.mesh.visible !== shown) {
          beam.mesh.visible = shown;
          changed = true;
        }
      }
      if (glow?.setCutWalls(cut)) changed = true;
      return changed;
    },
    setPixelsPerMetre(ppm: number) {
      mark.setPixelsPerMetre(ppm);
      zoneBoxes.setPixelsPerMetre(ppm);
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
