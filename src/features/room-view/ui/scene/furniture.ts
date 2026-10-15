// Parametric furniture, built in code from rounded boxes, cylinders and spheres: every model
// stretches to the piece's own width and depth instead of distorting a fixed asset, and every part
// stays inside the footprint the room map gives it. Which model a piece is lives in
// `model/furnitureModel.ts`; this file only builds it.
import { Color } from "three";

import { type FurniturePlacement, resolveFurnitureTop } from "@/shared/contracts/roomMap";

import {
  armWidth,
  cornerFits,
  DESK_TOP,
  FURNITURE_TONE_COLORS,
  type FurnitureModel,
  furnitureColours,
  modelTop,
} from "../../model/furnitureModel";
import { PALETTE } from "./palette";
import type { FinishKind } from "./finishes";
import { ball, block, crown, hashString, leaf, type Part, rod, seeded } from "./parts";

/** The colours one piece is built from: its upholstery and its wood, each a base and two shades. */
interface Finish {
  fabric: number;
  fabricDeep: number;
  cushion: number;
  wood: number;
  woodDark: number;
  toned: boolean;
}

function shade(hex: number, factor: number): number {
  return new Color(hex).multiplyScalar(factor).getHex();
}

function fabricOf(base: number): Pick<Finish, "fabric" | "fabricDeep" | "cushion"> {
  return { fabric: base, fabricDeep: shade(base, 0.84), cushion: Math.min(0xffffff, new Color(base).lerp(new Color(0xffffff), 0.1).getHex()) };
}

function finishFor(item: FurniturePlacement, model: FurnitureModel): Finish {
  const { fabric, wood, woodToned } = furnitureColours(item, model);
  return { ...fabricOf(fabric), wood, woodDark: woodToned ? shade(wood, 0.78) : PALETTE.oakDark, toned: woodToned };
}

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

/** The piece as parts in its own frame: x across its width, z across its depth, origin at the
 *  footprint's centre on the floor. Unrotated, a seat faces the TV wall (−z), as the room
 *  templates place it; a bed's head and a cabinet's back are at +z. */
export function furnitureParts(item: FurniturePlacement, model: FurnitureModel): Part[] {
  const w = Math.max(item.width, 0.1);
  const d = Math.max(item.height, 0.1);
  const rand = seeded(hashString(item.id));
  const f = finishFor(item, model);
  const top = resolveFurnitureTop(item);
  const parts = build(w, d, model, f, rand, top);
  tagFinishes(parts, f);
  // A stored height scales the model upright; the shelving kinds take it as a dimension instead.
  if (top !== undefined && model.kind !== "bookshelf" && model.kind !== "wardrobe" && model.kind !== "rug") {
    const scale = top / modelTop(model);
    for (const part of parts) part.geometry.scale(1, scale, 1);
  }
  return parts;
}

const METALS = new Set<number>([PALETTE.metal, PALETTE.metalSoft, PALETTE.handle]);
const WOODS = new Set<number>([PALETTE.oak, PALETTE.oakDark, PALETTE.walnut]);
const FABRICS = new Set<number>([PALETTE.pillowCamel, PALETTE.pillowCream, PALETTE.sage]);

/** What each part is made of, read from the colour it was given: the piece's upholstery and its
 *  wood are its own, the rest comes from the shared palette. */
function tagFinishes(parts: Part[], f: Finish) {
  const fabric = new Set([f.fabric, f.fabricDeep, f.cushion]);
  // White and black are paint, not timber: a lacquer with no grain.
  const painted = f.wood === FURNITURE_TONE_COLORS.white || f.wood === FURNITURE_TONE_COLORS.black;
  const wood = new Set([f.wood, f.woodDark, shade(f.wood, 1.08)]);
  for (const part of parts) {
    if (part.finish) continue;
    const c = part.color;
    const finish: FinishKind | undefined = fabric.has(c) || FABRICS.has(c)
      ? "fabric"
      : wood.has(c) && painted
        ? "satin"
        : wood.has(c) || WOODS.has(c)
        ? "wood"
        : METALS.has(c)
          ? "metal"
          : undefined;
    if (finish) part.finish = finish;
  }
}

function build(w: number, d: number, model: FurnitureModel, f: Finish, rand: () => number, top: number | undefined): Part[] {
  switch (model.kind) {
    case "upholstered":
      return model.corner !== null && cornerFits(w, d)
        ? cornerSofa(w, d, model.corner, f)
        : upholstered(w, d, model.seats, model.arms, f);
    case "diningChair":
      return diningChair(w, d, f);
    case "officeChair":
      return officeChair(w, d, f);
    case "bench":
      return bench(w, d, f);
    case "desk":
      return desk(w, d, model.screenX, f);
    case "coffeeTable":
      return coffeeTable(w, d, rand, f);
    case "sideTable":
      return sideTable(w, d, model.round, f);
    case "diningTable":
      return diningTable(w, d, f);
    case "cabinet":
      return cabinet(w, d, model.doors, f);
    case "bookshelf":
      return bookshelf(w, d, top ?? 1.8, rand, f);
    case "wardrobe":
      return wardrobe(w, d, top ?? 2.0, f);
    case "nightstand":
      return nightstand(w, d, f);
    case "tvUnit":
      return tvUnit(w, d, f);
    case "bed":
      return bed(w, d, f);
    case "plant":
      return plant(w, d, model.style, rand, f);
    case "rug":
      return rug(w, d, model.round, f);
    case "stool":
      return stool(w, d, f);
    case "beanbag":
      return beanbag(w, d, f);
    case "dresser":
      return dresser(w, d, f);
    case "counter":
      return counter(w, d, false, f);
    case "island":
      return counter(w, d, true, f);
    case "fridge":
      return fridge(w, d, f.toned ? f.wood : PALETTE.steel);
    case "box":
      return [block(w, 0.72, d, 0, 0, 0, f.wood, 0.03), block(w, 0.03, d, 0, 0.72, 0, shade(f.wood, 1.08), 0.012)];
  }
}

/** An arm's or a back's rounding: most of its thickness, so it reads as padded, not boxed. */
function softEdge(thickness: number): number {
  return Math.min(thickness * 0.46, 0.11);
}

/** The give of a seat cushion: a low dome over its top, so a sofa reads as soft, not as slabs. */
function seatCrown(w: number, d: number, x: number, top: number, z: number, color: number): Part {
  return crown(w - 0.05, d - 0.05, Math.min(0.03, w * 0.05), x, top - 0.006, z, color);
}

/** Frame, back, arms, cushions, leaning back cushions and two throw pillows on wider sofas. */
function upholstered(w: number, d: number, seats: number, arms: boolean, f: Finish): Part[] {
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
  parts.push(block(w, baseTop - legH, d, 0, legH, 0, f.fabricDeep, 0.035));
  parts.push(block(w, backTop - baseTop, backD, 0, baseTop, d / 2 - backD / 2, f.fabric, softEdge(backD)));
  if (arms) {
    for (const sx of [-1, 1]) parts.push(block(armW, armTop - baseTop, d, sx * (w / 2 - armW / 2), baseTop, 0, f.fabric, softEdge(armW)));
  }

  const inner = w - 2 * armW;
  const seatW = inner / seats;
  const seatD = Math.max(d - backD - 0.02, 0.02);
  for (let i = 0; i < seats; i++) {
    const x = -inner / 2 + seatW * (i + 0.5);
    parts.push(block(seatW - 0.014, seatTop - baseTop + 0.012, seatD, x, baseTop - 0.006, -d / 2 + 0.01 + seatD / 2, f.cushion, 0.055));
    parts.push(seatCrown(seatW - 0.014, seatD, x, seatTop, -d / 2 + 0.01 + seatD / 2, f.cushion));
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
      const back = block(seatW - 0.03, h, cushionD, 0, 0, -cushionD / 2, f.cushion, 0.06);
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
  if (arms && seats >= 3 && d >= 0.75) {
    // A knitted throw folded over the right arm, falling to the seat inside and the floor outside.
    const throwD = Math.min(0.5, d * 0.55);
    const x = w / 2 - armW / 2;
    parts.push({ ...block(armW + 0.004, 0.018, throwD, x - 0.002, armTop, -0.02, PALETTE.pillowCream, 0.008), finish: "fabric" });
    parts.push({ ...block(0.014, armTop - legH - 0.05, throwD, w / 2 - 0.007, legH + 0.05, -0.02, PALETTE.pillowCream, 0.006), finish: "fabric" });
    parts.push({ ...block(0.014, armTop - seatTop + 0.02, throwD, x - armW / 2 - 0.009, seatTop - 0.02, -0.02, PALETTE.pillowCream, 0.006), finish: "fabric" });
  }
  return parts;
}

/** An L sectional inside the rectangle: a sofa along the back, a chaise running forward on the
 *  sitter's `side` (left is −x for someone sitting facing −z). */
function cornerSofa(w: number, d: number, side: "left" | "right", f: Finish): Part[] {
  const sofaD = Math.min(0.98, d * 0.55);
  const chaiseW = clamp(w * 0.38, 0.8, 1.0);
  const sx = side === "left" ? -1 : 1;
  const legH = 0.06;
  const baseTop = legH + 0.24;
  const seatTop = baseTop + 0.13;
  const armW = armWidth(w);
  const backD = clamp(sofaD * 0.22, 0.06, 0.2);

  // The back run: the whole width, the back along +z, an arm only on the far side of the chaise.
  const backRun = upholsteredRun(w, sofaD, f, sx, armW, legH, baseTop, seatTop, backD);
  for (const part of backRun) part.geometry.translate(0, 0, d / 2 - sofaD / 2);

  // The chaise: from the front of the back run to the front of the footprint, on the corner side.
  const chaiseD = d - sofaD;
  const cx = sx * (w / 2 - chaiseW / 2);
  const cz = -d / 2 + chaiseD / 2;
  const chaise: Part[] = [
    block(chaiseW, baseTop - legH, chaiseD, cx, legH, cz, f.fabricDeep, 0.035),
    block(chaiseW - 0.04, seatTop - baseTop + 0.012, chaiseD - 0.02, cx, baseTop - 0.006, cz, f.cushion, 0.055),
    seatCrown(chaiseW - 0.04, chaiseD - 0.02, cx, seatTop, cz, f.cushion),
    block(armW, 0.29, chaiseD, sx * (w / 2 - armW / 2), baseTop, cz, f.fabric, softEdge(armW)),
  ];
  for (const z of [-d / 2 + 0.07, d / 2 - sofaD - 0.02]) {
    chaise.push(rod(0.016, 0.022, legH, cx - sx * (chaiseW / 2 - 0.07), 0, z, PALETTE.walnut, 10));
  }
  return [...backRun, ...chaise];
}

/** One straight run of an L: frame, back, an arm on the side away from the chaise, cushions. */
function upholsteredRun(
  w: number,
  d: number,
  f: Finish,
  chaiseSide: number,
  armW: number,
  legH: number,
  baseTop: number,
  seatTop: number,
  backD: number,
): Part[] {
  const backTop = seatTop + 0.4;
  const parts: Part[] = [
    block(w, baseTop - legH, d, 0, legH, 0, f.fabricDeep, 0.035),
    block(w, backTop - baseTop, backD, 0, baseTop, d / 2 - backD / 2, f.fabric, softEdge(backD)),
    block(armW, 0.29, d, -chaiseSide * (w / 2 - armW / 2), baseTop, 0, f.fabric, softEdge(armW)),
  ];
  for (const sx of [-1, 1]) parts.push(rod(0.016, 0.022, legH, sx * (w / 2 - 0.07), 0, d / 2 - 0.07, PALETTE.walnut, 10));
  const inner = w - armW;
  const seats = clamp(Math.round(inner / 0.62), 1, 5);
  const seatW = inner / seats;
  const seatD = Math.max(d - backD - 0.02, 0.02);
  const start = chaiseSide < 0 ? -w / 2 : -w / 2 + armW;
  for (let i = 0; i < seats; i++) {
    parts.push(block(seatW - 0.014, seatTop - baseTop + 0.012, seatD, start + seatW * (i + 0.5), baseTop - 0.006, -d / 2 + 0.01 + seatD / 2, f.cushion, 0.055));
    parts.push(seatCrown(seatW - 0.014, seatD, start + seatW * (i + 0.5), seatTop, -d / 2 + 0.01 + seatD / 2, f.cushion));
  }
  return parts;
}

function diningChair(w: number, d: number, f: Finish): Part[] {
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
  parts.push(block(w - 0.01, 0.045, d - 0.01, 0, seatY, 0, f.wood, 0.014));
  parts.push(block(Math.max(w - 0.07, 0.05), 0.03, Math.max(d - 0.09, 0.05), 0, seatY + 0.045, -0.015, f.fabric, 0.014));
  parts.push(block(Math.max(w - 2 * legT - 0.02, 0.05), 0.2, 0.024, 0, seatY + 0.24, lz, f.wood, 0.01));
  return parts;
}

function officeChair(w: number, d: number, f: Finish): Part[] {
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
  parts.push(block(w - 0.04, 0.08, d - 0.06, 0, 0.41, -0.02, f.fabric, 0.035));
  const back = block(w - 0.08, 0.44, 0.06, 0, 0, -0.03, f.fabric, 0.03);
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

function bench(w: number, d: number, f: Finish): Part[] {
  const parts: Part[] = [
    block(w, 0.05, d, 0, 0.4, 0, f.wood, 0.015),
    block(Math.max(w - 0.04, 0.05), 0.05, Math.max(d - 0.02, 0.02), 0, 0.45, 0, f.fabric, 0.02),
  ];
  const legs = Math.ceil(w / 1.4) + 1;
  for (let i = 0; i < legs; i++) {
    const x = -w / 2 + 0.1 + ((w - 0.2) * i) / (legs - 1);
    parts.push(block(0.05, 0.4, Math.max(d - 0.04, 0.02), x, 0, 0, PALETTE.walnut, 0.008));
  }
  return parts;
}

function desk(w: number, d: number, screenX: number | null, f: Finish): Part[] {
  const topY = DESK_TOP - 0.035;
  const parts: Part[] = [block(w, 0.035, d, 0, topY, 0, f.wood, 0.012)];
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

function coffeeTable(w: number, d: number, rand: () => number, f: Finish): Part[] {
  const topY = 0.38;
  const parts: Part[] = [
    block(w, 0.05, d, 0, topY, 0, f.wood, 0.02),
    block(Math.max(w - 0.1, 0.05), 0.025, Math.max(d - 0.1, 0.05), 0, 0.1, 0, f.woodDark, 0.008),
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

function sideTable(w: number, d: number, round: boolean, f: Finish): Part[] {
  const topY = 0.52;
  if (round) {
    const r = Math.min(w, d) / 2 - 0.005;
    return [
      rod(r, r, 0.03, 0, topY, 0, f.wood, 24),
      rod(0.022, 0.03, topY, 0, 0, 0, PALETTE.walnut, 10),
      rod(r * 0.55, r * 0.6, 0.025, 0, 0, 0, PALETTE.walnut, 20),
    ];
  }
  const parts: Part[] = [block(w, 0.035, d, 0, topY, 0, f.wood, 0.012)];
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) parts.push(block(0.035, topY, 0.035, sx * (w / 2 - 0.04), 0, sz * (d / 2 - 0.04), PALETTE.walnut, 0.006));
  }
  return parts;
}

function diningTable(w: number, d: number, f: Finish): Part[] {
  const parts: Part[] = [
    block(w, 0.04, d, 0, 0.71, 0, f.wood, 0.015),
    block(Math.max(w - 0.14, 0.05), 0.08, Math.max(d - 0.14, 0.05), 0, 0.63, 0, f.woodDark, 0.008),
  ];
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) parts.push(rod(0.024, 0.032, 0.71, sx * (w / 2 - 0.08), 0, sz * (d / 2 - 0.08), PALETTE.walnut, 10));
  }
  return parts;
}

/** A box on short legs whose front (−z) carries door seams and handles. */
function doorsAndHandles(w: number, d: number, doors: number, bottom: number, height: number, handleY: number): Part[] {
  const parts: Part[] = [];
  const front = -d / 2 + 0.004;
  const doorW = w / doors;
  for (let i = 1; i < doors; i++) {
    parts.push(block(0.006, height - 0.06, 0.004, -w / 2 + i * doorW, bottom + 0.03, front, PALETTE.floorGap, 0));
  }
  for (let i = 0; i < doors; i++) {
    // Pairs of doors meet at their handles, as a sideboard's do.
    const toward = i % 2 === 0 ? 1 : -1;
    const x = -w / 2 + doorW * (i + 0.5) + toward * (doorW / 2 - 0.05);
    parts.push(block(0.012, 0.12, 0.012, clamp(x, -w / 2 + 0.03, w / 2 - 0.03), handleY, -d / 2 + 0.008, PALETTE.handle, 0.005));
  }
  return parts;
}

function cabinet(w: number, d: number, doors: number, f: Finish): Part[] {
  const legH = 0.08;
  const bodyH = 0.7;
  const parts: Part[] = [
    block(Math.max(w - 0.01, 0.05), bodyH, Math.max(d - 0.01, 0.05), 0, legH, 0, PALETTE.lacquer, 0.015),
    block(w, 0.025, d, 0, legH + bodyH, 0, f.wood, 0.01),
    ...doorsAndHandles(w, d, doors, legH, bodyH, legH + bodyH - 0.22),
  ];
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) parts.push(rod(0.014, 0.02, legH, sx * (w / 2 - 0.05), 0, sz * (d / 2 - 0.05), PALETTE.walnut, 8));
  }
  return parts;
}

function nightstand(w: number, d: number, f: Finish): Part[] {
  const legH = 0.07;
  const bodyH = 0.45;
  return [
    block(Math.max(w - 0.01, 0.05), bodyH, Math.max(d - 0.01, 0.05), 0, legH, 0, f.wood, 0.012),
    block(w, 0.025, d, 0, legH + bodyH, 0, shade(f.wood, 1.06), 0.008),
    block(Math.max(w - 0.06, 0.04), 0.006, 0.004, 0, legH + bodyH * 0.52, -d / 2 + 0.002, PALETTE.floorGap, 0),
    block(0.08, 0.012, 0.012, 0, legH + bodyH * 0.72, -d / 2 + 0.006, PALETTE.handle, 0.005),
    ...[-1, 1].flatMap((sx) => [-1, 1].map((sz) => rod(0.012, 0.016, legH, sx * (w / 2 - 0.04), 0, sz * (d / 2 - 0.04), PALETTE.walnut, 8))),
  ];
}

const BOOK_COLOURS = [0xb4513e, 0x3f679a, 0xd8c9a8, 0x5d7d52, 0xc49a3c, 0x7b4f6e, 0x2f3b4d];

/** Open shelving with rows of books, each row drawn from the piece's own seed. */
function bookshelf(w: number, d: number, height: number, rand: () => number, f: Finish): Part[] {
  const t = 0.025;
  const h = clamp(height, 0.5, 3);
  const parts: Part[] = [
    block(t, h, d, -w / 2 + t / 2, 0, 0, f.wood, 0.006),
    block(t, h, d, w / 2 - t / 2, 0, 0, f.wood, 0.006),
    block(w, t, d, 0, h - t, 0, f.wood, 0.006),
    block(w - 2 * t, 0.06, d, 0, 0, 0, f.woodDark, 0.004),
    block(w - 2 * t, h - t - 0.06, 0.012, 0, 0.06, d / 2 - 0.006, f.woodDark, 0),
  ];
  const shelves = Math.max(2, Math.round((h - 0.06) / 0.36));
  const gap = (h - t - 0.06) / shelves;
  const inner = w - 2 * t - 0.02;
  for (let s = 0; s < shelves; s++) {
    const y = 0.06 + s * gap;
    if (s > 0) parts.push(block(w - 2 * t, 0.018, d - 0.012, 0, y, -0.006, f.wood, 0.004));
    // Books stand on the shelf in runs, with the odd gap, leaning only within their own slot.
    let x = -inner / 2;
    while (x < inner / 2 - 0.03) {
      const bookW = 0.02 + rand() * 0.025;
      if (rand() < 0.12) {
        x += bookW * 3;
        continue;
      }
      const bookH = Math.min(gap - 0.04, 0.18 + rand() * 0.1);
      const colour = BOOK_COLOURS[Math.floor(rand() * BOOK_COLOURS.length)] ?? BOOK_COLOURS[0] ?? 0xb4513e;
      const bookD = Math.min(d - 0.05, 0.16 + rand() * 0.05);
      if (x + bookW > inner / 2) break;
      parts.push(block(bookW, bookH, bookD, x + bookW / 2, y + 0.018, -d / 2 + 0.02 + bookD / 2, colour, 0.003));
      x += bookW + 0.002;
    }
  }
  return parts;
}

/**
 * A run of wardrobes: a carcass in the tone, a cornice over it, a plinth set back under it, and a
 * door every half metre or so that stands proud of the front with a shadow gap around it and a
 * long bar handle where each pair meets. One flat box with seams drawn on read as a crate.
 */
function wardrobe(w: number, d: number, height: number, f: Finish): Part[] {
  const plinth = 0.08;
  const cornice = 0.035;
  const h = clamp(height, 1.2, 2.8);
  const doors = clamp(Math.round(w / 0.5), 2, 12);
  const doorW = w / doors;
  const gap = 0.006;
  const proud = 0.018;
  const handleDepth = 0.02;
  // Everything inside the footprint: the handles at its front edge, the doors behind them, the
  // carcass behind the doors, so a wardrobe against a wall stands exactly where it is drawn.
  const doorFront = -d / 2 + handleDepth;
  const carcassFront = doorFront + proud;
  const carcassDepth = Math.max(d / 2 - carcassFront, 0.05);
  const doorBottom = plinth + 0.01;
  const doorH = h - cornice - doorBottom - 0.01;
  const parts: Part[] = [
    // Plinth, set back and dark so the wardrobe seems to stand off the floor.
    block(Math.max(w - 0.04, 0.05), plinth, Math.max(carcassDepth - 0.04, 0.05), 0, 0, carcassFront + carcassDepth / 2 + 0.02, PALETTE.walnut, 0.004),
    // Carcass: sides, back and the reveal the shadow gaps show.
    block(w, h - cornice - plinth, carcassDepth, 0, plinth, carcassFront + carcassDepth / 2, shade(f.wood, 0.82), 0.006),
    // Cornice over the carcass and the doors.
    block(w, cornice, d - handleDepth, 0, h - cornice, handleDepth / 2, shade(f.wood, 0.94), 0.008),
  ];
  for (let i = 0; i < doors; i++) {
    const x = -w / 2 + doorW * (i + 0.5);
    parts.push(block(doorW - gap, doorH, proud, x, doorBottom, doorFront + proud / 2, f.wood, 0.004));
    // Pairs meet at their handles; an odd last door keeps its handle on its inner edge.
    const toward = i % 2 === 0 ? 1 : -1;
    const hx = x + toward * (doorW / 2 - 0.045);
    parts.push(block(0.014, 0.36, handleDepth, hx, doorBottom + doorH * 0.42, -d / 2 + handleDepth / 2, PALETTE.handle, 0.006));
  }
  return parts;
}

function tvUnit(w: number, d: number, f: Finish): Part[] {
  const legH = 0.06;
  const h = 0.46;
  const drawers = Math.max(2, Math.round(w / 0.5));
  const parts: Part[] = [
    block(w, h - legH - 0.025, d, 0, legH, 0, f.wood, 0.015),
    block(w, 0.025, d, 0, h - 0.025, 0, shade(f.wood, 1.1), 0.008),
  ];
  for (let i = 1; i < drawers; i++) {
    parts.push(block(0.006, h - legH - 0.07, 0.004, -w / 2 + (w * i) / drawers, legH + 0.02, -d / 2 + 0.002, PALETTE.floorGap, 0));
  }
  for (const sx of [-1, 1]) parts.push(block(0.03, legH, 0.03, sx * (w / 2 - 0.06), 0, 0, PALETTE.metal, 0.006));
  return parts;
}

/** A bed with its head at +z: frame, headboard, mattress, a duvet folded back, one pillow per
 *  sleeper. */
function bed(w: number, d: number, f: Finish): Part[] {
  const legH = 0.06;
  const frameTop = 0.32;
  const mattressTop = 0.54;
  const headD = Math.min(0.08, d * 0.06);
  const mattressD = Math.max(d - headD - 0.04, 0.1);
  const mattressZ = -d / 2 + 0.02 + mattressD / 2;
  const parts: Part[] = [
    block(w, frameTop - legH, d - headD, 0, legH, -headD / 2, PALETTE.walnut, 0.02),
    block(w, Math.min(1.05, mattressTop + 0.45), headD, 0, 0, d / 2 - headD / 2, f.fabricDeep, 0.03),
    { ...block(w - 0.06, mattressTop - frameTop, mattressD, 0, frameTop, mattressZ, PALETTE.paper, 0.07), finish: "fabric" },
  ];
  for (const sx of [-1, 1]) parts.push(block(0.05, legH, 0.05, sx * (w / 2 - 0.06), 0, -d / 2 + 0.06, PALETTE.walnut, 0.006));
  // The duvet covers the foot two thirds, its folded edge a soft roll.
  const duvetD = mattressD * 0.68;
  const duvetZ = -d / 2 + 0.02 + duvetD / 2;
  parts.push(block(w - 0.03, 0.05, duvetD + 0.01, 0, mattressTop - 0.02, duvetZ, f.fabric, 0.03));
  // Its fill: a low dome, so the duvet lies soft over the mattress instead of as a board.
  parts.push(crown(w - 0.08, duvetD - 0.06, 0.04, 0, mattressTop + 0.024, duvetZ, f.fabric));
  parts.push(block(w - 0.03, 0.07, 0.12, 0, mattressTop - 0.02, -d / 2 + 0.02 + duvetD - 0.04, f.cushion, 0.035));
  // A throw across the foot, falling over both sides.
  const throwD = Math.min(0.45, duvetD * 0.42);
  const throwZ = -d / 2 + 0.03 + throwD / 2;
  parts.push({ ...block(w - 0.004, 0.014, throwD, 0, mattressTop + 0.05, throwZ, PALETTE.pillowCamel, 0.006), finish: "fabric" });
  for (const sx of [-1, 1]) {
    parts.push({ ...block(0.012, 0.2, throwD, sx * (w / 2 - 0.008), mattressTop - 0.14, throwZ, PALETTE.pillowCamel, 0.005), finish: "fabric" });
  }
  const sleepers = w >= 1.2 ? 2 : 1;
  const pillowW = Math.max(Math.min(0.62, (w - 0.18) / sleepers - 0.05), 0.05);
  // The pillow's depth follows the bed's, so a short bed keeps its pillows on it.
  const pillowD = Math.min(0.34, mattressD * 0.24);
  for (let i = 0; i < sleepers; i++) {
    const x = sleepers === 1 ? 0 : (i === 0 ? -1 : 1) * (w / 4 - 0.02);
    const pillow = block(pillowW, Math.min(0.11, pillowD * 0.5), pillowD, 0, 0, 0, PALETTE.pillowCream, 0.05);
    pillow.geometry.rotateX(-0.2);
    pillow.geometry.translate(x, mattressTop - 0.01, d / 2 - headD - 0.03 - pillowD / 2);
    parts.push(pillow);
  }
  if (w >= 0.9 && mattressD > 0.8) {
    // A lumbar cushion propped against the pillows.
    const lumbar = block(Math.min(0.5, w * 0.32), 0.2, 0.09, 0, 0, 0, PALETTE.sage, 0.04);
    lumbar.geometry.rotateX(-0.35);
    lumbar.geometry.translate(0, mattressTop + 0.02, d / 2 - headD - 0.06 - pillowD);
    parts.push(lumbar);
  }
  return parts;
}

/** Squeezes `parts` across x and z, about the origin, until they lie within ±`hx` and ±`hz`. */
function fitAcross(parts: readonly Part[], hx: number, hz: number) {
  let reachX = 0;
  let reachZ = 0;
  for (const part of parts) {
    part.geometry.computeBoundingBox();
    const box = part.geometry.boundingBox;
    if (!box) continue;
    reachX = Math.max(reachX, -box.min.x, box.max.x);
    reachZ = Math.max(reachZ, -box.min.z, box.max.z);
  }
  const sx = reachX > hx ? hx / reachX : 1;
  const sz = reachZ > hz ? hz / reachZ : 1;
  if (sx === 1 && sz === 1) return;
  for (const part of parts) part.geometry.scale(sx, 1, sz);
}

const LEAF = 0x3f7a4a;
const LEAF_DARK = 0x2f5e39;
const LEAF_LIGHT = 0x5a9a5f;

/** A pot with soil and foliage in one of three habits: clipped topiary balls, a leafy bush, or a
 *  palm's fronds. */
function plant(w: number, d: number, style: "topiary" | "leafy" | "palm", rand: () => number, f: Finish): Part[] {
  // A plant does not grow with its footprint past a real one's size; a big footprint is room
  // around it.
  const r = Math.min(w, d) / 2;
  const potR = Math.min(r * 0.72, 0.28);
  const potH = Math.min(0.34, Math.max(potR * 1.2, 0.1));
  const potColour = f.fabric;
  const parts: Part[] = [
    rod(potR, potR * 0.78, potH, 0, 0, 0, potColour, 20),
    rod(potR * 0.92, potR * 0.92, 0.02, 0, potH - 0.025, 0, PALETTE.floorGap, 20),
  ];
  const greens = [LEAF, LEAF_DARK, LEAF_LIGHT];
  const green = () => greens[Math.floor(rand() * greens.length)] ?? LEAF;
  if (style === "topiary") {
    parts.push(rod(0.015, 0.02, 0.28, 0, potH - 0.02, 0, PALETTE.walnut, 8));
    const balls = [Math.min(r * 0.82, 0.3), Math.min(r * 0.66, 0.24), Math.min(r * 0.48, 0.17)];
    let y = potH + 0.18;
    for (const br of balls) {
      const radius = Math.min(br, r - 0.005);
      y += radius;
      // A dark core for depth, clipped leaves all over it: a ball read as plastic.
      parts.push({ ...ball(radius * 0.86, 0, y, 0, LEAF_DARK, 10), finish: "leaf" });
      const count = Math.round(18 + radius * 90);
      for (let i = 0; i < count; i++) {
        // An even spread over the sphere (a golden-angle spiral), jittered.
        const t = (i + 0.5) / count;
        const polar = Math.acos(1 - 2 * t);
        const az = i * 2.39996 + rand() * 0.5;
        const dir = { x: Math.sin(polar) * Math.cos(az), y: Math.cos(polar), z: Math.sin(polar) * Math.sin(az) };
        const at = { x: dir.x * radius * 0.78, y: y + dir.y * radius * 0.78, z: dir.z * radius * 0.78 };
        parts.push(leaf(radius * (0.42 + rand() * 0.18), at, dir, 0.2 + rand() * 0.3, green()));
      }
      y += radius * 0.82;
    }
  } else if (style === "leafy") {
    // Stems rising from the pot and arching out, each with leaves along it.
    const reach = Math.min(Math.max(r - 0.05, 0.12), 0.5);
    const stems = 9;
    for (let i = 0; i < stems; i++) {
      const a = (i / stems) * Math.PI * 2 + rand() * 0.5;
      const rise = 0.25 + rand() * 0.35;
      const out = reach * (0.45 + rand() * 0.45);
      const leaves = 4;
      for (let k = 0; k < leaves; k++) {
        const t = (k + 1) / leaves;
        const at = { x: Math.cos(a) * out * t * 0.7, y: potH + rise * (0.3 + t * 0.7), z: Math.sin(a) * out * t * 0.7 };
        const side = k % 2 === 0 ? 0.6 : -0.6;
        const dir = { x: Math.cos(a + side), y: 0.35 + rand() * 0.3, z: Math.sin(a + side) };
        parts.push(leaf(Math.min(0.12 + rand() * 0.08, out * 0.9), at, dir, 0.25 + t * 0.35, green()));
      }
    }
    parts.push({ ...ball(Math.min(0.09, r * 0.4), 0, potH + 0.05, 0, LEAF_DARK, 8), finish: "leaf" });
  } else {
    const trunkH = 1.05;
    parts.push(rod(0.03, 0.045, trunkH, 0, potH - 0.02, 0, PALETTE.oakDark, 10));
    const fronds = 9;
    const frondL = Math.min(Math.max(r - 0.02, 0.05), 0.75);
    const crownAt = { x: 0, y: potH + trunkH - 0.02, z: 0 };
    for (let i = 0; i < fronds; i++) {
      const a = (i / fronds) * Math.PI * 2 + rand() * 0.3;
      const dir = { x: Math.cos(a), y: 0.5, z: Math.sin(a) };
      parts.push(leaf(frondL, crownAt, dir, 0.6 + rand() * 0.25, i % 2 === 0 ? LEAF : LEAF_LIGHT));
    }
  }
  // Leaves reach where they like; the plant as a whole is drawn back inside its footprint.
  fitAcross(parts, w / 2 - 0.0015, d / 2 - 0.0015);
  return parts;
}

/** A flat rug with a border: an outer band and a slightly raised field. */
/** A bordered field with a woven pattern: rings on a round rug; on a long one a second border line,
 *  a centre medallion where it is wide enough and fringe at its short ends. Each layer lies a
 *  millimetre over the last, so none z-fights. */
function rug(w: number, d: number, round: boolean, f: Finish): Part[] {
  const border = Math.min(0.08, Math.min(w, d) * 0.08);
  const field = shade(f.fabric, 1.18);
  if (round) {
    const r = Math.min(w, d) / 2;
    const parts = [rod(r, r, 0.01, 0, 0, 0, f.fabricDeep, 40), rod(r - border, r - border, 0.012, 0, 0, 0, field, 40)];
    if (r > 0.3) {
      parts.push(rod(r * 0.62, r * 0.62, 0.013, 0, 0, 0, f.fabricDeep, 40), rod(r * 0.56, r * 0.56, 0.014, 0, 0, 0, field, 40));
      parts.push(rod(r * 0.18, r * 0.18, 0.015, 0, 0, 0, f.fabric, 24));
    }
    return parts;
  }
  const fringe = Math.min(0.035, Math.max(w, d) * 0.02);
  const long = w >= d;
  const bw = long ? w - 2 * fringe : w;
  const bd = long ? d : d - 2 * fringe;
  const parts: Part[] = [block(bw, 0.01, bd, 0, 0, 0, f.fabricDeep, 0), block(bw - 2 * border, 0.012, bd - 2 * border, 0, 0, 0, field, 0)];
  const line = border * 0.35;
  const iw = bw - 4 * border;
  const id = bd - 4 * border;
  if (iw > 0.2 && id > 0.2) {
    parts.push(block(iw, 0.013, id, 0, 0, 0, f.fabricDeep, 0), block(iw - 2 * line, 0.014, id - 2 * line, 0, 0, 0, field, 0));
    const m = Math.min(iw, id) * 0.32;
    if (m > 0.15) {
      const medallion = block(m, 0.015, m, 0, 0, 0, f.fabric, 0);
      medallion.geometry.rotateY(Math.PI / 4);
      medallion.geometry.scale(long ? Math.min(1.6, iw / id) : 1, 1, long ? 1 : Math.min(1.6, id / iw));
      parts.push(medallion);
    }
  }
  // Fringe: short threads off both ends of the long side's run.
  const ends = long ? bd : bw;
  const threads = Math.max(2, Math.floor(ends / 0.05));
  for (const side of [-1, 1]) {
    for (let i = 0; i < threads; i++) {
      const at = -ends / 2 + (ends * (i + 0.5)) / threads;
      const reach = side * ((long ? bw : bd) / 2 + fringe / 2);
      parts.push(long ? block(fringe, 0.004, 0.008, reach, 0, at, PALETTE.paper, 0) : block(0.008, 0.004, fringe, at, 0, reach, PALETTE.paper, 0));
    }
  }
  return parts;
}

/** A bar stool: a round seat on four slim legs, ringed by a footrest. */
function stool(w: number, d: number, f: Finish): Part[] {
  const r = Math.min(w, d) / 2 - 0.01;
  const seatY = 0.7;
  const parts: Part[] = [rod(r * 0.98, r * 0.92, 0.05, 0, seatY, 0, f.fabric, 24), rod(r, r, 0.012, 0, seatY - 0.012, 0, f.wood, 24)];
  const at = r * 0.66;
  for (const [sx, sz] of [
    [1, 1],
    [1, -1],
    [-1, 1],
    [-1, -1],
  ] as const) {
    parts.push(rod(0.012, 0.014, seatY - 0.012, (sx * at) / Math.SQRT2, 0, (sz * at) / Math.SQRT2, PALETTE.metal, 8));
  }
  for (const turn of [0, Math.PI / 2]) {
    const bar = block(at * Math.SQRT2, 0.014, 0.014, 0, 0.26, 0, PALETTE.metal, 0.005);
    bar.geometry.rotateY(turn + Math.PI / 4);
    parts.push(bar);
  }
  return parts;
}

/** A beanbag: a slumped pouch with its back risen where someone last sat. */
function beanbag(w: number, d: number, f: Finish): Part[] {
  const body = ball(0.5, 0, 0, 0, f.fabric, 18);
  body.geometry.scale(w * 0.96, 0.5, d * 0.96);
  body.geometry.translate(0, 0.25, 0);
  const back = ball(0.5, 0, 0, 0, f.fabricDeep, 16);
  back.geometry.scale(w * 0.78, 0.5, d * 0.42);
  back.geometry.translate(0, 0.37, d * 0.24);
  const dent = ball(0.5, 0, 0, 0, f.cushion, 14);
  dent.geometry.scale(w * 0.55, 0.12, d * 0.45);
  dent.geometry.translate(0, 0.45, -d * 0.06);
  return [body, back, dent];
}

/** A chest of drawers: three rows of fronts, each with a pair of pulls, on short legs. */
function dresser(w: number, d: number, f: Finish): Part[] {
  const legH = 0.08;
  const bodyH = 0.82;
  const rows = 3;
  const parts: Part[] = [
    block(Math.max(w - 0.01, 0.05), bodyH, Math.max(d - 0.01, 0.05), 0, legH, 0, f.wood, 0.014),
    block(w, 0.025, d, 0, legH + bodyH - 0.005, 0, shade(f.wood, 1.06), 0.01),
  ];
  const rowH = (bodyH - 0.04) / rows;
  for (let i = 1; i < rows; i++) parts.push(block(w - 0.03, 0.006, 0.004, 0, legH + 0.02 + rowH * i, -d / 2 + 0.002, PALETTE.floorGap, 0));
  for (let i = 0; i < rows; i++) {
    const y = legH + 0.02 + rowH * (i + 0.5);
    for (const sx of w > 0.7 ? [-1, 1] : [0]) parts.push(block(0.1, 0.012, 0.014, sx * w * 0.26, y, -d / 2 + 0.007, PALETTE.handle, 0.005));
  }
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) parts.push(rod(0.014, 0.018, legH, sx * (w / 2 - 0.05), 0, sz * (d / 2 - 0.05), PALETTE.walnut, 8));
  }
  return parts;
}

/** Base cabinets under a stone worktop with a sink and a hob let into it; an island's top runs
 *  over its front (−z) far enough to sit at. */
function counter(w: number, d: number, island: boolean, f: Finish): Part[] {
  const kick = 0.1;
  const worktop = 0.04;
  const topY = 0.92 - worktop;
  const overhang = island ? Math.min(0.28, d * 0.3) : 0;
  const bodyD = Math.max(d - overhang - 0.02, Math.min(0.2, d * 0.6));
  const bodyZ = overhang / 2;
  const parts: Part[] = [
    block(w - 0.02, kick, bodyD - 0.08, 0, 0, bodyZ + 0.04, PALETTE.floorGap, 0.005),
    block(w - 0.01, topY - kick, bodyD, 0, kick, bodyZ, f.wood, 0.01),
    { ...block(w, worktop, d, 0, topY, 0, PALETTE.stone, 0.012), finish: "satin" },
  ];
  const doors = Math.max(1, Math.round(w / 0.6));
  const front = bodyZ - bodyD / 2;
  for (let i = 1; i < doors; i++) parts.push(block(0.006, topY - kick - 0.04, 0.004, -w / 2 + (w * i) / doors, kick + 0.02, front + 0.002, PALETTE.floorGap, 0));
  for (let i = 0; i < doors; i++) {
    parts.push(block(Math.min(0.14, w / doors - 0.1), 0.012, 0.014, -w / 2 + (w * (i + 0.5)) / doors, topY - 0.07, front + 0.006, PALETTE.handle, 0.005));
  }
  if (w >= 1.2) {
    const sinkX = -w / 2 + w * 0.3;
    const sinkW = Math.min(0.55, w * 0.25);
    parts.push({ ...block(sinkW, 0.006, Math.min(0.42, bodyD - 0.14), sinkX, topY + worktop - 0.004, bodyZ, PALETTE.steel, 0.02), finish: "satin" });
    parts.push({ ...rod(0.012, 0.014, 0.24, sinkX, topY + worktop, bodyZ + bodyD / 2 - 0.08, PALETTE.steel, 10), finish: "satin" });
  }
  if (w >= 1.8) {
    const hobX = -w / 2 + w * 0.72;
    parts.push({ ...block(Math.min(0.6, w * 0.25), 0.006, Math.min(0.5, bodyD - 0.1), hobX, topY + worktop, bodyZ, PALETTE.glassBlack, 0.01), finish: "satin" });
  }
  return parts;
}

/** A fridge-freezer: one tall body, steel unless a tone paints it, the freezer drawer below, a bar
 *  handle on each door. */
function fridge(w: number, d: number, body: number): Part[] {
  const h = 1.85;
  const split = 0.72;
  // The body stands back from the footprint's front by the handles' reach.
  const reach = 0.045;
  const front = -d / 2 + reach - 0.001;
  const satin = (part: Part): Part => ({ ...part, finish: "satin" });
  return [
    satin(block(w - 0.01, h, d - reach - 0.005, 0, 0, (reach - 0.005) / 2, body, 0.025)),
    block(w - 0.03, 0.008, 0.004, 0, split, front, PALETTE.floorGap, 0),
    satin(block(0.022, 0.5, 0.03, w / 2 - 0.08, split + 0.25, front - 0.017, PALETTE.metalSoft, 0.008)),
    satin(block(0.022, 0.3, 0.03, w / 2 - 0.08, split - 0.36, front - 0.017, PALETTE.metalSoft, 0.008)),
  ];
}
