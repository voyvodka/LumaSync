import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { type RoomCorner, resolveRoomFootprint } from "@/shared/contracts/roomMap";

import { buildFootprint, describeFootprint, type FootprintShape, type FootprintSide } from "../../../model/roomFootprint";
import { FootprintWalls } from "../FootprintWalls";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const dims = { widthMeters: 5, depthMeters: 4, heightMeters: 2.5 };
const L = buildFootprint({ kind: "L", corner: "bottomRight", width: 2, depth: 1.5 }, dims) ?? [];

const renderWalls = (corners: readonly RoomCorner[], panMode = false) => {
  const onMove = vi.fn<(corners: RoomCorner[], gesture: string) => void>();
  const onNotch = vi.fn<(corners: RoomCorner[]) => void>();
  const onResizeStart = vi.fn<(side: FootprintSide) => void>();
  const onResize = vi.fn<(side: FootprintSide, delta: number, gesture: string) => void>();
  const onShapeChange = vi.fn<(shape: FootprintShape, gesture?: string) => void>();
  render(
    <FootprintWalls
      corners={corners}
      dimensions={dims}
      shape={describeFootprint(corners.length === 4 ? undefined : [...corners], dims)}
      pxPerMeter={100}
      zoom={2}
      panMode={panMode}
      onMove={onMove}
      onNotch={onNotch}
      onResizeStart={onResizeStart}
      onResize={onResize}
      onShapeChange={onShapeChange}
    />,
  );
  return { onMove, onNotch, onResizeStart, onResize, onShapeChange };
};

describe("FootprintWalls", () => {
  it("offers the four outer walls to resize and each wall inside the box to reshape", () => {
    renderWalls(L);
    expect(screen.getAllByTestId(/^room-wall-/).map((e) => e.dataset.testid)).toEqual([
      "room-wall-top",
      "room-wall-bottom",
      "room-wall-left",
      "room-wall-right",
      "room-wall-2",
      "room-wall-3",
    ]);
  });

  // The room's size was a number field only; its walls did not move.
  it("pulls an outer wall out by the drag in metres, as one gesture", () => {
    const { onResize, onResizeStart } = renderWalls(resolveRoomFootprint({ dimensions: dims }));
    const left = screen.getByTestId("room-wall-left");
    fireEvent.pointerDown(left, { button: 0, clientX: 300, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(left, { clientX: 200, clientY: 100, pointerId: 1 });
    fireEvent.pointerUp(left, { pointerId: 1 });
    expect(onResizeStart).toHaveBeenCalledWith("left");
    // 100 px left at zoom 2 and 100 px/m is half a metre outward.
    expect(onResize).toHaveBeenCalledWith("left", 0.5, expect.stringMatching(/^room-wall:/));
  });

  it("slides a cut by its grip, and the × puts the rectangle back", () => {
    const { onShapeChange } = renderWalls(L);
    const grip = screen.getByTestId("room-shape-grip");
    fireEvent.pointerDown(grip, { button: 0, clientX: 0, clientY: 0, pointerId: 1 });
    // To the top-left quarter of the room: the L takes that corner.
    fireEvent.pointerMove(grip, { clientX: -600, clientY: -500, pointerId: 1 });
    expect(onShapeChange).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "L", corner: "topLeft" }), expect.any(String));
    fireEvent.click(screen.getByTestId("room-shape-remove"));
    expect(onShapeChange).toHaveBeenLastCalledWith({ kind: "rect" });
  });

  it("moves the wall by the drag in metres at the current zoom, as one gesture", () => {
    const { onMove } = renderWalls(L);
    const wall = screen.getByTestId("room-wall-2");
    fireEvent.pointerDown(wall, { button: 0, clientX: 300, clientY: 500, pointerId: 1 });
    fireEvent.pointerMove(wall, { clientX: 300, clientY: 600, pointerId: 1 });
    fireEvent.pointerMove(wall, { clientX: 300, clientY: 640, pointerId: 1 });
    fireEvent.pointerUp(wall, { pointerId: 1 });
    // 140 px at zoom 2 and 100 px/m is 0.7 m: the level wall at y 2.5 lands at 3.2.
    const last = onMove.mock.calls[onMove.mock.calls.length - 1]!;
    expect(last[0]).toContainEqual({ x: 3, y: 3.2 });
    expect(new Set(onMove.mock.calls.map((c) => c[1])).size).toBe(1);
  });

  it("stops at the last good place rather than break the outline", () => {
    const { onMove } = renderWalls(L);
    const wall = screen.getByTestId("room-wall-2");
    fireEvent.pointerDown(wall, { button: 0, clientX: 0, clientY: 0, pointerId: 1 });
    fireEvent.pointerMove(wall, { clientX: 0, clientY: 300, pointerId: 1 });
    expect(onMove).not.toHaveBeenCalled();
  });

  it("does nothing while the plan is being panned", () => {
    const { onMove } = renderWalls(L, true);
    const wall = screen.getByTestId("room-wall-2");
    fireEvent.pointerDown(wall, { button: 0, clientX: 0, clientY: 0, pointerId: 1 });
    fireEvent.pointerMove(wall, { clientX: 0, clientY: 40, pointerId: 1 });
    expect(onMove).not.toHaveBeenCalled();
  });

  it("cuts a notch where a plain room's wall is double-clicked", () => {
    const { onNotch } = renderWalls(resolveRoomFootprint({ dimensions: dims }));
    const bottom = screen.getByTestId("room-wall-bottom");
    bottom.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 24, right: 1000, bottom: 24, x: 0, y: 0, toJSON: () => ({}) });
    fireEvent.doubleClick(bottom, { clientX: 200, clientY: 10 });
    expect(onNotch).toHaveBeenCalledTimes(1);
    expect(onNotch.mock.calls[0]![0]).toContainEqual({ x: 0.7, y: 3.6 });
  });
});
