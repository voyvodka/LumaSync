import { describe, expect, it } from "vitest";

import type { TwinLedPosition } from "../geometry";
import { packLedColor } from "../ledColor";
import { buildEdgeTracks, DOT_SIZE_PX, OFF_COLOR_PACKED, paintDots, paintRibbons, type TwinPaint } from "../ui/twinCanvas";

interface FakeGradient {
  kind: "linear" | "radial";
  args: number[];
  stops: Array<[number, string]>;
  addColorStop(offset: number, colour: string): void;
}

function fakePaint() {
  const fills: Array<{ style: FakeGradient; rect: number[] }> = [];
  const gradient = (kind: FakeGradient["kind"], args: number[]): FakeGradient => ({
    kind,
    args,
    stops: [],
    addColorStop(offset, colour) {
      this.stops.push([offset, colour]);
    },
  });
  const ctx = {
    fillStyle: "" as TwinPaint["fillStyle"],
    clearRect: () => {},
    fillRect(x: number, y: number, w: number, h: number) {
      fills.push({ style: ctx.fillStyle as unknown as FakeGradient, rect: [x, y, w, h] });
    },
    createLinearGradient: (...args: number[]) => gradient("linear", args) as unknown as CanvasGradient,
    createRadialGradient: (...args: number[]) => gradient("radial", args) as unknown as CanvasGradient,
  };
  return { ctx: ctx as TwinPaint, fills };
}

const POSITIONS: TwinLedPosition[] = [
  { index: 0, edge: "top", x: 0.05, y: 0.022 },
  { index: 1, edge: "top", x: 0.95, y: 0.022 },
  { index: 2, edge: "right", x: 0.978, y: 0.05 },
  { index: 3, edge: "right", x: 0.978, y: 0.95 },
];

describe("paintDots", () => {
  it("centres one glow per LED in its colour, fading to clear inside its square", () => {
    const { ctx, fills } = fakePaint();
    const packed = [packLedColor([255, 0, 0]), packLedColor([0, 0, 255])];

    paintDots(ctx, POSITIONS.slice(0, 2), packed, 1000, 500);

    expect(fills).toHaveLength(2);
    const [first] = fills;
    expect(first?.rect).toEqual([50 - DOT_SIZE_PX / 2, 11 - DOT_SIZE_PX / 2, DOT_SIZE_PX, DOT_SIZE_PX]);
    expect(first?.style.stops).toEqual([
      [0, "rgba(255, 0, 0, 0.95)"],
      [0.36, "rgba(255, 0, 0, 0.55)"],
      [0.72, "rgba(255, 0, 0, 0)"],
    ]);
  });

  it("draws an LED no frame has lit in the dim off colour", () => {
    const { ctx, fills } = fakePaint();
    paintDots(ctx, POSITIONS.slice(0, 1), [], 100, 100);
    expect(fills[0]?.style.stops[0]?.[1]).toBe(
      `rgba(${(OFF_COLOR_PACKED >> 16) & 0xff}, ${(OFF_COLOR_PACKED >> 8) & 0xff}, ${OFF_COLOR_PACKED & 0xff}, 0.95)`,
    );
  });
});

describe("paintRibbons", () => {
  // The horizontal ribbons are inset 5% each side so the vertical ones own the
  // corners. Feeding them raw viewport offsets shifted every colour inboard of
  // the dot it mirrors — 4.5% of the display width at the corners.
  it("spans a horizontal ribbon's gradient across its own inset rectangle", () => {
    const { ctx, fills } = fakePaint();
    const packed = POSITIONS.map((_, i) => packLedColor([i * 10, 0, 0]));

    paintRibbons(ctx, buildEdgeTracks(POSITIONS), packed, 1000, 500);

    const top = fills[0];
    expect(top?.rect).toEqual([50, 0, 900, 25]);
    expect(top?.style.args).toEqual([50, 0, 950, 0]);
    const [first, last] = top?.style.stops.map(([offset]) => offset) ?? [];
    expect(first).toBeCloseTo(0);
    expect(last).toBeCloseTo(1);

    // The vertical ribbons run the full height, so their stops stay in viewport space.
    const right = fills[1];
    expect(right?.rect).toEqual([950, 0, 50, 500]);
    const [top0, bottom0] = right?.style.stops.map(([offset]) => offset) ?? [];
    expect(top0).toBeCloseTo(0.05);
    expect(bottom0).toBeCloseTo(0.95);
  });
});
