import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { HueAreaChannelInfo } from "@/features/hue/hueOnboardingApi";

import { __resetHueLampFamilyCache, useHueLampFamilies } from "../useHueLampFamilies";

const api = vi.hoisted(() => ({
  names: vi.fn<(ip: string, key: string, ids: string[]) => Promise<unknown>>(),
}));

vi.mock("@/features/hue/hueOnboardingApi", () => ({
  getHueLightNames: (ip: string, key: string, ids: string[]) => api.names(ip, key, ids),
}));

vi.mock("@/features/persistence/shellStore", () => ({
  shellStore: { load: () => Promise.resolve({ lastHueBridge: { ip: "192.168.1.20" }, hueAppKey: "" }) },
}));

const channels: HueAreaChannelInfo[] = [
  { index: 0, channelId: 0, lightIds: ["play"], positionX: 0, positionY: 0, positionZ: null, lightCount: 1, autoRegion: "center" },
  { index: 1, channelId: 1, lightIds: ["bulb"], positionX: 0, positionY: 0, positionZ: null, lightCount: 1, autoRegion: "center" },
] as HueAreaChannelInfo[];

const answered = {
  status: { code: "HUE_LIGHT_NAMES_OK", message: "", details: null },
  lights: [
    { id: "play", name: "Play", archetype: "hue_play" },
    { id: "bulb", name: "Bulb", archetype: null },
  ],
};

describe("useHueLampFamilies", () => {
  beforeEach(() => {
    __resetHueLampFamilyCache();
    api.names.mockReset();
    api.names.mockResolvedValue(answered);
  });

  it("asks the bridge nothing while the 3D room is closed", async () => {
    const { result } = renderHook(() => useHueLampFamilies(channels, false));
    await Promise.resolve();
    expect(api.names).not.toHaveBeenCalled();
    expect(result.current.size).toBe(0);
  });

  it("reads the shapes once when the room opens, and serves a second mount from the cache", async () => {
    const first = renderHook(() => useHueLampFamilies(channels, true));
    await waitFor(() => expect(first.result.current.get(0)).toBe("playBar"));
    expect(first.result.current.get(1)).toBe("bulb");
    expect(api.names).toHaveBeenCalledTimes(1);
    expect(api.names).toHaveBeenCalledWith("192.168.1.20", "", ["bulb", "play"]);

    const second = renderHook(() => useHueLampFamilies(channels, true));
    await waitFor(() => expect(second.result.current.get(0)).toBe("playBar"));
    expect(api.names).toHaveBeenCalledTimes(1);
  });
});
