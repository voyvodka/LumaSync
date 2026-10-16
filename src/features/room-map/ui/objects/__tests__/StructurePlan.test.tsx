import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { DEFAULT_ROOM_DIMENSIONS, type RoomStructure } from "@/shared/contracts/roomMap";

import { StructurePlan } from "../StructurePlan";

const plan = (structures: RoomStructure[]) =>
  render(<StructurePlan config={{ dimensions: DEFAULT_ROOM_DIMENSIONS, structures }} pxPerMeter={100} />);

describe("StructurePlan", () => {
  it("draws each kind it knows and skips one it does not", () => {
    const { container } = plan([
      { id: "c", kind: "column", x: 1, y: 1, width: 0.4, depth: 0.4, shape: "round" },
      { id: "b", kind: "beam", x1: 1, y1: 0, x2: 1, y2: 4, width: 0.2, dropMeters: 0.3 },
      { id: "w", kind: "window", x: 2.5, y: 0, width: 1.2, sillMeters: 0.9, heightMeters: 1.2 },
      { id: "d", kind: "door", x: 5, y: 2, width: 0.9, heightMeters: 2.05, hinge: "left", swing: "in" },
      { id: "n", kind: "niche", x: 2, y: 4, width: 0.8, bottomMeters: 0.4, heightMeters: 1, depth: 0.25 },
      { id: "s", kind: "skylight" } as never,
    ]);
    const kinds = [...container.querySelectorAll("[data-structure]")].map((g) => g.getAttribute("data-structure"));
    expect(kinds).toEqual(["column", "beam", "window", "door", "niche"]);
  });

  // A door on the right wall swinging in: its leaf lies inside the room, square to the wall.
  it("opens a door's leaf into the room when it swings in, and out of it when it swings out", () => {
    const leafEnd = (swing: "in" | "out") => {
      const { container, unmount } = plan([{ id: "d", kind: "door", x: 5, y: 2, width: 0.9, heightMeters: 2.05, hinge: "left", swing }]);
      const leaf = container.querySelectorAll("[data-structure=door] line")[1]!;
      const x = Number(leaf.getAttribute("x2"));
      unmount();
      return x;
    };
    expect(leafEnd("in")).toBeCloseTo(410);
    expect(leafEnd("out")).toBeCloseTo(590);
  });

  it("draws nothing for a room with no structures", () => {
    expect(plan([]).container.querySelector("svg")).toBeNull();
  });
});
