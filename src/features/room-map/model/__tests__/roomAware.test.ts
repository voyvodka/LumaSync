import { describe, expect, it } from "vitest";

import { defaultTvMountHeight, isRoomAwareActive } from "../roomAware";

const tv = { x: 1, y: 0, width: 1.2, height: 0.1 };

describe("isRoomAwareActive", () => {
  it("is on with a TV anchor and a Hue output", () => {
    expect(isRoomAwareActive(tv, ["hue"])).toBe(true);
    expect(isRoomAwareActive(tv, ["usb", "hue"])).toBe(true);
  });

  it("is off without a TV anchor", () => {
    expect(isRoomAwareActive(undefined, ["hue"])).toBe(false);
    expect(isRoomAwareActive(null, ["hue"])).toBe(false);
  });

  it("is off when Hue is not an output", () => {
    expect(isRoomAwareActive(tv, ["usb"])).toBe(false);
    expect(isRoomAwareActive(tv, [])).toBe(false);
  });
});

describe("defaultTvMountHeight", () => {
  it("is 40% of the room height", () => {
    expect(defaultTvMountHeight(2.5)).toBeCloseTo(1.0);
    expect(defaultTvMountHeight(3)).toBeCloseTo(1.2);
  });
});
