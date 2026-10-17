import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { describe, expect, it } from "vitest";

import { block } from "../parts";

describe("block", () => {
  it("builds the same rounded box again without sharing its buffers", () => {
    const first = block(0.6, 0.4, 0.5, 0, 0, 0, 0xffffff).geometry;
    const second = block(0.6, 0.4, 0.5, 1, 0, 0, 0xffffff).geometry;
    expect(second.getAttribute("position").array).not.toBe(first.getAttribute("position").array);

    const fresh = new RoundedBoxGeometry(0.6, 0.4, 0.5, 2, 0.02 * 0.98);
    fresh.translate(0, 0.2, 0);
    expect(Array.from(first.getAttribute("position").array)).toEqual(Array.from(fresh.getAttribute("position").array));
    expect(Array.from(first.getAttribute("uv").array)).toEqual(Array.from(fresh.getAttribute("uv").array));
    expect(first.getIndex()?.count ?? 0).toBe(fresh.getIndex()?.count ?? 0);
  });
});
