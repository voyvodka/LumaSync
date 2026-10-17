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
import { fireEvent, render, screen } from "@testing-library/react";
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

    // The invisible wide hit area for its one leg, and the visible dashed line.
    expect(container.querySelectorAll("line")).toHaveLength(1);
    expect(container.querySelector("polyline")?.getAttribute("points")).toBe("80,80 240,80");

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

  // The count is set in the inspector; a field on the plan stood over the strip's own badge.
  it("draws no LED count field on the plan, even when selected", () => {
    const { container } = render(
      <UsbStripObject placement={PLACEMENT} pxPerMeter={PX_PER_METER} selected onSelect={vi.fn()} onChange={vi.fn()} />,
    );
    expect(container.querySelector("input")).toBeNull();
  });

  it("says a strip that names no port has none, rather than offline", () => {
    render(<UsbStripObject placement={PLACEMENT} pxPerMeter={PX_PER_METER} selected={false} connectionStatus="unlinked" onSelect={vi.fn()} onChange={vi.fn()} />);
    expect(screen.getByText("roomMap:usbStrip.noPort")).toBeTruthy();
    expect(screen.queryByText("roomMap:usbStrip.offline")).toBeNull();
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

describe("UsbStripObject — corners", () => {
  const BENT: UsbStripPlacement = { ...PLACEMENT, corners: [{ x: 3, y: 2 }], endX: 2, endY: 2.5 };
  const renderStrip = (placement: UsbStripPlacement, selected = true, bendable = true) => {
    const onChange = vi.fn<(updated: UsbStripPlacement) => void>();
    const { container } = render(
      <UsbStripObject
        placement={placement}
        pxPerMeter={PX_PER_METER}
        selected={selected}
        room={{ width: 4, depth: 3 }}
        bendable={bendable}
        onSelect={vi.fn<(id: string) => void>()}
        onChange={onChange}
      />,
    );
    return { onChange, container };
  };

  it("draws a bent strip through its corners, a hit area per leg and a handle on each corner", () => {
    const { container } = renderStrip(BENT);
    expect(container.querySelector("polyline")?.getAttribute("points")).toBe("80,80 240,160 160,200");
    expect(container.querySelectorAll("line")).toHaveLength(2);
    expect(container.querySelectorAll("[data-strip-corner]")).toHaveLength(1);
    expect(renderStrip(BENT, false).container.querySelectorAll("[data-strip-corner]")).toHaveLength(0);
  });

  // A strip folded round a desk corner came back straight when it was dragged: only its ends moved.
  it("carries its corners when the whole strip is dragged", () => {
    const { onChange, container } = renderStrip(BENT);
    const leg = container.querySelectorAll("line")[0]!;
    fireEvent.pointerDown(leg, { clientX: 100, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(leg, { clientX: 60, clientY: 100, pointerId: 1 });
    fireEvent.pointerUp(leg, { clientX: 60, clientY: 100, pointerId: 1 });
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ startX: 0.5, endX: 1.5, corners: [{ x: 2.5, y: 2 }] }));
  });

  it("moves a corner on its own, snapping level with the point beside it", () => {
    const { onChange, container } = renderStrip(BENT);
    const corner = container.querySelector("[data-strip-corner]")!;
    fireEvent.pointerDown(corner, { clientX: 240, clientY: 160, pointerId: 1 });
    fireEvent.pointerMove(corner, { clientX: 260, clientY: 88, pointerId: 1 });
    fireEvent.pointerUp(corner, { clientX: 260, clientY: 88, pointerId: 1 });
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ startX: 1, endX: 2, corners: [{ x: 3.25, y: 1 }] }));
  });

  it("leaves the corners out of an end's drag when they did not move", () => {
    const { onChange, container } = renderStrip(PLACEMENT);
    const end = Array.from(container.querySelectorAll<HTMLElement>("div[style]")).find((el) => el.style.left === "234px")!;
    fireEvent.pointerDown(end, { clientX: 240, clientY: 80, pointerId: 1 });
    fireEvent.pointerMove(end, { clientX: 240, clientY: 160, pointerId: 1 });
    fireEvent.pointerUp(end, { clientX: 240, clientY: 160, pointerId: 1 });
    expect(onChange.mock.calls[0]![0]).not.toHaveProperty("corners");
    expect(onChange.mock.calls[0]![0]).toMatchObject({ endX: 3, endY: 2 });
  });

  it("bends the line where it is double-clicked, and a double-click on a corner takes it out", () => {
    const { onChange, container } = renderStrip(PLACEMENT);
    fireEvent.doubleClick(container.querySelector("line")!, { clientX: 160, clientY: 80 });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ corners: [{ x: 2, y: 1 }] }));
    const bent = renderStrip(BENT);
    fireEvent.doubleClick(bent.container.querySelector("[data-strip-corner]")!);
    expect(bent.onChange).toHaveBeenLastCalledWith(expect.objectContaining({ corners: null }));
  });

  it("does not bend a locked strip or the TV's backlight", () => {
    for (const { onChange, container } of [renderStrip({ ...PLACEMENT, locked: true }), renderStrip(PLACEMENT, true, false)]) {
      fireEvent.doubleClick(container.querySelector("line")!, { clientX: 160, clientY: 80 });
      expect(onChange).not.toHaveBeenCalled();
    }
  });
});
