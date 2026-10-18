// Built with the scene and only shown or hidden after, so picking a zone builds nothing.
import {
  BackSide,
  BoxGeometry,
  BufferGeometry,
  type Camera,
  CanvasTexture,
  DoubleSide,
  EdgesGeometry,
  Float32BufferAttribute,
  Group,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  type Quaternion,
  SRGBColorSpace,
  Vector3,
} from "three";

import { hueToMetres } from "@/features/room-map/model/hueChannelPosition";
import { zoneHex } from "@/features/room-map/model/zoneColor";
import type { ZoneMarks } from "@/features/room-map/model/zoneMarks";
import type { ZoneRect } from "@/features/room-map/model/zoneRect";
import type { HueZone, RoomDimensions } from "@/shared/contracts/roomMap";

import { zoneSceneBox } from "../../model/roomSpace";
import { zoneGrips } from "../../model/zoneGesture";
import { OVERLAY } from "./bloom";
import { floorBand } from "./selection";

const LABEL_PX = 22;
const LABEL_LIFT_PX = 12;
const FLOOR_LIFT = 0.006;
// The whole cube reads as a cage over the furniture, so at rest only a low wall rises from its bottom.
const WALL_M = 0.45;
/** Clear of the top bar and the carry hint under it. */
const TOP_NDC = 0.72;
const TOP_CORNERS = [
  [-1, -1],
  [-1, 1],
  [1, -1],
  [1, 1],
] as const;
const WALL_OPACITY = 0.16;
const POST_OPACITY = 0.6;
const FOOT = { active: 0.9, other: 0.35 };
/** The plan's zone grip: a 10 px mark, amber round the app's ground, one size on screen. */
const GRIP_PX = 10;
const GRIP_INNER_PX = 7;
const GRIP_RIM = 0xffb020;
const GRIP_FILL = 0x0e0e14;
const HELD_FILL_OPACITY = 0.07;
// A zone flush with a wall drew its side in the wall's own plane, and the two fought for the pixel.
const WALL_GAP = 0.01;

function offWalls(centre: number, size: number, room: number): [number, number] {
  const lo = Math.max(centre - size / 2, -room / 2 + WALL_GAP);
  const hi = Math.min(centre + size / 2, room / 2 - WALL_GAP);
  return [(lo + hi) / 2, Math.max(hi - lo, 0.01)];
}

export interface ZoneBoxes {
  group: Group;
  /** True when what is shown changed. */
  mark(marks: ZoneMarks | null): boolean;
  /** Its whole cube on `rect` (plan metres) at `centerZ` (Hue units) in place of its low wall while
   *  held; null sets it down. */
  hold(zoneId: string, rect: ZoneRect | null, centerZ?: number): boolean;
  setPixelsPerMetre(ppm: number): void;
  orient(cameraQuaternion: Quaternion, camera?: Camera): void;
}

function nameTexture(name: string, colour: string): { texture: CanvasTexture; aspect: number } {
  const canvas = document.createElement("canvas");
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  // Drawn at twice the screen's pixels, so it stays sharp shrunk to `LABEL_PX`.
  const height = Math.round(LABEL_PX * 2 * Math.max(window.devicePixelRatio || 1, 1));
  const text = Math.round(height * 0.5);
  const css = getComputedStyle(document.body);
  const font = `600 ${text}px ${css.fontFamily || "sans-serif"}`;
  const ink = css.getPropertyValue("--lm-ink").trim() || "white";
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
    context.fillStyle = ink;
    context.textBaseline = "middle";
    context.fillText(name, r * 1.7, r + 1);
    texture.needsUpdate = true;
  };
  draw();
  // A name drawn before the app's font loaded would keep the fallback for good.
  if (document.fonts && !document.fonts.check(font)) void document.fonts.ready.then(draw);
  return { texture, aspect: canvas.width / height };
}

const SIDES = [
  [-1, 1],
  [1, 1],
  [1, -1],
  [-1, -1],
] as const;

/** Wound outward and drawn from the back, so only the far sides show and nothing covers the room. */
function fadingWall(w: number, d: number, h: number): BufferGeometry {
  const position: number[] = [];
  const colour: number[] = [];
  for (let i = 0; i < 4; i++) {
    const [px, pz] = SIDES[i]!;
    const [qx, qz] = SIDES[(i + 1) % 4]!;
    const p = [(px * w) / 2, (pz * d) / 2];
    const q = [(qx * w) / 2, (qz * d) / 2];
    for (const [x, y, z] of [
      [p[0], 0, p[1]],
      [q[0], 0, q[1]],
      [q[0], h, q[1]],
      [p[0], 0, p[1]],
      [q[0], h, q[1]],
      [p[0], h, p[1]],
    ] as const) {
      position.push(x!, y, z!);
      colour.push(1, 1, 1, y === 0 ? 1 : 0);
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(position, 3));
  geometry.setAttribute("color", new Float32BufferAttribute(colour, 4));
  return geometry;
}

function cornerPosts(w: number, d: number, h: number): BufferGeometry {
  const position: number[] = [];
  const colour: number[] = [];
  for (const [sx, sz] of SIDES) {
    position.push((sx * w) / 2, 0, (sz * d) / 2, (sx * w) / 2, h, (sz * d) / 2);
    colour.push(1, 1, 1, 1, 1, 1, 1, 0);
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(position, 3));
  geometry.setAttribute("color", new Float32BufferAttribute(colour, 4));
  return geometry;
}

export function buildZoneBoxes(zones: readonly HueZone[], dims: RoomDimensions): ZoneBoxes {
  const group = new Group();
  group.visible = false;
  group.userData[OVERLAY] = true;
  const built = zones.map((zone, i) => {
    const colour = zoneHex(zone.borderColor, i);
    const { centre, size } = zoneSceneBox(zone, dims);
    const [x, w] = offWalls(centre.x, size.x, dims.widthMeters);
    const [z, d] = offWalls(centre.z, size.z, dims.depthMeters);
    const h = Math.max(size.y, 0.01);
    const wallH = Math.min(h, WALL_M);
    const bottom = Math.max(centre.y - h / 2, 0);
    const tint = { color: colour, transparent: true, depthWrite: false, toneMapped: false, vertexColors: true };
    const wall = new Mesh(fadingWall(w, d, wallH), new MeshBasicMaterial({ ...tint, side: BackSide, opacity: WALL_OPACITY }));
    const posts = new LineSegments(cornerPosts(w, d, wallH), new LineBasicMaterial({ ...tint, opacity: POST_OPACITY }));
    const foot = new Mesh(
      floorBand(w, d, 0, 0.025),
      new MeshBasicMaterial({ color: colour, transparent: true, depthWrite: false, side: DoubleSide, toneMapped: false, polygonOffset: true, polygonOffsetFactor: -4 }),
    );
    foot.rotation.x = -Math.PI / 2;
    foot.position.y = FLOOR_LIFT;
    const { texture, aspect } = nameTexture(zone.name, colour);
    // Over everything, so a zone behind a wall or the sofa is still named.
    const label = new Mesh(
      new PlaneGeometry(aspect, 1),
      new MeshBasicMaterial({ map: texture, transparent: true, depthTest: false, depthWrite: false, toneMapped: false }),
    );
    label.renderOrder = 11;
    // Its footprint stays on the floor under the cube, so a raised zone still marks the patch below it.
    wall.position.y = bottom;
    posts.position.y = bottom;
    const one = new Group();
    one.position.set(x, 0, z);
    one.add(wall, posts, foot, label);
    one.visible = false;
    group.add(one);
    return { id: zone.id, one, wall, posts, foot, label, half: new Vector3(w / 2, bottom + wallH, d / 2) };
  });

  const grips = new Group();
  grips.visible = false;
  for (const { at } of zoneGrips({ x0: -0.5, y0: -0.5, x1: 0.5, y1: 0.5 })) {
    const over = { transparent: true, depthTest: false, depthWrite: false, toneMapped: false };
    const rim = new Mesh(new PlaneGeometry(1, 1), new MeshBasicMaterial({ ...over, color: GRIP_RIM }));
    const fill = new Mesh(new PlaneGeometry(GRIP_INNER_PX / GRIP_PX, GRIP_INNER_PX / GRIP_PX), new MeshBasicMaterial({ ...over, color: GRIP_FILL }));
    rim.renderOrder = 12;
    fill.renderOrder = 13;
    rim.add(fill);
    rim.userData.at = at;
    grips.add(rim);
  }
  group.add(grips);

  const ghostTint = { transparent: true, depthWrite: false, toneMapped: false };
  const ghost = new Group();
  const ghostEdges = new LineSegments(new EdgesGeometry(new BoxGeometry(1, 1, 1)), new LineBasicMaterial({ ...ghostTint, opacity: 0.9 }));
  const ghostFill = new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial({ ...ghostTint, side: BackSide, opacity: HELD_FILL_OPACITY }));
  ghost.add(ghostFill, ghostEdges);
  ghost.visible = false;
  group.add(ghost);

  let marked: ZoneMarks | null = null;
  let held: string | null = null;
  let shown = "";
  let ppm = 0;
  const placeGrips = () => {
    const at = built.find((b) => b.id === marked?.held && b.one.visible);
    grips.visible = at !== undefined && held === null;
    if (!at) return;
    grips.position.set(at.one.position.x, 0, at.one.position.z);
    for (const rim of grips.children) {
      const unit = rim.userData.at as { x: number; y: number };
      rim.position.set(unit.x * at.half.x * 2, 0, unit.y * at.half.z * 2);
    }
  };
  const up = new Vector3();
  const corner = new Vector3();
  const probe = new Vector3();
  const mark = (marks: ZoneMarks | null): boolean => {
    const key = marks ? `${marks.active}|${marks.held}|${marks.others.join()}` : "";
    if (key === shown) return false;
    shown = key;
    marked = marks;
    let any = false;
    for (const { id, one, wall, posts, foot, label } of built) {
      const active = marks?.active === id;
      one.visible = id !== held && (active || Boolean(marks?.others.includes(id)));
      any ||= one.visible;
      // The others are their footprint alone, so several zones leave the floor readable.
      wall.visible = active;
      posts.visible = active;
      foot.material.opacity = active ? FOOT.active : FOOT.other;
      label.visible = active;
    }
    group.visible = any || held !== null;
    placeGrips();
    return true;
  };
  return {
    group,
    mark,
    hold(zoneId, rect, centerZ) {
      const zone = zones.find((z) => z.id === zoneId);
      const at = built.find((b) => b.id === zoneId);
      if (!rect || !zone || !at) {
        if (held === null) return false;
        held = null;
        ghost.visible = false;
        shown = "";
        mark(marked);
        return true;
      }
      held = zoneId;
      at.one.visible = false;
      grips.visible = false;
      const colour = zoneHex(zone.borderColor, zones.indexOf(zone));
      ghostEdges.material.color.set(colour);
      ghostFill.material.color.set(colour);
      const height = Math.min(rect.x1 - rect.x0, dims.heightMeters);
      const centreY = hueToMetres(centerZ ?? zone.centerZ, dims.heightMeters);
      const [x, w] = offWalls((rect.x0 + rect.x1) / 2 - dims.widthMeters / 2, rect.x1 - rect.x0, dims.widthMeters);
      const [z, d] = offWalls((rect.y0 + rect.y1) / 2 - dims.depthMeters / 2, rect.y1 - rect.y0, dims.depthMeters);
      ghost.scale.set(w, Math.max(height, 0.01), d);
      ghost.position.set(x, centreY, z);
      ghost.visible = true;
      group.visible = true;
      return true;
    },
    setPixelsPerMetre(next) {
      if (next === ppm || next <= 0) return;
      ppm = next;
      for (const { label } of built) label.scale.setScalar(LABEL_PX / ppm);
      for (const rim of grips.children) rim.scale.setScalar(GRIP_PX / ppm);
    },
    // The highest top corner still in view: over the top's middle the name sat on the lamp inside.
    orient(q, camera) {
      up.set(0, 1, 0).applyQuaternion(q);
      camera?.updateMatrixWorld();
      for (const rim of grips.children) rim.quaternion.copy(q);
      const lift = ppm > 0 ? (LABEL_LIFT_PX + LABEL_PX) / ppm : 0;
      for (const { one, label, half } of built) {
        if (!label.visible) continue;
        const corners = TOP_CORNERS.map(([sx, sz]) => new Vector3(sx * half.x, half.y, sz * half.z)).sort((a, b) => up.dot(b) - up.dot(a));
        const fits = (c: Vector3) => !camera || probe.copy(c).addScaledVector(up, lift).add(one.position).project(camera).y < TOP_NDC;
        corner.copy(corners.find(fits) ?? corners[corners.length - 1]!);
        label.quaternion.copy(q);
        label.position.copy(corner).addScaledVector(up, ppm > 0 ? (LABEL_LIFT_PX + LABEL_PX / 2) / ppm : 0);
      }
    },
  };
}
