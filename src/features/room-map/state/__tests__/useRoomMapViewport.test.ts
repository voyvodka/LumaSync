import { describe, expect, it } from "vitest";

import { computeFit, ROOM_MAP_PX_PER_METER } from "../useRoomMapViewport";

/** Replaces the ROOM-01 `it.todo`: measuring the canvas needs a layout engine,
 *  deciding the fit from a measurement does not. */
describe("computeFit", () => {
  it("scales the room to the tighter of the two axes", () => {
    // 5×4 m room ⇒ 400×320 px at zoom 1. In an 840×400 canvas with 20 px pad the
    // usable box is 800×360: width allows 2.0, height allows 1.125. Height wins.
    const fit = computeFit(840, 400, 5, 4, 20);

    expect(fit.zoom).toBeCloseTo(1.125, 5);
  });

  it("centres the room in the canvas", () => {
    const fit = computeFit(840, 400, 5, 4, 20);

    const roomW = 5 * ROOM_MAP_PX_PER_METER * fit.zoom;
    const roomH = 4 * ROOM_MAP_PX_PER_METER * fit.zoom;
    expect(fit.panOffset.x).toBeCloseTo((840 - roomW) / 2, 5);
    expect(fit.panOffset.y).toBeCloseTo((400 - roomH) / 2, 5);
  });

  it("respects the padding by shrinking the usable box on both sides", () => {
    const tight = computeFit(840, 400, 5, 4, 0);
    const padded = computeFit(840, 400, 5, 4, 20);

    expect(padded.zoom).toBeLessThan(tight.zoom);
  });

  it("clamps a tiny room to the 3× ceiling instead of filling the canvas", () => {
    // A 0.5×0.5 m room in a big canvas wants a zoom far above 3.
    const fit = computeFit(2000, 2000, 0.5, 0.5, 16);

    expect(fit.zoom).toBe(3);
  });

  it("clamps a huge room to the 0.3× floor instead of vanishing", () => {
    const fit = computeFit(400, 300, 100, 100, 16);

    expect(fit.zoom).toBe(0.3);
  });

  /** The clamp must not desynchronise the centring: pan is derived from the
   *  zoom actually applied, so a clamped room stays centred (and overflows
   *  symmetrically) rather than drifting to a corner. */
  it("centres using the clamped zoom, not the requested one", () => {
    const fit = computeFit(400, 300, 100, 100, 16);

    const roomW = 100 * ROOM_MAP_PX_PER_METER * 0.3;
    const roomH = 100 * ROOM_MAP_PX_PER_METER * 0.3;
    expect(fit.panOffset.x).toBeCloseTo((400 - roomW) / 2, 5);
    expect(fit.panOffset.y).toBeCloseTo((300 - roomH) / 2, 5);
    expect(fit.panOffset.x).toBeLessThan(0);
  });

  it("keeps a square room square in a wide canvas", () => {
    const wide = computeFit(1600, 400, 4, 4, 0);
    const tall = computeFit(400, 1600, 4, 4, 0);

    expect(wide.zoom).toBeCloseTo(tall.zoom, 5);
  });
});
