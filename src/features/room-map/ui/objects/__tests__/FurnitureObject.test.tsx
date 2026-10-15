/**
 * FurnitureObject — ROOM-02 structural render test
 *
 * ROOM-02: furniture renders with label and shows resize handles when selected
 * and unlocked.
 *
 * Drag resize is pointer-event driven with coordinate math — happy-dom does not
 * compute getBoundingClientRect, so delta assertions require a real browser.
 * The tests here pin structural rendering: label visibility, handle presence,
 * and locked-state suppression of handles.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";

import { FurnitureObject } from "../FurnitureObject";
import type { FurniturePlacement } from "@/shared/contracts/roomMap";

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
  model: { kind: "upholstered", seats: 3, arms: true, corner: null } as const,
  pxPerMeter: PX_PER_METER,
  selected: false,
  gridStepPx: 40,
  snapEnabled: false,
  onSelect: vi.fn(),
  onChange: vi.fn(),
};

describe("FurnitureObject", () => {
  it("draws a type from a newer build as other instead of throwing", () => {
    const placement = { ...BASE_PLACEMENT, type: "hammock" } as unknown as FurniturePlacement;
    render(<FurnitureObject {...BASE_PROPS} placement={placement} />);
    expect(screen.getByText("Corner sofa")).toBeDefined();
  });

  // ROOM-02: furniture renders with label
  it("ROOM-02: renders the placement label as visible text", () => {
    render(<FurnitureObject {...BASE_PROPS} />);
    expect(screen.getByText("Corner sofa")).toBeDefined();
  });

  it("marks a piece outside the room's shape, and nothing else", () => {
    const { container, rerender } = render(<FurnitureObject {...BASE_PROPS} outside />);
    expect(container.querySelector("[data-furniture-id]")?.hasAttribute("data-outside")).toBe(true);
    rerender(<FurnitureObject {...BASE_PROPS} />);
    expect(container.querySelector("[data-furniture-id]")?.hasAttribute("data-outside")).toBe(false);
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

  // A click selected the piece and then snapped it to the grid as though it had been dragged, so a
  // sofa off the grid jumped half a metre the moment it was clicked.
  it("stays where it is after a click, even with the grid snapping", () => {
    const onChange = vi.fn<(updated: FurniturePlacement) => void>();
    const onSelect = vi.fn<(id: string) => void>();
    const placement = { ...BASE_PLACEMENT, x: 1.3, y: 1.7 };
    const { container } = render(
      <FurnitureObject {...BASE_PROPS} placement={placement} snapEnabled onChange={onChange} onSelect={onSelect} />,
    );
    const piece = container.querySelector("[data-furniture-id]") as HTMLElement;
    fireEvent.pointerDown(piece, { clientX: 100, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(piece, { clientX: 101, clientY: 101, pointerId: 1 });
    fireEvent.pointerUp(piece, { clientX: 101, clientY: 101, pointerId: 1 });
    expect(onSelect).toHaveBeenCalledWith("sofa-1");
    expect(onChange).not.toHaveBeenCalled();
    expect(piece.style.left).toBe(`${1.3 * PX_PER_METER}px`);
  });

  it("still snaps a real drag to the grid", () => {
    const onChange = vi.fn<(updated: FurniturePlacement) => void>();
    const { container } = render(
      <FurnitureObject {...BASE_PROPS} placement={{ ...BASE_PLACEMENT, x: 1.3, y: 1.7 }} snapEnabled onChange={onChange} />,
    );
    const piece = container.querySelector("[data-furniture-id]") as HTMLElement;
    fireEvent.pointerDown(piece, { clientX: 100, clientY: 100, pointerId: 1 });
    // 16 px at 80 px/m is 0.2 m; the 40 px grid is half a metre.
    fireEvent.pointerMove(piece, { clientX: 116, clientY: 100, pointerId: 1 });
    fireEvent.pointerUp(piece, { clientX: 116, clientY: 100, pointerId: 1 });
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ x: 1.5, y: 1.5 }));
  });
});
