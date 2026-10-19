import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_ROOM_MAP } from "@/shared/contracts/roomMap";
import type {
  HueChannelPlacement,
  HueZone,
  HueZoneCommandResult,
  RoomMapConfig,
} from "@/shared/contracts/roomMap";
import { useRoomMapHueZones } from "../useRoomMapHueZones";
import { useRoomMapState } from "../useRoomMapState";
import type * as roomMapApiModule from "../../roomMapApi";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockCreate = vi.fn<typeof roomMapApiModule.createHueZone>();
const mockUpdate = vi.fn<typeof roomMapApiModule.updateHueZone>();
const mockDelete = vi.fn<typeof roomMapApiModule.deleteHueZone>();
const mockAssign = vi.fn<typeof roomMapApiModule.assignChannelToHueZone>();

vi.mock("../../roomMapApi", () => ({
  createHueZone: (...args: Parameters<typeof mockCreate>) => mockCreate(...args),
  updateHueZone: (...args: Parameters<typeof mockUpdate>) => mockUpdate(...args),
  deleteHueZone: (...args: Parameters<typeof mockDelete>) => mockDelete(...args),
  assignChannelToHueZone: (...args: Parameters<typeof mockAssign>) => mockAssign(...args),
}));

const SHELL = vi.hoisted(() => ({
  lastHueAreaId: "area-1",
  lastHueBridge: "192.168.1.2",
  credentialStorageBackend: "keychain",
}));
const mockShellLoad = vi.hoisted(() => vi.fn());

vi.mock("@/features/persistence/shellStore", () => ({
  shellStore: {
    load: () => mockShellLoad(),
    save: () => Promise.resolve(),
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
  // A 1.5 m cube in the 5 × 4 × 2.5 m default room.
  scaleX: 0.3,
  scaleY: 0.375,
  scaleZ: 0.6,
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
  const apply = vi.fn();
  const adopt = vi.fn();
  const hook = renderHook(() =>
    useRoomMapHueZones({
      config: { ...DEFAULT_ROOM_MAP, zones: [ZONE_A], hueChannels: [CHANNEL_0], ...config },
      apply,
      adopt,
      activeHueZoneId: null,
      selectHueZone: vi.fn(),
      hueAreaId: SHELL.lastHueAreaId,
    }),
  );
  return { ...hook, apply, adopt };
}

/** The hook wired to the real reducer, for what only shows up in its state. */
function renderZonesWithStore(stored: Partial<RoomMapConfig>) {
  mockShellLoad.mockResolvedValue({
    ...SHELL,
    roomMap: { ...DEFAULT_ROOM_MAP, ...stored },
  });
  return renderHook(() => {
    const store = useRoomMapState();
    const zones = useRoomMapHueZones({
      config: store.config,
      apply: store.apply,
      adopt: store.adopt,
      activeHueZoneId: store.activeHueZoneId,
      selectHueZone: store.selectHueZone,
      hueAreaId: SHELL.lastHueAreaId,
    });
    return { store, zones };
  });
}

beforeEach(() => {
  for (const m of [mockCreate, mockUpdate, mockDelete, mockAssign]) m.mockReset();
  mockShellLoad.mockReset();
  mockShellLoad.mockResolvedValue(SHELL);
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

// ---------------------------------------------------------------------------
// The pre-image contract
// ---------------------------------------------------------------------------

describe("useRoomMapHueZones — a light let out of its zone", () => {
  // The zone moved since the light joined it: its absolute pair is where the light stood back then.
  const moved = { ...ZONE_A, centerX: 0.5, centerY: -0.5 };
  const bound: HueChannelPlacement = {
    ...CHANNEL_0,
    entertainmentAreaId: "area-1",
    x: -0.9,
    y: 0.9,
    zoneId: "zone-a",
    zoneRelativePosition: { x: 1, y: 0, z: 0 },
  };

  it("stays where the zone had it when the zone is deleted, or it is taken out", () => {
    mockDelete.mockResolvedValue(applied([], []));
    mockAssign.mockResolvedValue(applied([moved], []));
    for (const run of [
      (r: ReturnType<typeof renderZones>["result"]) => r.current.handleDeleteHueZone("zone-a"),
      (r: ReturnType<typeof renderZones>["result"]) => r.current.handleAssignChannelToZone(0, null),
    ]) {
      const { result, apply } = renderZones({ zones: [{ ...moved, channelIndices: [0] }], hueChannels: [bound] });
      act(() => run(result));
      const light = apply.mock.calls[0][0].hueChannels[0];
      expect(light.zoneId).toBeUndefined();
      expect(light.x).toBeCloseTo(0.8);
      expect(light.y).toBeCloseTo(-0.5);
      cleanup();
    }
  });
});

describe("useRoomMapHueZones — a zone centre stepped by key", () => {
  it("is one gesture for the run, and a drag's drop is its own step", () => {
    mockUpdate.mockResolvedValue(applied([ZONE_A]));
    const { result, apply } = renderZones();
    act(() => result.current.handleHueZoneCenterChange("zone-a", 0.1, 0, true));
    act(() => result.current.handleHueZoneCenterChange("zone-a", 0.2, 0, true));
    act(() => result.current.handleHueZoneCenterChange("zone-a", 0.4, 0));
    const [first, second, dropped] = apply.mock.calls.map((call) => call[1]);
    expect(first?.gesture).toBeTruthy();
    expect(second?.gesture).toBe(first?.gesture);
    expect(dropped).toBeUndefined();
  });
});

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
    expect(payload.existingZones?.[0]?.channelIndices).toEqual([]);
    expect(payload.channels?.[0]?.zoneId).toBeUndefined();
  });
});

describe("useRoomMapHueZones — a light joining a zone from a card", () => {
  it("joins it where it stands, without moving it to the centre", async () => {
    mockAssign.mockResolvedValue(applied([ZONE_A], [CHANNEL_0]));
    const { result, apply } = renderZones({ hueChannels: [{ ...CHANNEL_0, x: 0.15, y: -0.1875, z: 0.3 }] });

    act(() => result.current.handleAssignChannelToZone(0, "zone-a"));

    expect(apply.mock.calls[0][0].hueChannels[0].zoneRelativePosition).toEqual({ x: 0.5, y: -0.5, z: 0.5 });
    await waitFor(() => expect(mockAssign).toHaveBeenCalledTimes(1));
    expect(mockAssign.mock.calls[0][0].zoneRelativePosition).toEqual({ x: 0.5, y: -0.5, z: 0.5 });
  });
});

describe("useRoomMapHueZones — a light dropped into a zone", () => {
  it("joins it where it was put down, sending that spot, and keeps what the drop changed", async () => {
    mockAssign.mockResolvedValue(applied([ZONE_A], [CHANNEL_0]));
    const { result, apply } = renderZones();
    const dropped = { ...CHANNEL_0, zOrigin: "user" as const };

    act(() => result.current.handleAssignChannelToZone(0, "zone-a", { channel: dropped, at: { x: 0.5, y: -0.25, z: 0.1 } }));

    const written = apply.mock.calls[0][0];
    expect(written.hueChannels[0]).toMatchObject({ zoneId: "zone-a", zOrigin: "user", zoneRelativePosition: { x: 0.5, y: -0.25, z: 0.1 } });
    await waitFor(() => expect(mockAssign).toHaveBeenCalledTimes(1));
    expect(mockAssign.mock.calls[0][0].zoneRelativePosition).toEqual({ x: 0.5, y: -0.25, z: 0.1 });
  });
});

// Channel 0 of another area is a different light; the index alone matched it.
describe("useRoomMapHueZones — assignment stays inside the viewed area", () => {
  it("binds the viewed area's channel and leaves the other area's channel and zones alone", async () => {
    mockAssign.mockResolvedValue(applied([ZONE_A]));
    const otherZone: HueZone = { ...ZONE_A, id: "zone-b", entertainmentAreaId: "area-2", channelIndices: [0] };
    const otherChannel: HueChannelPlacement = {
      channelIndex: 0,
      x: 0.9,
      y: 0.9,
      z: 0,
      entertainmentAreaId: "area-2",
      zoneId: "zone-b",
      zoneRelativePosition: { x: 0.5, y: 0.5, z: 0 },
    };
    const ownChannel: HueChannelPlacement = { ...CHANNEL_0, entertainmentAreaId: "area-1" };
    const { result, apply } = renderZones({
      zones: [otherZone, ZONE_A],
      hueChannels: [otherChannel, ownChannel],
    });

    act(() => result.current.handleAssignChannelToZone(0, "zone-a"));

    const written = apply.mock.calls[0][0];
    expect(written.hueChannels[0]).toEqual(otherChannel);
    expect(written.hueChannels[1]).toMatchObject({ entertainmentAreaId: "area-1", zoneId: "zone-a" });
    expect(written.zones[0].channelIndices).toEqual([0]);
    expect(written.zones[1].channelIndices).toEqual([0]);
  });

  // The light would name the zone while the zone's list, synced per area, never took the light.
  it("refuses to put the viewed area's light in another area's zone", () => {
    const otherZone: HueZone = { ...ZONE_A, id: "zone-b", entertainmentAreaId: "area-2" };
    const ownChannel: HueChannelPlacement = { ...CHANNEL_0, entertainmentAreaId: "area-1" };
    const { result, apply } = renderZones({ zones: [ZONE_A, otherZone], hueChannels: [ownChannel] });

    act(() => result.current.handleAssignChannelToZone(0, "zone-b"));

    expect(apply).not.toHaveBeenCalled();
    expect(mockAssign).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

describe("useRoomMapHueZones — a refusal is a resolved promise", () => {
  it("restores the backend pre-image and records the code when an update is refused", async () => {
    mockUpdate.mockResolvedValue(refused("HUE_ZONE_OVERSIZED", [ZONE_A]));
    const { result, apply, adopt } = renderZones();

    act(() => result.current.handleHueZoneUpdate("zone-a", { scaleX: 2 }));

    await waitFor(() => expect(result.current.hueZoneRejection).toBe("HUE_ZONE_OVERSIZED"));
    // The optimistic edit is the user's; the reconciliation is not.
    expect(apply).toHaveBeenCalledTimes(1);
    // Made a cube on the way, capped at the ceiling's 2.5 m.
    expect(apply.mock.calls[0][0].zones[0]).toMatchObject({ scaleX: 0.5, scaleY: 0.625, scaleZ: 1 });
    expect(adopt).toHaveBeenCalledTimes(1);
    expect(adopt.mock.calls[0][0]).toEqual({ zones: [ZONE_A] });
  });

  it("leaves state alone and reports nothing when the mutation is applied", async () => {
    mockUpdate.mockResolvedValue(applied([{ ...ZONE_A, scaleX: 0.4 }]));
    const { result, apply, adopt } = renderZones();

    act(() => result.current.handleHueZoneUpdate("zone-a", { scaleX: 0.4 }));

    await waitFor(() => expect(mockUpdate).toHaveBeenCalledTimes(1));
    expect(result.current.hueZoneRejection).toBeNull();
    expect(apply).toHaveBeenCalledTimes(1);
    expect(adopt).not.toHaveBeenCalled();
  });

  it("restores channels too when an assign is refused", async () => {
    mockAssign.mockResolvedValue(refused("HUE_ZONE_LIMIT_REACHED", [ZONE_A], [CHANNEL_0]));
    const { result, adopt } = renderZones();

    act(() => result.current.handleAssignChannelToZone(0, "zone-a"));

    await waitFor(() => expect(result.current.hueZoneRejection).toBe("HUE_ZONE_LIMIT_REACHED"));
    expect(adopt.mock.calls[0][0]).toEqual({ zones: [ZONE_A], hueChannels: [CHANNEL_0] });
  });

  it("does not write back the empty channel list a zone-only command returns", async () => {
    mockUpdate.mockResolvedValue(refused("HUE_ZONE_OVERSIZED", [ZONE_A], []));
    const { result, adopt } = renderZones();

    act(() => result.current.handleHueZoneUpdate("zone-a", { scaleX: 2 }));

    await waitFor(() => expect(adopt).toHaveBeenCalledTimes(1));
    // `update_hue_zone` always returns `channels: []`; writing that back would
    // erase every placement on the map.
    expect(adopt.mock.calls[0][0]).not.toHaveProperty("hueChannels");
  });

  it("drops the selection when the zone that was just created is refused", async () => {
    mockCreate.mockResolvedValue(refused("HUE_ZONE_OVERSIZED", []));
    const { result } = renderZonesWithStore({});

    await waitFor(() => expect(result.current.store.loading).toBe(false));
    act(() => result.current.zones.handleAddHueZone());
    expect(result.current.store.activeHueZoneId).not.toBeNull();

    await waitFor(() => expect(result.current.zones.hueZoneRejection).toBe("HUE_ZONE_OVERSIZED"));
    expect(result.current.store.activeHueZoneId).toBeNull();
  });

  // As an undo step the reconciliation handed Cmd+Z the very state the backend
  // refused; undo now goes back past the edit instead.
  it("keeps a refusal out of undo history", async () => {
    mockUpdate.mockResolvedValue(refused("HUE_ZONE_OVERSIZED", [ZONE_A]));
    const { result } = renderZonesWithStore({ zones: [ZONE_A] });
    await waitFor(() => expect(result.current.store.loading).toBe(false));

    act(() => result.current.zones.handleHueZoneUpdate("zone-a", { scaleX: 2 }));
    await waitFor(() => expect(result.current.zones.hueZoneRejection).toBe("HUE_ZONE_OVERSIZED"));
    expect(result.current.store.config.zones).toEqual([ZONE_A]);

    // Undo saves, and the save settles after the call returns.
    await act(async () => result.current.store.undo());
    expect(result.current.store.config.zones).toEqual([ZONE_A]);
    expect(result.current.store.canUndo).toBe(false);
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
    const { result, apply, adopt } = renderZones();

    act(() => result.current.handleHueZoneUpdate("zone-a", { scaleX: 0.4 }));

    await waitFor(() => expect(err).toHaveBeenCalled());
    expect(result.current.hueZoneRejection).toBeNull();
    expect(apply).toHaveBeenCalledTimes(1);
    expect(adopt).not.toHaveBeenCalled();
  });
});

describe("useRoomMapHueZones — drawn and resized zones", () => {
  it("makes a drawn zone a cube where it was drawn, at mid-height", async () => {
    mockCreate.mockResolvedValue(applied([]));
    const { result, apply } = renderZones();

    act(() => result.current.handleAddHueZone({ centerX: 0.4, centerY: -0.2, edge: 1.5 }));

    const zone = mockCreate.mock.calls[0]![0].zone;
    expect(zone).toMatchObject({ centerX: 0.4, centerY: -0.2, centerZ: 0, scaleX: 0.3, scaleY: 0.375, scaleZ: 0.6 });
    expect(apply).toHaveBeenCalledWith({ zones: [ZONE_A, zone] });
  });

  it("adds half the tallest cube at the room's middle by default, and keeps a drawn one inside the room", async () => {
    mockCreate.mockResolvedValue(applied([]));
    const { result } = renderZones();

    act(() => result.current.handleAddHueZone());
    act(() => result.current.handleAddHueZone({ centerX: 0.9, centerY: 0, edge: 1.5 }));

    // 1.25 m, half the room's height.
    expect(mockCreate.mock.calls[0]![0].zone).toMatchObject({ centerX: 0, centerY: 0, centerZ: 0, scaleX: 0.25, scaleY: 0.3125, scaleZ: 0.5 });
    expect(mockCreate.mock.calls[1]![0].zone.centerX).toBeCloseTo(0.7);
  });

  it("moves a zone up and down, its cube kept under the ceiling", async () => {
    mockUpdate.mockResolvedValue(applied([ZONE_A]));
    const { result } = renderZonesWithStore({ zones: [ZONE_A] });
    await waitFor(() => expect(result.current.store.loading).toBe(false));

    act(() => result.current.zones.handleHueZoneCenterChange("zone-a", ZONE_A.centerX, ZONE_A.centerY, false, 2));

    const zone = result.current.store.config.zones[0]!;
    expect(zone.centerZ).toBeCloseTo(1 - zone.scaleZ);
  });

  it("resizes from the bottom, its top coming down to it", async () => {
    mockUpdate.mockResolvedValue(applied([ZONE_A]));
    const { result } = renderZonesWithStore({ zones: [{ ...ZONE_A, scaleX: 0.25, scaleY: 0.3125, scaleZ: 0.5 }] });
    await waitFor(() => expect(result.current.store.loading).toBe(false));

    // From 1.25 m to 0.75 m, its bottom kept at -0.5.
    act(() => result.current.zones.handleHueZoneResize("zone-a", { centerX: 0, centerY: 0, edge: 0.75 }));
    expect(result.current.store.config.zones[0]!.centerZ).toBeCloseTo(-0.2);
  });

  it("writes each resize as its own undo step", async () => {
    mockUpdate.mockResolvedValue(applied([ZONE_A]));
    const { result } = renderZonesWithStore({ zones: [ZONE_A] });
    await waitFor(() => expect(result.current.store.loading).toBe(false));

    act(() => result.current.zones.handleHueZoneResize("zone-a", { centerX: 0.1, centerY: 0, edge: 2 }));
    act(() => result.current.zones.handleHueZoneResize("zone-a", { centerX: 0.2, centerY: 0, edge: 2.5 }));
    expect(result.current.store.config.zones[0]).toMatchObject({ scaleX: 0.5, scaleY: 0.625, scaleZ: 1 });

    await act(async () => result.current.store.undo());
    expect(result.current.store.config.zones[0]!.scaleX).toBe(0.4);
  });
});
