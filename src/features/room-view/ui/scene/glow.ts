// What makes a lamp read as lit without a real light per lamp: an unlit bulb, a camera-facing
// halo, a pool on the floor and a wash on the nearest wall. Each kind is one draw call whatever
// the number of lamps.
import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  DoubleSide,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  Object3D,
  PlaneGeometry,
  Points,
  PointsMaterial,
  Quaternion,
  SphereGeometry,
  type Texture,
  Vector3,
} from "three";

import type { ScenePoint } from "../../model/roomSpace";

export interface Lamp {
  /** Off the room's outline (in an L's or U's cut): it throws no pool on a floor that is not there. */
  outside?: boolean;
  /** The lit part's centre. */
  at: ScenePoint;
  /** The lit part's radii: a bulb is a small sphere, a shade a drum, a Play bar's back a strip. */
  radii: [number, number, number];
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
/** The halo's diameter in metres; the view turns it into pixels for the current zoom. */
export const HALO_METRES = 0.55;

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

const FLAT = new Quaternion().setFromEuler(new Object3D().rotateX(-Math.PI / 2).rotation);

export interface Glow {
  objects: Array<InstancedMesh | Points>;
  /** Hides the washes on walls the camera has cut down; true when anything changed. */
  setCutWalls(cut: readonly boolean[]): boolean;
  setPixelsPerMetre(ppm: number): void;
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
  texture: Texture,
  surface: Texture,
): Glow | null {
  if (lamps.length === 0) return null;
  const m = new Matrix4();
  const colour = new Color();

  const bulbs = new InstancedMesh(new SphereGeometry(1, 16, 12), new MeshBasicMaterial({ toneMapped: false }), lamps.length);
  const unturned = new Quaternion();
  lamps.forEach((lamp, i) => {
    const [rx, ry, rz] = lamp.radii;
    bulbs.setMatrixAt(
      i,
      m.compose(new Vector3(lamp.at.x, Math.max(lamp.at.y, ry + 0.02), lamp.at.z), unturned, new Vector3(rx, ry, rz)),
    );
    bulbs.setColorAt(i, colour.set(lamp.color));
  });

  const haloGeometry = new BufferGeometry();
  const positions = new Float32Array(lamps.length * 3);
  const colours = new Float32Array(lamps.length * 3);
  lamps.forEach((lamp, i) => {
    positions.set([lamp.at.x, Math.max(lamp.at.y, 0.08), lamp.at.z], i * 3);
    colour.set(lamp.color);
    colours.set([colour.r, colour.g, colour.b], i * 3);
  });
  haloGeometry.setAttribute("position", new BufferAttribute(positions, 3));
  haloGeometry.setAttribute("color", new BufferAttribute(colours, 3));
  const haloMaterial = new PointsMaterial({
    map: texture,
    size: 48,
    sizeAttenuation: false,
    vertexColors: true,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    toneMapped: false,
  });
  const halos = new Points(haloGeometry, haloMaterial);

  // An evening room: each lamp throws a wide pool, so the lights read as what lights the room.
  const pools = new InstancedMesh(new PlaneGeometry(1, 1), additive(surface, 0.62), lamps.length);
  lamps.forEach((lamp, i) => {
    const size = lamp.outside ? 0 : 1.6 + Math.min(Math.max(lamp.at.y, 0), heightM) * 0.9;
    pools.setMatrixAt(i, m.compose(new Vector3(lamp.at.x, 0.006, lamp.at.z), FLAT, new Vector3(size, size, 1)));
    pools.setColorAt(i, colour.set(lamp.color));
  });

  const washes: Array<{ wall: number; matrix: Matrix4 }> = [];
  const washColours: number[] = [];
  const p = new Vector3();
  lamps.forEach((lamp) => {
    if (lamp.outside) return;
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
      washColours.push(colour.set(lamp.color).multiplyScalar(fade).getHex());
    });
  });
  const washMesh = washes.length > 0 ? new InstancedMesh(new PlaneGeometry(1, 1), additive(surface, 0.55), washes.length) : null;
  if (washMesh) {
    washes.forEach((wash, i) => {
      washMesh.setMatrixAt(i, wash.matrix);
      washMesh.setColorAt(i, colour.set(washColours[i] ?? 0));
    });
  }

  const hidden = new Matrix4().makeScale(0, 0, 0);
  let cutState: readonly boolean[] = [];
  return {
    objects: [bulbs, halos, pools, ...(washMesh ? [washMesh] : [])],
    setCutWalls(cut) {
      if (!washMesh || (cutState.length === cut.length && cutState.every((c, i) => c === cut[i]))) return false;
      cutState = [...cut];
      washes.forEach((wash, i) => washMesh.setMatrixAt(i, cut[wash.wall] ? hidden : wash.matrix));
      washMesh.instanceMatrix.needsUpdate = true;
      return true;
    },
    setPixelsPerMetre(ppm) {
      haloMaterial.size = Math.min(Math.max(HALO_METRES * ppm, 8), 256);
    },
  };
}
