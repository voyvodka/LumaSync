import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { TvAnchorPlacement } from "@/shared/contracts/roomMap";

import { TvAnchorObject } from "../TvAnchorObject";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const tv: TvAnchorPlacement = { x: 1.3, y: 0.3, width: 1, height: 0.1 };

function renderTv(onChange = vi.fn<(updated: TvAnchorPlacement) => void>()) {
  const onSelect = vi.fn<() => void>();
  const { container } = render(
    <TvAnchorObject placement={tv} pxPerMeter={80} selected={false} gridStepPx={40} snapEnabled onSelect={onSelect} onChange={onChange} />,
  );
  return { onChange, onSelect, root: container.firstElementChild as HTMLElement };
}

describe("TvAnchorObject", () => {
  it("stays where it is after a click, even with the grid snapping", () => {
    const { onChange, onSelect, root } = renderTv();
    fireEvent.pointerDown(root, { clientX: 50, clientY: 50, pointerId: 1 });
    fireEvent.pointerUp(root, { clientX: 51, clientY: 50, pointerId: 1 });
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("snaps a real drag to the grid", () => {
    const { onChange, root } = renderTv();
    fireEvent.pointerDown(root, { clientX: 50, clientY: 50, pointerId: 1 });
    fireEvent.pointerMove(root, { clientX: 66, clientY: 50, pointerId: 1 });
    fireEvent.pointerUp(root, { clientX: 66, clientY: 50, pointerId: 1 });
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ x: 1.5, y: 0.5 }));
  });

  it("lands where it is let go with ⌥ held, off the grid", () => {
    const { onChange, root } = renderTv();
    fireEvent.pointerDown(root, { clientX: 50, clientY: 50, pointerId: 1 });
    fireEvent.pointerMove(root, { clientX: 70, clientY: 50, pointerId: 1, altKey: true });
    fireEvent.pointerUp(root, { clientX: 70, clientY: 50, pointerId: 1, altKey: true });
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ x: 1.55, y: 0.3 }));
  });

  describe("its corner handles", () => {
    const renderSelected = () => {
      const onChange = vi.fn<(updated: TvAnchorPlacement) => void>();
      const onSelect = vi.fn<() => void>();
      const { container } = render(
        <TvAnchorObject placement={tv} pxPerMeter={80} selected gridStepPx={40} snapEnabled onSelect={onSelect} onChange={onChange} />,
      );
      const root = container.firstElementChild as HTMLElement;
      const handle = root.querySelector<HTMLElement>(".cursor-nwse-resize")!;
      for (const el of [root, handle]) {
        el.setPointerCapture = () => {};
        el.releasePointerCapture = () => {};
      }
      return { onChange, onSelect, root, handle };
    };

    it("lets go of a press that never moved, so the TV still takes the next one", () => {
      const { onChange, onSelect, root, handle } = renderSelected();
      fireEvent.pointerDown(handle, { clientX: 10, clientY: 10, pointerId: 1 });
      fireEvent.pointerUp(handle, { clientX: 10, clientY: 10, pointerId: 1 });
      fireEvent.pointerDown(root, { clientX: 50, clientY: 50, pointerId: 2 });
      expect(onSelect).toHaveBeenCalledTimes(1);
      expect(onChange).not.toHaveBeenCalled();
    });

    it("puts the size back on Escape mid-resize and writes nothing", () => {
      const { onChange, root, handle } = renderSelected();
      const before = root.style.width;
      fireEvent.pointerDown(handle, { clientX: 10, clientY: 10, pointerId: 1 });
      fireEvent.pointerMove(handle, { clientX: -30, clientY: 10, pointerId: 1 });
      expect(root.style.width).not.toBe(before);
      fireEvent.keyDown(window, { key: "Escape" });
      fireEvent.pointerUp(handle, { clientX: -30, clientY: 10, pointerId: 1 });
      expect(root.style.width).toBe(before);
      expect(onChange).not.toHaveBeenCalled();
    });
  });
});
