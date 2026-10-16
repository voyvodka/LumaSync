// The Hue zones while the room is edited: each one's box, drawn in its colour, the one being worked
// on brighter and named. Built with the scene and only shown or hidden after, so picking a zone
// costs no build.
import {
  BoxGeometry,
  CanvasTexture,
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
} from "three";

import { zoneHex } from "@/features/room-map/model/zoneColor";
import type { ZoneMarks } from "@/features/room-map/model/zoneMarks";
import type { HueZone, RoomDimensions } from "@/shared/contracts/roomMap";

import { zoneSceneBox } from "../../model/roomSpace";

/** The name's height on screen, whatever the zoom. */
const LABEL_PX = 22;
/** How far over the box's top the name floats, in pixels. */
const LABEL_LIFT_PX = 16;
const TEXT_PX = 26;
const FILL = { active: 0.07, other: 0.025 };
const EDGE = { active: 0.85, other: 0.3 };

export interface ZoneBoxes {
  group: Group;
  /** True when what is shown changed. */
  mark(marks: ZoneMarks | null): boolean;
  setPixelsPerMetre(ppm: number): void;
  orient(cameraQuaternion: Quaternion): void;
}

function nameTexture(name: string, colour: string): { texture: CanvasTexture; aspect: number } {
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  const font = `600 ${TEXT_PX}px ${getComputedStyle(document.body).fontFamily || "sans-serif"}`;
  const height = TEXT_PX * 2;
  let width = height;
  if (context) {
    context.font = font;
    width = Math.ceil(context.measureText(name).width) + height * 1.4;
  }
  canvas.width = width;
  canvas.height = height;
  if (context) {
    const r = height / 2;
    context.fillStyle = "rgba(14, 14, 20, 0.86)";
    // Two arcs, not `roundRect`: the WebKit of the oldest macOS supported has none.
    context.beginPath();
    context.arc(r, r, r, Math.PI / 2, (Math.PI * 3) / 2);
    context.arc(width - r, r, r, -Math.PI / 2, Math.PI / 2);
    context.fill();
    context.fillStyle = colour;
    context.beginPath();
    context.arc(r, r, TEXT_PX * 0.24, 0, Math.PI * 2);
    context.fill();
    context.font = font;
    context.fillStyle = "#f4f4f6";
    context.textBaseline = "middle";
    context.fillText(name, r * 1.7, r + 1);
  }
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  return { texture, aspect: width / height };
}

export function buildZoneBoxes(zones: readonly HueZone[], dims: RoomDimensions): ZoneBoxes {
  const group = new Group();
  group.visible = false;
  const built = zones.map((zone, i) => {
    const colour = zoneHex(zone.borderColor, i);
    const { centre, size } = zoneSceneBox(zone, dims);
    const box = new BoxGeometry(Math.max(size.x, 0.01), Math.max(size.y, 0.01), Math.max(size.z, 0.01));
    const fill = new Mesh(box, new MeshBasicMaterial({ color: colour, transparent: true, depthWrite: false, side: DoubleSide, toneMapped: false }));
    const edges = new LineSegments(
      new EdgesGeometry(box),
      new LineDashedMaterial({ color: colour, dashSize: 0.08, gapSize: 0.06, transparent: true, depthWrite: false, toneMapped: false }),
    );
    edges.computeLineDistances();
    const { texture, aspect } = nameTexture(zone.name, colour);
    // Over everything, so a zone behind a wall or the sofa is still named.
    const label = new Mesh(
      new PlaneGeometry(aspect, 1),
      new MeshBasicMaterial({ map: texture, transparent: true, depthTest: false, depthWrite: false, toneMapped: false }),
    );
    label.renderOrder = 11;
    const one = new Group();
    one.position.set(centre.x, centre.y, centre.z);
    one.add(fill, edges, label);
    one.visible = false;
    group.add(one);
    return { id: zone.id, one, fill, edges, label, top: size.y / 2 };
  });

  let shown = "";
  let ppm = 0;
  const placeLabels = () => {
    if (ppm <= 0) return;
    for (const { label, top } of built) {
      label.scale.setScalar(LABEL_PX / ppm);
      label.position.y = top + (LABEL_LIFT_PX + LABEL_PX / 2) / ppm;
    }
  };
  return {
    group,
    mark(marks) {
      const key = marks ? `${marks.active}|${marks.others.join()}` : "";
      if (key === shown) return false;
      shown = key;
      let any = false;
      for (const { id, one, fill, edges, label } of built) {
        const active = marks?.active === id;
        one.visible = active || Boolean(marks?.others.includes(id));
        any ||= one.visible;
        fill.material.opacity = active ? FILL.active : FILL.other;
        edges.material.opacity = active ? EDGE.active : EDGE.other;
        label.visible = active;
      }
      group.visible = any;
      return true;
    },
    setPixelsPerMetre(next) {
      if (next === ppm) return;
      ppm = next;
      placeLabels();
    },
    orient(q) {
      for (const { label } of built) label.quaternion.copy(q);
    },
  };
}
