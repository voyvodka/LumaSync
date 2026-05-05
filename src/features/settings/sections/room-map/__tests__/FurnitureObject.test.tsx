/**
 * FurnitureObject — ROOM-02 structural render test
 *
 * ROOM-02: furniture renders with label and shows resize handles when selected
 * and unlocked.
 *
 * Drag resize is pointer-event driven with coordinate math — jsdom does not
 * compute getBoundingClientRect, so delta assertions require a real browser.
 * The tests here pin structural rendering: label visibility, handle presence,
 * and locked-state suppression of handles.
 */
import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";

import { FurnitureObject } from "../FurnitureObject";
import type { FurniturePlacement } from "../../../../../shared/contracts/roomMap";

// jsdom does not implement setPointerCapture / releasePointerCapture
beforeEach(() => {
  if (!(HTMLElement.prototype as { setPointerCapture?: unknown }).setPointerCapture) {
    HTMLElement.prototype.setPointerCapture = vi.fn();
    HTMLElement.prototype.releasePointerCapture = vi.fn();
  }
});

const BASE_PLACEMENT: FurniturePlacement = {
  id: "sofa-1",
  type: "sofa",
  x: 1,
  y: 1,
  width: 2,
  height: 1,
  label: "Corner sofa",
  locked: false,
};

const PX_PER_METER = 80;

const BASE_PROPS = {
  placement: BASE_PLACEMENT,
  pxPerMeter: PX_PER_METER,
  selected: false,
  gridStepPx: 40,
  snapEnabled: false,
  onSelect: vi.fn(),
  onChange: vi.fn(),
};

describe("FurnitureObject", () => {
  // ROOM-02: furniture renders with label
  it("ROOM-02: renders the placement label as visible text", () => {
    render(<FurnitureObject {...BASE_PROPS} />);
    expect(screen.getByText("Corner sofa")).toBeDefined();
  });

  it("does not render resize handles when not selected", () => {
    const { container } = render(<FurnitureObject {...BASE_PROPS} selected={false} />);
    // ResizeHandle renders divs with corner-specific cursor classes
    const handles = container.querySelectorAll("[class*='cursor-nwse-resize'], [class*='cursor-nesw-resize']");
    expect(handles.length).toBe(0);
  });

  it("renders 4 resize handles when selected and unlocked", () => {
    const { container } = render(
      <FurnitureObject {...BASE_PROPS} selected={true} placement={{ ...BASE_PLACEMENT, locked: false }} />,
    );
    const nwse = container.querySelectorAll("[class*='cursor-nwse-resize']");
    const nesw = container.querySelectorAll("[class*='cursor-nesw-resize']");
    // nw + se = 2 nwse-resize; ne + sw = 2 nesw-resize
    expect(nwse.length).toBe(2);
    expect(nesw.length).toBe(2);
  });

  it("does not render resize handles when selected but locked", () => {
    const { container } = render(
      <FurnitureObject
        {...BASE_PROPS}
        selected={true}
        placement={{ ...BASE_PLACEMENT, locked: true }}
      />,
    );
    const handles = container.querySelectorAll("[class*='cursor-nwse-resize'], [class*='cursor-nesw-resize']");
    expect(handles.length).toBe(0);
  });

  it("root div is positioned at pxPerMeter-scaled coordinates", () => {
    const { container } = render(<FurnitureObject {...BASE_PROPS} />);
    const root = container.firstElementChild as HTMLElement;
    expect(root.style.left).toBe(`${BASE_PLACEMENT.x * PX_PER_METER}px`);
    expect(root.style.top).toBe(`${BASE_PLACEMENT.y * PX_PER_METER}px`);
    expect(root.style.width).toBe(`${BASE_PLACEMENT.width * PX_PER_METER}px`);
    expect(root.style.height).toBe(`${BASE_PLACEMENT.height * PX_PER_METER}px`);
  });

  it("renders with grab cursor when unlocked and default cursor when locked", () => {
    const { container: c1 } = render(
      <FurnitureObject {...BASE_PROPS} placement={{ ...BASE_PLACEMENT, locked: false }} />,
    );
    expect((c1.firstElementChild as HTMLElement).className).toMatch(/cursor-grab/);

    const { container: c2 } = render(
      <FurnitureObject {...BASE_PROPS} placement={{ ...BASE_PLACEMENT, locked: true }} />,
    );
    expect((c2.firstElementChild as HTMLElement).className).toMatch(/cursor-default/);
  });
});
