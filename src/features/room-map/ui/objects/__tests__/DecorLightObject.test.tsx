import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { LightStructure } from "@/shared/contracts/roomMap";

import { DecorLightObject } from "../DecorLightObject";

const lamp: LightStructure = { id: "dining", kind: "light", x: 1, y: 3, fixture: "pendant" };

function renderLamp(light: LightStructure = lamp) {
  const onSelect = vi.fn<(objectId: string, additive: boolean) => void>();
  const onMove = vi.fn<(objectId: string, x: number, y: number) => void>();
  const { container, unmount } = render(
    <DecorLightObject
      light={light}
      name="Pendant"
      pxPerMeter={100}
      zoom={1}
      roomWidth={5}
      roomDepth={4}
      selected={false}
      panMode={false}
      onSelect={onSelect}
      onMove={onMove}
    />,
  );
  const element = container.querySelector<HTMLElement>("[data-object-id='decor-dining']")!;
  element.setPointerCapture = () => {};
  return { element, onSelect, onMove, unmount };
}

describe("DecorLightObject", () => {
  it("is picked on a press and moved where a drag lets it go, inside the room", () => {
    const { element, onSelect, onMove } = renderLamp();
    fireEvent.pointerDown(element, { clientX: 100, clientY: 300, pointerId: 1 });
    expect(onSelect).toHaveBeenCalledWith("decor-dining", false);
    fireEvent.pointerMove(element, { clientX: 150, clientY: 300, pointerId: 1 });
    fireEvent.pointerUp(element, { clientX: 150, clientY: 900, pointerId: 1 });
    expect(onMove).toHaveBeenCalledWith("decor-dining", 1.5, 4);
  });

  it("moves nothing on a click, or when locked", () => {
    const click = renderLamp();
    fireEvent.pointerDown(click.element, { clientX: 100, clientY: 300, pointerId: 1 });
    fireEvent.pointerUp(click.element, { clientX: 101, clientY: 300, pointerId: 1 });
    expect(click.onMove).not.toHaveBeenCalled();
    click.unmount();

    const held = renderLamp({ ...lamp, locked: true });
    fireEvent.pointerDown(held.element, { clientX: 100, clientY: 300, pointerId: 1 });
    fireEvent.pointerMove(held.element, { clientX: 200, clientY: 300, pointerId: 1 });
    fireEvent.pointerUp(held.element, { clientX: 200, clientY: 300, pointerId: 1 });
    expect(held.onSelect).toHaveBeenCalled();
    expect(held.onMove).not.toHaveBeenCalled();
  });
});
