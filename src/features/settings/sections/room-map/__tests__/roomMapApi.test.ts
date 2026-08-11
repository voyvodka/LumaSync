import { describe, expect, it, vi } from "vitest";

import { HUE_COMMANDS } from "@/shared/contracts/hue";
import { HUE_ZONE_COMMANDS, ROOM_MAP_COMMANDS, type HueZone } from "@/shared/contracts/roomMap";
import {
  assignChannelToHueZone,
  copyBackgroundImage,
  createHueZone,
  deleteHueZone,
  updateHueChannelPositions,
  updateHueZone,
} from "../roomMapApi";

const ZONE: HueZone = {
  id: "hue-zone-1",
  name: "Sofa",
  entertainmentAreaId: "area-1",
  centerX: 0,
  centerY: 0,
  centerZ: 0,
  scaleX: 0.5,
  scaleY: 0.5,
  scaleZ: 0.5,
  channelIndices: [0, 1],
};

// Regression guard: a missing `{ request }` envelope is rejected by Tauri
// silently when callers swallow the rejection — LightsSection shipped broken this way.
describe("roomMapApi zone wrappers send the { request } envelope", () => {
  it("createHueZone", async () => {
    const invokeMock = vi.fn().mockResolvedValue({ status: {}, zones: [], channels: [] });
    await createHueZone({ zone: ZONE, existingZones: [] }, invokeMock);
    expect(invokeMock).toHaveBeenCalledWith(HUE_ZONE_COMMANDS.CREATE_HUE_ZONE, {
      request: { zone: ZONE, existingZones: [] },
    });
  });

  it("updateHueZone", async () => {
    const invokeMock = vi.fn().mockResolvedValue({ status: {}, zones: [], channels: [] });
    await updateHueZone({ zone: ZONE, existingZones: [ZONE] }, invokeMock);
    expect(invokeMock).toHaveBeenCalledWith(HUE_ZONE_COMMANDS.UPDATE_HUE_ZONE, {
      request: { zone: ZONE, existingZones: [ZONE] },
    });
  });

  it("deleteHueZone", async () => {
    const invokeMock = vi.fn().mockResolvedValue({ status: {}, zones: [], channels: [] });
    await deleteHueZone({ zoneId: ZONE.id, existingZones: [ZONE], channels: [] }, invokeMock);
    expect(invokeMock).toHaveBeenCalledWith(HUE_ZONE_COMMANDS.DELETE_HUE_ZONE, {
      request: { zoneId: ZONE.id, existingZones: [ZONE], channels: [] },
    });
  });

  it("assignChannelToHueZone", async () => {
    const invokeMock = vi.fn().mockResolvedValue({ status: {}, zones: [], channels: [] });
    const payload = {
      channelIndex: 0,
      zoneId: ZONE.id,
      zoneRelativePosition: { x: 0, y: 0, z: 0 },
      entertainmentAreaId: "area-1",
      existingZones: [ZONE],
      channels: [],
    };
    await assignChannelToHueZone(payload, invokeMock);
    expect(invokeMock).toHaveBeenCalledWith(HUE_ZONE_COMMANDS.ASSIGN_CHANNEL_TO_HUE_ZONE, {
      request: payload,
    });
  });
});

describe("roomMapApi non-zone wrappers", () => {
  it("updateHueChannelPositions sends flat args, no envelope", async () => {
    const invokeMock = vi.fn().mockResolvedValue({ code: "OK", message: "", details: null });
    const payload = { channels: [], bridgeIp: "192.168.1.10", username: "app-user", areaId: "area-1" };
    await updateHueChannelPositions(payload, invokeMock);
    expect(invokeMock).toHaveBeenCalledWith(HUE_COMMANDS.UPDATE_CHANNEL_POSITIONS, payload);
  });

  it("copyBackgroundImage sends { srcPath }", async () => {
    const invokeMock = vi.fn().mockResolvedValue("/app-data/room-map-backgrounds/abc.png");
    await copyBackgroundImage("/Users/me/Pictures/floorplan.png", invokeMock);
    expect(invokeMock).toHaveBeenCalledWith(ROOM_MAP_COMMANDS.COPY_BACKGROUND_IMAGE, {
      srcPath: "/Users/me/Pictures/floorplan.png",
    });
  });
});

describe("roomMapApi zone wrappers are pass-through on rejection", () => {
  it("createHueZone propagates the rejection instead of absorbing it", async () => {
    const invokeMock = vi.fn().mockRejectedValue(new Error("transport failure"));
    await expect(createHueZone({ zone: ZONE, existingZones: [] }, invokeMock)).rejects.toThrow(
      "transport failure",
    );
  });
});
