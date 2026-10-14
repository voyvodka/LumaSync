// Parametric furniture, built in code from rounded boxes, cylinders and spheres: every model
// stretches to the piece's own width and depth instead of distorting a fixed asset, and every part
// stays inside the footprint the room map gives it. Which model a piece is lives in
// `model/furnitureModel.ts`; this file only builds it.
import { Color } from "three";

import { type FurniturePlacement, resolveFurnitureTop } from "@/shared/contracts/roomMap";

import { armWidth, cornerFits, DESK_TOP, type FurnitureModel, furnitureColours, modelTop } from "../../model/furnitureModel";
import { PALETTE } from "./palette";
import { ball, block, hashString, type Part, rod, seeded } from "./parts";

/** The colours one piece is built from: its upholstery and its wood, each a base and two shades. */
interface Finish {
  fabric: number;
  fabricDeep: number;
  cushion: number;
  wood: number;
  woodDark: number;
}

function shade(hex: number, factor: number): number {
  return new Color(hex).multiplyScalar(factor).getHex();
}

function fabricOf(base: number): Pick<Finish, "fabric" | "fabricDeep" | "cushion"> {
  return { fabric: base, fabricDeep: shade(base, 0.84), cushion: Math.min(0xffffff, new Color(base).lerp(new Color(0xffffff), 0.1).getHex()) };
}

function finishFor(item: FurniturePlacement, model: FurnitureModel): Finish {
  const { fabric, wood, woodToned } = furnitureColours(item, model);
  return { ...fabricOf(fabric), wood, woodDark: woodToned ? shade(wood, 0.78) : PALETTE.oakDark };
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
  // A stored height scales the model upright; the shelving kinds take it as a dimension instead.
  if (top !== undefined && model.kind !== "bookshelf" && model.kind !== "wardrobe" && model.kind !== "rug") {
    const scale = top / modelTop(model);
    for (const part of parts) part.geometry.scale(1, scale, 1);
  }
  return parts;
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
    case "box":
      return [block(w, 0.72, d, 0, 0, 0, f.wood, 0.03), block(w, 0.03, d, 0, 0.72, 0, shade(f.wood, 1.08), 0.012)];
  }
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
  parts.push(block(w, backTop - baseTop, backD, 0, baseTop, d / 2 - backD / 2, f.fabric, 0.06));
  if (arms) {
    for (const sx of [-1, 1]) parts.push(block(armW, armTop - baseTop, d, sx * (w / 2 - armW / 2), baseTop, 0, f.fabric, 0.07));
  }

  const inner = w - 2 * armW;
  const seatW = inner / seats;
  const seatD = Math.max(d - backD - 0.02, 0.02);
  for (let i = 0; i < seats; i++) {
    const x = -inner / 2 + seatW * (i + 0.5);
    parts.push(block(seatW - 0.014, seatTop - baseTop + 0.012, seatD, x, baseTop - 0.006, -d / 2 + 0.01 + seatD / 2, f.cushion, 0.055));
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
    block(armW, 0.29, chaiseD, sx * (w / 2 - armW / 2), baseTop, cz, f.fabric, 0.07),
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
    block(w, backTop - baseTop, backD, 0, baseTop, d / 2 - backD / 2, f.fabric, 0.06),
    block(armW, 0.29, d, -chaiseSide * (w / 2 - armW / 2), baseTop, 0, f.fabric, 0.07),
  ];
  for (const sx of [-1, 1]) parts.push(rod(0.016, 0.022, legH, sx * (w / 2 - 0.07), 0, d / 2 - 0.07, PALETTE.walnut, 10));
  const inner = w - armW;
  const seats = clamp(Math.round(inner / 0.62), 1, 5);
  const seatW = inner / seats;
  const seatD = Math.max(d - backD - 0.02, 0.02);
  const start = chaiseSide < 0 ? -w / 2 : -w / 2 + armW;
  for (let i = 0; i < seats; i++) {
    parts.push(block(seatW - 0.014, seatTop - baseTop + 0.012, seatD, start + seatW * (i + 0.5), baseTop - 0.006, -d / 2 + 0.01 + seatD / 2, f.cushion, 0.055));
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

function wardrobe(w: number, d: number, height: number, f: Finish): Part[] {
  const plinth = 0.06;
  const h = clamp(height, 1.2, 2.8);
  const doors = clamp(Math.round(w / 0.5), 2, 4);
  return [
    block(w, plinth, Math.max(d - 0.03, 0.05), 0, 0, 0.015, PALETTE.walnut, 0.006),
    block(w, h - plinth - 0.03, d, 0, plinth, 0, f.wood, 0.012),
    block(w, 0.03, d, 0, h - 0.03, 0, shade(f.wood, 0.9), 0.006),
    ...doorsAndHandles(w, d, doors, plinth, h - plinth - 0.03, plinth + (h - plinth) * 0.52),
  ];
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
    block(w - 0.06, mattressTop - frameTop, mattressD, 0, frameTop, mattressZ, PALETTE.paper, 0.05),
  ];
  for (const sx of [-1, 1]) parts.push(block(0.05, legH, 0.05, sx * (w / 2 - 0.06), 0, -d / 2 + 0.06, PALETTE.walnut, 0.006));
  // The duvet covers the foot two thirds, its folded edge a soft roll.
  const duvetD = mattressD * 0.68;
  const duvetZ = -d / 2 + 0.02 + duvetD / 2;
  parts.push(block(w - 0.03, 0.05, duvetD + 0.01, 0, mattressTop - 0.02, duvetZ, f.fabric, 0.03));
  parts.push(block(w - 0.03, 0.07, 0.12, 0, mattressTop - 0.02, -d / 2 + 0.02 + duvetD - 0.04, f.cushion, 0.035));
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
  return parts;
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
  if (style === "topiary") {
    parts.push(rod(0.015, 0.02, 0.28, 0, potH - 0.02, 0, PALETTE.walnut, 8));
    const balls = [Math.min(r * 0.82, 0.3), Math.min(r * 0.66, 0.24), Math.min(r * 0.48, 0.17)];
    let y = potH + 0.18;
    balls.forEach((br, i) => {
      const radius = Math.min(br, r - 0.005);
      y += radius;
      parts.push(ball(radius, 0, y, 0, i === 1 ? LEAF : LEAF_DARK, 12));
      y += radius * 0.82;
    });
  } else if (style === "leafy") {
    for (let i = 0; i < 9; i++) {
      const a = (i / 9) * Math.PI * 2 + rand() * 0.4;
      const reach = Math.min(Math.max(r - 0.12, 0), 0.42) * (0.35 + rand() * 0.55);
      const radius = Math.min(0.1 + rand() * 0.07, r - reach - 0.005);
      parts.push(ball(radius, Math.cos(a) * reach, potH + 0.1 + rand() * 0.35, Math.sin(a) * reach, [LEAF, LEAF_DARK, LEAF_LIGHT][i % 3] ?? LEAF, 10));
    }
    parts.push(ball(Math.min(0.16, r - 0.01), 0, potH + 0.45, 0, LEAF, 12));
  } else {
    const trunkH = 1.05;
    parts.push(rod(0.03, 0.045, trunkH, 0, potH - 0.02, 0, PALETTE.oakDark, 10));
    const fronds = 8;
    const frondL = Math.min(Math.max(r - 0.02, 0.05), 0.75);
    for (let i = 0; i < fronds; i++) {
      const a = (i / fronds) * Math.PI * 2;
      const frond = block(frondL, 0.012, 0.09, frondL / 2, 0, 0, i % 2 === 0 ? LEAF : LEAF_LIGHT, 0.005);
      frond.geometry.rotateZ(-0.45);
      frond.geometry.rotateY(a);
      frond.geometry.translate(0, potH + trunkH - 0.02, 0);
      parts.push(frond);
    }
  }
  return parts;
}

/** A flat rug with a border: an outer band and a slightly raised field. */
function rug(w: number, d: number, round: boolean, f: Finish): Part[] {
  const border = Math.min(0.08, Math.min(w, d) * 0.08);
  const field = shade(f.fabric, 1.18);
  if (round) {
    const r = Math.min(w, d) / 2;
    return [rod(r, r, 0.01, 0, 0, 0, f.fabricDeep, 40), rod(r - border, r - border, 0.012, 0, 0, 0, field, 40)];
  }
  return [block(w, 0.01, d, 0, 0, 0, f.fabricDeep, 0), block(w - 2 * border, 0.012, d - 2 * border, 0, 0, 0, field, 0)];
}
