// What makes a lamp read as lit: a bulb burning past white (the bloom pass glows from it) and,
// for a lamp past the real lights' count, a pool on the floor and a wash on the nearest wall.
// Each kind is one draw call whatever the number of lamps.
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

import type { ScenePoint } from "../../model/roomSpace";
import { BLOOM_LAYER } from "./bloom";
import type { LampShape } from "./lamps";

export interface Lamp {
  /** Off the room's outline (in an L's or U's cut): it throws no pool on a floor that is not there. */
  outside?: boolean;
  /** Lit by a real light, which puts the light on the floor and walls itself: no pool, no wash. */
  litByLight?: boolean;
  /** The lit part's centre. */
  at: ScenePoint;
  /** The lit part's half-extents: a bulb is a small sphere, a shade a drum, a Play bar's back a strip. */
  radii: [number, number, number];
  /** Drawn as a globe when absent. */
  shape?: LampShape;
  color: number;
}

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

export function radialTexture(size: number, inner: string, outer: string): CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    g.addColorStop(0, inner);
    g.addColorStop(0.35, inner.replace(/[\d.]+\)$/, "0.45)"));
    g.addColorStop(1, outer);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
  }
  return new CanvasTexture(canvas);
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
const UNLIT_BULB = new Color(0x24221f);
/** Past 1: the bulb burns out to white in the picture, and feeds the glow pass more than a surface. */
const BULB_BRIGHTNESS = 3;
const SHADE_BRIGHTNESS = 1.9;

/** Unit shapes, scaled per lamp by its half-extents: a cylinder 2 tall so its scale is a half-height. */
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
  /** Every lamp in one colour (or each its own, `null`) at `level`, 0 dark to 1 full. */
  paint(lampColour: number | null, level: number): void;
}

/** A wide, soft fall-off for light thrown on a surface: no bright core, so pools from neighbouring
 *  lamps mix their colours instead of adding up to white. */
export function poolTexture(size: number): CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    g.addColorStop(0, "rgba(255,255,255,0.75)");
    g.addColorStop(0.25, "rgba(255,255,255,0.5)");
    g.addColorStop(0.55, "rgba(255,255,255,0.16)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
  }
  return new CanvasTexture(canvas);
}

export function buildGlow(
  lamps: readonly Lamp[],
  walls: readonly WallPlane[],
  heightM: number,
  surface: Texture,
): Glow | null {
  if (lamps.length === 0) return null;
  const m = new Matrix4();
  const colour = new Color();

  // One mesh per shape, each holding every lamp and showing only its own (the rest scaled to
  // nothing): the draw count stays four whatever the lamps are.
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
    const place = m.compose(new Vector3(lamp.at.x, Math.max(lamp.at.y, ry + 0.02), lamp.at.z), unturned, new Vector3(rx, ry, rz));
    for (const { shape, mesh } of shapes) mesh.setMatrixAt(i, shape === (lamp.shape ?? "globe") ? place : none);
  });

  // An evening room: each lamp throws a wide pool, so the lights read as what lights the room.
  const pools = new InstancedMesh(new PlaneGeometry(1, 1), additive(surface, 0.62), lamps.length);
  lamps.forEach((lamp, i) => {
    const size = lamp.outside || lamp.litByLight ? 0 : 1.6 + Math.min(Math.max(lamp.at.y, 0), heightM) * 0.9;
    pools.setMatrixAt(i, m.compose(new Vector3(lamp.at.x, 0.006, lamp.at.z), FLAT, new Vector3(size, size, 1)));
  });

  const washes: Array<{ wall: number; matrix: Matrix4 }> = [];
  const washLamps: Array<{ lamp: number; fade: number }> = [];
  const p = new Vector3();
  lamps.forEach((lamp, lampIndex) => {
    if (lamp.outside || lamp.litByLight) return;
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
      onWall.y = Math.min(Math.max(lamp.at.y, size * 0.35), heightM - size * 0.35);
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

  // A lit bulb burns nearly white whatever its colour, the bloom pass carrying the colour out; an
  // unlit one is frosted glass.
  const paint = (lampColour: number | null, level: number) => {
    lamps.forEach((lamp, i) => {
      // A shade glows through its fabric, dimmer than a bare bulb.
      const gain = lamp.shape === "drum" || lamp.shape === "flare" ? SHADE_BRIGHTNESS : BULB_BRIGHTNESS;
      const lit = colour.set(lampColour ?? lamp.color).lerp(WHITE, 0.2).multiplyScalar(gain);
      lit.lerp(UNLIT_BULB, 1 - level);
      for (const { mesh } of shapes) mesh.setColorAt(i, lit);
      pools.setColorAt(i, colour.set(lampColour ?? lamp.color).multiplyScalar(level));
    });
    washLamps.forEach(({ lamp, fade }, i) => {
      washMesh?.setColorAt(i, colour.set(lampColour ?? lamps[lamp]?.color ?? 0).multiplyScalar(fade * level));
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
