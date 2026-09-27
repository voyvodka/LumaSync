import { describe, expect, it } from "vitest";

import { ends, type StripShape } from "../../model/startPoint";
import { computeStage, frameFor } from "../stageGeometry";

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
