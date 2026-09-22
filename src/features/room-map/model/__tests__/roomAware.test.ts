import { describe, expect, it } from "vitest";

import { defaultTvMountHeight, isRoomAwareActive, roomAwareStatus } from "../roomAware";

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

describe("roomAwareStatus", () => {
  const usable = { configured: true, reachable: true, verdict: "reachable" } as const;

  it("is active only while Hue is usable", () => {
    expect(roomAwareStatus(tv, ["hue"], usable)).toEqual({ state: "active" });
  });

  it("is paused, with the Hue row's reason, when the paired bridge cannot stream", () => {
    expect(
      roomAwareStatus(tv, ["hue"], { configured: true, reachable: false, verdict: "credentialRejected" }),
    ).toEqual({ state: "paused", reason: "keyRejected" });
    expect(
      roomAwareStatus(tv, ["hue"], { configured: true, reachable: false, verdict: "unreachable" }),
    ).toEqual({ state: "paused", reason: "unreachable" });
    expect(
      roomAwareStatus(tv, ["hue"], { configured: true, reachable: false, verdict: null }),
    ).toEqual({ state: "paused", reason: "checking" });
  });

  it("is hidden when no bridge is paired", () => {
    expect(
      roomAwareStatus(tv, ["hue"], { configured: false, reachable: false, verdict: null }),
    ).toBeNull();
  });

  it("is hidden without the TV + Hue-output gate, however usable Hue is", () => {
    expect(roomAwareStatus(null, ["hue"], usable)).toBeNull();
    expect(roomAwareStatus(tv, ["usb"], usable)).toBeNull();
  });
});

describe("defaultTvMountHeight", () => {
  it("is 40% of the room height", () => {
    expect(defaultTvMountHeight(2.5)).toBeCloseTo(1.0);
    expect(defaultTvMountHeight(3)).toBeCloseTo(1.2);
  });
});
