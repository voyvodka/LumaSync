/**
 * The twin drawn on canvas, as LED Setup draws the strip: a near-black bezel along the screen's
 * edges, and in it one small dot per LED in the colour and brightness it shows, a lit one throwing
 * a soft glow onto the picture. The bezel keeps a dot readable on any picture behind it; an LED
 * that is all but dark shows as a dim grey dot, so the strip's shape is always there.
 */

import type { TwinLedPosition } from "../geometry";
import {
  packLedColor,
  packedToCss,
  unpackBlue,
  unpackGreen,
  unpackRed,
  type PackedLedColor,
} from "../ledColor";

/** An LED no frame has lit yet. */
export const OFF_COLOR_PACKED: PackedLedColor = packLedColor([16, 18, 24]);
/** The bezel's depth, in CSS pixels. */
export const BAND_PX = 18;
const BAND_COLOR = "rgb(11 13 17 / 0.92)";
const BAND_EDGE_COLOR = "rgb(255 255 255 / 0.08)";
/** What an LED shows once it is all but dark, so its place on the strip stays in sight. */
const DOT_FLOOR = "rgb(42, 45, 52)";
/** Below this brightest channel an LED reads as dark. */
const DARK_BELOW = 40;
const MAX_DOT_RADIUS = 3.5;
const MIN_DOT_RADIUS = 1.5;
/** How far a lit LED's glow reaches, in dot radii. */
const GLOW_REACH = 7;
const GLOW_ALPHA = 0.55;

/** The part of a 2D context the twin uses, so a test can record the calls. */
export interface TwinPaint {
  clearRect(x: number, y: number, w: number, h: number): void;
  fillRect(x: number, y: number, w: number, h: number): void;
  beginPath(): void;
  arc(x: number, y: number, radius: number, startAngle: number, endAngle: number): void;
  fill(): void;
  createRadialGradient(x0: number, y0: number, r0: number, x1: number, y1: number, r1: number): CanvasGradient;
  fillStyle: string | CanvasGradient | CanvasPattern;
}

/** The bezel: the top and bottom run corner to corner, the sides between them; a faint inner edge. */
export function paintBand(ctx: TwinPaint, width: number, height: number): void {
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = BAND_COLOR;
  ctx.fillRect(0, 0, width, BAND_PX);
  ctx.fillRect(0, height - BAND_PX, width, BAND_PX);
  ctx.fillRect(0, BAND_PX, BAND_PX, height - 2 * BAND_PX);
  ctx.fillRect(width - BAND_PX, BAND_PX, BAND_PX, height - 2 * BAND_PX);
  ctx.fillStyle = BAND_EDGE_COLOR;
  ctx.fillRect(BAND_PX, BAND_PX, width - 2 * BAND_PX, 1);
  ctx.fillRect(BAND_PX, height - BAND_PX - 1, width - 2 * BAND_PX, 1);
  ctx.fillRect(BAND_PX, BAND_PX + 1, 1, height - 2 * BAND_PX - 2);
  ctx.fillRect(width - BAND_PX - 1, BAND_PX + 1, 1, height - 2 * BAND_PX - 2);
}

/** An LED's dot: along its edge where the layout puts it, across it in the middle of the bezel. */
export function dotCentre(p: TwinLedPosition, width: number, height: number): { x: number; y: number } {
  const middle = BAND_PX / 2;
  switch (p.edge) {
    case "top":
      return { x: p.x * width, y: middle };
    case "bottom":
      return { x: p.x * width, y: height - middle };
    case "left":
      return { x: middle, y: p.y * height };
    case "right":
    default:
      return { x: width - middle, y: p.y * height };
  }
}

/** As large as the bezel allows, and small enough that neighbours on the densest edge never touch. */
export function dotRadius(positions: readonly TwinLedPosition[], width: number, height: number): number {
  let pitch = Infinity;
  const byEdge = new Map<string, number[]>();
  for (const p of positions) {
    const horizontal = p.edge === "top" || p.edge === "bottom";
    const along = horizontal ? p.x * width : p.y * height;
    const list = byEdge.get(p.edge) ?? [];
    list.push(along);
    byEdge.set(p.edge, list);
  }
  for (const list of byEdge.values()) {
    list.sort((a, b) => a - b);
    for (let i = 1; i < list.length; i++) pitch = Math.min(pitch, list[i]! - list[i - 1]!);
  }
  const fit = Number.isFinite(pitch) ? pitch * 0.36 : MAX_DOT_RADIUS;
  return Math.min(MAX_DOT_RADIUS, Math.max(MIN_DOT_RADIUS, fit));
}

const colourAt = (packed: readonly PackedLedColor[], index: number) => packed[index] ?? OFF_COLOR_PACKED;

const brightestChannel = (colour: PackedLedColor) =>
  Math.max(unpackRed(colour), unpackGreen(colour), unpackBlue(colour));

/** The dot's fill: the LED's own colour, or a dim grey once it is all but dark. Not a per-channel
 * floor: that would grey every saturated colour, a pure red included. */
export function dotFill(colour: PackedLedColor): string {
  return brightestChannel(colour) < DARK_BELOW ? DOT_FLOOR : packedToCss(colour);
}

/** How strongly an LED glows: its brightest channel, so a dim LED barely does. */
function glowStrength(colour: PackedLedColor): number {
  return brightestChannel(colour) / 255;
}

/** Each lit LED's glow first, then every dot over them: a glow never covers a neighbour's dot. */
export function paintDots(
  ctx: TwinPaint,
  positions: readonly TwinLedPosition[],
  packed: readonly PackedLedColor[],
  width: number,
  height: number,
  radius: number,
): void {
  ctx.clearRect(0, 0, width, height);
  const reach = radius * GLOW_REACH;
  for (const p of positions) {
    const colour = colourAt(packed, p.index);
    const strength = glowStrength(colour) * GLOW_ALPHA;
    if (strength < 0.04) continue;
    const { x, y } = dotCentre(p, width, height);
    const r = unpackRed(colour);
    const g = unpackGreen(colour);
    const b = unpackBlue(colour);
    const glow = ctx.createRadialGradient(x, y, 0, x, y, reach);
    glow.addColorStop(0, `rgba(${r}, ${g}, ${b}, ${strength.toFixed(3)})`);
    glow.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0)`);
    ctx.fillStyle = glow;
    ctx.fillRect(x - reach, y - reach, reach * 2, reach * 2);
  }
  for (const p of positions) {
    const { x, y } = dotCentre(p, width, height);
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fillStyle = dotFill(colourAt(packed, p.index));
    ctx.fill();
  }
}
