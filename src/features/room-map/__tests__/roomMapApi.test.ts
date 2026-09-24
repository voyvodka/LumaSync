import { describe, expect, it } from "vitest";

import { HUE_COMMANDS } from "@/shared/contracts/hue";
import {
  HUE_ZONE_COMMANDS,
  ROOM_MAP_COMMANDS,
  type HueZone,
  type HueZoneCommandResult,
} from "@/shared/contracts/roomMap";
import { mockCommands } from "@/test/mockCommands";
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

function zoneResult(): HueZoneCommandResult {
  return { status: { code: "HUE_ZONE_CREATED", message: "", details: null }, zones: [], channels: [] };
}

// Regression guard: a missing `{ request }` envelope is rejected by Tauri
// silently when callers swallow the rejection — LightsSection shipped broken this way.
describe("roomMapApi zone wrappers send the { request } envelope", () => {
  it("createHueZone", async () => {
    const invokeMock = mockCommands({ create_hue_zone: zoneResult() });
    await createHueZone({ zone: ZONE, existingZones: [] }, invokeMock);
    expect(invokeMock).toHaveBeenCalledWith(HUE_ZONE_COMMANDS.CREATE_HUE_ZONE, {
      request: { zone: ZONE, existingZones: [] },
    });
  });

  it("updateHueZone", async () => {
    const invokeMock = mockCommands({ update_hue_zone: zoneResult() });
    await updateHueZone({ zone: ZONE, existingZones: [ZONE] }, invokeMock);
    expect(invokeMock).toHaveBeenCalledWith(HUE_ZONE_COMMANDS.UPDATE_HUE_ZONE, {
      request: { zone: ZONE, existingZones: [ZONE] },
    });
  });

  it("deleteHueZone", async () => {
    const invokeMock = mockCommands({ delete_hue_zone: zoneResult() });
    await deleteHueZone({ zoneId: ZONE.id, existingZones: [ZONE], channels: [] }, invokeMock);
    expect(invokeMock).toHaveBeenCalledWith(HUE_ZONE_COMMANDS.DELETE_HUE_ZONE, {
      request: { zoneId: ZONE.id, existingZones: [ZONE], channels: [] },
    });
  });

  it("assignChannelToHueZone", async () => {
    const invokeMock = mockCommands({ assign_channel_to_hue_zone: zoneResult() });
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
    const invokeMock = mockCommands({
      update_hue_channel_positions: { code: "HUE_CHANNEL_POSITIONS_UPDATED", message: "", details: null },
    });
    const payload = { channels: [], bridgeIp: "192.168.1.10", username: "app-user", areaId: "area-1" };
    await updateHueChannelPositions(payload, invokeMock);
    expect(invokeMock).toHaveBeenCalledWith(HUE_COMMANDS.UPDATE_CHANNEL_POSITIONS, payload);
  });

  it("copyBackgroundImage sends { srcPath }", async () => {
    const invokeMock = mockCommands({ copy_background_image: "/app-data/room-map-backgrounds/abc.png" });
    await copyBackgroundImage("/Users/me/Pictures/floorplan.png", invokeMock);
    expect(invokeMock).toHaveBeenCalledWith(ROOM_MAP_COMMANDS.COPY_BACKGROUND_IMAGE, {
      srcPath: "/Users/me/Pictures/floorplan.png",
    });
  });
});

describe("roomMapApi zone wrappers are pass-through on rejection", () => {
  it("createHueZone propagates the rejection instead of absorbing it", async () => {
    const invokeMock = mockCommands({
      create_hue_zone: () => Promise.reject(new Error("transport failure")),
    });
    await expect(createHueZone({ zone: ZONE, existingZones: [] }, invokeMock)).rejects.toThrow(
      "transport failure",
    );
  });
});
