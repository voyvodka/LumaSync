import { describe, expect, it } from "vitest";

import type { TwinLedPosition } from "../geometry";
import { packLedColor } from "../ledColor";
import {
  BAND_PX,
  dotCentre,
  dotFill,
  dotRadius,
  OFF_COLOR_PACKED,
  paintBand,
  paintDots,
  type TwinPaint,
} from "../ui/twinCanvas";

interface FakeGradient {
  stops: Array<[number, string]>;
  addColorStop(offset: number, colour: string): void;
}

function fakePaint() {
  const rects: Array<{ rect: number[]; style: unknown }> = [];
  const dots: Array<{ x: number; y: number; radius: number; fill: string }> = [];
  const glows: FakeGradient[] = [];
  let arc: { x: number; y: number; radius: number } | null = null;
  const ctx: TwinPaint = {
    fillStyle: "",
    clearRect: () => {},
    fillRect: (x, y, w, h) => rects.push({ rect: [x, y, w, h], style: ctx.fillStyle }),
    beginPath: () => {
      arc = null;
    },
    arc: (x, y, radius) => {
      arc = { x, y, radius };
    },
    fill: () => {
      if (arc) dots.push({ ...arc, fill: String(ctx.fillStyle) });
    },
    createRadialGradient: () => {
      const gradient: FakeGradient = {
        stops: [],
        addColorStop(offset, colour) {
          this.stops.push([offset, colour]);
        },
      };
      glows.push(gradient);
      return gradient as unknown as CanvasGradient;
    },
  };
  return { ctx, rects, dots, glows };
}

const POSITIONS: TwinLedPosition[] = [
  { index: 0, edge: "top", x: 0.05, y: 0.022 },
  { index: 1, edge: "top", x: 0.95, y: 0.022 },
  { index: 2, edge: "right", x: 0.978, y: 0.05 },
  { index: 3, edge: "bottom", x: 0.5, y: 0.978 },
  { index: 4, edge: "left", x: 0.022, y: 0.5 },
];

describe("paintBand", () => {
  it("lays the bezel along all four edges without overlapping at the corners", () => {
    const { ctx, rects } = fakePaint();
    paintBand(ctx, 1000, 500);
    expect(rects.slice(0, 4).map((r) => r.rect)).toEqual([
      [0, 0, 1000, BAND_PX],
      [0, 500 - BAND_PX, 1000, BAND_PX],
      [0, BAND_PX, BAND_PX, 500 - 2 * BAND_PX],
      [1000 - BAND_PX, BAND_PX, BAND_PX, 500 - 2 * BAND_PX],
    ]);
  });
});

describe("dotCentre", () => {
  // Along the edge the layout decides; across it, the dot sits mid-bezel whatever the inset said.
  it("puts each LED in the middle of the bezel on its own edge", () => {
    const [top, , right, bottom, left] = POSITIONS.map((p) => dotCentre(p, 1000, 500));
    expect(top).toEqual({ x: 50, y: BAND_PX / 2 });
    expect(right).toEqual({ x: 1000 - BAND_PX / 2, y: 25 });
    expect(bottom).toEqual({ x: 500, y: 500 - BAND_PX / 2 });
    expect(left).toEqual({ x: BAND_PX / 2, y: 250 });
  });
});

describe("dotRadius", () => {
  it("is at its largest when the LEDs are sparse", () => {
    expect(dotRadius(POSITIONS, 1000, 500)).toBe(3.5);
  });

  it("shrinks so neighbours on the densest edge never touch", () => {
    const dense: TwinLedPosition[] = Array.from({ length: 200 }, (_, i) => ({
      index: i,
      edge: "top",
      x: 0.05 + (i / 199) * 0.9,
      y: 0.022,
    }));
    const radius = dotRadius(dense, 1000, 500);
    expect(radius * 2).toBeLessThan(900 / 199);
    expect(radius).toBeGreaterThanOrEqual(1.5);
  });
});

describe("dotFill", () => {
  // A per-channel floor would grey every saturated colour; only an all-but-dark LED goes grey.
  it("keeps a saturated colour as it is and greys only an all-but-dark LED", () => {
    expect(dotFill(packLedColor([255, 0, 0]))).toBe("rgb(255, 0, 0)");
    expect(dotFill(packLedColor([60, 0, 0]))).toBe("rgb(60, 0, 0)");
    expect(dotFill(packLedColor([20, 10, 5]))).toBe("rgb(42, 45, 52)");
    expect(dotFill(OFF_COLOR_PACKED)).toBe("rgb(42, 45, 52)");
  });
});

describe("paintDots", () => {
  it("draws one dot per LED in the colour it shows", () => {
    const { ctx, dots } = fakePaint();
    const packed = [packLedColor([255, 0, 0]), packLedColor([0, 0, 255])];

    paintDots(ctx, POSITIONS.slice(0, 2), packed, 1000, 500, 3);

    expect(dots).toEqual([
      { x: 50, y: BAND_PX / 2, radius: 3, fill: "rgb(255, 0, 0)" },
      { x: 950, y: BAND_PX / 2, radius: 3, fill: "rgb(0, 0, 255)" },
    ]);
  });

  // The glow is the light it throws: as strong as the LED is bright, none from a dark one.
  it("gives a lit LED a glow as strong as it is bright, and a dark one none", () => {
    const { ctx, glows } = fakePaint();
    const packed = [packLedColor([255, 0, 0]), packLedColor([64, 0, 0]), packLedColor([0, 0, 0])];

    paintDots(ctx, POSITIONS.slice(0, 3), packed, 1000, 500, 3);

    expect(glows).toHaveLength(2);
    const [bright, dim] = glows.map((g) => Number(g.stops[0]![1].split(", ")[3]!.replace(")", "")));
    expect(bright).toBeGreaterThan(dim!);
    expect(glows[0]!.stops[1]![1]).toBe("rgba(255, 0, 0, 0)");
  });
});
