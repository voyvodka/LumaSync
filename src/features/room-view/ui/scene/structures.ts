// The room's own build in the 3D view. A door is a real gap in its wall, as the reference draws a
// doorway, so it reads in a cut wall's stub too; a window or a niche is drawn on the wall's face —
// a hole would notch a wall that stands lower than the window's top. Columns and beams stand at the
// walls' height with the walls' cap: at the ceiling, over 70% walls, they read as stray planks.
import { BoxGeometry, BufferAttribute, type BufferGeometry, Color, CylinderGeometry, Matrix4 } from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

import { hangHeight } from "@/features/room-map/model/hueHang";
import { anchorWallItem } from "@/features/room-map/model/roomStructures";
import {
  type BeamStructure,
  type ColumnStructure,
  DECOR_LIGHT_KELVIN,
  type DecorLightFixture,
  type DoorStructure,
  type NicheStructure,
  type RoomMapConfig,
  STRUCTURE_KINDS,
  type WallColor,
  type WindowStructure,
} from "@/shared/contracts/roomMap";
import { isWallStructure, resolveRoomStructures } from "@/shared/contracts/roomStructureResolver";
import { kelvinToRgb } from "@/shared/lib/color";

import type { OutlineEdge } from "../../model/roomOutline";
import { WALL_PALETTE } from "../../model/surfaceColours";
import { openRuns, WALL_THICKNESS, type WallGap } from "./environment";
import { PALETTE } from "./palette";
import { block, type Part, transformParts } from "./parts";

const FRAME = 0xeceae4;
/** Dusk sky in the pane's upper part, darker below: one flat tone read as a switched-off screen. */
const PANE = 0x26304a;
const PANE_SKY = 0x3d4f75;
/** Under 30° the leaf read as a shut door, and in slate it matched the pane and the niche's back. */
const DOOR_AJAR = (30 * Math.PI) / 180;
const CASING = 0.05;
const FRAME_BAR = 0.05;
const FRAME_PROUD = 0.03;
/** A window's top stays this far under its wall's: the reference never notches a wall's top. */
const WINDOW_HEADROOM = 0.15;

export interface StructurePlan {
  /** Door gaps, by edge index. */
  gaps: Map<number, WallGap[]>;
  /** What is drawn on a wall's face, by edge index; hidden while the wall is cut. */
  wallParts: Map<number, Part[]>;
  columns: ColumnStructure[];
  beams: BeamStructure[];
}

interface Placed {
  edge: number;
  e: OutlineEdge;
  alongX: boolean;
  /** The item's middle along the wall's axis, and the wall's inner face across it, in scene metres. */
  along: number;
  face: number;
  /** Into the room, on the across axis. */
  inward: 1 | -1;
  width: number;
}

function place(item: WindowStructure | DoorStructure | NicheStructure, config: RoomMapConfig, edges: readonly OutlineEdge[]): Placed | null {
  const anchor = anchorWallItem(item, config);
  if (!anchor) return null;
  const { widthMeters: W, depthMeters: D } = config.dimensions;
  const face = anchor.alongX ? anchor.at - D / 2 : anchor.at - W / 2;
  const along = anchor.alongX ? anchor.centre - W / 2 : anchor.centre - D / 2;
  const edge = edges.findIndex((e) => {
    const alongX = e.outwardZ !== 0;
    if (alongX !== anchor.alongX) return false;
    const [lo, hi, at] = alongX ? [Math.min(e.ax, e.bx), Math.max(e.ax, e.bx), e.az] : [Math.min(e.az, e.bz), Math.max(e.az, e.bz), e.ax];
    return Math.abs(at - face) < 1e-6 && along >= lo - 1e-6 && along <= hi + 1e-6;
  });
  if (edge < 0) return null;
  const e = edges[edge]!;
  return { edge, e, alongX: anchor.alongX, along, face, inward: anchor.inward, width: anchor.width };
}

/** A box `w` along the wall, `h` tall from `y`, `t` thick from `across` into the room. */
function slab(p: Placed, along: number, w: number, y: number, h: number, across: number, t: number, colour: number): Part {
  const mid = p.face + p.inward * (across + t / 2);
  return p.alongX ? block(w, h, t, along, y, mid, colour, 0.004) : block(t, h, w, mid, y, along, colour, 0.004);
}

function windowParts(p: Placed, item: WindowStructure, top: number): Part[] {
  const w = p.width;
  const sill = item.sillMeters;
  const head = Math.min(sill + item.heightMeters, top);
  if (head - sill < FRAME_BAR * 3) return [];
  const h = head - sill;
  const left = p.along - w / 2 + FRAME_BAR / 2;
  const right = p.along + w / 2 - FRAME_BAR / 2;
  return [
    // The pane sits behind the frame's face, so the frame reads as a reveal.
    slab(p, p.along, w - FRAME_BAR, sill, h * 0.55, 0, 0.012, PANE),
    slab(p, p.along, w - FRAME_BAR, sill + h * 0.55, h * 0.45, 0, 0.012, PANE_SKY),
    slab(p, left, FRAME_BAR, sill, h, 0, FRAME_PROUD, FRAME),
    slab(p, right, FRAME_BAR, sill, h, 0, FRAME_PROUD, FRAME),
    slab(p, p.along, w, head - FRAME_BAR, FRAME_BAR, 0, FRAME_PROUD, FRAME),
    slab(p, p.along, FRAME_BAR * 0.6, sill, h, 0, FRAME_PROUD * 0.8, FRAME),
    slab(p, p.along, w + 0.08, sill - 0.03, 0.03, 0, 0.06, FRAME),
  ];
}

// No real hollow fits a 10 cm wall, and lips round the niche read as a picture frame.
function nicheParts(p: Placed, item: NicheStructure, top: number, paint: WallColor): Part[] {
  const look = WALL_PALETTE[paint] ?? WALL_PALETTE.warmWhite;
  const tone = (k: number) => new Color(look.wall).multiplyScalar(k).getHex();
  const w = p.width;
  const bottom = item.bottomMeters;
  const head = Math.min(bottom + item.heightMeters, top);
  if (head - bottom < 0.2) return [];
  const h = head - bottom;
  const band = 0.08;
  return [
    slab(p, p.along, w, bottom, h - 2 * band, 0, 0.008, tone(0.88)),
    slab(p, p.along, w, head - 2 * band, band, 0, 0.008, tone(0.7)),
    slab(p, p.along, w, head - band, band, 0, 0.008, tone(0.5)),
    slab(p, p.along, w, bottom - 0.025, 0.025, 0, Math.min(item.depth, 0.07), look.cap),
  ];
}

function doorParts(p: Placed, item: DoorStructure, standing: number, paint: WallColor): Part[] {
  const height = Math.min(item.heightMeters, standing - 0.05);
  if (height < 0.3) return [];
  // Facing the wall from inside, the outward direction, and its left.
  const outward = { x: p.e.outwardX, z: p.e.outwardZ };
  const left = { x: outward.z, z: -outward.x };
  const sign = item.hinge === "left" ? 1 : -1;
  const middle = p.alongX ? { x: p.along, z: p.face } : { x: p.face, z: p.along };
  const hinge = {
    x: middle.x + left.x * sign * (p.width / 2) + outward.x * 0.05,
    z: middle.z + left.z * sign * (p.width / 2) + outward.z * 0.05,
  };
  const closed = { x: -left.x * sign, z: -left.z * sign };
  const open = item.swing === "in" ? { x: -outward.x, z: -outward.z } : outward;
  const dir = {
    x: closed.x * Math.cos(DOOR_AJAR) + open.x * Math.sin(DOOR_AJAR),
    z: closed.z * Math.cos(DOOR_AJAR) + open.z * Math.sin(DOOR_AJAR),
  };
  const leaf: Part = { ...block(p.width - 0.02, height - 0.01, 0.04, 0, 0, 0, PALETTE.oakDark, 0.006), finish: "wood" };
  const handle = block(0.1, 0.02, 0.08, (p.width - 0.02) / 2 - 0.08, 1.0, 0, FRAME, 0.006);
  const swung = [leaf, handle];
  const centre = { x: hinge.x + (dir.x * p.width) / 2, z: hinge.z + (dir.z * p.width) / 2 };
  transformParts(swung, new Matrix4().makeTranslation(centre.x, 0, centre.z).multiply(new Matrix4().makeRotationY(Math.atan2(-dir.z, dir.x))));
  const look = WALL_PALETTE[paint] ?? WALL_PALETTE.warmWhite;
  const parts = [...swung];
  const lintel = standing - height - 0.005;
  if (lintel > 0.01) {
    parts.push(slab(p, p.along, p.width, height, lintel, -WALL_THICKNESS, WALL_THICKNESS, look.wall));
    parts.push(slab(p, p.along, p.width, standing - 0.005, 0.005, -WALL_THICKNESS, WALL_THICKNESS, look.cap));
  }
  const side = p.width / 2 + CASING / 2;
  parts.push(
    slab(p, p.along - side, CASING, 0, height + CASING, 0, 0.02, FRAME),
    slab(p, p.along + side, CASING, 0, height + CASING, 0, 0.02, FRAME),
    slab(p, p.along, p.width, height, CASING, 0, 0.02, FRAME),
  );
  return parts;
}

export interface DecorLight {
  x: number;
  y: number;
  fixture: DecorLightFixture;
  /** Its lit part's height, metres. */
  height: number;
  colour: number;
}

export function decorLights(config: RoomMapConfig, ceiling: number): DecorLight[] {
  const out: DecorLight[] = [];
  for (const s of resolveRoomStructures(config)) {
    if (s.kind !== STRUCTURE_KINDS.LIGHT) continue;
    const { r, g, b } = kelvinToRgb(s.kelvin ?? DECOR_LIGHT_KELVIN);
    const height = s.dropMeters !== undefined ? Math.max(ceiling - s.dropMeters, 0.3) : (hangHeight(s.fixture, ceiling) ?? ceiling);
    out.push({ x: s.x, y: s.y, fixture: s.fixture, height, colour: (r << 16) | (g << 8) | b });
  }
  return out;
}

/** How high the walls must stand to keep every window and niche under their top, or 0. */
export function openingsTop(config: RoomMapConfig): number {
  let top = 0;
  for (const s of resolveRoomStructures(config)) {
    if (s.kind === STRUCTURE_KINDS.WINDOW) top = Math.max(top, s.sillMeters + s.heightMeters + WINDOW_HEADROOM);
    if (s.kind === STRUCTURE_KINDS.NICHE) top = Math.max(top, s.bottomMeters + s.heightMeters + WINDOW_HEADROOM);
  }
  return top;
}

export function doorGaps(config: RoomMapConfig, edges: readonly OutlineEdge[]): Map<number, WallGap[]> {
  const gaps = new Map<number, WallGap[]>();
  for (const s of resolveRoomStructures(config)) {
    if (s.kind !== STRUCTURE_KINDS.DOOR) continue;
    const p = place(s, config, edges);
    if (!p) continue;
    gaps.set(p.edge, [...(gaps.get(p.edge) ?? []), { from: p.along - p.width / 2, to: p.along + p.width / 2 }]);
  }
  return gaps;
}

/** Built into the floor, so it stays when the wall is cut. */
export function thresholds(gaps: ReadonlyMap<number, readonly WallGap[]>, edges: readonly OutlineEdge[]): Part[] {
  const parts: Part[] = [];
  for (const [i, list] of gaps) {
    const e = edges[i];
    if (!e) continue;
    const alongX = e.outwardZ !== 0;
    for (const gap of list) {
      const mid = (gap.from + gap.to) / 2;
      const length = gap.to - gap.from;
      const x = alongX ? mid : e.ax + (e.outwardX * WALL_THICKNESS) / 2;
      const z = alongX ? e.az + (e.outwardZ * WALL_THICKNESS) / 2 : mid;
      parts.push(alongX ? block(length, 0.015, WALL_THICKNESS, x, 0, z, PALETTE.skirting, 0.004) : block(WALL_THICKNESS, 0.015, length, x, 0, z, PALETTE.skirting, 0.004));
    }
  }
  return parts;
}

/** Where every structure goes, under walls `standing` high: the doors' gaps in their walls, what is
 *  drawn on the walls' faces, and the columns and beams to build. */
export function planStructures(config: RoomMapConfig, edges: readonly OutlineEdge[], paint: WallColor, standing: number): StructurePlan {
  const structures = resolveRoomStructures(config);
  const gaps = doorGaps(config, edges);
  const wallParts = new Map<number, Part[]>();
  const top = standing - 0.03;
  for (const s of structures) {
    if (!isWallStructure(s)) continue;
    const p = place(s, config, edges);
    if (!p) continue;
    const parts =
      s.kind === STRUCTURE_KINDS.DOOR ? doorParts(p, s, standing, paint) : s.kind === STRUCTURE_KINDS.WINDOW ? windowParts(p, s, top) : nicheParts(p, s, top, paint);
    if (parts.length > 0) wallParts.set(p.edge, [...(wallParts.get(p.edge) ?? []), ...parts]);
  }
  return {
    gaps,
    wallParts,
    columns: structures.filter((s): s is ColumnStructure => s.kind === STRUCTURE_KINDS.COLUMN),
    beams: structures.filter((s): s is BeamStructure => s.kind === STRUCTURE_KINDS.BEAM),
  };
}

/** Paints a unit-tall geometry as a wall: its top the cap, its sides darkening toward the floor. */
export function paintAsWall(geometry: BufferGeometry, paint: WallColor): BufferGeometry {
  const position = geometry.getAttribute("position");
  const normal = geometry.getAttribute("normal");
  const look = WALL_PALETTE[paint] ?? WALL_PALETTE.warmWhite;
  const wall = new Color(look.wall);
  const cap = new Color(look.cap);
  const shade = new Color();
  const colours = new Float32Array(position.count * 3);
  for (let i = 0; i < position.count; i++) {
    const c = normal.getY(i) > 0.5 ? cap : shade.copy(wall).multiplyScalar(0.86 + 0.14 * position.getY(i));
    colours.set([c.r, c.g, c.b], i * 3);
  }
  geometry.setAttribute("color", new BufferAttribute(colours, 3));
  return geometry;
}

/** One wall along its axis with its doors' gaps left open, unit tall: `centre` is the mesh's place
 *  on that axis, `span` its length. */
export function gappedWallGeometry(alongX: boolean, span: number, centre: number, gaps: readonly WallGap[], thickness: number, paint: WallColor): BufferGeometry | null {
  const pieces: BufferGeometry[] = [];
  for (const [from, to] of openRuns(centre - span / 2, centre + span / 2, gaps)) {
    const length = to - from;
    const box = new BoxGeometry(alongX ? length : thickness, 1, alongX ? thickness : length);
    const offset = (from + to) / 2 - centre;
    box.translate(alongX ? offset : 0, 0.5, alongX ? 0 : offset);
    pieces.push(box.toNonIndexed());
    box.dispose();
  }
  if (pieces.length === 0) return null;
  const merged = mergeGeometries(pieces);
  for (const piece of pieces) piece.dispose();
  return merged ? paintAsWall(merged, paint) : null;
}

/** A column, unit tall: a square or round shaft its footprint's size. */
export function columnGeometry(column: ColumnStructure, paint: WallColor): BufferGeometry {
  const geometry =
    column.shape === "round"
      ? new CylinderGeometry(column.width / 2, column.width / 2, 1, 24)
      : new BoxGeometry(column.width, 1, column.depth);
  if (column.shape === "round") geometry.scale(1, 1, column.depth / column.width);
  geometry.translate(0, 0.5, 0);
  return paintAsWall(geometry, paint);
}

/** A beam from end to end, `dropMeters` deep, its top at `top`. */
export function beamGeometry(beam: BeamStructure, dims: RoomMapConfig["dimensions"], top: number, paint: WallColor): BufferGeometry {
  const ax = beam.x1 - dims.widthMeters / 2;
  const az = beam.y1 - dims.depthMeters / 2;
  const bx = beam.x2 - dims.widthMeters / 2;
  const bz = beam.y2 - dims.depthMeters / 2;
  const length = Math.max(Math.hypot(bx - ax, bz - az), 0.05);
  const drop = Math.min(beam.dropMeters, top - 0.2);
  const geometry = new BoxGeometry(length, 1, beam.width);
  geometry.translate(0, 0.5, 0);
  paintAsWall(geometry, paint);
  geometry.scale(1, drop, 1);
  geometry.applyMatrix4(new Matrix4().makeTranslation((ax + bx) / 2, top - drop, (az + bz) / 2).multiply(new Matrix4().makeRotationY(Math.atan2(-(bz - az), bx - ax))));
  return geometry;
}
