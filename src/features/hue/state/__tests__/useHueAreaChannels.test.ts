import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HUE_AREA_CHANNELS_STATUS, HUE_RUNTIME_STATUS } from "@/shared/contracts/hue";
import type {
  HueAreaChannelInfo,
  HueAreaChannelListResponse,
  HueAreaChannelsWireStatusCode,
  HueRuntimeState,
} from "@/shared/contracts/hue";
import type { HueHealthSnapshot } from "@/shared/contracts/hueHealth";

import { idleHealth, runtimeStatus } from "../../__tests__/fakeHueHealth";

import { useHueAreaChannels } from "../useHueAreaChannels";
import type * as hueHealthApiModule from "../../hueHealthApi";
import type * as hueOnboardingApiModule from "../../hueOnboardingApi";

const getAreaChannelsMock = vi.fn<typeof hueOnboardingApiModule.getHueAreaChannels>();

vi.mock("../../hueOnboardingApi", () => ({
  getHueAreaChannels: (...args: Parameters<typeof getAreaChannelsMock>) => getAreaChannelsMock(...args),
}));

// The runtime-idle check reads the health monitor's local runtime state.
const getHueHealthMock = vi.fn<typeof hueHealthApiModule.getHueHealth>();

vi.mock("../../hueHealthApi", () => ({
  getHueHealth: (...args: Parameters<typeof getHueHealthMock>) => getHueHealthMock(...args),
}));

function runtimeIn(state: HueRuntimeState): HueHealthSnapshot {
  return {
    ...idleHealth(),
    stream: { active: state !== "Idle", status: runtimeStatus(state, "HUE_STREAM_IDLE") },
  };
}

const BRIDGE = { id: "bridge-1", ip: "192.168.1.20", name: "Test Bridge" };
const CREDENTIALS = { username: "app-key", clientKey: "psk" };
const CHANNEL: HueAreaChannelInfo = {
  index: 0,
  channelId: 0,
  lightIds: ["light-0"],
  positionX: 0,
  positionY: 0,
  positionZ: null,
  lightCount: 1,
  autoRegion: "left",
};

/** The command never throws — every arm resolves with this envelope. */
function response(
  code: HueAreaChannelsWireStatusCode,
  channels: HueAreaChannelInfo[] = [],
  details: string | null = null,
): HueAreaChannelListResponse {
  return { status: { code, message: `stub ${code}`, details }, channels };
}

describe("useHueAreaChannels", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getAreaChannelsMock.mockResolvedValue(response(HUE_AREA_CHANNELS_STATUS.OK, [CHANNEL]));
    getHueHealthMock.mockResolvedValue(runtimeIn("Idle"));
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
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

  it("empties the list when the fetch reports a coded failure", async () => {
    getAreaChannelsMock.mockResolvedValue(response(HUE_AREA_CHANNELS_STATUS.FAILED));

    const { result } = renderHook(() => useHueAreaChannels(BRIDGE, CREDENTIALS, "area-1"));

    await waitFor(() => expect(result.current.isLoadingChannels).toBe(false));
    expect(result.current.areaChannels).toEqual([]);
  });

  it("keeps the last known channels when the bridge stops answering", async () => {
    // The whole point of splitting UNREACHABLE out of FAILED: an empty array on
    // that code means "no answer", not "no channels". Clearing here is what made
    // a Wi-Fi blip look like a deleted area.
    const { result, rerender } = renderHook(
      ({ areaId }: { areaId: string }) => useHueAreaChannels(BRIDGE, CREDENTIALS, areaId),
      { initialProps: { areaId: "area-1" } },
    );
    await waitFor(() => expect(result.current.areaChannels).toEqual([CHANNEL]));

    getAreaChannelsMock.mockResolvedValue(
      response(HUE_AREA_CHANNELS_STATUS.UNREACHABLE, [], "connection refused"),
    );
    rerender({ areaId: "area-2" });

    await waitFor(() => expect(result.current.isLoadingChannels).toBe(false));
    expect(result.current.areaChannels).toEqual([CHANNEL]);
  });

  it("reports a bridge 403 as the declared re-pair status, keeping the bridge's own message", async () => {
    getAreaChannelsMock.mockResolvedValue(
      response(HUE_RUNTIME_STATUS.AUTH_INVALID_RE_PAIR_REQUIRED, [], "HTTP 403 unauthorized-user"),
    );
    const onAuthInvalid = vi.fn();

    const { result } = renderHook(() =>
      useHueAreaChannels(BRIDGE, CREDENTIALS, "area-1", onAuthInvalid),
    );

    await waitFor(() => expect(onAuthInvalid).toHaveBeenCalledTimes(1));
    expect(onAuthInvalid).toHaveBeenCalledWith({
      code: HUE_RUNTIME_STATUS.AUTH_INVALID_RE_PAIR_REQUIRED,
      message: `stub ${HUE_RUNTIME_STATUS.AUTH_INVALID_RE_PAIR_REQUIRED}`,
      details: "HTTP 403 unauthorized-user",
    });
    expect(result.current.areaChannels).toEqual([]);
  });

  it("does not escalate a transient failure code to a re-pair prompt", async () => {
    getAreaChannelsMock.mockResolvedValue(
      response(HUE_AREA_CHANNELS_STATUS.FAILED, [], "bridge unreachable"),
    );
    const onAuthInvalid = vi.fn();

    const { result } = renderHook(() =>
      useHueAreaChannels(BRIDGE, CREDENTIALS, "area-1", onAuthInvalid),
    );

    await waitFor(() => expect(result.current.isLoadingChannels).toBe(false));
    expect(onAuthInvalid).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("bridge unreachable"));
  });

  it("treats an area with no channels as a success, not a failure", async () => {
    getAreaChannelsMock.mockResolvedValue(response(HUE_AREA_CHANNELS_STATUS.EMPTY));
    const onAuthInvalid = vi.fn();

    const { result } = renderHook(() =>
      useHueAreaChannels(BRIDGE, CREDENTIALS, "area-1", onAuthInvalid),
    );

    await waitFor(() => expect(result.current.isLoadingChannels).toBe(false));
    expect(result.current.areaChannels).toEqual([]);
    expect(onAuthInvalid).not.toHaveBeenCalled();
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("empties the list when the invoke layer itself rejects", async () => {
    getAreaChannelsMock.mockRejectedValue(new Error("ipc channel closed"));
    const onAuthInvalid = vi.fn();

    const { result } = renderHook(() =>
      useHueAreaChannels(BRIDGE, CREDENTIALS, "area-1", onAuthInvalid),
    );

    await waitFor(() => expect(result.current.isLoadingChannels).toBe(false));
    expect(result.current.areaChannels).toEqual([]);
    expect(onAuthInvalid).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("ipc channel closed"));
  });

  it("does not refetch when the callback identity changes every render", async () => {
    const { rerender } = renderHook(() =>
      useHueAreaChannels(BRIDGE, CREDENTIALS, "area-1", () => {}),
    );

    await waitFor(() => expect(getAreaChannelsMock).toHaveBeenCalledTimes(1));
    rerender();
    rerender();

    expect(getAreaChannelsMock).toHaveBeenCalledTimes(1);
  });

  it("surfaces the code so the surface can tell empty from unreachable", async () => {
    getAreaChannelsMock.mockResolvedValue(response(HUE_AREA_CHANNELS_STATUS.EMPTY));

    const { result } = renderHook(() => useHueAreaChannels(BRIDGE, CREDENTIALS, "area-1"));

    await waitFor(() =>
      expect(result.current.channelsStatus).toBe(HUE_AREA_CHANNELS_STATUS.EMPTY),
    );
    expect(result.current.areaChannels).toEqual([]);
  });

  it("records the unreachable code alongside the kept list", async () => {
    const { result } = renderHook(() => useHueAreaChannels(BRIDGE, CREDENTIALS, "area-1"));
    await waitFor(() => expect(result.current.areaChannels).toHaveLength(1));

    getAreaChannelsMock.mockResolvedValue(response(HUE_AREA_CHANNELS_STATUS.UNREACHABLE));
    const { result: second } = renderHook(() =>
      useHueAreaChannels(BRIDGE, CREDENTIALS, "area-2"),
    );

    await waitFor(() =>
      expect(second.current.channelsStatus).toBe(HUE_AREA_CHANNELS_STATUS.UNREACHABLE),
    );
  });

  it("reports a rejected invoke as a failure rather than an empty area", async () => {
    getAreaChannelsMock.mockRejectedValue(new Error("ipc channel closed"));

    const { result } = renderHook(() => useHueAreaChannels(BRIDGE, CREDENTIALS, "area-1"));

    await waitFor(() =>
      expect(result.current.channelsStatus).toBe(HUE_AREA_CHANNELS_STATUS.FAILED),
    );
  });

  it("clears the code when no area is selected, so a stale one cannot leak", async () => {
    const { result } = renderHook(() => useHueAreaChannels(BRIDGE, CREDENTIALS, null));

    await waitFor(() => expect(result.current.channelsStatus).toBeNull());
  });

  describe("whether the list is the bridge's own", () => {
    it("is, when the runtime was idle on both sides of the read", async () => {
      const { result } = renderHook(() => useHueAreaChannels(BRIDGE, CREDENTIALS, "area-1"));

      await waitFor(() => expect(result.current.channelsFromBridge).toBe(true));
    });

    it("is not, while lighting is on — the command answers with our placements", async () => {
      getHueHealthMock.mockResolvedValue(runtimeIn("Running"));
      const { result } = renderHook(() => useHueAreaChannels(BRIDGE, CREDENTIALS, "area-1"));

      await waitFor(() => expect(result.current.areaChannels).toEqual([CHANNEL]));
      expect(result.current.channelsFromBridge).toBe(false);
    });

    it("is not, when a stream started while the read was in flight", async () => {
      getHueHealthMock
        .mockResolvedValueOnce(runtimeIn("Idle"))
        .mockResolvedValueOnce(runtimeIn("Running"));
      const { result } = renderHook(() => useHueAreaChannels(BRIDGE, CREDENTIALS, "area-1"));

      await waitFor(() => expect(result.current.areaChannels).toEqual([CHANNEL]));
      expect(result.current.channelsFromBridge).toBe(false);
    });

    it("is not, when the runtime state cannot be read", async () => {
      getHueHealthMock.mockRejectedValue({ code: "IPC", message: "torn down" });
      const { result } = renderHook(() => useHueAreaChannels(BRIDGE, CREDENTIALS, "area-1"));

      await waitFor(() => expect(result.current.areaChannels).toEqual([CHANNEL]));
      expect(result.current.channelsFromBridge).toBe(false);
      expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("torn down"));
    });

    it("hands the caller of a refresh the read it asked for", async () => {
      const { result } = renderHook(() => useHueAreaChannels(BRIDGE, CREDENTIALS, "area-1"));
      await waitFor(() => expect(result.current.isLoadingChannels).toBe(false));
      const moved = { ...CHANNEL, positionX: 0.4 };
      getAreaChannelsMock.mockResolvedValue(response(HUE_AREA_CHANNELS_STATUS.OK, [moved]));

      let read: unknown;
      act(() => {
        void result.current.refreshChannels().then((r) => {
          read = r;
        });
      });

      await waitFor(() =>
        expect(read).toEqual({
          status: HUE_AREA_CHANNELS_STATUS.OK,
          channels: [moved],
          fromBridge: true,
        }),
      );
    });
  });
});
