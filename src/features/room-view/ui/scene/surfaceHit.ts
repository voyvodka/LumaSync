import type { Intersection, Mesh, Object3D } from "three";

function shownInScene(object: Object3D): boolean {
  for (let node: Object3D | null = object; node; node = node.parent) if (!node.visible) return false;
  return true;
}

/** The nearest surface the eye sees. The raycaster hits hidden objects too, and lines from a metre
 *  off: a hidden plumb line at the room's middle took a double-click from the sofa beside it. */
export function firstSurfaceHit(hits: readonly Intersection[]): Intersection | undefined {
  return hits.find((hit) => (hit.object as Mesh).isMesh === true && shownInScene(hit.object));
}
