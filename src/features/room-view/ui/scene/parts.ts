import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  CylinderGeometry,
  LatheGeometry,
  type Material,
  type Matrix4,
  Mesh,
  SphereGeometry,
  Vector2,
} from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

import type { FinishKind } from "./finishes";

/** One coloured piece of a model, in metres, and what it is made of (unset: by its colour). */
export interface Part {
  geometry: BufferGeometry;
  color: number;
  finish?: FinishKind;
  /** Off for what hangs on the ceiling: the house has no ceiling, so its shadow fell on the floor as a blot. */
  castShadow?: false;
}

/** Below this a size is floored, so a squeezed model degrades instead of failing to build. */
const MIN_SIZE = 0.004;

// Every edit rebuilds the room, and generating its rounded boxes was half of each rebuild; a copy is cheap.
const ROUNDED_KEPT = 512;
const rounded = new Map<string, BufferGeometry>();
function roundedBox(w: number, h: number, d: number, r: number): BufferGeometry {
  const key = `${w}|${h}|${d}|${r}`;
  let template = rounded.get(key);
  if (template) {
    rounded.delete(key);
  } else {
    // Plain, since `clone` runs the constructor: a RoundedBoxGeometry would generate a default box first.
    template = new BufferGeometry().copy(new RoundedBoxGeometry(w, h, d, 2, r));
    if (rounded.size >= ROUNDED_KEPT) rounded.delete(rounded.keys().next().value!);
  }
  rounded.set(key, template);
  return template.clone();
}

/** A box standing on `y`, centred on `x`/`z`, its edges rounded by up to `radius`. */
export function block(
  w: number,
  h: number,
  d: number,
  x: number,
  y: number,
  z: number,
  color: number,
  radius = 0.02,
): Part {
  const sw = Math.max(w, MIN_SIZE);
  const sh = Math.max(h, MIN_SIZE);
  const sd = Math.max(d, MIN_SIZE);
  // RoundedBoxGeometry folds over itself once the radius reaches half the smallest side.
  const r = Math.min(radius, sw / 2, sh / 2, sd / 2) * 0.98;
  const geometry = r > MIN_SIZE / 2 ? roundedBox(sw, sh, sd, r) : new BoxGeometry(sw, sh, sd);
  geometry.translate(x, y + sh / 2, z);
  return { geometry, color };
}

/** An upright cylinder (or cone) standing on `y`. */
export function rod(
  radiusTop: number,
  radiusBottom: number,
  h: number,
  x: number,
  y: number,
  z: number,
  color: number,
  segments = 12,
): Part {
  const geometry = new CylinderGeometry(
    Math.max(radiusTop, 0),
    Math.max(radiusBottom, 0),
    Math.max(h, MIN_SIZE),
    segments,
  );
  geometry.translate(x, y + Math.max(h, MIN_SIZE) / 2, z);
  return { geometry, color };
}

/** A flat ring standing on `y`, open in the middle. */
export function ring(inner: number, outer: number, h: number, x: number, y: number, z: number, color: number, segments = 24): Part {
  const profile = [new Vector2(inner, 0), new Vector2(outer, 0), new Vector2(outer, h), new Vector2(inner, h), new Vector2(inner, 0)];
  const geometry = new LatheGeometry(profile, segments);
  geometry.translate(x, y, z);
  return { geometry, color };
}

export function ball(r: number, x: number, y: number, z: number, color: number, detail = 10): Part {
  const geometry = new SphereGeometry(Math.max(r, MIN_SIZE), detail, Math.max(6, Math.round(detail * 0.75)));
  geometry.translate(x, y, z);
  return { geometry, color };
}

/** A leaf: a flattened, pointed ellipsoid `length` long, its tip along `dir` from `at`, tilted
 *  `droop` towards the floor. */
export function leaf(
  length: number,
  at: { x: number; y: number; z: number },
  dir: { x: number; y: number; z: number },
  droop: number,
  color: number,
): Part {
  const geometry = new SphereGeometry(1, 7, 4);
  geometry.scale(length / 2, 0.012, length * 0.2);
  geometry.translate(length / 2, 0, 0);
  const yaw = Math.atan2(-dir.z, dir.x);
  const pitch = Math.atan2(dir.y, Math.hypot(dir.x, dir.z)) - droop;
  geometry.rotateZ(pitch);
  geometry.rotateY(yaw);
  geometry.translate(at.x, at.y, at.z);
  return { geometry, color, finish: "leaf" };
}

/** A soft dome over a cushion's top: a squashed half-ellipsoid `w` × `d`, rising `h` above `y`. */
export function crown(w: number, d: number, h: number, x: number, y: number, z: number, color: number): Part {
  const geometry = new SphereGeometry(1, 16, 6, 0, Math.PI * 2, 0, Math.PI / 2);
  geometry.scale(Math.max(w, MIN_SIZE) / 2, Math.max(h, MIN_SIZE), Math.max(d, MIN_SIZE) / 2);
  geometry.translate(x, y, z);
  return { geometry, color };
}

export function transformParts(parts: readonly Part[], matrix: Matrix4): void {
  for (const part of parts) part.geometry.applyMatrix4(matrix);
}

/** How much darker a surface is where it meets the floor — a contact shade baked into the vertex
 *  colours, so objects sit on the floor instead of floating over it, at no draw cost. */
const FLOOR_SHADE = 0.24;
const FLOOR_SHADE_REACH = 0.35;

/** Parts painted by vertex colour and merged into one mesh, so a whole layer is one draw call. */
export function mergeParts(parts: readonly Part[], material: Material, floorShade = true): Mesh | null {
  if (parts.length === 0) return null;
  const c = new Color();
  const prepared = parts.map(({ geometry, color }) => {
    const flat = geometry.index ? geometry.toNonIndexed() : geometry;
    if (flat.getAttribute("uv")) flat.deleteAttribute("uv");
    c.set(color);
    const position = flat.getAttribute("position");
    const colors = new Float32Array(position.count * 3);
    for (let i = 0; i < position.count; i++) {
      const t = floorShade ? Math.min(Math.max(position.getY(i) / FLOOR_SHADE_REACH, 0), 1) : 1;
      const shade = 1 - FLOOR_SHADE * (1 - t * t * (3 - 2 * t));
      colors[i * 3] = c.r * shade;
      colors[i * 3 + 1] = c.g * shade;
      colors[i * 3 + 2] = c.b * shade;
    }
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

export function hashString(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967296;
}

/** A deterministic stream of numbers in [0, 1): the same room draws the same planks and pillows
 *  on every rebuild, so nothing shimmers when a single object moves. */
export function seeded(seed: number): () => number {
  let s = Math.floor(Math.abs(seed) * 2147483646) % 2147483647 || 1;
  return () => {
    s = (s * 48271) % 2147483647;
    return (s - 1) / 2147483646;
  };
}
