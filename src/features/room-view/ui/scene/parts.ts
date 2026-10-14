import {
  BoxGeometry,
  BufferAttribute,
  type BufferGeometry,
  Color,
  CylinderGeometry,
  type Material,
  type Matrix4,
  Mesh,
  SphereGeometry,
} from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

/** One coloured piece of a model, in metres. */
export interface Part {
  geometry: BufferGeometry;
  color: number;
}

/** Below this a size is floored, so a squeezed model degrades instead of failing to build. */
const MIN_SIZE = 0.004;

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
  const geometry = r > MIN_SIZE / 2 ? new RoundedBoxGeometry(sw, sh, sd, 2, r) : new BoxGeometry(sw, sh, sd);
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

export function ball(r: number, x: number, y: number, z: number, color: number, detail = 10): Part {
  const geometry = new SphereGeometry(Math.max(r, MIN_SIZE), detail, Math.max(6, Math.round(detail * 0.75)));
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
