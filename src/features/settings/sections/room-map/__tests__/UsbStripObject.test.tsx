/**
 * UsbStripObject — ROOM-05 structural render test
 *
 * ROOM-05: USB strip renders two-point line with drag handles at each endpoint.
 *
 * jsdom does not fire real pointer events at SVG coordinates, so drag-move
 * deltas cannot be measured. The test covers the rendered DOM structure:
 * the SVG line element is present and the two circular handle divs are
 * positioned at the start and end pixel coordinates.
 */
import { render } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";

import { UsbStripObject } from "../UsbStripObject";
import type { UsbStripPlacement } from "../../../../../shared/contracts/roomMap";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

// jsdom does not implement setPointerCapture
beforeEach(() => {
  if (!(HTMLElement.prototype as { setPointerCapture?: unknown }).setPointerCapture) {
    HTMLElement.prototype.setPointerCapture = vi.fn();
    HTMLElement.prototype.releasePointerCapture = vi.fn();
  }
});

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
