import { describe, expect, it } from "vitest";

import { HUE_CREDENTIAL_BACKENDS, HUE_RUNTIME_STATUS } from "@/shared/contracts/hue";
import {
  isHueStartCodeOk,
  isHueStopCodeOk,
  isSameHueStartConfig,
  toHueStartConfig,
} from "../hueStartConfig";

describe("toHueStartConfig", () => {
  const complete = {
    lastHueBridge: { ip: "192.168.1.10" },
    hueAppKey: "app-user",
    hueClientKey: "AABBCCDD",
    lastHueAreaId: "area-1",
  };

  it("projects a complete shell state", () => {
    expect(toHueStartConfig(complete)).toEqual({
      bridgeIp: "192.168.1.10",
      username: "app-user",
      clientKey: "AABBCCDD",
      areaId: "area-1",
    });
  });

  it("trims whitespace on every field", () => {
    expect(
      toHueStartConfig({
        lastHueBridge: { ip: "  192.168.1.10 " },
        hueAppKey: " app-user ",
        hueClientKey: " AABBCCDD ",
        lastHueAreaId: " area-1 ",
      }),
    ).toEqual({
      bridgeIp: "192.168.1.10",
      username: "app-user",
      clientKey: "AABBCCDD",
      areaId: "area-1",
    });
  });

  it("returns null when bridge or area is missing", () => {
    expect(toHueStartConfig({ ...complete, lastHueBridge: undefined })).toBeNull();
    expect(toHueStartConfig({ ...complete, lastHueAreaId: undefined })).toBeNull();
  });

  it("returns null when no app key and no keychain backend prove a pairing", () => {
    expect(toHueStartConfig({ ...complete, hueAppKey: undefined })).toBeNull();
    expect(toHueStartConfig({ ...complete, hueAppKey: "   " })).toBeNull();
    expect(
      toHueStartConfig({
        ...complete,
        hueAppKey: undefined,
        credentialStorageBackend: HUE_CREDENTIAL_BACKENDS.PLAINTEXT_LEGACY,
      }),
    ).toBeNull();
  });

  it("projects an empty username when the keychain owns the app key", () => {
    expect(
      toHueStartConfig({
        lastHueBridge: { ip: "192.168.1.10" },
        lastHueAreaId: "area-1",
        credentialStorageBackend: HUE_CREDENTIAL_BACKENDS.KEYCHAIN,
      }),
    ).toEqual({
      bridgeIp: "192.168.1.10",
      username: "",
      clientKey: "",
      areaId: "area-1",
    });
  });

  it("tolerates a missing client key — DTLS falls back to the HTTP path", () => {
    expect(toHueStartConfig({ ...complete, hueClientKey: undefined })?.clientKey).toBe("");
  });
});

describe("isHueStartCodeOk / isHueStopCodeOk", () => {
  it("accepts all four start-ok codes", () => {
    expect(isHueStartCodeOk(HUE_RUNTIME_STATUS.STREAM_RUNNING)).toBe(true);
    expect(isHueStartCodeOk(HUE_RUNTIME_STATUS.STREAM_RUNNING_DTLS)).toBe(true);
    expect(isHueStartCodeOk(HUE_RUNTIME_STATUS.STREAM_STARTING)).toBe(true);
    expect(isHueStartCodeOk(HUE_RUNTIME_STATUS.START_NOOP_ALREADY_ACTIVE)).toBe(true);
  });

  it("rejects a stop code and an unknown code on the start path", () => {
    expect(isHueStartCodeOk(HUE_RUNTIME_STATUS.STREAM_STOPPED)).toBe(false);
    expect(isHueStartCodeOk("HUE_STREAM_NOT_READY_ACTIVE_STREAMER")).toBe(false);
  });

  it("accepts only a confirmed stop", () => {
    expect(isHueStopCodeOk(HUE_RUNTIME_STATUS.STREAM_STOPPED)).toBe(true);
    expect(isHueStopCodeOk(HUE_RUNTIME_STATUS.STREAM_RUNNING)).toBe(false);
  });
});

describe("isSameHueStartConfig", () => {
  const state = {
    lastHueBridge: { ip: "192.168.1.10" },
    hueAppKey: "app-user",
    hueClientKey: "AABBCCDD",
    lastHueAreaId: "area-1",
  };

  // The whole point: two projections of an unchanged shell state are distinct
  // objects, so `Object.is` reports a change on every mode switch and every
  // effect keyed on the config restarts with a fresh failure budget.
  it("treats two projections of the same state as equal despite distinct identity", () => {
    const a = toHueStartConfig(state);
    const b = toHueStartConfig(state);

    expect(a).not.toBe(b);
    expect(isSameHueStartConfig(a, b)).toBe(true);
  });

  it("separates a real change on any of the four fields", () => {
    const base = toHueStartConfig(state);

    expect(isSameHueStartConfig(base, toHueStartConfig({ ...state, lastHueAreaId: "area-2" }))).toBe(false);
    expect(isSameHueStartConfig(base, toHueStartConfig({ ...state, lastHueBridge: { ip: "10.0.0.2" } }))).toBe(false);
    expect(isSameHueStartConfig(base, toHueStartConfig({ ...state, hueAppKey: "other" }))).toBe(false);
    expect(isSameHueStartConfig(base, toHueStartConfig({ ...state, hueClientKey: "FFFF" }))).toBe(false);
  });

  it("handles the unpaired null on either side", () => {
    expect(isSameHueStartConfig(null, null)).toBe(true);
    expect(isSameHueStartConfig(toHueStartConfig(state), null)).toBe(false);
    expect(isSameHueStartConfig(null, toHueStartConfig(state))).toBe(false);
  });
});
