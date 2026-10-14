// Parametric furniture, built in code from rounded boxes and cylinders: every model stretches to
// the piece's own width and depth instead of distorting a fixed asset, and every part stays inside
// the footprint the room map gives it.
import type { FurniturePlacement, RoomMapConfig } from "@/shared/contracts/roomMap";

import { tvMountHeight } from "../../model/roomSpace";
import { PALETTE } from "./palette";
import { ball, block, hashString, type Part, rod, seeded } from "./parts";

/** How a piece is drawn. The four stored types say little on their own — a "table" is a desk
 *  under the screen and a coffee table in front of a sofa, a "sofa" 0.8 m wide is an armchair — so
 *  the model is read from the piece's size and from what stands around it, as a person reads a
 *  floor plan. */
export type FurnitureModel =
  | { kind: "upholstered"; seats: number; arms: boolean }
  | { kind: "diningChair" }
  | { kind: "officeChair" }
  | { kind: "bench" }
  /** `screenX`: where the screen stands along the desk, in its frame; null on a desk's return. */
  | { kind: "desk"; screenX: number | null }
  | { kind: "coffeeTable" }
  | { kind: "sideTable"; round: boolean }
  | { kind: "diningTable" }
  | { kind: "cabinet"; doors: number };

/** Where a seat stops being a chair and becomes an armchair; also the narrowest piece with arms. */
const ARMCHAIR_MIN_WIDTH = 0.62;
/** A seat cushion's width; a sofa gets as many as fit between its arms. */
const SEAT_WIDTH = 0.62;
const MAX_SEATS = 5;
const SIDE_TABLE_MAX_SIDE = 0.65;
const COFFEE_TABLE_MAX_AREA = 1.6;
/** How far from a sofa a low table still reads as its coffee table. */
const COFFEE_TABLE_REACH = 1.8;
/** How close a table must stand to a desk to read as its return (an L desk). */
const DESK_RETURN_GAP = 0.08;
/** How close a small chair must stand to a desk to read as its office chair. */
const OFFICE_CHAIR_REACH = 1.0;
/** A screen whose bottom edge is lower than this is not standing on a desk. */
const MONITOR_MIN_BOTTOM = 0.55;
export const DESK_TOP = 0.755;

interface Rect {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

function centreOf(item: FurniturePlacement): { x: number; y: number } {
  return { x: item.x + item.width / 2, y: item.y + item.height / 2 };
}

/** The footprint's bounding box in room metres, rotation included. */
function boundsOf(item: FurniturePlacement): Rect {
  const { x, y } = centreOf(item);
  const a = ((item.rotation ?? 0) * Math.PI) / 180;
  const hw = (Math.abs(Math.cos(a)) * item.width + Math.abs(Math.sin(a)) * item.height) / 2;
  const hh = (Math.abs(Math.sin(a)) * item.width + Math.abs(Math.cos(a)) * item.height) / 2;
  return { x0: x - hw, x1: x + hw, y0: y - hh, y1: y + hh };
}

function gapBetween(a: Rect, b: Rect): number {
  const gx = Math.max(0, a.x0 - b.x1, b.x0 - a.x1);
  const gy = Math.max(0, a.y0 - b.y1, b.y0 - a.y1);
  return Math.hypot(gx, gy);
}

/** A room point in the piece's own frame: x across its width, y across its depth. */
function toLocal(item: FurniturePlacement, px: number, py: number): { x: number; y: number } {
  const c = centreOf(item);
  const a = (-(item.rotation ?? 0) * Math.PI) / 180;
  const dx = px - c.x;
  const dy = py - c.y;
  return { x: dx * Math.cos(a) - dy * Math.sin(a), y: dx * Math.sin(a) + dy * Math.cos(a) };
}

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

function seating(width: number): { seats: number; arms: boolean } {
  const arms = width >= ARMCHAIR_MIN_WIDTH;
  const inner = width - 2 * (arms ? armWidth(width) : 0);
  return { seats: clamp(Math.round(inner / SEAT_WIDTH), 1, MAX_SEATS), arms };
}

const armWidth = (width: number) => clamp(width * 0.085, 0.1, 0.2);

/** Reads every piece's model from its size and its neighbours. */
export function classifyFurniture(config: RoomMapConfig): Map<string, FurnitureModel> {
  const models = new Map<string, FurnitureModel>();
  const items = config.furniture;
  const tv = config.tvAnchor;
  const screen = tv
    ? (() => {
        const height = tv.width * 0.5625;
        return {
          x: tv.x + tv.width / 2,
          y: tv.y + tv.height / 2,
          bottom: tvMountHeight(tv, config.dimensions) - height / 2,
        };
      })()
    : null;

  const sofas = items.filter((f) => f.type === "sofa" || (f.type === "chair" && f.width > ARMCHAIR_MIN_WIDTH && f.height >= 0.45));
  for (const f of items) {
    if (f.type === "sofa") models.set(f.id, { kind: "upholstered", ...seating(f.width) });
  }

  const desks: FurniturePlacement[] = [];
  const tables = items.filter((f) => f.type === "table");
  for (const f of tables) {
    if (!screen || screen.bottom < MONITOR_MIN_BOTTOM) continue;
    const local = toLocal(f, screen.x, screen.y);
    if (Math.abs(local.x) <= f.width / 2 + 0.05 && Math.abs(local.y) <= f.height / 2 + 0.3) {
      models.set(f.id, { kind: "desk", screenX: clamp(local.x, -f.width / 2, f.width / 2) });
      desks.push(f);
    }
  }
  for (const f of tables) {
    if (models.has(f.id)) continue;
    if (desks.some((desk) => gapBetween(boundsOf(f), boundsOf(desk)) <= DESK_RETURN_GAP)) {
      models.set(f.id, { kind: "desk", screenX: null });
      desks.push(f);
    }
  }
  for (const f of tables) {
    if (models.has(f.id)) continue;
    if (Math.max(f.width, f.height) <= SIDE_TABLE_MAX_SIDE) {
      models.set(f.id, { kind: "sideTable", round: Math.abs(f.width - f.height) < 0.12 });
      continue;
    }
    const c = centreOf(f);
    const nearSofa = sofas.some((s) => {
      const sc = centreOf(s);
      return Math.hypot(sc.x - c.x, sc.y - c.y) <= COFFEE_TABLE_REACH;
    });
    models.set(f.id, nearSofa && f.width * f.height <= COFFEE_TABLE_MAX_AREA ? { kind: "coffeeTable" } : { kind: "diningTable" });
  }

  for (const f of items) {
    if (f.type === "chair") {
      if (f.width <= ARMCHAIR_MIN_WIDTH && f.height >= 0.3) {
        const atDesk = desks.some((desk) => gapBetween(boundsOf(f), boundsOf(desk)) <= OFFICE_CHAIR_REACH);
        models.set(f.id, { kind: atDesk ? "officeChair" : "diningChair" });
      } else if (f.height < 0.45) {
        models.set(f.id, { kind: "bench" });
      } else {
        models.set(f.id, { kind: "upholstered", ...seating(f.width) });
      }
    } else if (f.type === "other") {
      models.set(f.id, { kind: "cabinet", doors: clamp(Math.round(f.width / 0.45), 1, 6) });
    }
  }
  return models;
}

/** The height of the surface a piece offers on top, for what stands on it. */
export function surfaceTop(model: FurnitureModel): number {
  switch (model.kind) {
    case "desk":
      return DESK_TOP;
    case "coffeeTable":
      return 0.43;
    case "sideTable":
      return 0.55;
    case "diningTable":
      return 0.75;
    case "cabinet":
      return 0.805;
    case "bench":
      return 0.5;
    default:
      return 0.45;
  }
}

/** How dark the soft contact shadow under a piece is: a closed base shades the floor, legs barely. */
export function contactShade(model: FurnitureModel): number {
  switch (model.kind) {
    case "upholstered":
    case "cabinet":
      return 0.42;
    case "officeChair":
    case "sideTable":
      return 0.18;
    default:
      return 0.26;
  }
}

/** The piece as parts in its own frame: x across its width, z across its depth, origin at the
 *  footprint's centre on the floor. Unrotated, a seat faces the TV wall (−z), as the room
 *  templates place it. */
export function furnitureParts(item: FurniturePlacement, model: FurnitureModel): Part[] {
  const w = Math.max(item.width, 0.1);
  const d = Math.max(item.height, 0.1);
  const rand = seeded(hashString(item.id));
  switch (model.kind) {
    case "upholstered":
      return upholstered(w, d, model.seats, model.arms);
    case "diningChair":
      return diningChair(w, d);
    case "officeChair":
      return officeChair(w, d);
    case "bench":
      return bench(w, d);
    case "desk":
      return desk(w, d, model.screenX);
    case "coffeeTable":
      return coffeeTable(w, d, rand);
    case "sideTable":
      return sideTable(w, d, model.round);
    case "diningTable":
      return diningTable(w, d);
    case "cabinet":
      return cabinet(w, d, model.doors);
  }
}

function upholstered(w: number, d: number, seats: number, arms: boolean): Part[] {
  // One seat with arms reads as an armchair, so it takes the warm upholstery; a small armless
  // seat is a slipper chair; a sofa stays slate.
  const tone = arms && seats === 1 ? "caramel" : !arms ? "sage" : "slate";
  const main = tone === "caramel" ? PALETTE.caramel : tone === "sage" ? PALETTE.sage : PALETTE.slate;
  const deep = tone === "caramel" ? PALETTE.caramelDeep : tone === "sage" ? PALETTE.sage : PALETTE.slateDeep;
  const cushion = tone === "caramel" ? PALETTE.caramelCushion : tone === "sage" ? PALETTE.sage : PALETTE.slateCushion;

  const legH = arms ? 0.06 : 0.12;
  const baseTop = legH + 0.24;
  const seatTop = baseTop + 0.13;
  const backTop = seatTop + (d < 0.5 ? 0.26 : 0.4);
  const armW = arms ? armWidth(w) : 0;
  const armTop = baseTop + 0.29;
  const backD = clamp(d * 0.22, 0.06, 0.2);
  const inset = Math.min(0.07, w / 4, d / 4);

  const parts: Part[] = [];
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) parts.push(rod(0.016, 0.022, legH, sx * (w / 2 - inset), 0, sz * (d / 2 - inset), PALETTE.walnut, 10));
  }
  parts.push(block(w, baseTop - legH, d, 0, legH, 0, deep, 0.035));
  parts.push(block(w, backTop - baseTop, backD, 0, baseTop, d / 2 - backD / 2, main, 0.06));
  if (arms) {
    for (const sx of [-1, 1]) parts.push(block(armW, armTop - baseTop, d, sx * (w / 2 - armW / 2), baseTop, 0, main, 0.07));
  }

  const inner = w - 2 * armW;
  const seatW = inner / seats;
  const seatD = Math.max(d - backD - 0.02, 0.02);
  for (let i = 0; i < seats; i++) {
    const x = -inner / 2 + seatW * (i + 0.5);
    parts.push(block(seatW - 0.014, seatTop - baseTop + 0.012, seatD, x, baseTop - 0.006, -d / 2 + 0.01 + seatD / 2, cushion, 0.055));
  }

  if (d >= 0.45) {
    // Back cushions lean into the frame from their bottom-back edge; the lean is held so their
    // top never passes the back of the footprint.
    const lean = 0.17;
    const cushionD = clamp(d * 0.17, 0.06, 0.16);
    const h = backTop - seatTop - 0.03;
    const pivotZ = Math.min(d / 2 - backD + 0.025, d / 2 - 0.005 - h * Math.sin(lean));
    for (let i = 0; i < seats; i++) {
      const x = -inner / 2 + seatW * (i + 0.5);
      const back = block(seatW - 0.03, h, cushionD, 0, 0, -cushionD / 2, cushion, 0.06);
      back.geometry.rotateX(lean);
      back.geometry.translate(x, seatTop - 0.01, pivotZ);
      parts.push(back);
    }
    if (seats >= 2 && d >= 0.6) {
      const size = clamp(seatW * 0.55, 0.28, 0.42);
      [PALETTE.pillowCamel, PALETTE.pillowCream].forEach((color, k) => {
        const sx = k === 0 ? -1 : 1;
        const pillow = block(size, size, 0.12, 0, 0, 0, color, 0.05);
        pillow.geometry.rotateX(0.32);
        pillow.geometry.rotateY(sx * 0.3);
        pillow.geometry.translate(sx * (inner / 2 - size * 0.62), seatTop - 0.01, pivotZ - cushionD - 0.08);
        parts.push(pillow);
      });
    }
  }
  return parts;
}

function diningChair(w: number, d: number): Part[] {
  const legT = clamp(Math.min(w, d) * 0.08, 0.025, 0.04);
  const seatY = 0.43;
  const lx = w / 2 - legT / 2 - 0.01;
  const lz = d / 2 - legT / 2 - 0.01;
  const parts: Part[] = [];
  for (const sx of [-1, 1]) {
    parts.push(block(legT, seatY, legT, sx * lx, 0, -lz, PALETTE.walnut, 0.006));
    // The back legs carry on up as the back's posts.
    parts.push(block(legT, seatY + 0.46, legT, sx * lx, 0, lz, PALETTE.walnut, 0.006));
  }
  parts.push(block(w - 0.01, 0.045, d - 0.01, 0, seatY, 0, PALETTE.oak, 0.014));
  parts.push(block(Math.max(w - 0.07, 0.05), 0.03, Math.max(d - 0.09, 0.05), 0, seatY + 0.045, -0.015, PALETTE.sage, 0.014));
  parts.push(block(Math.max(w - 2 * legT - 0.02, 0.05), 0.2, 0.024, 0, seatY + 0.24, lz, PALETTE.oak, 0.01));
  return parts;
}

function officeChair(w: number, d: number): Part[] {
  const caster = Math.min(0.03, Math.min(w, d) * 0.12);
  const reach = Math.max(Math.min(w, d) / 2 - caster - 0.005, 0.01);
  const hub = Math.min(0.06, reach);
  const parts: Part[] = [rod(hub * 0.8, hub, 0.05, 0, 0.04, 0, PALETTE.metal, 16)];
  for (let k = 0; k < 5; k++) {
    const a = (k / 5) * Math.PI * 2;
    const arm = block(reach, 0.03, Math.min(0.045, reach), reach / 2, 0.045, 0, PALETTE.metal, 0.01);
    arm.geometry.rotateY(a);
    parts.push(arm);
    parts.push(ball(caster, Math.cos(a) * reach, caster, -Math.sin(a) * reach, PALETTE.metal, 8));
  }
  parts.push(rod(0.024, 0.024, 0.32, 0, 0.09, 0, PALETTE.metalSoft, 12));
  parts.push(block(w - 0.04, 0.08, d - 0.06, 0, 0.41, -0.02, PALETTE.slate, 0.035));
  const back = block(w - 0.08, 0.44, 0.06, 0, 0, -0.03, PALETTE.slate, 0.03);
  back.geometry.rotateX(0.12);
  back.geometry.translate(0, 0.55, d / 2 - 0.08);
  parts.push(back);
  parts.push(block(0.05, 0.14, 0.04, 0, 0.45, d / 2 - 0.1, PALETTE.metal, 0.01));
  if (w >= 0.5) {
    for (const sx of [-1, 1]) {
      parts.push(block(0.035, 0.16, 0.035, sx * (w / 2 - 0.045), 0.49, 0, PALETTE.metal, 0.01));
      parts.push(block(0.06, 0.03, Math.min(0.26, d - 0.1), sx * (w / 2 - 0.045), 0.65, 0, PALETTE.metal, 0.012));
    }
  }
  return parts;
}

function bench(w: number, d: number): Part[] {
  const parts: Part[] = [
    block(w, 0.05, d, 0, 0.4, 0, PALETTE.oak, 0.015),
    block(Math.max(w - 0.04, 0.05), 0.05, Math.max(d - 0.02, 0.02), 0, 0.45, 0, PALETTE.sage, 0.02),
  ];
  const legs = Math.ceil(w / 1.4) + 1;
  for (let i = 0; i < legs; i++) {
    const x = -w / 2 + 0.1 + ((w - 0.2) * i) / (legs - 1);
    parts.push(block(0.05, 0.4, Math.max(d - 0.04, 0.02), x, 0, 0, PALETTE.walnut, 0.008));
  }
  return parts;
}

function desk(w: number, d: number, screenX: number | null): Part[] {
  const topY = DESK_TOP - 0.035;
  const parts: Part[] = [block(w, 0.035, d, 0, topY, 0, PALETTE.oak, 0.012)];
  // Open sled frames: two posts, a foot and a top rail per side, so the floor shows through.
  const frameD = Math.max(d - 0.08, 0.04);
  const post = Math.min(0.035, frameD / 4);
  for (const sx of [-1, 1]) {
    const x = sx * (w / 2 - 0.06);
    for (const sz of [-1, 1]) parts.push(block(post, topY, post, x, 0, sz * (frameD / 2 - post / 2), PALETTE.metal, 0.006));
    parts.push(block(post, 0.025, frameD, x, 0, 0, PALETTE.metal, 0.006));
    parts.push(block(post, 0.03, frameD, x, topY - 0.03, 0, PALETTE.metal, 0.006));
  }
  parts.push(block(Math.max(w - 0.16, 0.05), 0.04, 0.02, 0, topY - 0.12, d / 2 - 0.06, PALETTE.metal, 0.006));
  if (screenX !== null) {
    const kw = Math.min(0.44, w * 0.5);
    const kx = clamp(screenX, -w / 2 + kw / 2 + 0.02, w / 2 - kw / 2 - 0.02);
    const kz = -d / 2 + Math.min(0.2, d * 0.32);
    parts.push(block(kw, 0.018, Math.min(0.14, d * 0.3), kx, DESK_TOP, kz, PALETTE.keyboard, 0.006));
    const mx = clamp(kx + kw / 2 + 0.1, -w / 2 + 0.05, w / 2 - 0.05);
    parts.push(block(0.06, 0.022, Math.min(0.1, d * 0.2), mx, DESK_TOP, kz, PALETTE.keyboard, 0.02));
  }
  return parts;
}

function coffeeTable(w: number, d: number, rand: () => number): Part[] {
  const topY = 0.38;
  const parts: Part[] = [
    block(w, 0.05, d, 0, topY, 0, PALETTE.oak, 0.02),
    block(Math.max(w - 0.1, 0.05), 0.025, Math.max(d - 0.1, 0.05), 0, 0.1, 0, PALETTE.oakDark, 0.008),
  ];
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) parts.push(block(0.045, topY, 0.045, sx * (w / 2 - 0.05), 0, sz * (d / 2 - 0.05), PALETTE.walnut, 0.008));
  }
  // A book and a mug, placed by the piece's own seed: a table, not a slab.
  const bw = Math.min(0.24, w * 0.3);
  const bd = Math.min(0.17, d * 0.35);
  const bx = (rand() - 0.5) * (w - bw) * 0.5;
  const bz = (rand() - 0.5) * (d - bd) * 0.4;
  const book = block(bw, 0.03, bd, 0, 0, 0, PALETTE.bookRed, 0.004);
  book.geometry.rotateY(0.22);
  book.geometry.translate(bx, 0.43, bz);
  parts.push(book);
  const top = block(bw * 0.8, 0.025, bd * 0.8, 0, 0, 0, PALETTE.bookBlue, 0.004);
  top.geometry.rotateY(-0.12);
  top.geometry.translate(bx, 0.46, bz);
  parts.push(top);
  const mx = clamp(bx + (bx < 0 ? 1 : -1) * w * 0.28, -w / 2 + 0.07, w / 2 - 0.07);
  parts.push(rod(0.04, 0.036, 0.09, mx, 0.43, clamp(-bz, -d / 2 + 0.07, d / 2 - 0.07), PALETTE.mug, 14));
  return parts;
}

function sideTable(w: number, d: number, round: boolean): Part[] {
  const topY = 0.52;
  if (round) {
    const r = Math.min(w, d) / 2 - 0.005;
    return [
      rod(r, r, 0.03, 0, topY, 0, PALETTE.oak, 24),
      rod(0.022, 0.03, topY, 0, 0, 0, PALETTE.walnut, 10),
      rod(r * 0.55, r * 0.6, 0.025, 0, 0, 0, PALETTE.walnut, 20),
    ];
  }
  const parts: Part[] = [block(w, 0.035, d, 0, topY, 0, PALETTE.oak, 0.012)];
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) parts.push(block(0.035, topY, 0.035, sx * (w / 2 - 0.04), 0, sz * (d / 2 - 0.04), PALETTE.walnut, 0.006));
  }
  return parts;
}

function diningTable(w: number, d: number): Part[] {
  const parts: Part[] = [
    block(w, 0.04, d, 0, 0.71, 0, PALETTE.oak, 0.015),
    block(Math.max(w - 0.14, 0.05), 0.08, Math.max(d - 0.14, 0.05), 0, 0.63, 0, PALETTE.oakDark, 0.008),
  ];
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) parts.push(rod(0.024, 0.032, 0.71, sx * (w / 2 - 0.08), 0, sz * (d / 2 - 0.08), PALETTE.walnut, 10));
  }
  return parts;
}

function cabinet(w: number, d: number, doors: number): Part[] {
  const legH = 0.08;
  const bodyH = 0.7;
  const parts: Part[] = [
    block(Math.max(w - 0.01, 0.05), bodyH, Math.max(d - 0.01, 0.05), 0, legH, 0, PALETTE.lacquer, 0.015),
    block(w, 0.025, d, 0, legH + bodyH, 0, PALETTE.oak, 0.01),
  ];
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) parts.push(rod(0.014, 0.02, legH, sx * (w / 2 - 0.05), 0, sz * (d / 2 - 0.05), PALETTE.walnut, 8));
  }
  const front = -d / 2 + 0.004;
  const doorW = w / doors;
  for (let i = 1; i < doors; i++) {
    parts.push(block(0.006, bodyH - 0.06, 0.004, -w / 2 + i * doorW, legH + 0.03, front, PALETTE.floorGap, 0));
  }
  for (let i = 0; i < doors; i++) {
    // Pairs of doors meet at their handles, as a sideboard's do.
    const toward = i % 2 === 0 ? 1 : -1;
    const x = -w / 2 + doorW * (i + 0.5) + toward * (doorW / 2 - 0.05);
    parts.push(block(0.012, 0.12, 0.012, clamp(x, -w / 2 + 0.03, w / 2 - 0.03), legH + bodyH - 0.22, -d / 2 + 0.008, PALETTE.handle, 0.005));
  }
  return parts;
}
