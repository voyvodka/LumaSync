/**
 * The twin drawn on canvas, as LED Setup draws the strip: a band along the
 * screen's edges, and in it one dot per LED in the colour it shows. The band
 * is what keeps a dot readable on any picture behind it — a black LED on a
 * dark film, a white one on a white page.
 */

import type { TwinLedPosition } from "../geometry";
import { packLedColor, packedToCss, type PackedLedColor } from "../ledColor";

/** An LED no frame has lit yet. */
export const OFF_COLOR_PACKED: PackedLedColor = packLedColor([16, 18, 24]);
/** The band's depth, in CSS pixels. */
export const BAND_PX = 22;
const BAND_COLOR = "rgba(64, 66, 74, 0.85)";
const RING_COLOR = "rgba(0, 0, 0, 0.6)";
const MAX_DOT_RADIUS = 5;
const MIN_DOT_RADIUS = 2;

/** The part of a 2D context the twin uses, so a test can record the calls. */
export interface TwinPaint {
  clearRect(x: number, y: number, w: number, h: number): void;
  fillRect(x: number, y: number, w: number, h: number): void;
  beginPath(): void;
  arc(x: number, y: number, radius: number, startAngle: number, endAngle: number): void;
  fill(): void;
  stroke(): void;
  fillStyle: string | CanvasGradient | CanvasPattern;
  strokeStyle: string | CanvasGradient | CanvasPattern;
  lineWidth: number;
}

/** The band: the top and bottom run corner to corner, the sides between them. */
export function paintBand(ctx: TwinPaint, width: number, height: number): void {
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = BAND_COLOR;
  ctx.fillRect(0, 0, width, BAND_PX);
  ctx.fillRect(0, height - BAND_PX, width, BAND_PX);
  ctx.fillRect(0, BAND_PX, BAND_PX, height - 2 * BAND_PX);
  ctx.fillRect(width - BAND_PX, BAND_PX, BAND_PX, height - 2 * BAND_PX);
}

/** An LED's dot: along its edge where the layout puts it, across it in the middle of the band. */
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

/** As large as the band allows, and small enough that neighbours on the densest edge never touch. */
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
  const fit = Number.isFinite(pitch) ? pitch * 0.38 : MAX_DOT_RADIUS;
  return Math.min(MAX_DOT_RADIUS, Math.max(MIN_DOT_RADIUS, fit));
}

const colourAt = (packed: readonly PackedLedColor[], index: number) => packed[index] ?? OFF_COLOR_PACKED;

/** One dot per LED, in its colour, ringed so a dot the band's own shade still shows. */
export function paintDots(
  ctx: TwinPaint,
  positions: readonly TwinLedPosition[],
  packed: readonly PackedLedColor[],
  width: number,
  height: number,
  radius: number,
): void {
  ctx.clearRect(0, 0, width, height);
  ctx.strokeStyle = RING_COLOR;
  ctx.lineWidth = 1;
  for (const p of positions) {
    const { x, y } = dotCentre(p, width, height);
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fillStyle = packedToCss(colourAt(packed, p.index));
    ctx.fill();
    ctx.stroke();
  }
}
