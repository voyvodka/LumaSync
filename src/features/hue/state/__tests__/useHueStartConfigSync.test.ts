import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { hueCredentialEvents } from "../../hueCredentialEvents";
import { useHueStartConfigSync } from "../useHueStartConfigSync";

const loadMock = vi.fn();

vi.mock("@/features/persistence/shellStore", () => ({
  shellStore: {
    load: () => loadMock(),
  },
}));

const PAIRED = {
  lastHueBridge: { ip: "192.168.1.10" },
  hueAppKey: "app-user",
  hueClientKey: "AABBCCDD",
  lastHueAreaId: "area-1",
};

describe("useHueStartConfigSync", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loadMock.mockResolvedValue(PAIRED);
  });

  it("re-projects the stored pairing when one is announced", async () => {
    const setConfig = vi.fn();
    renderHook(() => useHueStartConfigSync(setConfig));

    act(() => hueCredentialEvents.emit({ reason: "paired" }));

    await waitFor(() =>
      expect(setConfig).toHaveBeenCalledWith({
        bridgeIp: "192.168.1.10",
        username: "app-user",
        clientKey: "AABBCCDD",
        areaId: "area-1",
      }),
    );
  });

  it("projects null when the area selection is cleared", async () => {
    loadMock.mockResolvedValue({ ...PAIRED, lastHueAreaId: undefined });
    const setConfig = vi.fn();
    renderHook(() => useHueStartConfigSync(setConfig));

    act(() => hueCredentialEvents.emit({ reason: "area-selected" }));

    await waitFor(() => expect(setConfig).toHaveBeenCalledWith(null));
  });

  it("stops listening once unmounted", async () => {
    const setConfig = vi.fn();
    const { unmount } = renderHook(() => useHueStartConfigSync(setConfig));
    unmount();

    act(() => hueCredentialEvents.emit({ reason: "paired" }));

    await Promise.resolve();
    expect(loadMock).not.toHaveBeenCalled();
  });

  it("survives a failed read rather than tearing down the subscription", async () => {
    loadMock.mockRejectedValueOnce(new Error("store unavailable"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const setConfig = vi.fn();
    renderHook(() => useHueStartConfigSync(setConfig));

    act(() => hueCredentialEvents.emit({ reason: "paired" }));
    await waitFor(() => expect(errorSpy).toHaveBeenCalled());
    expect(setConfig).not.toHaveBeenCalled();

    act(() => hueCredentialEvents.emit({ reason: "paired" }));
    await waitFor(() => expect(setConfig).toHaveBeenCalledTimes(1));

    errorSpy.mockRestore();
  });
});
