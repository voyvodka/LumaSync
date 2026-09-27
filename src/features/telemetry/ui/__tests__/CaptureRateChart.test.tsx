import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    i18n: { language: "en-GB" },
    t: (key: string, opts?: Record<string, unknown>) =>
      `${key}${opts ? ` ${Object.values(opts).join(" ")}` : ""}`,
  }),
}));

import { CHART_WINDOW_MS, CaptureRateChart, chartModel, nearestPoint } from "../CaptureRateChart";

const END = Date.UTC(2026, 8, 27, 0, 35, 20);
const sample = (ageSecs: number, fps: number, targetFps = 20) => ({
  epochMs: END - ageSecs * 1000,
  fps,
  targetFps,
});
const moves = (path: string) => path.match(/M/g)?.length ?? 0;

describe("chartModel", () => {
  it("breaks the line where the lights were off instead of drawing through zero", () => {
    const model = chartModel([sample(60, 18), sample(59, 19), sample(20, 17), sample(19, 18)], END);

    expect(moves(model.line)).toBe(2);
    expect(moves(model.target)).toBe(2);
  });

  it("reads a clock that stepped back as a gap", () => {
    const model = chartModel([sample(10, 18), sample(9, 18), sample(12, 18)], END);
    expect(moves(model.line)).toBe(2);
  });

  it("leaves out what is older than the window and sums only what it draws", () => {
    const model = chartModel(
      [{ epochMs: END - CHART_WINDOW_MS - 1000, fps: 2, targetFps: 20 }, sample(2, 18), sample(1, 12)],
      END,
    );

    expect(model.points).toHaveLength(2);
    expect(model.avg).toBe(15);
    expect(model.min).toBe(12);
    expect(model.lastTarget).toBe(20);
  });

  it("draws no target before any worker said one", () => {
    const model = chartModel([sample(2, 18, 0), sample(1, 18, 0)], END);
    expect(model.target).toBe("");
    expect(model.lastTarget).toBeNull();
  });

  it("has nothing to say about an empty history", () => {
    const model = chartModel([], END);
    expect(model).toMatchObject({ line: "", avg: null, min: null, lastTarget: null });
  });
});

describe("nearestPoint", () => {
  const { points } = chartModel([sample(100, 18), sample(99, 19), sample(10, 17)], END);

  it("finds the sample under the pointer", () => {
    expect(nearestPoint(points, points[1]?.x ?? 0)).toBe(1);
  });

  it("finds none over a gap", () => {
    expect(nearestPoint(points, ((CHART_WINDOW_MS / 1000 - 50) / (CHART_WINDOW_MS / 1000)) * 300)).toBe(-1);
  });
});

describe("CaptureRateChart", () => {
  afterEach(cleanup);

  it("steps through the samples with the arrow keys and says each one's time and rate", async () => {
    render(<CaptureRateChart samples={[sample(2, 17.6), sample(1, 12.2)]} endMs={END} />);
    const plot = screen.getByRole("img");

    await act(async () => {
      plot.focus();
      fireEvent.keyDown(plot, { key: "ArrowLeft" });
    });
    const live = document.querySelector("[aria-live]");
    expect(live?.textContent).toMatch(/:\d\d:18 · telemetry:fps 18$/);

    fireEvent.keyDown(plot, { key: "End" });
    expect(live?.textContent).toMatch(/:\d\d:19 · telemetry:fps 12$/);
  });

  it("reads again under a still pointer when a new reading moves the line", () => {
    const first = [sample(3, 17), sample(2, 22), sample(1, 25)];
    const view = render(<CaptureRateChart samples={first} endMs={END} />);
    const plot = screen.getByRole("img");
    plot.getBoundingClientRect = () => ({ left: 0, width: 300 }) as DOMRect;
    // Two seconds from the end of a five-minute, 300 px axis.
    fireEvent.pointerMove(plot, { clientX: 298 });
    const bubble = document.querySelector("[class*=bubble]");
    expect(bubble?.textContent).toMatch(/telemetry:fps 22$/);

    view.rerender(<CaptureRateChart samples={[...first, sample(0, 9)]} endMs={END + 1000} />);

    expect(bubble?.textContent).toMatch(/telemetry:fps 25$/);
  });

  it("moves the bubble with the plot when the window is resized under it", () => {
    let resized: () => void = () => {};
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: () => void) {
          resized = callback;
        }
        observe() {}
        disconnect() {}
      },
    );
    render(<CaptureRateChart samples={[sample(2, 17), sample(1, 25)]} endMs={END} />);
    const plot = screen.getByRole("img");
    let width = 300;
    Object.defineProperty(plot, "clientWidth", { configurable: true, get: () => width });
    fireEvent.keyDown(plot, { key: "Home" });
    const cursor = plot.querySelector("[class*=cursor]") as HTMLElement;
    const before = cursor.style.transform;

    width = 600;
    resized();

    expect(cursor.style.transform).not.toBe(before);
    expect(cursor.style.transform).toMatch(/translateX\(59[0-9.]+px\)/);
    vi.unstubAllGlobals();
  });

  it("never pushes a bubble wider than the plot past its left edge", () => {
    render(<CaptureRateChart samples={[sample(2, 17), sample(1, 25)]} endMs={END} />);
    const plot = screen.getByRole("img");
    Object.defineProperty(plot, "clientWidth", { configurable: true, get: () => 100 });
    const bubble = plot.querySelector("[class*=bubble]") as HTMLElement;
    Object.defineProperty(bubble, "offsetWidth", { configurable: true, get: () => 160 });

    fireEvent.keyDown(plot, { key: "End" });

    expect(bubble.style.transform).toBe("translateX(0px)");
  });

  it("is not a tab stop with nothing to read", () => {
    render(<CaptureRateChart samples={[]} endMs={END} />);
    expect(screen.getByRole("img")).not.toHaveAttribute("tabindex");
    expect(screen.getByTestId("telemetry-history")).toHaveTextContent("telemetry:historyEmpty");
  });
});
