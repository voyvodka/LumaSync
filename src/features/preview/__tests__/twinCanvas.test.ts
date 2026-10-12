import { describe, expect, it } from "vitest";

import type { TwinLedPosition } from "../geometry";
import { packLedColor } from "../ledColor";
import { BAND_PX, dotCentre, dotRadius, OFF_COLOR_PACKED, paintBand, paintDots, type TwinPaint } from "../ui/twinCanvas";

function fakePaint() {
  const rects: number[][] = [];
  const dots: Array<{ x: number; y: number; radius: number; fill: string }> = [];
  let arc: { x: number; y: number; radius: number } | null = null;
  const ctx: TwinPaint = {
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 0,
    clearRect: () => {},
    fillRect: (x, y, w, h) => rects.push([x, y, w, h]),
    beginPath: () => {
      arc = null;
    },
    arc: (x, y, radius) => {
      arc = { x, y, radius };
    },
    fill: () => {
      if (arc) dots.push({ ...arc, fill: String(ctx.fillStyle) });
    },
    stroke: () => {},
  };
  return { ctx, rects, dots };
}

const POSITIONS: TwinLedPosition[] = [
  { index: 0, edge: "top", x: 0.05, y: 0.022 },
  { index: 1, edge: "top", x: 0.95, y: 0.022 },
  { index: 2, edge: "right", x: 0.978, y: 0.05 },
  { index: 3, edge: "bottom", x: 0.5, y: 0.978 },
  { index: 4, edge: "left", x: 0.022, y: 0.5 },
];

describe("paintBand", () => {
  it("lays the band along all four edges without overlapping at the corners", () => {
    const { ctx, rects } = fakePaint();
    paintBand(ctx, 1000, 500);
    expect(rects).toEqual([
      [0, 0, 1000, BAND_PX],
      [0, 500 - BAND_PX, 1000, BAND_PX],
      [0, BAND_PX, BAND_PX, 500 - 2 * BAND_PX],
      [1000 - BAND_PX, BAND_PX, BAND_PX, 500 - 2 * BAND_PX],
    ]);
  });
});

describe("dotCentre", () => {
  // Along the edge the layout decides; across it, the dot sits mid-band whatever the inset said.
  it("puts each LED in the middle of the band on its own edge", () => {
    const [top, , right, bottom, left] = POSITIONS.map((p) => dotCentre(p, 1000, 500));
    expect(top).toEqual({ x: 50, y: BAND_PX / 2 });
    expect(right).toEqual({ x: 1000 - BAND_PX / 2, y: 25 });
    expect(bottom).toEqual({ x: 500, y: 500 - BAND_PX / 2 });
    expect(left).toEqual({ x: BAND_PX / 2, y: 250 });
  });
});

describe("dotRadius", () => {
  it("fills the band when the LEDs are sparse", () => {
    expect(dotRadius(POSITIONS, 1000, 500)).toBe(5);
  });

  it("shrinks so neighbours on the densest edge never touch", () => {
    const dense: TwinLedPosition[] = Array.from({ length: 200 }, (_, i) => ({
      index: i,
      edge: "top",
      x: 0.05 + (i / 199) * 0.9,
      y: 0.022,
    }));
    const radius = dotRadius(dense, 1000, 500);
    const pitch = 900 / 199;
    expect(radius * 2).toBeLessThan(pitch);
    expect(radius).toBeGreaterThanOrEqual(2);
  });
});

describe("paintDots", () => {
  it("draws one dot per LED in the colour it shows", () => {
    const { ctx, dots } = fakePaint();
    const packed = [packLedColor([255, 0, 0]), packLedColor([0, 0, 255])];

    paintDots(ctx, POSITIONS.slice(0, 2), packed, 1000, 500, 4);

    expect(dots).toEqual([
      { x: 50, y: BAND_PX / 2, radius: 4, fill: "rgb(255, 0, 0)" },
      { x: 950, y: BAND_PX / 2, radius: 4, fill: "rgb(0, 0, 255)" },
    ]);
  });

  it("draws an LED no frame has lit in the dim off colour", () => {
    const { ctx, dots } = fakePaint();
    paintDots(ctx, POSITIONS.slice(0, 1), [], 100, 100, 4);
    expect(dots[0]?.fill).toBe(
      `rgb(${(OFF_COLOR_PACKED >> 16) & 0xff}, ${(OFF_COLOR_PACKED >> 8) & 0xff}, ${OFF_COLOR_PACKED & 0xff})`,
    );
  });
});
