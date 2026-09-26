import { describe, expect, it } from "vitest";

import { anchorForLed, ledOfAnchor } from "../startAnchor";

const counts = { top: 9, right: 5, bottom: 8, left: 5 };

describe("anchorForLed", () => {
  it("names an end or a stand side with the anchor alone", () => {
    expect(anchorForLed(counts, 0, { edge: "top", k: 0 })).toEqual({ startAnchor: "top-start" });
    expect(anchorForLed(counts, 0, { edge: "top", k: 8 })).toEqual({ startAnchor: "top-end" });
    expect(anchorForLed(counts, 2, { edge: "bottom", k: 3 })).toEqual({ startAnchor: "bottom-gap-right" });
    expect(anchorForLed(counts, 2, { edge: "bottom", k: 4 })).toEqual({ startAnchor: "bottom-gap-left" });
  });

  it("anchors a mid-edge LED to the nearer end, the start on a tie", () => {
    expect(anchorForLed(counts, 0, { edge: "top", k: 4 })).toEqual({ startAnchor: "top-start", startLocalIndex: 4 });
    expect(anchorForLed(counts, 0, { edge: "top", k: 6 })).toEqual({ startAnchor: "top-end", startLocalIndex: 6 });
  });

  it("round-trips through ledOfAnchor", () => {
    for (let k = 0; k < counts.bottom; k += 1) {
      const saved = anchorForLed(counts, 2, { edge: "bottom", k });
      expect(ledOfAnchor({ counts, bottomMissing: 2, ...saved })).toEqual({ edge: "bottom", k });
    }
  });

  it("an edge with no LEDs falls back to its start", () => {
    expect(anchorForLed({ ...counts, left: 0 }, 0, { edge: "left", k: 3 })).toEqual({ startAnchor: "left-start" });
  });
});
