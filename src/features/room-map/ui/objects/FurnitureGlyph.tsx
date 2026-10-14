// A piece drawn from above, the way the 3D room builds it: the same model, the same parts in the
// same places and the same colours, so the plan and the room read as one. Unrotated, a seat faces
// the TV wall (the top), and a bed's head and a cabinet's back are at the bottom.
import type { ReactElement } from "react";

import {
  armWidth,
  cornerFits,
  type FurnitureColours,
  type FurnitureModel,
  hexCss,
} from "@/features/room-view/model/furnitureModel";
import { cx } from "@/shared/lib/cx";

import styles from "./FurnitureGlyph.module.css";

const METAL = 0x2b2d31;
const DARK = 0x1d1e21;
const CREAM = 0xe4dacb;
const MUG = 0xf2eee7;
const BOOK_RED = 0xb4513e;
const BOOK_BLUE = 0x3f679a;
const LEAVES = [0x55744a, 0x67875a, 0x4a6640];
const BOOKS = [0xb4513e, 0x3f679a, 0xd8c9a8, 0x5d7d52, 0xc49a3c, 0x7b4f6e, 0x2f3b4d];
const BOX = 0x6b7079;

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

/** `colour` scaled towards black (< 1) or white (> 1). */
function shade(colour: number, factor: number): number {
  const channel = (shift: number) => {
    const c = (colour >> shift) & 0xff;
    const v = factor <= 1 ? c * factor : c + (255 - c) * (factor - 1);
    return clamp(Math.round(v), 0, 255) << shift;
  };
  return channel(16) | channel(8) | channel(0);
}

interface Shape {
  key: string;
  fill: number;
  /** The outline is the fill a shade darker unless given. */
  line?: number | null;
}

/** Collects one glyph's shapes, each outlined a shade darker than its fill unless told otherwise. */
class Pen {
  readonly shapes: ReactElement[] = [];

  private outline(s: Shape): string | undefined {
    return s.line === null ? undefined : hexCss(s.line ?? shade(s.fill, 0.62));
  }

  rect(s: Shape, x: number, y: number, w: number, h: number, r = 0.03) {
    if (w <= 0 || h <= 0) return;
    this.shapes.push(
      <rect key={s.key} x={x} y={y} width={w} height={h} rx={Math.min(r, w / 2, h / 2)} fill={hexCss(s.fill)} stroke={this.outline(s)} />,
    );
  }

  ellipse(s: Shape, cx: number, cy: number, rx: number, ry: number, rotate = 0) {
    if (rx <= 0 || ry <= 0) return;
    this.shapes.push(
      <ellipse
        key={s.key}
        cx={cx}
        cy={cy}
        rx={rx}
        ry={ry}
        transform={rotate === 0 ? undefined : `rotate(${rotate} ${cx} ${cy})`}
        fill={hexCss(s.fill)}
        stroke={this.outline(s)}
      />,
    );
  }

  line(key: string, colour: number, x1: number, y1: number, x2: number, y2: number) {
    this.shapes.push(<line key={key} x1={x1} y1={y1} x2={x2} y2={y2} stroke={hexCss(colour)} />);
  }

  group(key: string, transform: string, shapes: (pen: Pen) => void) {
    const inner = new Pen();
    shapes(inner);
    this.shapes.push(
      <g key={key} transform={transform}>
        {inner.shapes}
      </g>,
    );
  }
}

function upholstered(pen: Pen, w: number, d: number, seats: number, arms: boolean, c: FurnitureColours) {
  const armW = arms ? armWidth(w) : 0;
  const backD = clamp(d * 0.22, 0.06, 0.2);
  pen.rect({ key: "frame", fill: shade(c.fabric, 0.84) }, 0, 0, w, d, 0.06);
  pen.rect({ key: "back", fill: c.fabric }, 0, d - backD, w, backD, 0.05);
  if (arms) {
    pen.rect({ key: "arm-l", fill: c.fabric }, 0, 0, armW, d, 0.05);
    pen.rect({ key: "arm-r", fill: c.fabric }, w - armW, 0, armW, d, 0.05);
  }
  const seatW = (w - 2 * armW) / Math.max(seats, 1);
  const seatD = Math.max(d - backD - 0.02, 0.02);
  for (let i = 0; i < seats; i++) {
    pen.rect({ key: `seat-${i}`, fill: shade(c.fabric, 1.12) }, armW + i * seatW + 0.007, 0.01, seatW - 0.014, seatD, 0.05);
  }
}

/** An L sectional: a run along the back and a chaise forward on the sitter's `side`. */
function cornerSofa(pen: Pen, w: number, d: number, side: "left" | "right", c: FurnitureColours) {
  const sofaD = Math.min(0.98, d * 0.55);
  const chaiseW = clamp(w * 0.38, 0.8, 1.0);
  const armW = armWidth(w);
  const backD = clamp(sofaD * 0.22, 0.06, 0.2);
  const left = side === "left";
  const runY = d - sofaD;
  const deep = shade(c.fabric, 0.84);
  const cushion = shade(c.fabric, 1.12);
  const chaiseX = left ? 0 : w - chaiseW;
  pen.rect({ key: "chaise", fill: deep }, chaiseX, 0, chaiseW, runY + 0.06, 0.06);
  pen.rect({ key: "chaise-seat", fill: cushion }, chaiseX + (left ? armW : 0.02), 0.01, chaiseW - armW - 0.02, runY, 0.05);
  pen.rect({ key: "chaise-arm", fill: c.fabric }, left ? 0 : w - armW, 0, armW, runY + 0.04, 0.05);
  pen.rect({ key: "run", fill: deep }, 0, runY, w, sofaD, 0.06);
  pen.rect({ key: "back", fill: c.fabric }, 0, d - backD, w, backD, 0.05);
  pen.rect({ key: "run-arm", fill: c.fabric }, left ? w - armW : 0, runY, armW, sofaD, 0.05);
  const inner = w - armW;
  const seats = clamp(Math.round(inner / 0.62), 1, 5);
  const seatW = inner / seats;
  const start = left ? 0 : armW;
  for (let i = 0; i < seats; i++) {
    pen.rect({ key: `seat-${i}`, fill: cushion }, start + i * seatW + 0.007, runY + 0.01, seatW - 0.014, sofaD - backD - 0.02, 0.05);
  }
}

function diningChair(pen: Pen, w: number, d: number, c: FurnitureColours) {
  pen.rect({ key: "seat", fill: shade(c.fabric, 1.05) }, 0.02, 0.02, w - 0.04, d - 0.08, 0.04);
  pen.rect({ key: "back", fill: c.wood }, 0, d - 0.06, w, 0.06, 0.02);
}

function officeChair(pen: Pen, w: number, d: number, c: FurnitureColours) {
  const cx = w / 2;
  const cy = d / 2;
  const reach = Math.max(Math.min(w, d) / 2 - 0.03, 0.02);
  for (let k = 0; k < 5; k++) {
    const a = (k / 5) * Math.PI * 2 - Math.PI / 2;
    pen.line(`leg-${k}`, METAL, cx, cy, cx + Math.cos(a) * reach, cy + Math.sin(a) * reach);
    pen.ellipse({ key: `caster-${k}`, fill: DARK, line: null }, cx + Math.cos(a) * reach, cy + Math.sin(a) * reach, 0.022, 0.022);
  }
  const seatR = Math.min(w, d) * 0.34;
  pen.ellipse({ key: "seat", fill: shade(c.fabric, 0.9) }, cx, cy - seatR * 0.1, seatR, seatR * 0.92);
  pen.rect({ key: "back", fill: shade(c.fabric, 0.75) }, cx - seatR * 0.95, cy + seatR * 0.62, seatR * 1.9, 0.07, 0.035);
}

function bench(pen: Pen, w: number, d: number, c: FurnitureColours) {
  pen.rect({ key: "frame", fill: c.wood }, 0, 0, w, d, 0.02);
  pen.rect({ key: "pad", fill: c.fabric }, 0.02, 0.01, w - 0.04, d - 0.02, 0.025);
}

function desk(pen: Pen, w: number, d: number, screenX: number | null, c: FurnitureColours) {
  pen.rect({ key: "top", fill: c.wood }, 0, 0, w, d, 0.015);
  if (screenX === null) return;
  const kw = Math.min(0.44, w * 0.5);
  const kx = clamp(w / 2 + screenX, kw / 2 + 0.02, w - kw / 2 - 0.02);
  const kd = Math.min(0.14, d * 0.3);
  const ky = Math.min(0.2, d * 0.32);
  const mw = Math.min(0.6, w * 0.45);
  pen.rect({ key: "monitor", fill: DARK, line: null }, clamp(kx - mw / 2, 0.02, w - mw - 0.02), Math.max(ky - kd / 2 - 0.07, 0.015), mw, 0.03, 0.01);
  pen.rect({ key: "keyboard", fill: shade(DARK, 1.3) }, kx - kw / 2, ky - kd / 2 + 0.02, kw, kd * 0.7, 0.01);
  pen.rect({ key: "mouse", fill: shade(DARK, 1.3) }, clamp(kx + kw / 2 + 0.07, 0.02, w - 0.08), ky - 0.01, 0.06, 0.09, 0.03);
}

function coffeeTable(pen: Pen, w: number, d: number, c: FurnitureColours) {
  pen.rect({ key: "top", fill: c.wood }, 0, 0, w, d, 0.03);
  const bw = Math.min(0.24, w * 0.3);
  const bd = Math.min(0.17, d * 0.35);
  const bx = w * 0.38;
  const by = d * 0.48;
  pen.group("books", `rotate(12 ${bx} ${by})`, (books) => {
    books.rect({ key: "red", fill: BOOK_RED }, bx - bw / 2, by - bd / 2, bw, bd, 0.006);
    books.rect({ key: "blue", fill: BOOK_BLUE }, bx - bw * 0.4, by - bd * 0.4, bw * 0.8, bd * 0.8, 0.006);
  });
  pen.ellipse({ key: "mug", fill: MUG }, clamp(w * 0.7, 0.06, w - 0.06), clamp(d * 0.42, 0.06, d - 0.06), 0.04, 0.04);
}

function sideTable(pen: Pen, w: number, d: number, round: boolean, c: FurnitureColours) {
  if (round) {
    const r = Math.min(w, d) / 2 - 0.005;
    pen.ellipse({ key: "top", fill: c.wood }, w / 2, d / 2, r, r);
    pen.ellipse({ key: "rim", fill: shade(c.wood, 1.08), line: null }, w / 2, d / 2, r * 0.82, r * 0.82);
    return;
  }
  pen.rect({ key: "top", fill: c.wood }, 0, 0, w, d, 0.015);
}

function diningTable(pen: Pen, w: number, d: number, c: FurnitureColours) {
  pen.rect({ key: "top", fill: c.wood }, 0, 0, w, d, 0.02);
  pen.rect({ key: "inlay", fill: shade(c.wood, 1.06), line: shade(c.wood, 0.8) }, 0.07, 0.07, w - 0.14, d - 0.14, 0.01);
}

/** A top seen from above, with the seams of its doors or drawers along the front edge (the top). */
function cabinetTop(pen: Pen, w: number, d: number, fill: number, fronts: number) {
  pen.rect({ key: "top", fill }, 0, 0, w, d, 0.012);
  const seamD = Math.min(0.06, d * 0.3);
  for (let i = 1; i < fronts; i++) pen.line(`seam-${i}`, shade(fill, 0.55), (w * i) / fronts, 0, (w * i) / fronts, seamD);
}

function bookshelf(pen: Pen, w: number, d: number, c: FurnitureColours) {
  pen.rect({ key: "top", fill: c.wood }, 0, 0, w, d, 0.01);
  // Book tops along the open front, as a fixed rhythm rather than the room's seed.
  const inner = w - 0.06;
  let x = 0.03;
  for (let i = 0; x < 0.03 + inner - 0.02; i++) {
    const bookW = 0.025 + ((i * 7) % 5) * 0.006;
    const bookD = Math.min(d - 0.05, 0.16 + ((i * 3) % 4) * 0.015);
    pen.rect({ key: `book-${i}`, fill: BOOKS[i % BOOKS.length] ?? BOOK_RED, line: null }, x, 0.02, Math.min(bookW, 0.03 + inner - x), bookD, 0.004);
    x += bookW + 0.004;
  }
}

function bed(pen: Pen, w: number, d: number, c: FurnitureColours) {
  const headD = Math.min(0.08, d * 0.06);
  const mattressD = Math.max(d - headD - 0.04, 0.1);
  pen.rect({ key: "frame", fill: c.wood }, 0, 0, w, d, 0.04);
  pen.rect({ key: "mattress", fill: CREAM }, 0.04, 0.02, w - 0.08, mattressD, 0.05);
  pen.rect({ key: "head", fill: shade(c.wood, 0.8) }, 0, d - headD, w, headD, 0.03);
  const sleepers = w >= 1.2 ? 2 : 1;
  const pillowW = Math.max(Math.min(0.62, (w - 0.18) / sleepers - 0.05), 0.05);
  const pillowD = Math.min(0.34, mattressD * 0.24);
  const pillowY = 0.02 + mattressD - pillowD - 0.04;
  for (let i = 0; i < sleepers; i++) {
    const x = sleepers === 1 ? w / 2 : w / 2 + (i === 0 ? -1 : 1) * (w / 4 - 0.02);
    pen.rect({ key: `pillow-${i}`, fill: CREAM }, x - pillowW / 2, pillowY, pillowW, pillowD, 0.06);
  }
  const duvetD = mattressD * 0.68;
  pen.rect({ key: "duvet", fill: c.fabric }, 0.03, 0.01, w - 0.06, duvetD, 0.05);
  pen.rect({ key: "fold", fill: shade(c.fabric, 1.15) }, 0.03, duvetD - 0.08, w - 0.06, 0.09, 0.04);
}

function plant(pen: Pen, w: number, d: number, style: "topiary" | "leafy" | "palm", c: FurnitureColours) {
  const cx = w / 2;
  const cy = d / 2;
  const r = Math.min(w, d) / 2;
  const potR = Math.min(r * 0.72, 0.28);
  pen.ellipse({ key: "pot", fill: c.fabric }, cx, cy, potR, potR);
  const [mid, light, deep] = LEAVES as [number, number, number];
  if (style === "topiary") {
    pen.ellipse({ key: "ball", fill: mid }, cx, cy, Math.min(r * 0.82, 0.3), Math.min(r * 0.82, 0.3));
    pen.ellipse({ key: "shine", fill: light, line: null }, cx - r * 0.18, cy - r * 0.18, Math.min(r * 0.4, 0.14), Math.min(r * 0.4, 0.14));
    return;
  }
  const fronds = style === "palm" ? 7 : 6;
  for (let i = 0; i < fronds; i++) {
    const a = (i / fronds) * 360 + 15;
    const rad = (a * Math.PI) / 180;
    const len = style === "palm" ? r * 0.92 : r * 0.62;
    const reach = style === "palm" ? len / 2 : r * 0.42;
    pen.ellipse(
      { key: `leaf-${i}`, fill: i % 2 === 0 ? mid : deep },
      cx + Math.cos(rad) * reach,
      cy + Math.sin(rad) * reach,
      len / 2,
      style === "palm" ? r * 0.12 : r * 0.3,
      a,
    );
  }
  pen.ellipse({ key: "heart", fill: light, line: null }, cx, cy, r * 0.2, r * 0.2);
}

function rug(pen: Pen, w: number, d: number, round: boolean, c: FurnitureColours) {
  if (round) {
    pen.ellipse({ key: "rug", fill: c.fabric }, w / 2, d / 2, w / 2 - 0.01, d / 2 - 0.01);
    pen.ellipse({ key: "border", fill: c.fabric, line: shade(c.fabric, 1.3) }, w / 2, d / 2, w / 2 - 0.09, d / 2 - 0.09);
    return;
  }
  pen.rect({ key: "rug", fill: c.fabric }, 0.04, 0, w - 0.08, d, 0.02);
  pen.rect({ key: "border", fill: c.fabric, line: shade(c.fabric, 1.3) }, 0.12, 0.08, w - 0.24, d - 0.16, 0.01);
  const fringe = Math.max(4, Math.round(d / 0.05));
  for (let i = 0; i <= fringe; i++) {
    const y = (d * i) / fringe;
    pen.line(`fringe-l-${i}`, shade(c.fabric, 1.25), 0, y, 0.04, y);
    pen.line(`fringe-r-${i}`, shade(c.fabric, 1.25), w - 0.04, y, w, y);
  }
}

function draw(pen: Pen, model: FurnitureModel, w: number, d: number, c: FurnitureColours) {
  switch (model.kind) {
    case "upholstered":
      return model.corner && cornerFits(w, d)
        ? cornerSofa(pen, w, d, model.corner, c)
        : upholstered(pen, w, d, model.seats, model.arms, c);
    case "diningChair":
      return diningChair(pen, w, d, c);
    case "officeChair":
      return officeChair(pen, w, d, c);
    case "bench":
      return bench(pen, w, d, c);
    case "desk":
      return desk(pen, w, d, model.screenX, c);
    case "coffeeTable":
      return coffeeTable(pen, w, d, c);
    case "sideTable":
      return sideTable(pen, w, d, model.round, c);
    case "diningTable":
      return diningTable(pen, w, d, c);
    case "cabinet":
      return cabinetTop(pen, w, d, c.wood, model.doors);
    case "bookshelf":
      return bookshelf(pen, w, d, c);
    case "wardrobe":
      return cabinetTop(pen, w, d, c.wood, Math.round(clamp(w / 0.5, 2, 4)));
    case "nightstand":
      return cabinetTop(pen, w, d, c.wood, 1);
    case "tvUnit":
      return cabinetTop(pen, w, d, c.wood, Math.max(2, Math.round(w / 0.5)));
    case "bed":
      return bed(pen, w, d, c);
    case "plant":
      return plant(pen, w, d, model.style, c);
    case "rug":
      return rug(pen, w, d, model.round, c);
    case "box":
      pen.rect({ key: "box", fill: BOX }, 0, 0, w, d, 0.02);
      pen.line("cross-a", shade(BOX, 0.7), 0.04, 0.04, w - 0.04, d - 0.04);
      pen.line("cross-b", shade(BOX, 0.7), w - 0.04, 0.04, 0.04, d - 0.04);
      return;
  }
}

/**
 * One piece from above, in a box of its own width and depth (metres). On the plan it fills the
 * piece's rectangle; `fit` keeps its proportions inside any box, for a tile or a preview.
 */
export function FurnitureGlyph({
  model,
  colours,
  width,
  depth,
  fit = false,
  className,
}: {
  model: FurnitureModel;
  colours: FurnitureColours;
  width: number;
  depth: number;
  fit?: boolean;
  className?: string;
}) {
  const w = Math.max(width, 0.05);
  const d = Math.max(depth, 0.05);
  const pen = new Pen();
  draw(pen, model, w, d, colours);
  return (
    <svg
      className={cx(styles.glyph, className)}
      viewBox={`0 0 ${w} ${d}`}
      preserveAspectRatio={fit ? "xMidYMid meet" : "none"}
      aria-hidden="true"
      focusable="false"
    >
      {pen.shapes}
    </svg>
  );
}
