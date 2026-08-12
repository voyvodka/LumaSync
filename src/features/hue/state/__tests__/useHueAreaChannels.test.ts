import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useHueAreaChannels } from "../useHueAreaChannels";

const shellLoadMock = vi.fn();
const shellSaveMock = vi.fn();
const getAreaChannelsMock = vi.fn();

vi.mock("@/features/persistence/shellStore", () => ({
  shellStore: {
    load: () => shellLoadMock(),
    save: (...args: unknown[]) => shellSaveMock(...args),
  },
}));

vi.mock("../../hueOnboardingApi", () => ({
  getHueAreaChannels: (...args: unknown[]) => getAreaChannelsMock(...args),
}));

const BRIDGE = { id: "bridge-1", ip: "192.168.1.20", name: "Test Bridge" };
const CREDENTIALS = { username: "app-key", clientKey: "psk" };

describe("useHueAreaChannels", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    shellLoadMock.mockResolvedValue({});
    shellSaveMock.mockResolvedValue(undefined);
    getAreaChannelsMock.mockResolvedValue([
      { index: 0, positionX: 0, positionY: 0, lightCount: 1, autoRegion: "left" },
    ]);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("loads channels for the selected area", async () => {
    const { result } = renderHook(() => useHueAreaChannels(BRIDGE, CREDENTIALS, "area-1"));

    await waitFor(() => expect(result.current.areaChannels).toHaveLength(1));
    expect(getAreaChannelsMock).toHaveBeenCalledWith(BRIDGE.ip, CREDENTIALS.username, "area-1");
    expect(result.current.isLoadingChannels).toBe(false);
  });

  it("clears the channel list and issues no request without an area", async () => {
    const { result } = renderHook(() => useHueAreaChannels(BRIDGE, CREDENTIALS, null));

    await waitFor(() => expect(result.current.areaChannels).toEqual([]));
    expect(getAreaChannelsMock).not.toHaveBeenCalled();
  });

  it("empties the list when the channel request rejects", async () => {
    getAreaChannelsMock.mockRejectedValue(new Error("bridge unreachable"));

    const { result } = renderHook(() => useHueAreaChannels(BRIDGE, CREDENTIALS, "area-1"));

    await waitFor(() => expect(result.current.isLoadingChannels).toBe(false));
    expect(result.current.areaChannels).toEqual([]);
  });

  it("hydrates overrides for the selected area from the store", async () => {
    shellLoadMock.mockResolvedValue({ hueChannelRegionOverrides: { "area-1": { 0: "top" } } });

    const { result } = renderHook(() => useHueAreaChannels(BRIDGE, CREDENTIALS, "area-1"));

    await waitFor(() => expect(result.current.channelRegionOverrides).toEqual({ 0: "top" }));
  });

  it("persists an added override under its area key", async () => {
    const { result } = renderHook(() => useHueAreaChannels(BRIDGE, CREDENTIALS, "area-1"));
    await waitFor(() => expect(getAreaChannelsMock).toHaveBeenCalled());

    act(() => {
      result.current.setChannelRegion(0, "top");
    });

    expect(result.current.channelRegionOverrides).toEqual({ 0: "top" });
    await waitFor(() =>
      expect(shellSaveMock).toHaveBeenCalledWith({ hueChannelRegionOverrides: { "area-1": { 0: "top" } } }),
    );
  });

  it("drops the area key entirely once its last override is removed", async () => {
    shellLoadMock.mockResolvedValue({
      hueChannelRegionOverrides: { "area-1": { 0: "top" }, "area-2": { 1: "left" } },
    });

    const { result } = renderHook(() => useHueAreaChannels(BRIDGE, CREDENTIALS, "area-1"));
    await waitFor(() => expect(result.current.channelRegionOverrides).toEqual({ 0: "top" }));

    act(() => {
      result.current.setChannelRegion(0, null);
    });

    expect(result.current.channelRegionOverrides).toEqual({});
    await waitFor(() =>
      expect(shellSaveMock).toHaveBeenCalledWith({
        hueChannelRegionOverrides: { "area-2": { 1: "left" } },
      }),
    );
  });

  it("ignores an override write while no area is selected", () => {
    const { result } = renderHook(() => useHueAreaChannels(BRIDGE, CREDENTIALS, null));

    act(() => {
      result.current.setChannelRegion(0, "top");
    });

    expect(result.current.channelRegionOverrides).toEqual({});
    expect(shellSaveMock).not.toHaveBeenCalled();
  });
});
