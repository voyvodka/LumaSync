import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { type RoomCorner, resolveRoomFootprint } from "@/shared/contracts/roomMap";

import { buildFootprint } from "../../../model/roomFootprint";
import { FootprintWalls } from "../FootprintWalls";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const dims = { widthMeters: 5, depthMeters: 4, heightMeters: 2.5 };
const L = buildFootprint({ kind: "L", corner: "bottomRight", width: 2, depth: 1.5 }, dims) ?? [];

const renderWalls = (corners: readonly RoomCorner[], panMode = false) => {
  const onMove = vi.fn<(corners: RoomCorner[], gesture: string) => void>();
  const onNotch = vi.fn<(corners: RoomCorner[]) => void>();
  render(
    <FootprintWalls corners={corners} dimensions={dims} pxPerMeter={100} zoom={2} panMode={panMode} onMove={onMove} onNotch={onNotch} />,
  );
  return { onMove, onNotch };
};

describe("FootprintWalls", () => {
  it("offers a handle for each wall inside the room's box only", () => {
    renderWalls(L);
    expect(screen.getAllByTestId(/^room-wall-/).map((e) => e.dataset.testid)).toEqual(["room-wall-2", "room-wall-3"]);
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
