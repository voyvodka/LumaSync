/**
 * The twin drawn on canvas: one glow per LED and a blurred ribbon along each
 * edge, the same picture the DOM version drew with one element per LED. A
 * frame is a full repaint — hundreds of radial gradients cost less on a canvas
 * than hundreds of absolutely placed elements re-styled per frame.
 */

import type { LedSegmentKey } from "@/shared/contracts/calibration";
import type { TwinLedPosition } from "../geometry";
import { packLedColor, packedToCss, type PackedLedColor } from "../ledColor";

/** Dim "off" colour for an LED no frame has lit yet. */
export const OFF_COLOR_PACKED: PackedLedColor = packLedColor([16, 18, 24]);
export const DOT_SIZE_PX = 18;
/** Ribbon depth, and the corner inset the horizontal ribbons give up. */
export const RIBBON_THICKNESS = 0.05;
const EDGE_ORDER: LedSegmentKey[] = ["top", "right", "bottom", "left"];

/** The part of a 2D context the twin uses, so a test can record the calls. */
export interface TwinPaint {
  clearRect(x: number, y: number, w: number, h: number): void;
  fillRect(x: number, y: number, w: number, h: number): void;
  createLinearGradient(x0: number, y0: number, x1: number, y1: number): CanvasGradient;
  createRadialGradient(x0: number, y0: number, r0: number, x1: number, y1: number, r1: number): CanvasGradient;
  fillStyle: string | CanvasGradient | CanvasPattern;
}

/**
 * Viewport X → the horizontal ribbon's own 0..1 span. Those ribbons inset by
 * `RIBBON_THICKNESS` each side, so a raw offset drifts inboard of its dot.
 */
function horizontalOffset(x: number): number {
  const span = 1 - RIBBON_THICKNESS * 2;
  return Math.min(1, Math.max(0, (x - RIBBON_THICKNESS) / span));
}

/** One edge's LEDs, sorted along the edge with their gradient stop offsets (0..1). */
export interface EdgeTrack {
  edge: LedSegmentKey;
  stops: Array<{ index: number; offset: number }>;
}

/** Split once per layout; a frame only recolours the stops. */
export function buildEdgeTracks(positions: readonly TwinLedPosition[]): EdgeTrack[] {
  return EDGE_ORDER.flatMap((edge) => {
    const onEdge = positions.filter((p) => p.edge === edge);
    if (onEdge.length === 0) return [];
    const horizontal = edge === "top" || edge === "bottom";
    const sorted = [...onEdge].sort((a, b) => (horizontal ? a.x - b.x : a.y - b.y));
    return [
      {
        edge,
        stops: sorted.map((p) => ({ index: p.index, offset: horizontal ? horizontalOffset(p.x) : p.y })),
      },
    ];
  });
}

// Corner ownership: the vertical (left/right) ribbons run the full height
// and OWN the four corners; the horizontal (top/bottom) ribbons inset by
// `thickness` on each side so the two never cross — that crossing was what
// produced the doubled-brightness corner blobs.
function ribbonRect(edge: LedSegmentKey, width: number, height: number): [number, number, number, number] {
  const across = RIBBON_THICKNESS;
  switch (edge) {
    case "top":
      return [width * across, 0, width * (1 - 2 * across), height * across];
    case "bottom":
      return [width * across, height * (1 - across), width * (1 - 2 * across), height * across];
    case "left":
      return [0, 0, width * across, height];
    case "right":
    default:
      return [width * (1 - across), 0, width * across, height];
  }
}

const colourAt = (packed: readonly PackedLedColor[], index: number) => packed[index] ?? OFF_COLOR_PACKED;

/** Ribbons only; the canvas they go on carries the blur and the opacity. */
export function paintRibbons(
  ctx: TwinPaint,
  tracks: readonly EdgeTrack[],
  packed: readonly PackedLedColor[],
  width: number,
  height: number,
): void {
  ctx.clearRect(0, 0, width, height);
  for (const track of tracks) {
    const [x, y, w, h] = ribbonRect(track.edge, width, height);
    const horizontal = track.edge === "top" || track.edge === "bottom";
    const gradient = horizontal ? ctx.createLinearGradient(x, 0, x + w, 0) : ctx.createLinearGradient(0, 0, 0, height);
    for (const { index, offset } of track.stops) gradient.addColorStop(offset, packedToCss(colourAt(packed, index)));
    ctx.fillStyle = gradient;
    ctx.fillRect(x, y, w, h);
  }
}

/**
 * One glow per LED: the colour fading out to clear. CSS's `radial-gradient(circle, …)`
 * on the old square dot reached its farthest corner, so the radius is the
 * half-diagonal and the square clips the outer stop, as it did there.
 */
export function paintDots(
  ctx: TwinPaint,
  positions: readonly TwinLedPosition[],
  packed: readonly PackedLedColor[],
  width: number,
  height: number,
): void {
  ctx.clearRect(0, 0, width, height);
  const half = DOT_SIZE_PX / 2;
  const radius = half * Math.SQRT2;
  for (const p of positions) {
    const cx = p.x * width;
    const cy = p.y * height;
    const colour = colourAt(packed, p.index);
    const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
    glow.addColorStop(0, packedToCss(colour, 0.95));
    glow.addColorStop(0.36, packedToCss(colour, 0.55));
    glow.addColorStop(0.72, packedToCss(colour, 0));
    ctx.fillStyle = glow;
    ctx.fillRect(cx - half, cy - half, DOT_SIZE_PX, DOT_SIZE_PX);
  }
}
