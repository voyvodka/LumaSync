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
  Line,
  LineDashedMaterial,
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
import type { HueZone, RoomCorner, RoomDimensions } from "@/shared/contracts/roomMap";

import { zoneSceneBox } from "../../model/roomSpace";
import { zoneGrips } from "../../model/zoneGesture";
import { OVERLAY } from "./bloom";
import { floorBand } from "./selection";

const LABEL_PX = 22;
const LABEL_LIFT_PX = 12;
const FLOOR_LIFT = 0.006;
const TAG_PX = 18;
const TAG_GAP_PX = 6;
/** The far edges at the ceiling, and the near ones, which crossed the floor and its grips on screen. */
const CEILING_OPACITY = { far: 0.3, near: 0.12 };
/** The carried light's amber: in the zone's colour a light's box read as a second, small zone. */
const LIGHT_GHOST = 0xffb020;
/** Clear of the top bar. */
const TOP_NDC = 0.72;
const TOP_CORNERS = [
  [-1, -1],
  [-1, 1],
  [1, -1],
  [1, 1],
] as const;
const EDGE_OPACITY = 0.85;
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

// The same fight with the floor: a cube standing on it drew its bottom face in the planks' plane.
function offFloor(centre: number, size: number): [number, number] {
  const lo = Math.max(centre - size / 2, FLOOR_LIFT);
  const hi = Math.max(centre + size / 2, lo + 0.01);
  return [(lo + hi) / 2, hi - lo];
}

export interface ZoneLight {
  zoneId: string;
  rel: { x: number; y: number; z: number };
  half: readonly [number, number, number];
  /** From the zone point to the box's middle: a fixture's lit part is not where it is stored. */
  offset: { x: number; y: number; z: number };
}

export interface ZoneBoxes {
  group: Group;
  /** True when what is shown changed. */
  mark(marks: ZoneMarks | null): boolean;
  /** Its cube on `rect` (plan metres) at `centerZ` (Hue units), its lights with it, while held; null
   *  sets it down. */
  hold(zoneId: string, rect: ZoneRect | null, centerZ?: number): boolean;
  setPixelsPerMetre(ppm: number): void;
  orient(cameraQuaternion: Quaternion, camera?: Camera): void;
}

interface Pill {
  texture: CanvasTexture;
  aspect: number;
  /** Draws `text` again in place; true when its width changed. */
  set(text: string): boolean;
}

function pillTexture(px: number, colour: string | null, weight: number): Pill {
  const canvas = document.createElement("canvas");
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  // Drawn at twice the screen's pixels, so it stays sharp shrunk to `px`.
  const height = Math.round(px * 2 * Math.max(window.devicePixelRatio || 1, 1));
  const size = Math.round(height * 0.5);
  const css = getComputedStyle(document.body);
  const font = `${weight} ${size}px ${css.fontFamily || "sans-serif"}`;
  const ink = css.getPropertyValue("--lm-ink").trim() || "white";
  const r = height / 2;
  canvas.height = height;
  canvas.width = height;
  let shown = "";
  const pill: Pill = {
    texture,
    aspect: 1,
    set(text) {
      shown = text;
      const context = canvas.getContext("2d");
      if (!context) return false;
      const before = pill.aspect;
      context.font = font;
      const inset = colour ? r * 1.7 : r * 0.9;
      canvas.width = Math.ceil(context.measureText(text).width + inset + r * 0.9);
      canvas.height = height;
      const width = canvas.width;
      // Nearly solid: a tag on the TV's glow lost its text through a lighter pill.
      context.fillStyle = "rgba(14, 14, 20, 0.92)";
      // Two arcs, not `roundRect`: the WebKit of the oldest macOS supported has none.
      context.beginPath();
      context.arc(r, r, r, Math.PI / 2, (Math.PI * 3) / 2);
      context.arc(width - r, r, r, -Math.PI / 2, Math.PI / 2);
      context.fill();
      if (colour) {
        context.fillStyle = colour;
        context.beginPath();
        context.arc(r, r, size * 0.24, 0, Math.PI * 2);
        context.fill();
      }
      context.font = font;
      context.fillStyle = ink;
      context.textBaseline = "middle";
      context.fillText(text, inset, r + 1);
      texture.needsUpdate = true;
      pill.aspect = width / height;
      return pill.aspect !== before;
    },
  };
  // A text drawn before the app's font loaded would keep the fallback for good.
  if (document.fonts && !document.fonts.check(font)) void document.fonts.ready.then(() => shown && pill.set(shown));
  return pill;
}

// Half a centimetre lands either way by float noise; the card stores its zone in single precision.
const metres = (m: number) => `${(Math.round(m * 100 + 1e-6) / 100).toFixed(2)} m`;

const FOOTPRINT_CORNERS = [
  [-1, -1],
  [-1, 1],
  [1, -1],
  [1, 1],
] as const;

/** The room's outline at the ceiling, for a zone to be read against: the walls stand cut away below it.
 *  An edge per line, so each dashes along its own length and can fade on its own. */
function ceilingFrame(dims: RoomDimensions, outline: readonly RoomCorner[] | null): Group {
  const corners = outline && outline.length >= 3 ? outline : [
    { x: 0, y: 0 },
    { x: dims.widthMeters, y: 0 },
    { x: dims.widthMeters, y: dims.depthMeters },
    { x: 0, y: dims.depthMeters },
  ];
  const frame = new Group();
  frame.visible = false;
  corners.forEach((a, i) => {
    const b = corners[(i + 1) % corners.length]!;
    const geometry = new BufferGeometry();
    const at = (c: RoomCorner) => [c.x - dims.widthMeters / 2, dims.heightMeters, c.y - dims.depthMeters / 2];
    geometry.setAttribute("position", new Float32BufferAttribute([...at(a), ...at(b)], 3));
    // Over everything: the cut walls never reach it, and a zone's top in its plane would fight it.
    const edge = new Line(
      geometry,
      new LineDashedMaterial({ color: 0xffffff, dashSize: 0.12, gapSize: 0.08, transparent: true, opacity: CEILING_OPACITY.far, depthTest: false, depthWrite: false, toneMapped: false }),
    );
    edge.computeLineDistances();
    edge.renderOrder = 10;
    edge.userData.mid = new Vector3((a.x + b.x) / 2 - dims.widthMeters / 2, 0, (a.y + b.y) / 2 - dims.depthMeters / 2);
    frame.add(edge);
  });
  return frame;
}

export function buildZoneBoxes(
  zones: readonly HueZone[],
  dims: RoomDimensions,
  options: { lights?: readonly ZoneLight[]; outline?: readonly RoomCorner[] | null } = {},
): ZoneBoxes {
  const group = new Group();
  group.visible = false;
  group.userData[OVERLAY] = true;
  const built = zones.map((zone, i) => {
    const colour = zoneHex(zone.borderColor, i);
    const { centre, size } = zoneSceneBox(zone, dims);
    const [x, w] = offWalls(centre.x, size.x, dims.widthMeters);
    const [z, d] = offWalls(centre.z, size.z, dims.depthMeters);
    const h = Math.max(size.y, 0.01);
    const [y, tall] = offFloor(centre.y, h);
    const tint = { color: colour, transparent: true, depthWrite: false, toneMapped: false };
    // The whole cube, its four sides drawn at once: the near ones went missing when only the far showed.
    const fill = new Mesh(new BoxGeometry(w, tall, d), new MeshBasicMaterial({ ...tint, side: BackSide, opacity: HELD_FILL_OPACITY }));
    const edges = new LineSegments(new EdgesGeometry(new BoxGeometry(w, tall, d)), new LineBasicMaterial({ ...tint, opacity: EDGE_OPACITY }));
    const foot = new Mesh(
      floorBand(w, d, 0, 0.025),
      new MeshBasicMaterial({ color: colour, transparent: true, depthWrite: false, side: DoubleSide, toneMapped: false, polygonOffset: true, polygonOffsetFactor: -4 }),
    );
    foot.rotation.x = -Math.PI / 2;
    foot.position.y = FLOOR_LIFT;
    const name = pillTexture(LABEL_PX, colour, 600);
    name.set(zone.name);
    // Over everything, so a zone behind a wall or the sofa is still named.
    const label = new Mesh(
      new PlaneGeometry(name.aspect, 1),
      new MeshBasicMaterial({ map: name.texture, transparent: true, depthTest: false, depthWrite: false, toneMapped: false }),
    );
    label.renderOrder = 11;
    // Its footprint stays on the floor under the cube, so a raised zone still marks the patch below it.
    fill.position.y = y;
    edges.position.y = y;
    const one = new Group();
    one.position.set(x, 0, z);
    one.add(fill, edges, foot, label);
    one.visible = false;
    group.add(one);
    const reach = { x, z, w, d, base: Math.max(centre.y - h / 2, 0), top: Math.min(centre.y + h / 2, dims.heightMeters) };
    return { id: zone.id, colour, one, fill, edges, foot, label, reach, half: new Vector3(w / 2, y + tall / 2, d / 2) };
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

  const tags = (["base", "top"] as const).map(() => {
    const pill = pillTexture(TAG_PX, null, 600);
    const mesh = new Mesh(new PlaneGeometry(1, 1), new MeshBasicMaterial({ map: pill.texture, transparent: true, depthTest: false, depthWrite: false, toneMapped: false }));
    mesh.renderOrder = 11;
    return { pill, mesh, text: "" };
  });
  const measure = new Group();
  measure.name = "zone-reach";
  measure.visible = false;
  measure.add(...tags.map((t) => t.mesh));
  group.add(measure);
  const ceiling = ceilingFrame(dims, options.outline ?? null);
  ceiling.name = "zone-ceiling";
  group.add(ceiling);
  // The held zone's lights go with it, as the carried light's box does, until the room is built again.
  const lightGhosts = (options.lights ?? []).map((light) => {
    const box = new LineSegments(
      new EdgesGeometry(new BoxGeometry(light.half[0] * 2, Math.max(light.half[1] * 2, 0.05), light.half[2] * 2)),
      new LineBasicMaterial({ ...ghostTint, color: LIGHT_GHOST, opacity: 0.9 }),
    );
    box.name = "zone-light";
    box.visible = false;
    group.add(box);
    return { light, box };
  });

  let marked: ZoneMarks | null = null;
  let held: string | null = null;
  let shown = "";
  let ppm = 0;
  let reach: (typeof built)[number]["reach"] | null = null;
  const right = new Vector3();
  const toward = new Vector3();
  const showReach = (next: typeof reach) => {
    reach = next;
    measure.visible = next !== null;
    ceiling.visible = next !== null;
    if (!next) return;
    for (const [tag, m] of [[tags[0]!, next.base], [tags[1]!, next.top]] as const) {
      const text = metres(m);
      if (text === tag.text) continue;
      tag.text = text;
      tag.pill.set(text);
    }
  };
  const placeTags = () => {
    if (!reach || ppm <= 0) return;
    const r = reach;
    const [sx, sz] = FOOTPRINT_CORNERS.reduce((best, c) =>
      c[0] * r.w * right.x + c[1] * r.d * right.z > best[0] * r.w * right.x + best[1] * r.d * right.z ? c : best,
    );
    for (const [tag, y] of [[tags[0]!, r.base], [tags[1]!, r.top]] as const) {
      const tall = TAG_PX / ppm;
      const wide = tag.pill.aspect * tall;
      tag.mesh.scale.set(wide, tall, 1);
      tag.mesh.position.set(r.x + (sx * r.w) / 2, Math.max(y, FLOOR_LIFT), r.z + (sz * r.d) / 2).addScaledVector(right, wide / 2 + TAG_GAP_PX / ppm);
    }
  };
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
    for (const { id, one, fill, edges, foot, label } of built) {
      const active = marks?.active === id;
      one.visible = id !== held && (active || Boolean(marks?.others.includes(id)));
      any ||= one.visible;
      // The others are their footprint alone, so several zones leave the floor readable.
      fill.visible = active;
      edges.visible = active;
      foot.material.opacity = active ? FOOT.active : FOOT.other;
      label.visible = active;
    }
    group.visible = any || held !== null;
    if (held === null) showReach(built.find((b) => b.id === marks?.active && b.one.visible)?.reach ?? null);
    placeGrips();
    placeTags();
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
        for (const { box } of lightGhosts) box.visible = false;
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
      const [y, tall] = offFloor(centreY, height);
      ghost.scale.set(w, tall, d);
      ghost.position.set(x, y, z);
      ghost.visible = true;
      group.visible = true;
      const across = { x: (rect.x0 + rect.x1) / 2 - dims.widthMeters / 2, z: (rect.y0 + rect.y1) / 2 - dims.depthMeters / 2 };
      const edge = rect.x1 - rect.x0;
      for (const { light, box } of lightGhosts) {
        box.visible = light.zoneId === zoneId;
        if (!box.visible) continue;
        // Hue's y runs toward the screen wall, the scene's z away from it.
        box.position.set(
          across.x + (light.rel.x * edge) / 2 + light.offset.x,
          centreY + (light.rel.z * height) / 2 + light.offset.y,
          across.z - (light.rel.y * (rect.y1 - rect.y0)) / 2 + light.offset.z,
        );
      }
      showReach({ x, z, w, d, base: Math.max(centreY - height / 2, 0), top: Math.min(centreY + height / 2, dims.heightMeters) });
      placeTags();
      return true;
    },
    setPixelsPerMetre(next) {
      if (next === ppm || next <= 0) return;
      ppm = next;
      for (const { label } of built) label.scale.setScalar(LABEL_PX / ppm);
      for (const rim of grips.children) rim.scale.setScalar(GRIP_PX / ppm);
      placeTags();
    },
    // The highest top corner still in view: over the top's middle the name sat on the lamp inside.
    orient(q, camera) {
      up.set(0, 1, 0).applyQuaternion(q);
      right.set(1, 0, 0).applyQuaternion(q);
      toward.set(0, 0, 1).applyQuaternion(q);
      for (const edge of ceiling.children as Line<BufferGeometry, LineDashedMaterial>[]) {
        const mid = edge.userData.mid as Vector3;
        edge.material.opacity = mid.x * toward.x + mid.z * toward.z > 0 ? CEILING_OPACITY.near : CEILING_OPACITY.far;
      }
      camera?.updateMatrixWorld();
      for (const { mesh } of tags) mesh.quaternion.copy(q);
      placeTags();
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
