// The selection's mark in the room: an amber outline on the floor around what is selected, and for
// a light a second ring around the lit part itself. Built once per scene and moved, never rebuilt,
// so a new selection costs one draw.
import { DoubleSide, Group, Mesh, MeshBasicMaterial, type Object3D, Path, type Quaternion, RingGeometry, Shape, ShapeGeometry } from "three";

import type { Pickable } from "../../model/picking";
import { PLUMB_FROM, plumbGuide } from "./plumb";

/** `--lm-amber`. */
export const SELECTION_COLOUR = 0xffb020;
/** How far the floor outline stands off the piece it marks. */
const MARGIN = 0.07;
const LINE = 0.03;
/** Just over the floor and its decals, under everything standing on it. */
const FLOOR_LIFT = 0.006;
/** A light's ring never shrinks below this radius on screen, however far the view zooms out. */
const HALO_MIN_PX = 20;

/** A strip's frame hugs its tape: the floor outline's margin round a centimetre-wide line read as a
 *  slab. */
const STRIP_MARGIN = 0.025;
const STRIP_LINE = 0.012;

/** A rounded-rectangle band `line` wide around a `w` × `d` rectangle, in the xy plane. */
function outline(w: number, d: number, margin = MARGIN, line = LINE): ShapeGeometry {
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
  const hw = w / 2 + margin;
  const hd = d / 2 + margin;
  const r = Math.min(0.12, hw, hd);
  const shape = rect(hw, hd, r, new Shape());
  shape.holes.push(rect(hw - line, hd - line, Math.max(r - line, 0.005), new Path()));
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

  let floor: Object3D | null = null;
  const plumb = plumbGuide(1, SELECTION_COLOUR);
  plumb.group.visible = false;
  group.add(plumb.group);
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
      plumb.group.visible = false;
      if (floor) {
        group.remove(floor);
        floor.traverse((o) => {
          if (o instanceof Mesh) o.geometry.dispose();
        });
        floor = null;
      }
      if (!item) {
        group.visible = false;
        return true;
      }
      group.visible = true;
      const [hx, hy, hz] = item.half;
      if (item.line) {
        // A ring sized to a strip's length circled half the room. A bent strip is framed leg by leg.
        halo.visible = false;
        haloThrough.visible = false;
        const legs = new Group();
        for (const leg of item.legs ?? [item]) {
          const [lx, ly, lz] = leg.half;
          const lying = ly < lz;
          const frame = new Mesh(outline(lx * 2, Math.max(ly, lz) * 2, STRIP_MARGIN, STRIP_LINE), material);
          if (lying) frame.rotation.set(-Math.PI / 2, -leg.angle, 0, "YXZ");
          else frame.rotation.set(0, -leg.angle, 0);
          frame.position.set(leg.centre.x, lying ? FLOOR_LIFT : leg.centre.y, leg.centre.z);
          legs.add(frame);
        }
        floor = legs;
      } else if (item.kind === "light") {
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
        // A light high on a wall or the ceiling is shown its floor by a plumb line instead.
        const bottom = item.centre.y - hy;
        floor.visible = bottom < PLUMB_FROM;
        if (!floor.visible) {
          plumb.setTop(bottom);
          plumb.group.position.set(item.centre.x, 0, item.centre.z);
          plumb.group.visible = true;
        }
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
