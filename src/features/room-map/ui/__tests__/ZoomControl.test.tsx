import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ZOOM_MAX, ZOOM_MIN, ZoomControl } from "../ZoomControl";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

beforeEach(cleanup);

function renderControl(zoom: number) {
  const onZoomChange = vi.fn();
  const onPanChange = vi.fn();
  const onFitToView = vi.fn();
  render(
    <ZoomControl
      zoom={zoom}
      canvasSize={{ w: 800, h: 600 }}
      panOffset={{ x: 0, y: 0 }}
      onZoomChange={onZoomChange}
      onPanChange={onPanChange}
      onFitToView={onFitToView}
      isMac={false}
    />,
  );
  return {
    onZoomChange,
    onPanChange,
    onFitToView,
    zoomIn: screen.getByLabelText("roomMap:zoomControl.in"),
    zoomOut: screen.getByLabelText("roomMap:zoomControl.out"),
    fit: screen.getByLabelText("roomMap:zoomControl.fit"),
  };
}

describe("ZoomControl", () => {
  it("steps zoom in and out from real buttons", () => {
    const { zoomIn, onZoomChange } = renderControl(1);
    fireEvent.click(zoomIn);
    expect(onZoomChange).toHaveBeenCalledWith(1.1);
  });

  it("re-anchors the pan on the canvas centre so the room does not slide away", () => {
    // Centre (400, 300) must map to the same world point after the step.
    const { zoomIn, onPanChange } = renderControl(1);
    fireEvent.click(zoomIn);
    expect(onPanChange).toHaveBeenCalledWith({
      x: 400 - 400 * 1.1,
      y: 300 - 300 * 1.1,
    });
  });

  it("disables the buttons at the same bounds the wheel enforces", () => {
    const atMin = renderControl(ZOOM_MIN);
    expect((atMin.zoomOut as HTMLButtonElement).disabled).toBe(true);
    expect((atMin.zoomIn as HTMLButtonElement).disabled).toBe(false);

    cleanup();
    const atMax = renderControl(ZOOM_MAX);
    expect((atMax.zoomIn as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows the current zoom and fits to view when it is pressed", () => {
    const { fit, onFitToView } = renderControl(1.5);
    expect(fit).toHaveTextContent("150%");
    fireEvent.click(fit);
    expect(onFitToView).toHaveBeenCalledTimes(1);
  });

  it("advertises the fit shortcut, which was previously undiscoverable", () => {
    const { fit } = renderControl(1);
    expect(fit.getAttribute("title")).toContain("Ctrl+0");
  });
});
