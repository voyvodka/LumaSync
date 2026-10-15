import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { DEFAULT_ROOM_MAP } from "@/shared/contracts/roomMap";

import { RoomPreview } from "../RoomPreview";

describe("RoomPreview", () => {
  it("draws the room, each piece where it stands, the screen and the strips", () => {
    const { container } = render(
      <RoomPreview
        config={{
          ...DEFAULT_ROOM_MAP,
          dimensions: { widthMeters: 5, depthMeters: 4, heightMeters: 2.5 },
          tvAnchor: { x: 1.75, y: 0.2, width: 1.5, height: 0.08 },
          usbStrips: [{ stripId: "s", startX: 1.8, startY: 0.15, endX: 3.2, endY: 0.15, ledCount: 90 }],
          furniture: [
            { id: "sofa", type: "sofa", x: 1.5, y: 2.5, width: 2, height: 0.9, label: "Sofa" },
            { id: "arm", type: "chair", x: 0.3, y: 2.5, width: 0.7, height: 0.7, rotation: 45, label: "Armchair" },
          ],
        }}
      />,
    );
    const root = container.querySelector("svg") as SVGSVGElement;
    expect(root.getAttribute("viewBox")).toBe("-0.2 -0.2 5.4 4.4");

    const placed = [...root.querySelectorAll(":scope > g > svg")];
    expect(placed.map((svg) => [svg.getAttribute("x"), svg.getAttribute("y"), svg.getAttribute("width")])).toEqual([
      ["1.5", "2.5", "2"],
      ["0.3", "2.5", "0.7"],
    ]);
    // A rotated piece turns about its own centre, as on the plan.
    expect(placed[1]?.parentElement?.getAttribute("transform")).toBe("rotate(45 0.6499999999999999 2.85)");
    expect(root.querySelectorAll(":scope > line")).toHaveLength(1);
    expect(root.querySelector(":scope > polyline")?.getAttribute("points")).toBe("1.8,0.15 3.2,0.15");
  });

  it("draws an empty room as its outline alone", () => {
    const { container } = render(<RoomPreview config={DEFAULT_ROOM_MAP} />);
    const root = container.querySelector("svg") as SVGSVGElement;
    expect(root.querySelectorAll(":scope > rect")).toHaveLength(1);
    expect(root.querySelectorAll(":scope > g, :scope > line, :scope > polyline")).toHaveLength(0);
  });
});
