import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { HUE_STATUS } from "@/shared/contracts/hue";

import type { HueStartConfig } from "../../model/hueStartConfig";
import { useHueBridgeReachability } from "../useHueBridgeReachability";

const validateHueCredentialsMock = vi.fn();

vi.mock("../../hueOnboardingApi", () => ({
  validateHueCredentials: (...args: unknown[]) => validateHueCredentialsMock(...args),
}));

const config: HueStartConfig = {
  bridgeIp: "192.168.1.10",
  username: "app-user",
  clientKey: "AABBCCDD",
  areaId: "area-1",
};

const valid = { status: { code: HUE_STATUS.CREDENTIAL_VALID } };

describe("useHueBridgeReachability (INV-30)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    validateHueCredentialsMock.mockResolvedValue(valid);
  });

  it("does not poll without a paired bridge", () => {
    const { result } = renderHook(() => useHueBridgeReachability(null, false));
    expect(validateHueCredentialsMock).not.toHaveBeenCalled();
    expect(result.current.reachable).toBe(false);
  });

  it("does not poll while the stream is live — the stream is its own proof", () => {
    renderHook(() => useHueBridgeReachability(config, true));
    expect(validateHueCredentialsMock).not.toHaveBeenCalled();
  });

  it("ticks immediately on mount and reports a valid credential as reachable", async () => {
    const { result } = renderHook(() => useHueBridgeReachability(config, false));
    await waitFor(() => expect(result.current.reachable).toBe(true));
    expect(validateHueCredentialsMock).toHaveBeenCalledWith(
      "192.168.1.10",
      "app-user",
      "AABBCCDD",
    );
  });

  it("reports unreachable when the bridge answers with a non-valid code", async () => {
    validateHueCredentialsMock.mockResolvedValue({ status: { code: "HUE_CREDENTIAL_INVALID" } });
    const { result } = renderHook(() => useHueBridgeReachability(config, false));
    await waitFor(() => expect(validateHueCredentialsMock).toHaveBeenCalled());
    expect(result.current.reachable).toBe(false);
  });

  it("reports unreachable when the probe rejects", async () => {
    validateHueCredentialsMock.mockRejectedValue(new Error("network down"));
    const { result } = renderHook(() => useHueBridgeReachability(config, false));
    await waitFor(() => expect(validateHueCredentialsMock).toHaveBeenCalled());
    expect(result.current.reachable).toBe(false);
  });

  it("skips the mount tick while the window is hidden and catches up when it returns", async () => {
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    renderHook(() => useHueBridgeReachability(config, false));
    expect(validateHueCredentialsMock).not.toHaveBeenCalled();

    visibility.mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    await waitFor(() => expect(validateHueCredentialsMock).toHaveBeenCalledOnce());
    visibility.mockRestore();
  });

  it("stops probing once unmounted", async () => {
    const { unmount } = renderHook(() => useHueBridgeReachability(config, false));
    await waitFor(() => expect(validateHueCredentialsMock).toHaveBeenCalledOnce());
    unmount();
    document.dispatchEvent(new Event("visibilitychange"));
    expect(validateHueCredentialsMock).toHaveBeenCalledOnce();
  });
});
