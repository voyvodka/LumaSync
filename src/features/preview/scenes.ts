// The test scenes the scene window draws. Each is a pure function of the size
// and the time since it started: the same moment always draws the same frame,
// so a run can be repeated and compared. Nothing on screen but the scene — any
// text would be sampled by the capture like the rest.

import type { SceneKind } from "@/shared/contracts/preview";

export type SceneRenderer = (ctx: CanvasRenderingContext2D, width: number, height: number, timeMs: number) => void;

const TAU = Math.PI * 2;

const hsl = (hue: number, saturation: number, lightness: number) =>
  `hsl(${((hue % 360) + 360) % 360} ${saturation}% ${lightness}%)`;

// ── Edge tour ───────────────────────────────────────────────────────────────

/** One loop of the edge, clockwise from the top-left corner. */
export const EDGE_TOUR_LOOP_MS = 12_000;

/** A colour per edge, so a strip that runs the other way or starts on another edge shows it. */
export const EDGE_TOUR_COLORS = {
  top: "rgb(255 42 42)",
  right: "rgb(42 255 74)",
  bottom: "rgb(42 107 255)",
  left: "rgb(255 194 26)",
} as const;

type Edge = keyof typeof EDGE_TOUR_COLORS;

/**
 * Where along the edge the band's centre is: the edge, and how far along it in
 * the clockwise direction, 0..1. The perimeter is shared out by length, so the
 * band moves at one speed all the way round.
 */
export function edgeTourPosition(width: number, height: number, timeMs: number): { edge: Edge; along: number } {
  const perimeter = 2 * (width + height);
  let distance = (((timeMs % EDGE_TOUR_LOOP_MS) + EDGE_TOUR_LOOP_MS) % EDGE_TOUR_LOOP_MS) / EDGE_TOUR_LOOP_MS;
  distance *= perimeter;
  const edges: Array<[Edge, number]> = [
    ["top", width],
    ["right", height],
    ["bottom", width],
    ["left", height],
  ];
  for (const [edge, length] of edges) {
    if (distance < length) return { edge, along: length > 0 ? distance / length : 0 };
    distance -= length;
  }
  return { edge: "top", along: 0 };
}

const edgeTour: SceneRenderer = (ctx, width, height, timeMs) => {
  ctx.fillStyle = "rgb(0 0 0)";
  ctx.fillRect(0, 0, width, height);
  const depth = Math.round(Math.min(width, height) * 0.14);
  const band = Math.round((width + height) * 0.06);
  const { edge, along } = edgeTourPosition(width, height, timeMs);
  ctx.fillStyle = EDGE_TOUR_COLORS[edge];
  switch (edge) {
    case "top":
      ctx.fillRect(along * width - band / 2, 0, band, depth);
      break;
    case "right":
      ctx.fillRect(width - depth, along * height - band / 2, depth, band);
      break;
    case "bottom":
      ctx.fillRect(width - along * width - band / 2, height - depth, band, depth);
      break;
    case "left":
      ctx.fillRect(0, height - along * height - band / 2, depth, band);
      break;
  }
};

// ── Colour spiral ───────────────────────────────────────────────────────────

export const SPIRAL_TURN_MS = 10_000;
const SPIRAL_WEDGES = 180;

/** A colour wheel turning about the centre: every hue passes every LED, smoothly. */
const spiral: SceneRenderer = (ctx, width, height, timeMs) => {
  const cx = width / 2;
  const cy = height / 2;
  const radius = Math.hypot(width, height);
  const turn = (timeMs / SPIRAL_TURN_MS) * 360;
  const step = TAU / SPIRAL_WEDGES;
  for (let i = 0; i < SPIRAL_WEDGES; i++) {
    const start = i * step;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    // A hair of overlap, or anti-aliased seams show between wedges.
    ctx.arc(cx, cy, radius, start, start + step * 1.02);
    ctx.closePath();
    ctx.fillStyle = hsl((i / SPIRAL_WEDGES) * 360 + turn, 100, 50);
    ctx.fill();
  }
};

// ── Sunset ──────────────────────────────────────────────────────────────────

export const SUNSET_LOOP_MS = 40_000;

/** A sky going from day to dusk and back, the sun setting across it: slow, warm, film-like. */
const sunset: SceneRenderer = (ctx, width, height, timeMs) => {
  // 0 → 1 → 0 over a loop, eased, so the sky never jumps back.
  const phase = (1 - Math.cos(((timeMs % SUNSET_LOOP_MS) / SUNSET_LOOP_MS) * TAU)) / 2;
  const horizon = height * 0.68;

  const sky = ctx.createLinearGradient(0, 0, 0, horizon);
  sky.addColorStop(0, hsl(220 + phase * 40, 70, 45 - phase * 33));
  sky.addColorStop(0.6, hsl(30 - phase * 20, 85, 60 - phase * 18));
  sky.addColorStop(1, hsl(18 - phase * 12, 95, 55 - phase * 10));
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, width, horizon);

  const sunRadius = Math.min(width, height) * 0.11;
  const sunX = width * (0.3 + phase * 0.35);
  const sunY = horizon - sunRadius * 1.6 + phase * sunRadius * 2.2;
  const glow = ctx.createRadialGradient(sunX, sunY, 0, sunX, sunY, sunRadius * 5);
  glow.addColorStop(0, "rgb(255 235 170 / 0.85)");
  glow.addColorStop(0.2, "rgb(255 160 60 / 0.45)");
  glow.addColorStop(1, "rgb(255 120 40 / 0)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, width, horizon);
  ctx.beginPath();
  ctx.arc(sunX, sunY, sunRadius, 0, TAU);
  ctx.fillStyle = hsl(45 - phase * 25, 100, 70 - phase * 10);
  ctx.fill();

  const ground = ctx.createLinearGradient(0, horizon, 0, height);
  ground.addColorStop(0, hsl(20, 40, 18 - phase * 10));
  ground.addColorStop(1, hsl(240, 30, 6));
  ctx.fillStyle = ground;
  ctx.fillRect(0, horizon, width, height - horizon);
};

// ── Colour fields ───────────────────────────────────────────────────────────

const FIELDS: ReadonlyArray<{ hue: number; ax: number; ay: number; px: number; py: number; size: number }> = [
  { hue: 0, ax: 0.38, ay: 0.3, px: 17_000, py: 23_000, size: 0.55 },
  { hue: 130, ax: 0.32, ay: 0.36, px: 21_000, py: 13_000, size: 0.5 },
  { hue: 220, ax: 0.4, ay: 0.28, px: 13_000, py: 19_000, size: 0.6 },
  { hue: 50, ax: 0.3, ay: 0.38, px: 29_000, py: 11_000, size: 0.45 },
  { hue: 290, ax: 0.36, ay: 0.32, px: 11_000, py: 27_000, size: 0.5 },
];

function drawFields(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, timeMs: number) {
  ctx.fillStyle = "rgb(6 6 10)";
  ctx.fillRect(x, y, width, height);
  const reach = Math.max(width, height);
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, width, height);
  ctx.clip();
  // Laid over each other, not added: five saturated hues summed go white.
  for (const field of FIELDS) {
    const fx = x + width * (0.5 + field.ax * Math.sin((timeMs / field.px) * TAU));
    const fy = y + height * (0.5 + field.ay * Math.cos((timeMs / field.py) * TAU));
    const radius = reach * field.size;
    const hue = field.hue + timeMs / 400;
    const blob = ctx.createRadialGradient(fx, fy, 0, fx, fy, radius);
    blob.addColorStop(0, `hsl(${((hue % 360) + 360) % 360} 95% 50% / 0.9)`);
    blob.addColorStop(1, `hsl(${((hue % 360) + 360) % 360} 95% 50% / 0)`);
    ctx.fillStyle = blob;
    ctx.fillRect(x, y, width, height);
  }
  ctx.restore();
}

/** Saturated colour fields drifting over each other, each edge seeing its own mix. */
const colorFields: SceneRenderer = (ctx, width, height, timeMs) => {
  drawFields(ctx, 0, 0, width, height, timeMs);
};

// ── Letterbox ───────────────────────────────────────────────────────────────

/** A scope film's picture: wider than the display, so bars fill above and below. */
export const LETTERBOX_ASPECT = 2.39;

/** The picture's height in a `width`×`height` frame, bars excluded. */
export function letterboxPictureHeight(width: number, height: number): number {
  return Math.min(height, width / LETTERBOX_ASPECT);
}

/**
 * A film between black bars. With black border detection on, the top and
 * bottom LEDs take the picture's edge rather than the bars; off, they go dark.
 */
const letterbox: SceneRenderer = (ctx, width, height, timeMs) => {
  ctx.fillStyle = "rgb(0 0 0)";
  ctx.fillRect(0, 0, width, height);
  const picture = letterboxPictureHeight(width, height);
  drawFields(ctx, 0, (height - picture) / 2, width, picture, timeMs);
};

export const SCENE_RENDERERS = {
  edgeTour,
  spiral,
  sunset,
  colorFields,
  letterbox,
} satisfies Record<SceneKind, SceneRenderer>;
