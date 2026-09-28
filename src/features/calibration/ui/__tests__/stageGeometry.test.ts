import { describe, expect, it } from "vitest";

import { ends, type StripShape } from "../../model/startPoint";
import { computeStage, frameFor, nearFrame } from "../stageGeometry";

// A strip with a stand gap: LED #1 on either side of the gap, heading either way.
const SHAPE: StripShape = { counts: { top: 16, right: 14, bottom: 16, left: 14 }, gap: 3 };

describe("computeStage — the flow from LED #1", () => {
  const gapEnds = ends(SHAPE)!;
  const cases = (["A", "B"] as const).flatMap((end) =>
    (["cw", "ccw"] as const).map((direction) => [end, direction] as const),
  );

  // Heading into the stand gap used to draw nothing: the first run was LED #1 alone, and the
  // light's way across the gap to the far side was never shown.
  it.each(cases)("draws a flow and its head from gap end %s heading %s", (end, direction) => {
    const layout = computeStage(SHAPE, { led: gapEnds[end], direction }, frameFor({ width: 1920, height: 1080 }));

    expect(layout.flow).not.toBeNull();
    expect(layout.head).not.toBeNull();
  });
});

// The stage runs up under the display picker: only the area around the screen shows where LED #1 can go.
describe("nearFrame", () => {
  const f = { x: 100, y: 80, w: 400, h: 240 };
  it("is near on the screen, just around it, and further below where the stand's + sits", () => {
    expect(nearFrame(300, 200, f)).toBe(true);
    expect(nearFrame(60, 40, f)).toBe(true);
    expect(nearFrame(300, 80 + 240 + 70, f)).toBe(true);
  });
  it("is not near further out, as under the display picker at the stage's top", () => {
    expect(nearFrame(20, 5, f)).toBe(false);
    expect(nearFrame(300, 20, f)).toBe(false);
    expect(nearFrame(560, 200, f)).toBe(false);
  });
});
