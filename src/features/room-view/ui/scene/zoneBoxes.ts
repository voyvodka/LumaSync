// The Hue zones while the room is edited: each one's box, drawn in its colour, the one being worked
// on brighter and named. Built with the scene and only shown or hidden after, so picking a zone
// costs no build.
import {
  BackSide,
  BoxGeometry,
  CanvasTexture,
  Color,
  DoubleSide,
  EdgesGeometry,
  Group,
  LineDashedMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  type Quaternion,
  SRGBColorSpace,
  Vector3,
} from "three";

import { zoneHex } from "@/features/room-map/model/zoneColor";
import type { ZoneMarks } from "@/features/room-map/model/zoneMarks";
import type { HueZone, RoomDimensions } from "@/shared/contracts/roomMap";

import { zoneSceneBox } from "../../model/roomSpace";
import { OVERLAY } from "./bloom";
import { floorBand } from "./selection";

/** The name's height on screen, whatever the zoom. */
const LABEL_PX = 22;
/** How far over the box's highest corner on screen the name floats. */
const LABEL_LIFT_PX = 12;
const DASH_PX = 8;
const GAP_PX = 6;
const FLOOR_LIFT = 0.006;
// One side only: both faces of a box stacked every pixel twice and read at double the opacity.
const FILL = { active: 0.06, other: 0.02 };
const EDGE = { active: 0.5, other: 0.3 };
const FOOT = { active: 0.9, other: 0.3 };

export interface ZoneBoxes {
  group: Group;
  /** True when what is shown changed. */
  mark(marks: ZoneMarks | null): boolean;
  setPixelsPerMetre(ppm: number): void;
  orient(cameraQuaternion: Quaternion): void;
}

function nameTexture(name: string, colour: string): { texture: CanvasTexture; aspect: number } {
  const canvas = document.createElement("canvas");
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  // Drawn at twice the screen's pixels, so it stays sharp shrunk to `LABEL_PX`.
  const height = Math.round(LABEL_PX * 2 * Math.max(window.devicePixelRatio || 1, 1));
  const text = Math.round(height * 0.5);
  const font = `600 ${text}px ${getComputedStyle(document.body).fontFamily || "sans-serif"}`;
  const r = height / 2;
  canvas.height = height;
  canvas.width = height;
  const draw = () => {
    const context = canvas.getContext("2d");
    if (!context) return;
    context.font = font;
    canvas.width = Math.ceil(context.measureText(name).width + height * 1.4);
    canvas.height = height;
    const width = canvas.width;
    context.fillStyle = "rgba(14, 14, 20, 0.86)";
    // Two arcs, not `roundRect`: the WebKit of the oldest macOS supported has none.
    context.beginPath();
    context.arc(r, r, r, Math.PI / 2, (Math.PI * 3) / 2);
    context.arc(width - r, r, r, -Math.PI / 2, Math.PI / 2);
    context.fill();
    context.fillStyle = colour;
    context.beginPath();
    context.arc(r, r, text * 0.24, 0, Math.PI * 2);
    context.fill();
    context.font = font;
    context.fillStyle = "#f4f4f6";
    context.textBaseline = "middle";
    context.fillText(name, r * 1.7, r + 1);
    texture.needsUpdate = true;
  };
  draw();
  // A name drawn before the app's font loaded would keep the fallback for good.
  if (document.fonts && !document.fonts.check(font)) void document.fonts.ready.then(draw);
  return { texture, aspect: canvas.width / height };
}

export function buildZoneBoxes(zones: readonly HueZone[], dims: RoomDimensions): ZoneBoxes {
  const group = new Group();
  group.visible = false;
  group.userData[OVERLAY] = true;
  const built = zones.map((zone, i) => {
    const colour = zoneHex(zone.borderColor, i);
    const { centre, size } = zoneSceneBox(zone, dims);
    const w = Math.max(size.x, 0.01);
    const h = Math.max(size.y, 0.01);
    const d = Math.max(size.z, 0.01);
    const box = new BoxGeometry(w, h, d);
    const fill = new Mesh(box, new MeshBasicMaterial({ color: colour, transparent: true, depthWrite: false, side: BackSide, toneMapped: false }));
    // Lightened so the dashes hold against a lit floor.
    const edges = new LineSegments(
      new EdgesGeometry(box),
      new LineDashedMaterial({ color: new Color(colour).lerp(new Color(0xffffff), 0.3), transparent: true, depthWrite: false, toneMapped: false }),
    );
    edges.computeLineDistances();
    // Where the zone meets the floor, drawn as the selection's outline is.
    const foot = new Mesh(
      floorBand(w, d, 0, 0.025),
      new MeshBasicMaterial({ color: colour, transparent: true, depthWrite: false, side: DoubleSide, toneMapped: false, polygonOffset: true, polygonOffsetFactor: -4 }),
    );
    foot.rotation.x = -Math.PI / 2;
    foot.position.y = FLOOR_LIFT - centre.y;
    const { texture, aspect } = nameTexture(zone.name, colour);
    // Over everything, so a zone behind a wall or the sofa is still named.
    const label = new Mesh(
      new PlaneGeometry(aspect, 1),
      new MeshBasicMaterial({ map: texture, transparent: true, depthTest: false, depthWrite: false, toneMapped: false }),
    );
    label.renderOrder = 11;
    const one = new Group();
    one.position.set(centre.x, centre.y, centre.z);
    one.add(fill, edges, foot, label);
    one.visible = false;
    group.add(one);
    return { id: zone.id, one, fill, edges, foot, label, half: new Vector3(w / 2, h / 2, d / 2) };
  });

  let shown = "";
  let ppm = 0;
  const up = new Vector3();
  const corner = new Vector3();
  return {
    group,
    mark(marks) {
      const key = marks ? `${marks.active}|${marks.others.join()}` : "";
      if (key === shown) return false;
      shown = key;
      let any = false;
      for (const { id, one, fill, edges, foot, label } of built) {
        const active = marks?.active === id;
        one.visible = active || Boolean(marks?.others.includes(id));
        any ||= one.visible;
        fill.material.opacity = active ? FILL.active : FILL.other;
        edges.material.opacity = active ? EDGE.active : EDGE.other;
        foot.material.opacity = active ? FOOT.active : FOOT.other;
        label.visible = active;
      }
      group.visible = any;
      return true;
    },
    setPixelsPerMetre(next) {
      if (next === ppm || next <= 0) return;
      ppm = next;
      for (const { edges, label } of built) {
        edges.material.dashSize = DASH_PX / ppm;
        edges.material.gapSize = GAP_PX / ppm;
        label.scale.setScalar(LABEL_PX / ppm);
      }
    },
    // Over the top corner highest on screen: over the top face's middle, it sat on the lamp inside.
    orient(q) {
      up.set(0, 1, 0).applyQuaternion(q);
      for (const { label, half } of built) {
        if (!label.visible) continue;
        let best = Number.NEGATIVE_INFINITY;
        for (const sx of [-1, 1]) {
          for (const sz of [-1, 1]) {
            const height = up.x * sx * half.x + up.y * half.y + up.z * sz * half.z;
            if (height > best) {
              best = height;
              corner.set(sx * half.x, half.y, sz * half.z);
            }
          }
        }
        label.quaternion.copy(q);
        label.position.copy(corner).addScaledVector(up, ppm > 0 ? (LABEL_LIFT_PX + LABEL_PX / 2) / ppm : 0);
      }
    },
  };
}
