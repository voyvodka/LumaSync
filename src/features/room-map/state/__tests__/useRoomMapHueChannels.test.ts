import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HUE_AREA_CHANNELS_STATUS } from "@/shared/contracts/hue";
import type { HueAreaChannelInfo } from "@/shared/contracts/hue";
import { DEFAULT_ROOM_MAP, type RoomMapConfig } from "@/shared/contracts/roomMap";

import { useRoomMapHueChannels } from "../useRoomMapHueChannels";

const shellLoadMock = vi.fn();
const getAreaChannelsMock = vi.fn();

vi.mock("@/features/persistence/shellStore", () => ({
  shellStore: { load: () => shellLoadMock() },
}));

vi.mock("@/features/hue/hueOnboardingApi", () => ({
  getHueAreaChannels: (...args: unknown[]) => getAreaChannelsMock(...args),
}));

/** Gapped bridge ids — an ordinal substituted anywhere shows up as a wrong id. */
const CHANNELS: HueAreaChannelInfo[] = [0, 2, 5].map((channelId, i) => ({
  index: i,
  channelId,
  lightIds: [`light-${channelId}`],
  positionX: i - 1,
  positionY: 0,
  lightCount: 2,
  autoRegion: "center",
}));

function response(code: string, channels: HueAreaChannelInfo[] = []) {
  return { status: { code, message: `stub ${code}`, details: null }, channels };
}

function config(overrides: Partial<RoomMapConfig> = {}): RoomMapConfig {
  return { ...DEFAULT_ROOM_MAP, ...overrides };
}

function args(overrides: Record<string, unknown> = {}) {
  return {
    config: config(),
    adoptConfig: vi.fn().mockResolvedValue(undefined),
    hueAreaId: "area-1",
    hueBridgeConfigured: true,
    ready: true,
    ...overrides,
  } as Parameters<typeof useRoomMapHueChannels>[0] & { adoptConfig: ReturnType<typeof vi.fn> };
}

describe("useRoomMapHueChannels", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    shellLoadMock.mockResolvedValue({ lastHueBridge: { ip: "192.168.1.20" }, hueAppKey: "" });
    getAreaChannelsMock.mockResolvedValue(response(HUE_AREA_CHANNELS_STATUS.OK, CHANNELS));
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fetches the area's channels without any Devices surface being open", async () => {
    const a = args();
    renderHook(() => useRoomMapHueChannels(a));

    await waitFor(() => expect(getAreaChannelsMock).toHaveBeenCalledTimes(1));
    expect(getAreaChannelsMock).toHaveBeenCalledWith("192.168.1.20", "", "area-1");
  });

  it("seeds a placement per live channel, stamped with the area and the bridge id", async () => {
    const a = args();
    renderHook(() => useRoomMapHueChannels(a));

    await waitFor(() => expect(a.adoptConfig).toHaveBeenCalled());
    const written = a.adoptConfig.mock.calls[0]![0].hueChannels;
    expect(written).toEqual([
      expect.objectContaining({ channelIndex: 0, channelId: 0, entertainmentAreaId: "area-1" }),
      expect.objectContaining({ channelIndex: 1, channelId: 2, entertainmentAreaId: "area-1" }),
      expect.objectContaining({ channelIndex: 2, channelId: 5, entertainmentAreaId: "area-1" }),
    ]);
  });

  it("merges rather than assigns, so another area's placements survive", async () => {
    const other = { channelIndex: 0, channelId: 9, entertainmentAreaId: "area-2", x: 0, y: 0, z: 0 };
    const a = args({ config: config({ hueChannels: [other] }) });
    renderHook(() => useRoomMapHueChannels(a));

    await waitFor(() => expect(a.adoptConfig).toHaveBeenCalled());
    const written = a.adoptConfig.mock.calls[0]![0].hueChannels;
    expect(written).toContainEqual(other);
    expect(written).toHaveLength(4);
  });

  it("writes nothing when the store already matches the bridge", async () => {
    const stored = CHANNELS.map((ch) => ({
      channelIndex: ch.index,
      channelId: ch.channelId,
      entertainmentAreaId: "area-1",
      x: ch.positionX,
      y: ch.positionY,
      z: 0,
    }));
    const a = args({ config: config({ hueChannels: stored }) });
    renderHook(() => useRoomMapHueChannels(a));

    await waitFor(() => expect(getAreaChannelsMock).toHaveBeenCalled());
    expect(a.adoptConfig).not.toHaveBeenCalled();
  });

  it("does not seed into the default map while the persisted one is still loading", async () => {
    const a = args({ ready: false });
    renderHook(() => useRoomMapHueChannels(a));

    await waitFor(() => expect(getAreaChannelsMock).toHaveBeenCalled());
    expect(a.adoptConfig).not.toHaveBeenCalled();
  });

  it("keeps the last known list when the bridge stops answering", async () => {
    const { result } = renderHook(() => useRoomMapHueChannels(args()));
    await waitFor(() => expect(result.current.liveChannelIds.size).toBe(3));

    getAreaChannelsMock.mockResolvedValue(response(HUE_AREA_CHANNELS_STATUS.UNREACHABLE));
    act(() => {
      result.current.refreshChannels();
    });
    await waitFor(() =>
      expect(result.current.channelsStatus).toBe(HUE_AREA_CHANNELS_STATUS.UNREACHABLE),
    );

    // Still three. Emptying here would mark every placement on the map a ghost
    // on a Wi-Fi blip — the same invariant the Devices list carries.
    expect(result.current.liveChannelIds.size).toBe(3);
  });

  it("exposes the bridge ids, so a placement outside them can be told apart", async () => {
    const { result } = renderHook(() => useRoomMapHueChannels(args()));

    await waitFor(() => expect(result.current.liveChannelIds.size).toBe(3));
    expect([...result.current.liveChannelIds].sort((a, b) => a - b)).toEqual([0, 2, 5]);
  });

  it("leaves the id set empty before the first answer, so nothing reads as a ghost", () => {
    getAreaChannelsMock.mockReturnValue(new Promise(() => {}));
    const { result } = renderHook(() => useRoomMapHueChannels(args()));
    expect(result.current.liveChannelIds.size).toBe(0);
  });

  it("does not touch the bridge when none is configured", async () => {
    const a = args({ hueBridgeConfigured: false });
    const { result } = renderHook(() => useRoomMapHueChannels(a));

    await waitFor(() => expect(result.current.channelsStatus).toBeNull());
    expect(getAreaChannelsMock).not.toHaveBeenCalled();
  });

  it("re-reads on demand, which is what makes a ghost resolvable", async () => {
    const { result } = renderHook(() => useRoomMapHueChannels(args()));
    await waitFor(() => expect(getAreaChannelsMock).toHaveBeenCalledTimes(1));

    result.current.refreshChannels();

    await waitFor(() => expect(getAreaChannelsMock).toHaveBeenCalledTimes(2));
  });

  it("reports a rejected fetch as a failure rather than an empty area", async () => {
    getAreaChannelsMock.mockRejectedValue(new Error("ipc closed"));
    const { result } = renderHook(() => useRoomMapHueChannels(args()));

    await waitFor(() =>
      expect(result.current.channelsStatus).toBe(HUE_AREA_CHANNELS_STATUS.FAILED),
    );
  });
});
