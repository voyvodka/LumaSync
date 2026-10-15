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
import type { ReactNode } from "react";
import { describe, it, expect, vi } from "vitest";

import { FurnitureObject } from "../FurnitureObject";
import { SelectionLayerContext } from "../selectionLayer";
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
  roomWidth: 6,
  roomDepth: 5,
  gridStepPx: 40,
  snapEnabled: false,
  onSelect: vi.fn(),
  onChange: vi.fn(),
};

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

/** The plan's top layer, where a selected piece draws its frame. */
function withLayer(ui: ReactNode) {
  const layer = document.createElement("div");
  document.body.appendChild(layer);
  return { ui: <SelectionLayerContext.Provider value={layer}>{ui}</SelectionLayerContext.Provider>, layer };
}

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

  it("does not draw a frame when not selected", () => {
    const { ui, layer } = withLayer(<FurnitureObject {...BASE_PROPS} selected={false} />);
    render(ui);
    expect(layer.querySelector("[data-testid=selection-frame]")).toBeNull();
  });

  // Corner-only 8 px handles read as no resize at all, and turning a piece had no handle.
  it("draws eight resize handles and a turn knob in the top layer when selected and unlocked", () => {
    const { ui, layer } = withLayer(<FurnitureObject {...BASE_PROPS} selected={true} />);
    render(ui);
    expect(layer.querySelectorAll("[data-testid^=frame-handle-]")).toHaveLength(8);
    expect(layer.querySelector("[data-testid=frame-rotate]")).not.toBeNull();
  });

  it("draws the frame but no handles when selected but locked", () => {
    const { ui, layer } = withLayer(
      <FurnitureObject {...BASE_PROPS} selected={true} placement={{ ...BASE_PLACEMENT, locked: true }} />,
    );
    render(ui);
    expect(layer.querySelector("[data-testid=selection-frame]")).not.toBeNull();
    expect(layer.querySelectorAll("[data-testid^=frame-handle-]")).toHaveLength(0);
  });

  it("stays inside the room while dragged past its wall", () => {
    const onChange = vi.fn<(updated: FurniturePlacement) => void>();
    const { container } = render(<FurnitureObject {...BASE_PROPS} onChange={onChange} />);
    const piece = container.querySelector("[data-furniture-id]") as HTMLElement;
    fireEvent.pointerDown(piece, { clientX: 100, clientY: 100, pointerId: 1 });
    // 800 px at 80 px/m is 10 m to the right, past the 6 m wall.
    fireEvent.pointerMove(piece, { clientX: 900, clientY: 100, pointerId: 1 });
    fireEvent.pointerUp(piece, { clientX: 900, clientY: 100, pointerId: 1 });
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ x: 4 }));
  });

  it("lifts while carried, and Esc puts it back with nothing written", () => {
    const onChange = vi.fn<(updated: FurniturePlacement) => void>();
    const { container } = render(<FurnitureObject {...BASE_PROPS} onChange={onChange} />);
    const piece = container.querySelector("[data-furniture-id]") as HTMLElement;
    fireEvent.pointerDown(piece, { clientX: 100, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(piece, { clientX: 104, clientY: 100, pointerId: 1 });
    // Inside the slop it is still a click: nothing lifts.
    expect(piece.hasAttribute("data-dragging")).toBe(false);
    fireEvent.pointerMove(piece, { clientX: 180, clientY: 100, pointerId: 1 });
    expect(piece.hasAttribute("data-dragging")).toBe(true);
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.pointerUp(piece, { clientX: 180, clientY: 100, pointerId: 1 });
    expect(piece.hasAttribute("data-dragging")).toBe(false);
    expect(onChange).not.toHaveBeenCalled();
    expect(piece.style.left).toBe(`${BASE_PLACEMENT.x * PX_PER_METER}px`);
  });

  it("holds the grid on the axis a guide did not catch", () => {
    const onChange = vi.fn<(updated: FurniturePlacement) => void>();
    const onSnapDragMove = vi.fn(() => ({ snapX: 2.2, snapY: null, guides: [] }));
    const { container } = render(
      <FurnitureObject
        {...BASE_PROPS}
        placement={{ ...BASE_PLACEMENT, x: 1.3, y: 1.7 }}
        snapEnabled
        onChange={onChange}
        onSnapDragMove={onSnapDragMove}
      />,
    );
    const piece = container.querySelector("[data-furniture-id]") as HTMLElement;
    fireEvent.pointerDown(piece, { clientX: 100, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(piece, { clientX: 140, clientY: 116, pointerId: 1 });
    fireEvent.pointerUp(piece, { clientX: 140, clientY: 116, pointerId: 1 });
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ x: 2.2, y: 2 }));
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
    expect(onSelect).toHaveBeenCalledWith("sofa-1", false);
    expect(onChange).not.toHaveBeenCalled();
    expect(piece.style.left).toBe(`${1.3 * PX_PER_METER}px`);
  });

  // Snapping every step made a drag jump half a metre at a time; a line catches only what comes near it.
  it("catches a drag on a grid line it ends near, and leaves the axis that is far from one", () => {
    const onChange = vi.fn<(updated: FurniturePlacement) => void>();
    const { container } = render(
      <FurnitureObject {...BASE_PROPS} placement={{ ...BASE_PLACEMENT, x: 1.3, y: 1.7 }} snapEnabled onChange={onChange} />,
    );
    const piece = container.querySelector("[data-furniture-id]") as HTMLElement;
    fireEvent.pointerDown(piece, { clientX: 100, clientY: 100, pointerId: 1 });
    // 16 px at 80 px/m is 0.2 m; the 40 px grid is half a metre.
    fireEvent.pointerMove(piece, { clientX: 116, clientY: 100, pointerId: 1 });
    fireEvent.pointerUp(piece, { clientX: 116, clientY: 100, pointerId: 1 });
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ x: 1.5, y: 1.7 }));
  });
});
