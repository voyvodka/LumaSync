import { type RoomMapConfig, resolveRoomFootprint } from "@/shared/contracts/roomMap";
import { hueToPlanMetres, resolveHueChannelWorld } from "./hueChannelPosition";
import { furnitureObjectId, hueChannelObjectId, parseObjectId, TV_ANCHOR_OBJECT_ID } from "./objectId";

export interface ObjectRect {
  id: string;
  x: number; // meters, top-left
  y: number;
  w: number;
  h: number;
  /** Degrees about its middle. Only a quarter turn has edges on the plan's axes. */
  r?: number;
  /** A wall offers the one axis it runs across, not its ends or middle. */
  axis?: "x" | "y";
  /** The mirror of another light across the screen's middle, at this x: met on both axes at once. */
  mirror?: number;
}

export type SnapGuideKind = "edge" | "centre" | "line" | "wall" | "mirror";

export interface SnapGuide {
  axis: "x" | "y";
  position: number; // meters
  kind?: SnapGuideKind;
  /** Where along the line its label sits: the mirror's line is named level with the light. */
  at?: number;
}

export interface SnapResult {
  snapX: number | null; // snapped x position (meters), null if no snap
  snapY: number | null;
  guides: SnapGuide[];
}

/** What a drag is held to, carried from one move to the next so it lets go further out than it caught. */
export interface SnapHold {
  x?: string;
  y?: string;
  mirror?: string;
}

export interface SnapOptions {
  /** Past this a held target lets go; within `threshold` a new one catches. */
  release?: number;
  hold?: SnapHold;
}

/** Engage and release radii on screen: never pulled from far, and no chatter at the edge. The
 *  engage radius is the plan's soft grid reach, so a guide never lets go where the grid still holds. */
export const SNAP_ENGAGE_PX = 10;
export const SNAP_RELEASE_PX = 14;
/** A room fitted small makes a few pixels a long way: a target past this never pulls. */
const SNAP_REACH_MAX_M = 0.15;

/** A screen radius in the plan's metres, never further than `SNAP_REACH_MAX_M`. */
export function snapReach(px: number, metresPerPx: number): number {
  return Math.min(px * metresPerPx, SNAP_REACH_MAX_M * (px / SNAP_RELEASE_PX));
}

export const SNAP_THRESHOLD_M = 0.08; // ~5px at typical zoom

/** How far, in screen pixels, a press may wander and still be a click rather than a drag. 3 px let
 *  a trackpad click's wobble move what was only being selected. */
export const CLICK_SLOP_PX = 6;

/** A press that never left its spot selects; snapping it to the grid would move a piece nobody dragged. */
export function isClick(startX: number, startY: number, endX: number, endY: number): boolean {
  return Math.hypot(endX - startX, endY - startY) < CLICK_SLOP_PX;
}

const quarterTurned = (r: number | undefined) => Math.abs(((r ?? 0) % 90) + 90) % 90 < 1e-6;
const sideways = (r: number | undefined) => Math.abs((((r ?? 0) % 180) + 180) % 180 - 90) < 1e-6;

/** The box a piece covers on the plan's axes; a piece turned off a quarter offers its middle alone. */
function onAxes(rect: ObjectRect): ObjectRect {
  if (rect.r === undefined || rect.r === 0) return rect;
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  if (!quarterTurned(rect.r)) return { ...rect, x: cx, y: cy, w: 0, h: 0 };
  const [w, h] = sideways(rect.r) ? [rect.h, rect.w] : [rect.w, rect.h];
  return { ...rect, x: cx - w / 2, y: cy - h / 2, w, h };
}

export function getObjectRects(config: RoomMapConfig, excludeId: string): ObjectRect[] {
  const rects: ObjectRect[] = [];
  const dragged = parseObjectId(excludeId)?.kind;

  if (config.tvAnchor && excludeId !== TV_ANCHOR_OBJECT_ID) {
    const tv = config.tvAnchor;
    rects.push({ id: TV_ANCHOR_OBJECT_ID, x: tv.x, y: tv.y, w: tv.width, h: tv.height });
  }

  for (const f of config.furniture) {
    const fId = furnitureObjectId(f.id);
    if (fId === excludeId) continue;
    rects.push(f.rotation ? { id: fId, x: f.x, y: f.y, w: f.width, h: f.height, r: f.rotation } : { id: fId, x: f.x, y: f.y, w: f.width, h: f.height });
  }

  // Lights line up with lights; a sofa caught on every bulb would never sit where it was put.
  if (dragged === "hue") {
    const { widthMeters, depthMeters } = config.dimensions;
    // The screen faces into the room from the plan's top, so its middle is a line down the plan.
    const middle = config.tvAnchor ? config.tvAnchor.x + config.tvAnchor.width / 2 : null;
    for (const ch of config.hueChannels) {
      const id = hueChannelObjectId(ch.channelIndex);
      if (id === excludeId) continue;
      const at = hueToPlanMetres(resolveHueChannelWorld(ch, config.zones), widthMeters, depthMeters);
      rects.push({ id, x: at.x, y: at.y, w: 0, h: 0 });
      if (middle !== null && Math.abs(at.x - middle) > 1e-6) rects.push({ id: `${id}~mirror`, x: 2 * middle - at.x, y: at.y, w: 0, h: 0, mirror: middle });
    }
  }

  // A piece goes flush against a wall it is brought to; a light hangs where it is put.
  if (dragged === "furniture" || excludeId === TV_ANCHOR_OBJECT_ID) {
    const corners = resolveRoomFootprint(config);
    corners.forEach((a, i) => {
      const b = corners[(i + 1) % corners.length]!;
      if (a.x === b.x && a.y !== b.y) rects.push({ id: `wall-${i}`, x: a.x, y: Math.min(a.y, b.y), w: 0, h: Math.abs(b.y - a.y), axis: "x" });
      else if (a.y === b.y && a.x !== b.x) rects.push({ id: `wall-${i}`, x: Math.min(a.x, b.x), y: a.y, w: Math.abs(b.x - a.x), h: 0, axis: "y" });
    });
  }

  // Origin (room center) as a zero-size rect so objects snap to it
  const ox = config.dimensions.widthMeters / 2;
  const oy = config.dimensions.depthMeters / 2;
  rects.push({ id: "__origin", x: ox, y: oy, w: 0, h: 0 });

  return rects;
}

type Role = "start" | "end" | "centre";
const ROLES: readonly [Role, Role][] = [
  ["start", "start"],
  ["end", "end"],
  ["centre", "centre"],
  ["start", "end"],
  ["end", "start"],
];

function guideKind(other: ObjectRect, role: Role): SnapGuideKind {
  if (other.axis) return "wall";
  if (other.w === 0 && other.h === 0) return other.id === "__origin" ? "centre" : "line";
  return role === "centre" ? "centre" : "edge";
}

interface AxisPick {
  key: string;
  diff: number;
  delta: number;
  guides: SnapGuide[];
}

/** Per axis: the target held from the last move while it is within `release`, else the nearest within `threshold`. */
function pickAxis(axis: "x" | "y", dragging: ObjectRect, others: readonly ObjectRect[], threshold: number, release: number, held: string | undefined): AxisPick | null {
  const lo = (r: ObjectRect) => (axis === "x" ? r.x : r.y);
  const size = (r: ObjectRect) => (axis === "x" ? r.w : r.h);
  const at = (r: ObjectRect, role: Role) => lo(r) + (role === "start" ? 0 : role === "end" ? size(r) : size(r) / 2);
  let best: AxisPick | null = null;
  let kept: AxisPick | null = null;
  for (const other of others) {
    if (other.mirror !== undefined || (other.axis && other.axis !== axis)) continue;
    const target = onAxes(other);
    for (const [mine, theirs] of ROLES) {
      if (other.axis && theirs !== "start") continue;
      const dragVal = at(dragging, mine);
      const otherVal = at(target, theirs);
      const diff = Math.abs(dragVal - otherVal);
      const key = `${other.id}:${mine}:${theirs}`;
      const guide: SnapGuide = { axis, position: otherVal, kind: guideKind(other, theirs) };
      if (key === held && diff < release) kept = { key, diff, delta: otherVal - dragVal, guides: [guide] };
      if (diff < (best?.diff ?? threshold)) best = { key, diff, delta: otherVal - dragVal, guides: [guide] };
      else if (best && diff === best.diff && !best.guides.some((g) => g.position === otherVal)) best.guides.push(guide);
    }
  }
  return kept ?? best;
}

export function computeSnap(
  dragging: ObjectRect,
  others: ObjectRect[],
  threshold: number,
  options: SnapOptions = {},
): SnapResult & { hold: SnapHold } {
  const release = Math.max(options.release ?? threshold, threshold);
  const hold = options.hold ?? {};
  const box = onAxes(dragging);

  // A light's mirror across the screen outranks a line: it is the pair being set up.
  let mirror: ObjectRect | null = null;
  let mirrorDiff = threshold;
  for (const other of others) {
    if (other.mirror === undefined) continue;
    const diff = Math.hypot(box.x + box.w / 2 - other.x, box.y + box.h / 2 - other.y);
    if (other.id === hold.mirror && diff < release) {
      mirror = other;
      break;
    }
    if (diff < mirrorDiff) {
      mirrorDiff = diff;
      mirror = other;
    }
  }
  if (mirror) {
    const dx = mirror.x - (box.x + box.w / 2);
    const dy = mirror.y - (box.y + box.h / 2);
    return {
      snapX: dragging.x + dx,
      snapY: dragging.y + dy,
      guides: [
        { axis: "x", position: mirror.mirror!, kind: "mirror", at: mirror.y },
        { axis: "y", position: mirror.y, kind: "line" },
      ],
      hold: { mirror: mirror.id },
    };
  }

  const x = pickAxis("x", box, others, threshold, release, hold.x);
  const y = pickAxis("y", box, others, threshold, release, hold.y);
  return {
    snapX: x ? dragging.x + x.delta : null,
    snapY: y ? dragging.y + y.delta : null,
    guides: [...(x?.guides ?? []), ...(y?.guides ?? [])],
    hold: { ...(x ? { x: x.key } : {}), ...(y ? { y: y.key } : {}) },
  };
}
