/**
 * UsbStripObject — ROOM-05 structural render test
 *
 * ROOM-05: USB strip renders two-point line with drag handles at each endpoint.
 *
 * happy-dom does not fire real pointer events at SVG coordinates, so drag-move
 * deltas cannot be measured. The test covers the rendered DOM structure:
 * the SVG line element is present and the two circular handle divs are
 * positioned at the start and end pixel coordinates.
 */
import { fireEvent, render } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";

import { UsbStripObject } from "../UsbStripObject";
import type { UsbStripPlacement } from "@/shared/contracts/roomMap";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const PLACEMENT: UsbStripPlacement = {
  stripId: "strip-1",
  startX: 1,
  startY: 1,
  endX: 3,
  endY: 1,
  ledCount: 30,
  locked: false,
};

const PX_PER_METER = 80;

describe("UsbStripObject", () => {
  // ROOM-05: USB strip renders two-point line with drag handles at each endpoint
  it("ROOM-05: renders an SVG line and two circular drag handles at start and end positions", () => {
    const { container } = render(
      <UsbStripObject
        placement={PLACEMENT}
        pxPerMeter={PX_PER_METER}
        selected={false}
        onSelect={vi.fn()}
        onChange={vi.fn()}
      />,
    );

    // SVG line element must be present
    const lines = container.querySelectorAll("line");
    // There are two <line> elements: invisible wide hit area + visible dashed line
    expect(lines.length).toBeGreaterThanOrEqual(2);

    // Two circular handle divs (start + end) — they are absolute-positioned
    // rounded-full divs with inline style left/top derived from pixel coordinates.
    const sx = PLACEMENT.startX * PX_PER_METER; // 80
    const sy = PLACEMENT.startY * PX_PER_METER; // 80
    const ex = PLACEMENT.endX * PX_PER_METER;   // 240
    const ey = PLACEMENT.endY * PX_PER_METER;   // 80

    // Handles are 12x12 px divs positioned at (pos - 6) to center them
    const handles = Array.from(container.querySelectorAll<HTMLElement>("div[style]")).filter(
      (el) => el.style.width === "12px" && el.style.height === "12px",
    );
    expect(handles.length).toBe(2);

    const startHandle = handles.find(
      (el) => el.style.left === `${sx - 6}px` && el.style.top === `${sy - 6}px`,
    );
    const endHandle = handles.find(
      (el) => el.style.left === `${ex - 6}px` && el.style.top === `${ey - 6}px`,
    );

    expect(startHandle).toBeDefined();
    expect(endHandle).toBeDefined();
  });

  it("LED count input is hidden when not selected", () => {
    const { container } = render(
      <UsbStripObject
        placement={PLACEMENT}
        pxPerMeter={PX_PER_METER}
        selected={false}
        onSelect={vi.fn()}
        onChange={vi.fn()}
      />,
    );
    const input = container.querySelector("input[type=number]");
    expect(input).toBeNull();
  });

  it("LED count input is visible when selected", () => {
    const { container } = render(
      <UsbStripObject
        placement={PLACEMENT}
        pxPerMeter={PX_PER_METER}
        selected={true}
        onSelect={vi.fn()}
        onChange={vi.fn()}
      />,
    );
    const input = container.querySelector("input[type=number]");
    expect(input).not.toBeNull();
    expect((input as HTMLInputElement).value).toBe(String(PLACEMENT.ledCount));
  });
});

describe("UsbStripObject — dragging", () => {
  const renderStrip = () => {
    const onChange = vi.fn<(updated: UsbStripPlacement) => void>();
    const { container } = render(
      <UsbStripObject placement={PLACEMENT} pxPerMeter={PX_PER_METER} selected room={{ width: 4, depth: 3 }} onSelect={vi.fn<(id: string) => void>()} onChange={onChange} />,
    );
    const line = container.querySelectorAll("line")[0]!;
    return { onChange, line };
  };

  // The strip had no stop at the walls and could be dragged off the room.
  it("keeps both ends inside the room when the whole strip is dragged past a wall", () => {
    const { onChange, line } = renderStrip();
    fireEvent.pointerDown(line, { clientX: 100, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(line, { clientX: 900, clientY: 100, pointerId: 1 });
    fireEvent.pointerUp(line, { clientX: 900, clientY: 100, pointerId: 1 });
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ startX: 2, endX: 4 }));
  });

  it("moves nothing on a click's wobble or after Esc", () => {
    const { onChange, line } = renderStrip();
    fireEvent.pointerDown(line, { clientX: 100, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(line, { clientX: 103, clientY: 101, pointerId: 1 });
    fireEvent.pointerUp(line, { clientX: 103, clientY: 101, pointerId: 1 });
    fireEvent.pointerDown(line, { clientX: 100, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(line, { clientX: 160, clientY: 100, pointerId: 1 });
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.pointerUp(line, { clientX: 160, clientY: 100, pointerId: 1 });
    expect(onChange).not.toHaveBeenCalled();
  });
});
