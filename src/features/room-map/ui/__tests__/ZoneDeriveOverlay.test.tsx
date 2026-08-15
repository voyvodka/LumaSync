// ZONE-02 / ZONE-03. Previously import-only smoke checks, justified by a jsdom
// limitation the project no longer has — it renders under happy-dom.
import { describe, it, expect, vi } from "vitest";
import { fireEvent, render } from "@testing-library/react";

import { ZoneDeriveOverlay } from "../ZoneDeriveOverlay";
import type { ZoneDeriveResult } from "../../model/deriveZones";
import type { TvAnchorPlacement } from "@/shared/contracts/roomMap";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const EDGE_COLORS = {
  top: "#10b981",
  bottom: "#f59e0b",
  left: "#3b82f6",
  right: "#a855f7",
} as const;

// pxPerMeter 100 with this TV puts the box at left 140, right 260, top 115,
// bottom 185 — the numbers the geometry assertions below expect.
const TV: TvAnchorPlacement = { x: 2, y: 1.5, width: 1.2, height: 0.7 };
const PX_PER_METER = 100;

function makeResult(segments: ZoneDeriveResult["segments"]): ZoneDeriveResult {
  const counts = { top: 0, right: 0, bottom: 0, left: 0 };
  for (const s of segments) counts[s.edge] += s.ledCount;
  return { counts, segments };
}

function renderOverlay(
  result: ZoneDeriveResult,
  handlers: { onConfirm?: () => void; onDiscard?: () => void } = {},
) {
  return render(
    <ZoneDeriveOverlay
      result={result}
      tv={TV}
      pxPerMeter={PX_PER_METER}
      onConfirm={handlers.onConfirm ?? (() => {})}
      onDiscard={handlers.onDiscard ?? (() => {})}
    />,
  );
}

const ALL_EDGES = makeResult([
  { edge: "top", ledCount: 24, lengthMeters: 1.2 },
  { edge: "right", ledCount: 14, lengthMeters: 0.7 },
  { edge: "bottom", ledCount: 24, lengthMeters: 1.2 },
  { edge: "left", ledCount: 14, lengthMeters: 0.7 },
]);

describe("ZoneDeriveOverlay", () => {
  it("draws one edge line per lit edge, spanning the TV bounds in pixels", () => {
    const { container } = renderOverlay(ALL_EDGES);

    const coord = (el: Element | null, attr: string) => Number(el?.getAttribute(attr));

    const top = container.querySelector('[data-testid="zone-edge-top"]');
    expect(top).toBeTruthy();
    expect(coord(top, "x1")).toBeCloseTo(140);
    expect(coord(top, "x2")).toBeCloseTo(260);
    expect(coord(top, "y1")).toBeCloseTo(115);
    expect(coord(top, "y2")).toBeCloseTo(115);

    const left = container.querySelector('[data-testid="zone-edge-left"]');
    expect(coord(left, "x1")).toBeCloseTo(140);
    expect(coord(left, "y1")).toBeCloseTo(115);
    expect(coord(left, "y2")).toBeCloseTo(185);
  });

  it("paints each edge in its own palette color", () => {
    const { container } = renderOverlay(ALL_EDGES);
    for (const [edge, color] of Object.entries(EDGE_COLORS)) {
      const line = container.querySelector(`[data-testid="zone-edge-${edge}"]`);
      expect(line?.getAttribute("stroke")).toBe(color);
    }
  });

  it("omits both the line and the badge for an edge with no LEDs", () => {
    const { container } = renderOverlay(
      makeResult([{ edge: "top", ledCount: 24, lengthMeters: 1.2 }]),
    );

    expect(container.querySelector('[data-testid="zone-edge-top"]')).toBeTruthy();
    for (const edge of ["right", "bottom", "left"]) {
      expect(container.querySelector(`[data-testid="zone-edge-${edge}"]`)).toBeNull();
    }
    expect(container.textContent).toContain("roomMap:edges.top: 24");
    expect(container.textContent).not.toContain("roomMap:edges.bottom");
  });

  it("sums several segments on the same edge into one badge count", () => {
    const { container } = renderOverlay(
      makeResult([
        { edge: "top", ledCount: 10, lengthMeters: 0.5 },
        { edge: "top", ledCount: 14, lengthMeters: 0.7 },
      ]),
    );

    expect(container.textContent).toContain("roomMap:edges.top: 24");
    expect(container.querySelectorAll('[data-testid="zone-edge-top"]')).toHaveLength(1);
  });

  it("calls onConfirm and onDiscard from their own buttons", () => {
    const onConfirm = vi.fn();
    const onDiscard = vi.fn();
    const { getByText } = renderOverlay(ALL_EDGES, { onConfirm, onDiscard });

    fireEvent.click(getByText("roomMap:zones.confirmDeriveButton"));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onDiscard).not.toHaveBeenCalled();

    fireEvent.click(getByText("roomMap:zones.cancelDeriveButton"));
    expect(onDiscard).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("puts focus on the confirm button as soon as the overlay opens", () => {
    const { getByText } = renderOverlay(ALL_EDGES);
    expect(document.activeElement).toBe(getByText("roomMap:zones.confirmDeriveButton"));
  });
});
