import { describe, expect, it } from "vitest";

import {
  defaultStart,
  ends,
  holdStart,
  nudge,
  pickCorner,
  pickEnd,
  placeName,
  restoreStart,
  setDirection,
  stops,
  stripOrder,
  type StartPoint,
  type StripShape,
} from "../startPoint";

const loop: StripShape = { counts: { top: 50, right: 32, bottom: 50, left: 32 }, gap: 0 };
const stand: StripShape = { counts: { top: 50, right: 32, bottom: 41, left: 32 }, gap: 8 };
const three: StripShape = { counts: { top: 50, right: 32, bottom: 0, left: 32 }, gap: 0 };

describe("ends", () => {
  it("a loop has none; a stand's are the LEDs either side of it", () => {
    expect(ends(loop)).toBeNull();
    const en = ends(stand)!;
    // Right of the stand holds floor(41 / 2) = 20, like the output's gap anchors.
    expect(en.A).toMatchObject({ edge: "bottom", k: 20 });
    expect(en.B).toMatchObject({ edge: "bottom", k: 19 });
    expect(placeName(stand, en.A)).toEqual({ kind: "gapLeft" });
    expect(placeName(stand, en.B)).toEqual({ kind: "gapRight" });
  });

  it("a strip with no bottom runs from bottom-left up to bottom-right", () => {
    const en = ends(three)!;
    expect(en.A).toMatchObject({ edge: "left", k: 0 });
    expect(en.B).toMatchObject({ edge: "right", k: 31 });
  });
});

describe("picking", () => {
  it("defaults to the loop's bottom-left, clockwise, and an open strip's first end", () => {
    expect(defaultStart(loop)).toEqual({ led: { edge: "left", k: 0 }, direction: "cw" });
    expect(defaultStart(stand)).toEqual({ led: { edge: "bottom", k: 20 }, direction: "cw" });
  });

  it("the same corner again turns the strip round without leaving the corner", () => {
    const first = pickCorner(loop, "bl", { led: { edge: "top", k: 3 }, direction: "cw" });
    expect(first).toEqual({ led: { edge: "left", k: 0 }, direction: "cw" });
    expect(pickCorner(loop, "bl", first)).toEqual({ led: { edge: "bottom", k: 49 }, direction: "ccw" });
  });

  it("an end picked again moves to the other end, always heading in", () => {
    const a = pickEnd(stand, "A", { led: { edge: "top", k: 0 }, direction: "cw" });
    expect(a.direction).toBe("cw");
    expect(pickEnd(stand, "A", a)).toEqual({ led: { edge: "bottom", k: 19 }, direction: "ccw" });
  });

  it("flipping direction at a corner keeps LED #1 at that corner", () => {
    const tl: StartPoint = { led: { edge: "top", k: 0 }, direction: "cw" };
    expect(setDirection(loop, tl, "ccw")).toEqual({ led: { edge: "left", k: 31 }, direction: "ccw" });
    const mid: StartPoint = { led: { edge: "top", k: 25 }, direction: "cw" };
    expect(setDirection(loop, mid, "ccw")).toEqual({ led: mid.led, direction: "ccw" });
  });
});

describe("stops", () => {
  it("steps through the corners and the stand's ends only, clockwise", () => {
    const names = stops(stand, "cw").map((s) => placeName(stand, s.led));
    expect(names).toEqual([
      { kind: "corner", corner: "tl" },
      { kind: "corner", corner: "tr" },
      { kind: "corner", corner: "br" },
      { kind: "gapRight" },
      { kind: "gapLeft" },
      { kind: "corner", corner: "bl" },
    ]);
    expect(placeName(loop, { edge: "top", k: 25 })).toEqual({ kind: "edge", edge: "top" });
  });

  it("‹ › from between two stops goes to the nearest one that way, and wraps", () => {
    const between: StartPoint = { led: { edge: "top", k: 10 }, direction: "cw" };
    expect(placeName(loop, nudge(loop, between, 1).led)).toEqual({ kind: "corner", corner: "tr" });
    expect(placeName(loop, nudge(loop, between, -1).led)).toEqual({ kind: "corner", corner: "tl" });
    const all = stops(loop, "cw");
    const last = all[all.length - 1];
    expect(placeName(loop, nudge(loop, last, 1).led)).toEqual({ kind: "corner", corner: "tl" });
  });
});

describe("order and counts changing", () => {
  it("lights the strip clockwise or back from LED #1", () => {
    const cw = stripOrder(loop, { led: { edge: "left", k: 0 }, direction: "cw" });
    expect(cw[1]).toMatchObject({ edge: "left", k: 1 });
    const ccw = stripOrder(loop, { led: { edge: "left", k: 0 }, direction: "ccw" });
    expect(ccw[1]).toMatchObject({ edge: "bottom", k: 49 });
    expect(cw).toHaveLength(164);
  });

  it("an end or an edge's last LED stays that when counts change", () => {
    const last: StartPoint = { led: { edge: "top", k: 49 }, direction: "cw" };
    const grown: StripShape = { ...loop, counts: { ...loop.counts, top: 60 } };
    expect(restoreStart(grown, last, holdStart(loop, last)).led).toEqual({ edge: "top", k: 59 });
    const end: StartPoint = { led: { edge: "bottom", k: 20 }, direction: "cw" };
    const wider: StripShape = { ...stand, counts: { ...stand.counts, bottom: 45 } };
    expect(restoreStart(wider, end, holdStart(stand, end)).led).toEqual({ edge: "bottom", k: 22 });
  });
});
