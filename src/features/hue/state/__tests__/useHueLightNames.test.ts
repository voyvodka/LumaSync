import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as hueOnboardingApiModule from "../../hueOnboardingApi";
import type { HueAreaChannelInfo } from "../../hueOnboardingApi";
import { __resetHueLightNameCache, useHueLightNames } from "../useHueLightNames";

const namesMock = vi.fn<typeof hueOnboardingApiModule.getHueLightNames>();
const identifyMock = vi.fn<typeof hueOnboardingApiModule.identifyHueLights>();

vi.mock("../../hueOnboardingApi", () => ({
  getHueLightNames: (...args: Parameters<typeof namesMock>) => namesMock(...args),
  identifyHueLights: (...args: Parameters<typeof identifyMock>) => identifyMock(...args),
}));

const BRIDGE = { id: "bridge-1", ip: "192.168.1.20", name: "Bridge" };
const CREDS = { username: "", clientKey: "" };

function channels(ids: string[][]): HueAreaChannelInfo[] {
  return ids.map((lightIds, index) => ({
    index,
    channelId: index,
    lightIds,
    positionX: 0,
    positionY: 0,
    positionZ: null,
    lightCount: lightIds.length,
    autoRegion: "center",
  }));
}

const answered = (lights: Array<[string, string]>) => ({
  status: { code: "HUE_LIGHT_NAMES_OK" as const, message: "", details: null },
  lights: lights.map(([id, name]) => ({ id, name })),
});

describe("useHueLightNames", () => {
  beforeEach(() => {
    __resetHueLightNameCache();
    namesMock.mockReset();
    identifyMock.mockReset();
  });

  it("reads an area's names once and serves every later mount from the cache", async () => {
    namesMock.mockResolvedValue(answered([["light-a", "Sofa lamp"], ["light-b", "TV left"]]));
    const area = channels([["light-b"], ["light-a", "light-b"]]);

    const first = renderHook(() => useHueLightNames(BRIDGE, CREDS, area));
    await waitFor(() => expect(first.result.current.lightNames).toEqual({ "light-a": "Sofa lamp", "light-b": "TV left" }));
    expect(namesMock).toHaveBeenCalledWith(BRIDGE.ip, "", ["light-a", "light-b"]);
    first.unmount();

    const second = renderHook(() => useHueLightNames(BRIDGE, CREDS, channels([["light-a", "light-b"]])));
    expect(second.result.current.lightNames).toEqual({ "light-a": "Sofa lamp", "light-b": "TV left" });
    expect(namesMock).toHaveBeenCalledTimes(1);
  });

  it("asks again only when told to, and never while nothing is paired", async () => {
    namesMock.mockResolvedValue(answered([["light-a", "Sofa lamp"]]));
    const area = channels([["light-a"]]);

    renderHook(() => useHueLightNames(BRIDGE, null, area));
    renderHook(() => useHueLightNames(null, CREDS, area));
    expect(namesMock).not.toHaveBeenCalled();

    const { result } = renderHook(() => useHueLightNames(BRIDGE, CREDS, area));
    await waitFor(() => expect(result.current.lightNames["light-a"]).toBe("Sofa lamp"));

    namesMock.mockResolvedValue(answered([["light-a", "Reading lamp"]]));
    act(() => result.current.reloadLightNames());
    await waitFor(() => expect(result.current.lightNames["light-a"]).toBe("Reading lamp"));
    expect(namesMock).toHaveBeenCalledTimes(2);
  });

  it("caches nothing from a failed read", async () => {
    namesMock.mockResolvedValue({
      status: { code: "HUE_LIGHT_NAMES_FAILED", message: "", details: "no answer" },
      lights: [],
    });
    const area = channels([["light-a"]]);
    const first = renderHook(() => useHueLightNames(BRIDGE, CREDS, area));
    await waitFor(() => expect(namesMock).toHaveBeenCalledTimes(1));
    first.unmount();

    namesMock.mockResolvedValue(answered([["light-a", "Sofa lamp"]]));
    const second = renderHook(() => useHueLightNames(BRIDGE, CREDS, area));
    await waitFor(() => expect(second.result.current.lightNames["light-a"]).toBe("Sofa lamp"));
  });

  it("identify passes the lights through and turns a rejected invoke into a failed blink", async () => {
    identifyMock.mockResolvedValueOnce({ code: "HUE_IDENTIFY_OK", message: "", details: null });
    identifyMock.mockRejectedValueOnce(new Error("ipc torn down"));
    const { result } = renderHook(() => useHueLightNames(BRIDGE, CREDS, []));

    await expect(result.current.identifyLights(["light-a"])).resolves.toMatchObject({ code: "HUE_IDENTIFY_OK" });
    expect(identifyMock).toHaveBeenCalledWith(BRIDGE.ip, "", ["light-a"]);
    await expect(result.current.identifyLights(["light-a"])).resolves.toMatchObject({
      code: "HUE_IDENTIFY_FAILED",
      details: "ipc torn down",
    });
  });
});
