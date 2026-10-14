import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useRoomMapHueArea } from "../useRoomMapHueArea";

const mockShellLoad = vi.hoisted(() => vi.fn<() => Promise<Record<string, unknown>>>());

vi.mock("@/features/persistence/shellStore", () => ({
  shellStore: { load: () => mockShellLoad() },
}));

beforeEach(() => {
  mockShellLoad.mockReset();
});

describe("useRoomMapHueArea", () => {
  it("reads the last area and a keychain-paired bridge", async () => {
    mockShellLoad.mockResolvedValue({
      lastHueAreaId: "area-1",
      lastHueBridge: { ip: "192.168.1.2" },
      credentialStorageBackend: "keychain",
    });
    const { result } = renderHook(() => useRoomMapHueArea());

    expect(result.current).toEqual({ hueAreaId: null, hueBridgeConfigured: false });
    await waitFor(() => expect(result.current).toEqual({ hueAreaId: "area-1", hueBridgeConfigured: true }));
  });

  it("counts a legacy plaintext key as paired, and no bridge as not", async () => {
    mockShellLoad.mockResolvedValue({ lastHueBridge: { ip: "192.168.1.2" }, hueAppKey: "legacy" });
    const legacy = renderHook(() => useRoomMapHueArea());
    await waitFor(() => expect(legacy.result.current.hueBridgeConfigured).toBe(true));
    expect(legacy.result.current.hueAreaId).toBeNull();

    mockShellLoad.mockResolvedValue({ lastHueAreaId: "area-1", credentialStorageBackend: "keychain" });
    const bridgeless = renderHook(() => useRoomMapHueArea());
    await waitFor(() => expect(bridgeless.result.current.hueAreaId).toBe("area-1"));
    expect(bridgeless.result.current.hueBridgeConfigured).toBe(false);
  });

  it("logs a failed read and stays unbound", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockShellLoad.mockRejectedValue(new Error("disk"));
    const { result } = renderHook(() => useRoomMapHueArea());

    await waitFor(() => expect(warn).toHaveBeenCalledWith(expect.stringContaining("Room map Hue area not read")));
    expect(result.current).toEqual({ hueAreaId: null, hueBridgeConfigured: false });
    warn.mockRestore();
  });
});
