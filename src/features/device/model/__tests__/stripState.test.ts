import { describe, expect, it } from "vitest";

import type { SerialCommandStatusCode, SerialOutputStatus } from "@/shared/contracts/device";

import { serialStripState, wledStripState } from "../stripState";

const entry = (connected: boolean, code: SerialCommandStatusCode): SerialOutputStatus => ({
  portName: "COM3",
  connected,
  status: { code, message: code, details: null },
  firmware: null,
  updatedAtUnixMs: 0,
});

const facts = { connecting: false, entry: null, unlit: false, firmwareMismatch: false };

describe("serialStripState", () => {
  it("reads a connect in flight first, whatever the entry says", () => {
    expect(serialStripState({ ...facts, connecting: true, entry: entry(true, "CONNECT_OK") })).toBe("connecting");
  });

  it("reads a connected strip, one the user said did not light, and a firmware mismatch", () => {
    expect(serialStripState({ ...facts, entry: entry(true, "CONNECT_OK") })).toBe("connected");
    expect(serialStripState({ ...facts, entry: entry(true, "CONNECT_OK"), unlit: true })).toBe("unlit");
    expect(serialStripState({ ...facts, entry: entry(true, "CONNECT_OK"), firmwareMismatch: true, unlit: true })).toBe(
      "firmwareMismatch",
    );
  });

  // The shell brings a strip whose port went away back when it reappears.
  it("reads an unplugged strip as waiting to come back", () => {
    expect(serialStripState({ ...facts, entry: entry(false, "PORT_NOT_FOUND") })).toBe("reconnecting");
  });

  it("names a port the OS refuses until a replug, and one another app holds", () => {
    expect(serialStripState({ ...facts, entry: entry(false, "CONNECT_REPLUG_REQUIRED") })).toBe("replug");
    expect(serialStripState({ ...facts, entry: entry(false, "CONNECT_IO_ERROR") })).toBe("busy");
    expect(serialStripState({ ...facts, entry: entry(false, "CONNECT_PERMISSION_DENIED") })).toBe("busy");
  });

  it("reads anything else, and no entry at all, as not connected", () => {
    expect(serialStripState(facts)).toBe("disconnected");
    expect(serialStripState({ ...facts, entry: entry(false, "DISCONNECTED") })).toBe("disconnected");
    expect(serialStripState({ ...facts, entry: entry(false, "CONNECT_TIMEOUT") })).toBe("disconnected");
  });
});

describe("wledStripState", () => {
  it("reads a device bound, not bound, connecting, or one that did not light", () => {
    expect(wledStripState({ connecting: false, bound: true, unlit: false })).toBe("connected");
    expect(wledStripState({ connecting: false, bound: false, unlit: false })).toBe("disconnected");
    expect(wledStripState({ connecting: true, bound: false, unlit: false })).toBe("connecting");
    expect(wledStripState({ connecting: false, bound: true, unlit: true })).toBe("unlit");
  });
});
