import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { FootprintShape } from "../../../model/roomFootprint";
import { RoomShapeField } from "../RoomShapeField";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const dims = { widthMeters: 5, depthMeters: 4, heightMeters: 2.5 };

describe("RoomShapeField", () => {
  it("offers the four shapes and starts a picked one at its default size", () => {
    const onChange = vi.fn<(shape: FootprintShape) => void>();
    render(<RoomShapeField shape={{ kind: "rect" }} dimensions={dims} onChange={onChange} />);
    expect(screen.getByTestId("room-shape-rect").getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByTestId("room-shape-L"));
    expect(onChange).toHaveBeenCalledWith({ kind: "L", corner: "bottomRight", width: 2.5, depth: 2 });
    expect(screen.queryByTestId("room-shape-width")).toBeNull();
  });

  it("shows an L's corner and its two sizes, and changes only what was touched", () => {
    const onChange = vi.fn<(shape: FootprintShape) => void>();
    const shape: FootprintShape = { kind: "L", corner: "bottomRight", width: 2, depth: 1.5 };
    render(<RoomShapeField shape={shape} dimensions={dims} onChange={onChange} />);
    fireEvent.click(screen.getByRole("radio", { name: "roomMap:shape.corner.topLeft" }));
    expect(onChange).toHaveBeenLastCalledWith({ ...shape, corner: "topLeft" });
    expect(screen.queryByTestId("room-shape-offset")).toBeNull();
  });

  it("keeps a notch's place in proportion when it moves to a wall of another length", () => {
    const onChange = vi.fn<(shape: FootprintShape) => void>();
    const shape: FootprintShape = { kind: "U", side: "bottom", width: 1, depth: 1, offset: 2 };
    render(<RoomShapeField shape={shape} dimensions={dims} onChange={onChange} />);
    fireEvent.click(screen.getByRole("radio", { name: "roomMap:shape.side.left" }));
    expect(onChange).toHaveBeenLastCalledWith({ ...shape, side: "left", width: 0.8, offset: 1.6 });
    expect(screen.getByTestId("room-shape-offset")).toBeTruthy();
  });

  it("says a shape it cannot name is custom, with no kind chosen", () => {
    render(<RoomShapeField shape={{ kind: "custom" }} dimensions={dims} onChange={() => {}} />);
    expect(screen.getByText("roomMap:shape.custom")).toBeTruthy();
    expect(screen.getAllByRole("radio").every((r) => r.getAttribute("aria-checked") === "false")).toBe(true);
  });
});
