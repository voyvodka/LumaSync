import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { FurnitureColours, FurnitureModel } from "@/features/room-view/model/furnitureModel";

import { FurnitureGlyph } from "../FurnitureGlyph";

const COLOURS: FurnitureColours = { fabric: 0x55657d, wood: 0xb88d63, woodToned: false };

const MODELS: FurnitureModel[] = [
  { kind: "upholstered", seats: 3, arms: true, corner: null },
  { kind: "upholstered", seats: 1, arms: false, corner: null },
  { kind: "upholstered", seats: 3, arms: true, corner: "left" },
  { kind: "upholstered", seats: 3, arms: true, corner: "right" },
  { kind: "diningChair" },
  { kind: "officeChair" },
  { kind: "bench" },
  { kind: "desk", screenX: 0.2 },
  { kind: "desk", screenX: null },
  { kind: "coffeeTable" },
  { kind: "sideTable", round: true },
  { kind: "sideTable", round: false },
  { kind: "diningTable" },
  { kind: "cabinet", doors: 3 },
  { kind: "bookshelf" },
  { kind: "wardrobe" },
  { kind: "nightstand" },
  { kind: "tvUnit" },
  { kind: "bed" },
  { kind: "plant", style: "topiary" },
  { kind: "plant", style: "leafy" },
  { kind: "plant", style: "palm" },
  { kind: "rug", round: true },
  { kind: "rug", round: false },
  { kind: "box" },
];

const SIZES: Array<[number, number]> = [
  [2.4, 0.95],
  [0.5, 0.5],
  [3.2, 1.8],
  [0.12, 0.3],
];

const num = (el: Element, name: string) => Number(el.getAttribute(name) ?? 0);

/** Every shape the glyph draws outside a rotated group, as a box in the piece's metres. */
function extents(svg: SVGSVGElement): Array<{ tag: string; x0: number; y0: number; x1: number; y1: number }> {
  return [...svg.querySelectorAll("rect, ellipse, line")]
    .filter((el) => el.parentNode === svg)
    .map((el) => {
      if (el.tagName === "rect") {
        return { tag: "rect", x0: num(el, "x"), y0: num(el, "y"), x1: num(el, "x") + num(el, "width"), y1: num(el, "y") + num(el, "height") };
      }
      if (el.tagName === "ellipse") {
        // Rotated leaves reach as far as their longer radius in any direction.
        const r = el.hasAttribute("transform") ? Math.max(num(el, "rx"), num(el, "ry")) : 0;
        const rx = r || num(el, "rx");
        const ry = r || num(el, "ry");
        return { tag: "ellipse", x0: num(el, "cx") - rx, y0: num(el, "cy") - ry, x1: num(el, "cx") + rx, y1: num(el, "cy") + ry };
      }
      return {
        tag: "line",
        x0: Math.min(num(el, "x1"), num(el, "x2")),
        y0: Math.min(num(el, "y1"), num(el, "y2")),
        x1: Math.max(num(el, "x1"), num(el, "x2")),
        y1: Math.max(num(el, "y1"), num(el, "y2")),
      };
    });
}

describe("FurnitureGlyph", () => {
  it.each(MODELS.map((model) => [JSON.stringify(model), model] as const))(
    "%s stays inside its footprint at every size",
    (_name, model) => {
      for (const [w, d] of SIZES) {
        const { container, unmount } = render(<FurnitureGlyph model={model} colours={COLOURS} width={w} depth={d} />);
        const svg = container.querySelector("svg") as SVGSVGElement;
        const vw = Math.max(w, 0.05);
        const vd = Math.max(d, 0.05);
        expect(svg.getAttribute("viewBox")).toBe(`0 0 ${vw} ${vd}`);
        const shapes = extents(svg);
        expect(shapes.length).toBeGreaterThan(0);
        for (const s of shapes) {
          expect(s.x0, `${s.tag} left at ${w}×${d}`).toBeGreaterThanOrEqual(-1e-6);
          expect(s.y0, `${s.tag} top at ${w}×${d}`).toBeGreaterThanOrEqual(-1e-6);
          expect(s.x1, `${s.tag} right at ${w}×${d}`).toBeLessThanOrEqual(vw + 1e-6);
          expect(s.y1, `${s.tag} bottom at ${w}×${d}`).toBeLessThanOrEqual(vd + 1e-6);
        }
        unmount();
      }
    },
  );

  it("fills the piece on the plan and keeps its proportions in a tile", () => {
    const model: FurnitureModel = { kind: "bed" };
    const plan = render(<FurnitureGlyph model={model} colours={COLOURS} width={1.6} depth={2.1} />);
    expect(plan.container.querySelector("svg")?.getAttribute("preserveAspectRatio")).toBe("none");
    const tile = render(<FurnitureGlyph model={model} colours={COLOURS} width={1.6} depth={2.1} fit />);
    expect(tile.container.querySelector("svg")?.getAttribute("preserveAspectRatio")).toBe("xMidYMid meet");
  });

  it("paints the piece in its own colours", () => {
    const { container } = render(
      <FurnitureGlyph model={{ kind: "coffeeTable" }} colours={{ ...COLOURS, wood: 0x6b4a33 }} width={1} depth={0.6} />,
    );
    expect(container.querySelector("rect")?.getAttribute("fill")).toBe("#6b4a33");
  });
});
