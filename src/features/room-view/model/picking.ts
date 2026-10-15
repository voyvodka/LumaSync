// What a click in the 3D room lands on. The room is drawn as a few merged meshes, so a raycast
// against them cannot say which piece was hit; each pickable object carries its own box instead,
// and the ray is tested against those.
import type { ScenePoint } from "./roomSpace";

export type PickKind = "light" | "furniture" | "tv";

export interface Pickable {
  /** The room map's object id (`hue-3`, `furniture-sofa`, `tv`). */
  id: string;
  kind: PickKind;
  /** The box's centre in the scene frame. */
  centre: ScenePoint;
  /** Half the box along its own x, y and z. */
  half: readonly [number, number, number];
  /** The rotation about y the piece was placed with (radians, as the plan stores it). */
  angle: number;
  /** A strip: long and a centimetre thick. */
  line?: boolean;
  /** A bent strip's straight runs, picked and marked one by one; the box above is round them all. */
  legs?: readonly PickLeg[];
}

export type PickLeg = Pick<Pickable, "centre" | "half" | "angle">;

export interface PickRay {
  origin: ScenePoint;
  direction: ScenePoint;
}

/** A light is a small target; anything thinner than this is picked as if it were this thick. */
export const MIN_LIGHT_HALF = 0.15;
/** …and never smaller on screen than this radius, so a lamp stays a 32 px target at any zoom. */
export const MIN_LIGHT_HALF_PX = 16;

/** The half-size a light is picked at, for a view drawing `pixelsPerMetre`. */
export function lightPickHalf(pixelsPerMetre: number): number {
  return pixelsPerMetre > 0 ? Math.max(MIN_LIGHT_HALF, MIN_LIGHT_HALF_PX / pixelsPerMetre) : MIN_LIGHT_HALF;
}

/** The distance along the ray to the box, or null when it misses (slab test in the box's frame). */
export function rayBoxDistance(ray: PickRay, item: Pickable): number | null {
  const c = Math.cos(item.angle);
  const s = Math.sin(item.angle);
  // Placement rotates by -angle about y; undo it on the ray.
  const ox = ray.origin.x - item.centre.x;
  const oz = ray.origin.z - item.centre.z;
  const origin = [ox * c + oz * s, ray.origin.y - item.centre.y, -ox * s + oz * c];
  const direction = [
    ray.direction.x * c + ray.direction.z * s,
    ray.direction.y,
    -ray.direction.x * s + ray.direction.z * c,
  ];
  let near = -Infinity;
  let far = Infinity;
  for (let axis = 0; axis < 3; axis++) {
    const o = origin[axis] ?? 0;
    const d = direction[axis] ?? 0;
    const h = item.half[axis] ?? 0;
    if (Math.abs(d) < 1e-9) {
      if (o < -h || o > h) return null;
      continue;
    }
    let t1 = (-h - o) / d;
    let t2 = (h - o) / d;
    if (t1 > t2) [t1, t2] = [t2, t1];
    near = Math.max(near, t1);
    far = Math.min(far, t2);
    if (near > far) return null;
  }
  if (far < 0) return null;
  return Math.max(near, 0);
}

/** The object a ray picks. Lights are what the view is about, so any light the ray passes through
 *  wins over a nearer piece of furniture: a lamp on a desk, or one half behind the sofa, is still
 *  the one clicked. Among the rest, the nearest. */
export function pickObject(ray: PickRay, items: readonly Pickable[], minLightHalf = MIN_LIGHT_HALF): string | null {
  let light: { id: string; t: number } | null = null;
  let other: { id: string; t: number } | null = null;
  for (const item of items) {
    const grow = (half: Pickable["half"]) =>
      item.kind === "light" ? (half.map((h) => Math.max(h, minLightHalf)) as [number, number, number]) : half;
    let t: number | null = null;
    for (const leg of item.legs ?? [item]) {
      const d = rayBoxDistance(ray, { ...item, ...leg, half: grow(leg.half) });
      if (d !== null && (t === null || d < t)) t = d;
    }
    if (t === null) continue;
    if (item.kind === "light") {
      if (!light || t < light.t) light = { id: item.id, t };
    } else if (!other || t < other.t) {
      other = { id: item.id, t };
    }
  }
  return light?.id ?? other?.id ?? null;
}
