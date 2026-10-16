import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ZoneRect } from "../../model/zoneRect";
import { ZoneDrawLayer } from "../ZoneDrawLayer";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
}));

afterEach(cleanup);

// A 5×4 m room drawn at 100 px a metre, at the origin of the viewport.
function setup(panMode = false) {
  const onDraw = vi.fn<(rect: ZoneRect) => void>();
  const onCancel = vi.fn<() => void>();
  render(<ZoneDrawLayer widthM={5} depthM={4} pxPerMeter={100} zoom={1} panMode={panMode} colour="var(--lm-zone-1)" onDraw={onDraw} onCancel={onCancel} />);
  const layer = screen.getByTestId("zone-draw-layer");
  layer.getBoundingClientRect = () => ({ left: 0, top: 0, width: 500, height: 400, right: 500, bottom: 400, x: 0, y: 0, toJSON: () => ({}) });
  layer.setPointerCapture = () => {};
  return { layer, onDraw, onCancel };
}

describe("ZoneDrawLayer", () => {
  it("draws the dragged rectangle in metres", () => {
    const { layer, onDraw } = setup();
    fireEvent.pointerDown(layer, { button: 0, clientX: 100, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(layer, { clientX: 250, clientY: 300, pointerId: 1 });
    fireEvent.pointerUp(layer, { clientX: 300, clientY: 300, pointerId: 1 });
    expect(onDraw).toHaveBeenCalledWith({ x0: 1, y0: 1, x1: 3, y1: 3 });
  });

  it("drops the default size on a click", () => {
    const { layer, onDraw } = setup();
    fireEvent.pointerDown(layer, { button: 0, clientX: 250, clientY: 200, pointerId: 1 });
    fireEvent.pointerUp(layer, { clientX: 250, clientY: 200, pointerId: 1 });
    expect(onDraw).toHaveBeenCalledWith({ x0: 1.25, y0: 1, x1: 3.75, y1: 3 });
  });

  it("leaves a press with space held to the canvas, which pans", () => {
    const { layer, onDraw } = setup(true);
    const canvas = vi.fn<() => void>();
    layer.parentElement!.addEventListener("pointerdown", canvas);
    fireEvent.pointerDown(layer, { button: 0, clientX: 100, clientY: 100, pointerId: 1 });
    fireEvent.pointerUp(layer, { clientX: 300, clientY: 300, pointerId: 1 });
    expect(canvas).toHaveBeenCalledTimes(1);
    expect(onDraw).not.toHaveBeenCalled();
  });

  it("cancels on Escape before the editor sees it", () => {
    const { onCancel } = setup();
    const outer = vi.fn<(e: KeyboardEvent) => void>();
    window.addEventListener("keydown", outer);
    fireEvent.keyDown(window, { key: "Escape" });
    window.removeEventListener("keydown", outer);
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(outer).not.toHaveBeenCalled();
  });
});
