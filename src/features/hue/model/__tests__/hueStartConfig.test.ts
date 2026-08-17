import { describe, expect, it } from "vitest";

import { HUE_CREDENTIAL_BACKENDS, HUE_RUNTIME_STATUS } from "@/shared/contracts/hue";
import type { RoomMapConfig } from "@/shared/contracts/roomMap";
import {
  isHueStartCodeOk,
  isHueStopCodeOk,
  isSameHueStartConfig,
  toChannelPlacements,
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

  it("carries the area's placements, because this projection is the only wiring that counts", () => {
    // The field this replaces was wired only on the Devices surface, so it never
    // rode the path a user actually starts a mode from and nobody noticed for
    // the whole life of the field. Wire it anywhere else and the feature is dead
    // while still testing green from Devices.
    const withRoom = {
      ...complete,
      roomMap: {
        hueChannels: [
          { channelIndex: 0, channelId: 3, x: 0.4, y: -0.2, z: 0, entertainmentAreaId: "area-1" },
        ],
        zones: [],
      } as unknown as RoomMapConfig,
    };
    expect(toHueStartConfig(withRoom)?.channelPlacements).toEqual([
      { channelId: 3, positionX: 0.4, positionY: -0.2 },
    ]);
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

describe("toChannelPlacements", () => {
  const zones = [
    { id: "z1", name: "Z", entertainmentAreaId: "area-1", channelIndices: [1],
      centerX: 0.5, centerY: 0, centerZ: 0, scaleX: 0.25, scaleY: 0.25, scaleZ: 0.25 },
  ] as unknown as RoomMapConfig["zones"];

  it("addresses the bridge id and drops a placement that has none", () => {
    // A record with no `channelId` has never been matched to the bridge. The
    // ordinal is not a substitute — sending it is the defect #305 removed.
    const roomMap = {
      hueChannels: [
        { channelIndex: 0, channelId: 4, x: -0.5, y: 0.25, z: 0, entertainmentAreaId: "area-1" },
        { channelIndex: 1, x: 0.5, y: 0, z: 0, entertainmentAreaId: "area-1" },
      ],
      zones: [],
    } as unknown as RoomMapConfig;

    expect(toChannelPlacements(roomMap, "area-1")).toEqual([
      { channelId: 4, positionX: -0.5, positionY: 0.25 },
    ]);
  });

  it("resolves a zone-bound channel through its zone", () => {
    // The absolute pair on a bound record is derived, not authoritative; sending
    // it would stream the position the editor ignores.
    const roomMap = {
      hueChannels: [
        {
          channelIndex: 1,
          channelId: 7,
          x: 0, y: 0, z: 0,
          entertainmentAreaId: "area-1",
          zoneId: "z1",
          zoneRelativePosition: { x: 1, y: 0, z: 0 },
        },
      ],
      zones,
    } as unknown as RoomMapConfig;

    // centre 0.5 + scale 0.25 * relative 1 = 0.75
    expect(toChannelPlacements(roomMap, "area-1")).toEqual([
      { channelId: 7, positionX: 0.75, positionY: 0 },
    ]);
  });

  it("is undefined rather than empty when the area has nothing placed", () => {
    expect(toChannelPlacements({ hueChannels: [], zones: [] } as unknown as RoomMapConfig, "area-1"))
      .toBeUndefined();
    expect(toChannelPlacements(undefined, "area-1")).toBeUndefined();
  });
});
