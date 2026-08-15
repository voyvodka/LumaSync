import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_ROOM_MAP } from "@/shared/contracts/roomMap";
import type {
  HueChannelPlacement,
  HueZone,
  HueZoneCommandResult,
  RoomMapConfig,
} from "@/shared/contracts/roomMap";
import { useRoomMapHueZones } from "../useRoomMapHueZones";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockCreate = vi.fn();
const mockUpdate = vi.fn();
const mockDelete = vi.fn();
const mockAssign = vi.fn();

vi.mock("../../roomMapApi", () => ({
  createHueZone: (p: unknown) => mockCreate(p),
  updateHueZone: (p: unknown) => mockUpdate(p),
  deleteHueZone: (p: unknown) => mockDelete(p),
  assignChannelToHueZone: (p: unknown) => mockAssign(p),
}));

vi.mock("@/features/persistence/shellStore", () => ({
  shellStore: {
    load: () =>
      Promise.resolve({
        lastHueAreaId: "area-1",
        lastHueBridge: "192.168.1.2",
        credentialStorageBackend: "keychain",
      }),
  },
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ZONE_A: HueZone = {
  id: "zone-a",
  name: "Sofa",
  entertainmentAreaId: "area-1",
  centerX: 0,
  centerY: 0,
  centerZ: 0,
  scaleX: 0.3,
  scaleY: 0.3,
  scaleZ: 0.3,
  channelIndices: [],
  borderColor: "#3b82f6",
};

const CHANNEL_0: HueChannelPlacement = { channelIndex: 0, x: 0, y: 0, z: 0 };

function applied(zones: HueZone[], channels: HueChannelPlacement[] = []): HueZoneCommandResult {
  return { status: { code: "HUE_ZONE_UPDATED", message: "ok", details: null }, zones, channels };
}

function refused(
  code: HueZoneCommandResult["status"]["code"],
  zones: HueZone[],
  channels: HueChannelPlacement[] = [],
): HueZoneCommandResult {
  return { status: { code, message: "refused", details: null }, zones, channels };
}

function renderZones(config: Partial<RoomMapConfig> = {}) {
  const updateConfig = vi.fn().mockResolvedValue(undefined);
  const hook = renderHook(() =>
    useRoomMapHueZones({
      config: { ...DEFAULT_ROOM_MAP, zones: [ZONE_A], hueChannels: [CHANNEL_0], ...config },
      updateConfig,
      setSelectedId: vi.fn(),
      setObjectPanelOpen: vi.fn(),
    }),
  );
  return { ...hook, updateConfig };
}

beforeEach(() => {
  for (const m of [mockCreate, mockUpdate, mockDelete, mockAssign]) m.mockReset();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

// ---------------------------------------------------------------------------
// The pre-image contract
// ---------------------------------------------------------------------------

describe("useRoomMapHueZones — pre-mutation payloads", () => {
  it("sends the untouched zone list on update, not the optimistic one", async () => {
    mockUpdate.mockResolvedValue(applied([ZONE_A]));
    const { result } = renderZones();

    act(() => result.current.handleHueZoneUpdate("zone-a", { scaleX: 0.4 }));

    await waitFor(() => expect(mockUpdate).toHaveBeenCalledTimes(1));
    const payload = mockUpdate.mock.calls[0][0];
    // The draft travels in `zone`; `existingZones` must still hold the old value,
    // or a refusal echoes back the state it just refused.
    expect(payload.zone.scaleX).toBe(0.4);
    expect(payload.existingZones).toEqual([ZONE_A]);
  });

  it("sends the untouched lists on assign, which is what re-arms the channel cap", async () => {
    mockAssign.mockResolvedValue(applied([ZONE_A], [CHANNEL_0]));
    const { result } = renderZones();

    act(() => result.current.handleAssignChannelToZone(0, "zone-a"));

    await waitFor(() => expect(mockAssign).toHaveBeenCalledTimes(1));
    const payload = mockAssign.mock.calls[0][0];
    // With the optimistic list the backend saw the channel already present,
    // so `already_in_zone` was always true and the cap check never ran.
    expect(payload.existingZones[0].channelIndices).toEqual([]);
    expect(payload.channels[0].zoneId).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

describe("useRoomMapHueZones — a refusal is a resolved promise", () => {
  it("restores the backend pre-image and records the code when an update is refused", async () => {
    mockUpdate.mockResolvedValue(refused("HUE_ZONE_OVERSIZED", [ZONE_A]));
    const { result, updateConfig } = renderZones();

    act(() => result.current.handleHueZoneUpdate("zone-a", { scaleX: 2 }));

    await waitFor(() => expect(result.current.hueZoneRejection).toBe("HUE_ZONE_OVERSIZED"));
    // First write is the optimistic edit, second is the reconciliation.
    expect(updateConfig).toHaveBeenCalledTimes(2);
    expect(updateConfig.mock.calls[0][0].zones[0].scaleX).toBe(2);
    expect(updateConfig.mock.calls[1][0]).toEqual({ zones: [ZONE_A] });
  });

  it("leaves state alone and reports nothing when the mutation is applied", async () => {
    mockUpdate.mockResolvedValue(applied([{ ...ZONE_A, scaleX: 0.4 }]));
    const { result, updateConfig } = renderZones();

    act(() => result.current.handleHueZoneUpdate("zone-a", { scaleX: 0.4 }));

    await waitFor(() => expect(mockUpdate).toHaveBeenCalledTimes(1));
    expect(result.current.hueZoneRejection).toBeNull();
    expect(updateConfig).toHaveBeenCalledTimes(1);
  });

  it("restores channels too when an assign is refused", async () => {
    mockAssign.mockResolvedValue(refused("HUE_ZONE_LIMIT_REACHED", [ZONE_A], [CHANNEL_0]));
    const { result, updateConfig } = renderZones();

    act(() => result.current.handleAssignChannelToZone(0, "zone-a"));

    await waitFor(() => expect(result.current.hueZoneRejection).toBe("HUE_ZONE_LIMIT_REACHED"));
    expect(updateConfig.mock.calls[1][0]).toEqual({ zones: [ZONE_A], hueChannels: [CHANNEL_0] });
  });

  it("does not write back the empty channel list a zone-only command returns", async () => {
    mockUpdate.mockResolvedValue(refused("HUE_ZONE_OVERSIZED", [ZONE_A], []));
    const { result, updateConfig } = renderZones();

    act(() => result.current.handleHueZoneUpdate("zone-a", { scaleX: 2 }));

    await waitFor(() => expect(updateConfig).toHaveBeenCalledTimes(2));
    // `update_hue_zone` always returns `channels: []`; writing that back would
    // erase every placement on the map.
    expect(updateConfig.mock.calls[1][0]).not.toHaveProperty("hueChannels");
  });

  it("drops the selection when the zone that was just created is refused", async () => {
    mockCreate.mockResolvedValue(refused("HUE_ZONE_OVERSIZED", [ZONE_A]));
    const { result } = renderZones();

    await waitFor(() => expect(result.current.hueAreaId).toBe("area-1"));
    act(() => result.current.handleAddHueZone());

    await waitFor(() => expect(result.current.hueZoneRejection).toBe("HUE_ZONE_OVERSIZED"));
    expect(result.current.activeHueZoneId).toBeNull();
  });

  it("clears the rejection on dismiss", async () => {
    mockUpdate.mockResolvedValue(refused("HUE_ZONE_NOT_FOUND", [ZONE_A]));
    const { result } = renderZones();

    act(() => result.current.handleHueZoneUpdate("zone-a", { scaleX: 2 }));
    await waitFor(() => expect(result.current.hueZoneRejection).toBe("HUE_ZONE_NOT_FOUND"));

    act(() => result.current.dismissHueZoneRejection());
    expect(result.current.hueZoneRejection).toBeNull();
  });

  it("still reports a transport rejection without touching config", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    mockUpdate.mockRejectedValue(new Error("ipc down"));
    const { result, updateConfig } = renderZones();

    act(() => result.current.handleHueZoneUpdate("zone-a", { scaleX: 0.4 }));

    await waitFor(() => expect(err).toHaveBeenCalled());
    expect(result.current.hueZoneRejection).toBeNull();
    expect(updateConfig).toHaveBeenCalledTimes(1);
  });
});
