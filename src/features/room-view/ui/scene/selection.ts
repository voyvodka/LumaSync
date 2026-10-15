// The selection's mark in the room: an amber outline on the floor around what is selected, and for
// a light a second ring around the lit part itself. Built once per scene and moved, never rebuilt,
// so a new selection costs one draw.
import { DoubleSide, Group, Mesh, MeshBasicMaterial, Path, type Quaternion, RingGeometry, Shape, ShapeGeometry } from "three";

import type { Pickable } from "../../model/picking";

/** `--lm-amber`. */
export const SELECTION_COLOUR = 0xffb020;
/** How far the floor outline stands off the piece it marks. */
const MARGIN = 0.07;
const LINE = 0.03;
/** Just over the floor and its decals, under everything standing on it. */
const FLOOR_LIFT = 0.006;
/** A light's ring never shrinks below this radius on screen, however far the view zooms out. */
const HALO_MIN_PX = 20;

/** A rounded-rectangle band `LINE` wide around a `w` × `d` rectangle, in the xy plane. */
function outline(w: number, d: number): ShapeGeometry {
  const rect = <P extends Path>(hw: number, hd: number, r: number, path: P): P => {
    path.moveTo(-hw + r, -hd);
    path.lineTo(hw - r, -hd);
    path.quadraticCurveTo(hw, -hd, hw, -hd + r);
    path.lineTo(hw, hd - r);
    path.quadraticCurveTo(hw, hd, hw - r, hd);
    path.lineTo(-hw + r, hd);
    path.quadraticCurveTo(-hw, hd, -hw, hd - r);
    path.lineTo(-hw, -hd + r);
    path.quadraticCurveTo(-hw, -hd, -hw + r, -hd);
    return path;
  };
  const hw = w / 2 + MARGIN;
  const hd = d / 2 + MARGIN;
  const r = Math.min(0.12, hw, hd);
  const shape = rect(hw, hd, r, new Shape());
  shape.holes.push(rect(hw - LINE, hd - LINE, Math.max(r - LINE, 0.005), new Path()));
  return new ShapeGeometry(shape, 6);
}

export interface SelectionMark {
  group: Group;
  /** Moves the mark to the object, or hides it; true when anything changed. */
  select(objectId: string | null): boolean;
  /** Keeps a light's ring a readable size on screen as the view zooms. */
  setPixelsPerMetre(ppm: number): void;
  /** Turns a light's ring to face the camera, so it reads as a circle from any side. */
  orient(cameraQuaternion: Quaternion): void;
}

export function buildSelectionMark(pickables: readonly Pickable[]): SelectionMark {
  const group = new Group();
  group.visible = false;
  const material = new MeshBasicMaterial({
    color: SELECTION_COLOUR,
    transparent: true,
    opacity: 0.95,
    depthWrite: false,
    toneMapped: false,
    side: DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -4,
  });
  // The ring around a light is drawn over everything, faintly, so a lamp behind a sofa still shows
  // which one is picked.
  const through = material.clone();
  through.depthTest = false;
  through.opacity = 0.35;

  let floor: Mesh | null = null;
  const halo = new Mesh(new RingGeometry(0.84, 1, 64), material);
  const haloThrough = new Mesh(halo.geometry, through);
  haloThrough.renderOrder = 10;
  group.add(halo, haloThrough);

  let current: string | null = null;
  let haloRadius = 0;
  let pixelsPerMetre = 0;
  const scaleHalo = () => {
    const radius = pixelsPerMetre > 0 ? Math.max(haloRadius, HALO_MIN_PX / pixelsPerMetre) : haloRadius;
    halo.scale.setScalar(radius);
    haloThrough.scale.setScalar(radius);
  };
  return {
    group,
    setPixelsPerMetre(ppm) {
      if (ppm === pixelsPerMetre) return;
      pixelsPerMetre = ppm;
      scaleHalo();
    },
    orient(q) {
      halo.quaternion.copy(q);
      haloThrough.quaternion.copy(q);
    },
    select(objectId) {
      const item = objectId ? pickables.find((p) => p.id === objectId) : undefined;
      const next = item ? item.id : null;
      if (next === current) return false;
      current = next;
      if (floor) {
        group.remove(floor);
        floor.geometry.dispose();
        floor = null;
      }
      if (!item) {
        group.visible = false;
        return true;
      }
      group.visible = true;
      const [hx, hy, hz] = item.half;
      if (item.kind === "light") {
        const radius = Math.max(hx, hy, hz) + MARGIN;
        haloRadius = radius;
        for (const ring of [halo, haloThrough]) {
          ring.visible = true;
          ring.position.set(item.centre.x, item.centre.y, item.centre.z);
        }
        scaleHalo();
        floor = new Mesh(outline(radius * 2 - MARGIN * 2, radius * 2 - MARGIN * 2), material);
        floor.rotation.set(-Math.PI / 2, 0, 0);
        floor.position.set(item.centre.x, FLOOR_LIFT, item.centre.z);
        // A light high on a wall or the ceiling has no floor under it worth marking.
        floor.visible = item.centre.y - hy < 1.2;
      } else {
        halo.visible = false;
        haloThrough.visible = false;
        if (item.kind === "tv") {
          // The screen is marked where it hangs: a frame standing just in front of the panel.
          floor = new Mesh(outline(hx * 2, hy * 2), material);
          floor.position.set(item.centre.x, item.centre.y, item.centre.z + hz + 0.01);
        } else {
          floor = new Mesh(outline(hx * 2, hz * 2), material);
          floor.rotation.set(-Math.PI / 2, -item.angle, 0, "YXZ");
          floor.position.set(item.centre.x, FLOOR_LIFT, item.centre.z);
        }
      }
      group.add(floor);
      return true;
    },
  };
}
