import { describe, expect, it } from "vitest";

import {
  countBounds,
  distribute,
  draftFromCounts,
  isLinked,
  keyForEdge,
  minTotal,
  setCount,
  setStand,
  sumCounts,
  toggleEdge,
  toggleLink,
  type LayoutDraft,
} from "../ledLayout";

const MON = { width: 3600, height: 2338 };
const four = () => draftFromCounts({ top: 50, right: 32, bottom: 50, left: 32 }, 0);
const stand = (): LayoutDraft => setStand(four(), true);

describe("edges", () => {
  it("putting an edge out touches only that edge, and it comes back with its count", () => {
    const d = { ...four(), counts: { top: 50, right: 32, bottom: 40, left: 32 } };
    const off = toggleEdge(d, "bottom", false, MON);
    expect(off.counts).toEqual({ top: 50, right: 32, bottom: 0, left: 32 });
    expect(toggleEdge(off, "bottom", true, MON).counts.bottom).toBe(40);
  });

  it("an edge back with no memory takes the opposite edge's count", () => {
    const off = { ...toggleEdge(four(), "left", false, MON), memo: {} };
    expect(toggleEdge(off, "left", true, MON).counts.left).toBe(32);
  });

  it("the last lit edge stays lit, and the stand goes with the bottom", () => {
    let d = four();
    for (const e of ["right", "bottom", "left"] as const) d = toggleEdge(d, e, false, MON);
    expect(toggleEdge(d, "top", false, MON)).toBe(d);
    expect(toggleEdge(stand(), "bottom", false, MON).gap).toBe(0);
  });
});

describe("stand", () => {
  it("adds only the gap; the counts and links stay", () => {
    const s = stand();
    expect(s.gap).toBe(8);
    expect(s.counts).toEqual(four().counts);
    expect(isLinked(s, "tb")).toBe(true);
    expect(setStand(s, false).counts).toEqual(four().counts);
  });

  it("nothing moves another edge: top 60, bottom 60 with a gap of 10", () => {
    const d = setCount(setCount(stand(), "tb", 60, MON), "gap", 10, MON);
    expect(d.counts).toMatchObject({ top: 60, bottom: 60 });
    expect(setCount(d, "gap", 30, MON).counts.bottom).toBe(60);
    const apart = toggleLink(d, "tb");
    expect(setCount(apart, "top", 70, MON).counts.bottom).toBe(60);
  });

  it("keeps one LED each side of it", () => {
    expect(countBounds(stand(), "bottom", MON).min).toBe(2);
    expect(countBounds(stand(), "tb", MON).min).toBe(2);
    expect(setCount(toggleLink(stand(), "tb"), "bottom", 0, MON).counts.bottom).toBe(2);
  });
});

describe("links", () => {
  it("caps an edge at 200 LEDs/m along a 100-inch screen of the display's shape", () => {
    const wide = { width: 16, height: 9 };
    expect(countBounds(four(), "top", wide).max).toBe(443);
    expect(countBounds(four(), "lr", wide).max).toBe(250);
    expect(setCount(four(), "top", 5000, wide).counts.top).toBe(443);
  });

  it("a linked pair edits as one number", () => {
    expect(keyForEdge(four(), "bottom")).toBe("tb");
    expect(setCount(four(), "lr", 40, MON).counts).toMatchObject({ left: 40, right: 40 });
  });

  it("the chain splits a pair, and joins it again at the top or right edge's count", () => {
    const apart = setCount(toggleLink(four(), "lr"), "left", 20, MON);
    expect(keyForEdge(apart, "left")).toBe("left");
    expect(toggleLink(apart, "lr").counts).toMatchObject({ left: 32, right: 32 });
  });
});

describe("distribute", () => {
  it("always adds up to the total and keeps linked pairs equal", () => {
    for (let total = 4; total <= 400; total += 1) {
      const d = distribute(four(), total, MON);
      expect(sumCounts(d.counts)).toBe(total);
      if (total % 2 === 0) {
        expect(d.counts.left).toBe(d.counts.right);
        expect(d.counts.top).toBe(d.counts.bottom);
      }
    }
  });

  it("an odd total puts the spare LED on the top", () => {
    const d = distribute(four(), 165, MON);
    expect(d.counts.top).toBe(d.counts.bottom + 1);
    expect(d.links.tb).toBe(false);
  });

  it("with a stand it adds up, keeps the gap, and an odd strip lengthens a side", () => {
    for (const s of [stand(), toggleLink(stand(), "tb")]) {
      for (let total = minTotal(s); total <= 300; total += 1) {
        const d = distribute(s, total, MON);
        expect(sumCounts(d.counts)).toBe(total);
        expect(d.gap).toBe(8);
        if (isLinked(s, "tb")) expect(d.counts.top).toBe(d.counts.bottom);
      }
    }
  });

  it("an unlinked bottom beside a stand gives up the gap's share", () => {
    const d = distribute(toggleLink(stand(), "tb"), 164, MON);
    expect(d.counts.top - d.counts.bottom).toBeGreaterThanOrEqual(7);
  });

  it("refuses a total the edges cannot hold", () => {
    const s = stand();
    expect(distribute(s, minTotal(s) - 1, MON)).toBe(s);
  });

  it("an empty layout shares the total over all four edges", () => {
    const empty = draftFromCounts({ top: 0, right: 0, bottom: 0, left: 0 }, 0);
    expect(sumCounts(distribute(empty, 150, MON).counts)).toBe(150);
  });
});
