import {
  AdditiveBlending,
  BoxGeometry,
  type BufferGeometry,
  CanvasTexture,
  Color,
  DoubleSide,
  CylinderGeometry,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  Object3D,
  PlaneGeometry,
  Quaternion,
  SphereGeometry,
  type Texture,
  Vector3,
} from "three";

import { paletteColour } from "../../model/roomMood";
import type { ScenePoint } from "../../model/roomSpace";
import { BLOOM_LAYER } from "./bloom";
import type { LampShape } from "./lamps";

export interface Lamp {
  /** Off the room's outline (in an L's or U's cut): it throws no pool on a floor that is not there. */
  outside?: boolean;
  /** A real light already lights its floor and walls: it keeps no wall wash and only a faint pool. */
  litByLight?: boolean;
  /** The lit part's centre. */
  at: ScenePoint;
  radii: [number, number, number];
  shape?: LampShape;
  /** The lit part's turn; absent ⇒ upright. */
  rotation?: Quaternion;
  /** A one-sided fixture's cone. */
  beam?: { aim: Vector3; spread: number };
  color: number;
  /** One of the house's own lights: its own white at its own level, whatever mode runs. */
  own?: boolean;
}

/** The share of a pool's half-width that must stay on the floor; the rest has faded out. */
const POOL_INSIDE = 0.95;
/** How far a pool may move off its light to stay on the floor before it narrows instead. */
const POOL_SHIFT_MAX = 0.4;

/** How bright the house's own lights burn: on, a little under a Hue light at full. */
const OWN_LEVEL = 0.8;

/** A wall's inner plane: `normal` points into the room. */
export interface WallPlane {
  normal: Vector3;
  /** Distance from the room's centre to the inner face. */
  offset: number;
  /** Where the wall's middle is along its face (x for a wall along x, z otherwise). */
  centre: number;
  /** Half the wall's length along its face. */
  halfLength: number;
}

/** How near a wall a lamp must be to wash it. */
const WASH_REACH = 1.6;
const WASH_SIZE = 2.4;

/** Data, never a drawn gradient: WebKit's straight-alpha upload wrapped dithered channels to ~0. */
function alphaTexture(size: number, alphaAt: (u: number, v: number) => number): CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    const image = ctx.createImageData(size, size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const i = (y * size + x) * 4;
        image.data[i] = image.data[i + 1] = image.data[i + 2] = 255;
        image.data[i + 3] = Math.round(255 * alphaAt((x + 0.5) / size, (y + 0.5) / size));
      }
    }
    ctx.putImageData(image, 0, 0);
  }
  return new CanvasTexture(canvas);
}

/** Light thrown on the wall by a strip behind a screen: brightest at the screen's edge and falling
 *  off from it, a rim rather than a round pool. `inner` is the screen's share of the texture. */
export function rimTexture(size: number, innerWidth: number, innerHeight: number): CanvasTexture {
  const hw = innerWidth / 2;
  const hh = innerHeight / 2;
  const reach = Math.min(0.5 - hw, 0.5 - hh);
  return alphaTexture(size, (u, v) => {
    const t = Math.min(Math.hypot(Math.max(Math.abs(u - 0.5) - hw, 0), Math.max(Math.abs(v - 0.5) - hh, 0)) / reach, 1);
    return (1 - t) ** 1.5;
  });
}

function additive(texture: Texture, opacity: number): MeshBasicMaterial {
  return new MeshBasicMaterial({
    map: texture,
    transparent: true,
    depthWrite: false,
    opacity,
    toneMapped: false,
    blending: AdditiveBlending,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    side: DoubleSide,
  });
}

const WHITE = new Color(0xffffff);
const UNLIT_BULB = new Color(0x16171c);
/** Past 1 on purpose: the bulb burns out to white and feeds the glow pass. */
const BULB_BRIGHTNESS = 1.7;
const SHADE_BRIGHTNESS = 1.9;
const LIT_POOL_SHARE = 0.85;

/** Unit size 2, so a lamp's half-extents are its scale. */
const SHAPES: ReadonlyArray<{ shape: LampShape; geometry: () => BufferGeometry }> = [
  { shape: "globe", geometry: () => new SphereGeometry(1, 16, 12) },
  { shape: "drum", geometry: () => new CylinderGeometry(1, 1, 2, 28) },
  { shape: "flare", geometry: () => new CylinderGeometry(0.4, 1, 2, 28) },
  { shape: "bar", geometry: () => new BoxGeometry(2, 2, 2) },
];
const FLAT = new Quaternion().setFromEuler(new Object3D().rotateX(-Math.PI / 2).rotation);

export interface Glow {
  objects: InstancedMesh[];
  /** Hides the washes on walls the camera has cut down; true when anything changed. */
  setCutWalls(cut: readonly boolean[]): boolean;
  /** `null` keeps each lamp's own colour; a palette gives lamp i stop i mod n. */
  paint(lampColour: number | null, level: number, palette?: readonly number[]): void;
}

const POOL_STOPS: ReadonlyArray<readonly [number, number]> = [
  [0, 0.75],
  [0.25, 0.5],
  [0.55, 0.16],
  [1, 0],
];

/** A wide, soft fall-off for light thrown on a surface: no bright core, so pools from neighbouring
 *  lamps mix their colours instead of adding up to white. */
export function poolTexture(size: number): CanvasTexture {
  return alphaTexture(size, (u, v) => {
    const r = Math.hypot(u - 0.5, v - 0.5) * 2;
    for (let i = 1; i < POOL_STOPS.length; i++) {
      const [r1, a1] = POOL_STOPS[i]!;
      if (r > r1) continue;
      const [r0, a0] = POOL_STOPS[i - 1]!;
      return a0 + ((a1 - a0) * (r - r0)) / (r1 - r0);
    }
    return 0;
  });
}
export function buildGlow(
  lamps: readonly Lamp[],
  walls: readonly WallPlane[],
  heightM: number,
  surface: Texture,
  // The walls are cut below the ceiling: a wash placed by the ceiling hung in the air above them.
  wallTop = heightM,
): Glow | null {
  if (lamps.length === 0) return null;
  const m = new Matrix4();
  const colour = new Color();

  // Every shape's mesh holds every lamp, the others scaled to nothing: four draws whatever the lamps.
  const material = new MeshBasicMaterial({ toneMapped: false });
  const shapes = SHAPES.map(({ shape, geometry }) => {
    const mesh = new InstancedMesh(geometry(), material, lamps.length);
    mesh.layers.enable(BLOOM_LAYER);
    return { shape, mesh };
  });
  const unturned = new Quaternion();
  const none = new Matrix4().makeScale(0, 0, 0);
  lamps.forEach((lamp, i) => {
    const [rx, ry, rz] = lamp.radii;
    const place = m.compose(new Vector3(lamp.at.x, Math.max(lamp.at.y, ry + 0.02), lamp.at.z), lamp.rotation ?? unturned, new Vector3(rx, ry, rz));
    for (const { shape, mesh } of shapes) mesh.setMatrixAt(i, shape === (lamp.shape ?? "globe") ? place : none);
  });

  // An evening room: each lamp throws a wide pool, so the lights read as what lights the room.
  const pools = new InstancedMesh(new PlaneGeometry(1, 1), additive(surface, 0.62), lamps.length);
  lamps.forEach((lamp, i) => {
    const height = Math.min(Math.max(lamp.at.y, 0), heightM);
    // Thrown straight down, the pool is the cone's footprint rather than a wide wash.
    const down = lamp.beam && lamp.beam.aim.y < -0.9 ? Math.min(Math.max(1.4 * height * Math.tan(lamp.beam.spread), 0.7), 2.6) : null;
    // By a wall a pool moves in, then narrows: it lit the backdrop, and narrowed alone a wall light lost it.
    let size = lamp.outside ? 0 : (down ?? 1.6 + height * 0.9);
    const at = new Vector3(lamp.at.x, 0.006, lamp.at.z);
    for (const wall of lamp.outside ? [] : walls) {
      if (Math.abs((wall.normal.z !== 0 ? at.x : at.z) - wall.centre) > wall.halfLength) continue;
      const room = wall.offset + at.dot(wall.normal);
      const over = (size / 2) * POOL_INSIDE - room;
      if (over <= 0) continue;
      const shift = Math.min(over, POOL_SHIFT_MAX);
      at.addScaledVector(wall.normal, shift);
      if (over > shift) size = (2 * (room + shift)) / POOL_INSIDE;
    }
    pools.setMatrixAt(i, m.compose(at, FLAT, new Vector3(size, size, 1)));
  });

  const washes: Array<{ wall: number; matrix: Matrix4 }> = [];
  const washLamps: Array<{ lamp: number; fade: number }> = [];
  const p = new Vector3();
  lamps.forEach((lamp, lampIndex) => {
    // A light thrown straight down lights the floor, not the wall beside it: washed, a downlight read as a sconce.
    if (lamp.outside || lamp.litByLight || (lamp.beam && lamp.beam.aim.y < -0.9)) return;
    p.set(lamp.at.x, lamp.at.y, lamp.at.z);
    walls.forEach((wall, wallIndex) => {
      const distance = wall.offset + p.dot(wall.normal);
      if (distance < 0 || distance > WASH_REACH) return;
      // A wall of a room that is not a rectangle does not span it: a lamp off its end lights
      // another wall, not this one.
      const along = wall.normal.z !== 0 ? p.x : p.z;
      if (Math.abs(along - wall.centre) > wall.halfLength) return;
      const fade = 1 - distance / WASH_REACH;
      const size = WASH_SIZE * (0.6 + 0.4 * fade);
      const onWall = p.clone().addScaledVector(wall.normal, -distance + 0.004);
      onWall.y = Math.min(Math.max(lamp.at.y, size * 0.35), wallTop - size * 0.35);
      // Kept off the wall's ends, so a lamp in a corner does not wash the air outside the room.
      const reach = Math.max(wall.halfLength - size / 2, 0);
      if (wall.normal.z !== 0) onWall.x = Math.min(Math.max(onWall.x, wall.centre - reach), wall.centre + reach);
      else onWall.z = Math.min(Math.max(onWall.z, wall.centre - reach), wall.centre + reach);
      const facing = new Quaternion().setFromUnitVectors(new Vector3(0, 0, 1), wall.normal);
      washes.push({ wall: wallIndex, matrix: new Matrix4().compose(onWall, facing, new Vector3(size, size, 1)) });
      washLamps.push({ lamp: lampIndex, fade });
    });
  });
  const washMesh = washes.length > 0 ? new InstancedMesh(new PlaneGeometry(1, 1), additive(surface, 0.55), washes.length) : null;
  if (washMesh) {
    washes.forEach((wash, i) => washMesh.setMatrixAt(i, wash.matrix));
  }

  const paint = (lampColour: number | null, level: number, palette?: readonly number[]) => {
    const hue = (lamp: Lamp | undefined, i: number) => (lamp?.own ? lamp.color : (paletteColour(palette, i) ?? lampColour ?? lamp?.color ?? 0));
    const levelOf = (lamp: Lamp | undefined) => (lamp?.own ? OWN_LEVEL : level);
    lamps.forEach((lamp, i) => {
      const at = levelOf(lamp);
      const gain = lamp.shape === "drum" || lamp.shape === "flare" ? SHADE_BRIGHTNESS : BULB_BRIGHTNESS;
      // Steeper than the level: a dimmed bulb still blew out at a third and bloomed like a full one.
      const lit = colour.set(hue(lamp, i)).lerp(WHITE, 0.2).multiplyScalar(gain * at ** 1.5);
      lit.lerp(UNLIT_BULB, 1 - at);
      for (const { mesh } of shapes) mesh.setColorAt(i, lit);
      pools.setColorAt(i, colour.set(hue(lamp, i)).multiplyScalar(at * (lamp.litByLight ? LIT_POOL_SHARE : 1)));
    });
    washLamps.forEach(({ lamp, fade }, i) => {
      washMesh?.setColorAt(i, colour.set(hue(lamps[lamp], lamp)).multiplyScalar(fade * levelOf(lamps[lamp])));
    });
    for (const mesh of [...shapes.map((entry) => entry.mesh), pools, washMesh]) if (mesh?.instanceColor) mesh.instanceColor.needsUpdate = true;
  };
  paint(null, 1);

  const hidden = new Matrix4().makeScale(0, 0, 0);
  let cutState: readonly boolean[] = [];
  return {
    objects: [...shapes.map((entry) => entry.mesh), pools, ...(washMesh ? [washMesh] : [])],
    paint,
    setCutWalls(cut) {
      if (!washMesh || (cutState.length === cut.length && cutState.every((c, i) => c === cut[i]))) return false;
      cutState = [...cut];
      washes.forEach((wash, i) => washMesh.setMatrixAt(i, cut[wash.wall] ? hidden : wash.matrix));
      washMesh.instanceMatrix.needsUpdate = true;
      return true;
    },
  };
}
