// Split from `useHueBridgeReachability.test.ts`: these cases need fake timers
// and that file's `waitFor` assertions need real ones.
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HUE_STATUS } from "@/shared/contracts/hue";

import type { HueStartConfig } from "../../model/hueStartConfig";
import { HUE_BRIDGE_REACHABILITY_POLL_MS } from "../../model/pollingCadence";
import { requestHuePollRestart } from "../huePollRestart";
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

const valid = { status: { code: HUE_STATUS.CREDENTIAL_VALID }, valid: true };
const unreachable = { status: { code: HUE_STATUS.CREDENTIAL_CHECK_FAILED }, valid: false };

const advance = async (ms: number) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

describe("useHueBridgeReachability — give up and retry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(0);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    validateHueCredentialsMock.mockResolvedValue(unreachable);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("stops polling once the failure budget is spent", async () => {
    const { result } = renderHook(() => useHueBridgeReachability(config, false));
    await advance(0);
    expect(validateHueCredentialsMock).toHaveBeenCalledOnce();

    // Ticks at 0 / 30 / 60 / 90 s — the fourth spends the budget.
    await advance(HUE_BRIDGE_REACHABILITY_POLL_MS * 3);
    expect(validateHueCredentialsMock).toHaveBeenCalledTimes(4);
    expect(result.current.gaveUp).toBe(true);
    expect(result.current.reachable).toBe(false);

    // Ten more cadences: nothing is scheduled any more.
    await advance(HUE_BRIDGE_REACHABILITY_POLL_MS * 10);
    expect(validateHueCredentialsMock).toHaveBeenCalledTimes(4);
  });

  it("a success in between resets the streak, so it keeps polling", async () => {
    validateHueCredentialsMock
      .mockResolvedValueOnce(unreachable)
      .mockResolvedValueOnce(unreachable)
      .mockResolvedValueOnce(valid)
      .mockResolvedValue(unreachable);

    const { result } = renderHook(() => useHueBridgeReachability(config, false));
    await advance(0);
    // Ticks at 0 / 30 / 60 / 90 / 120 / 150 s. Without the reset the third
    // tick's success would leave the streak intact and the loop would have
    // stopped at the 120 s tick, five calls in.
    await advance(HUE_BRIDGE_REACHABILITY_POLL_MS * 5);
    expect(validateHueCredentialsMock).toHaveBeenCalledTimes(6);
    expect(result.current.gaveUp).toBe(false);
  });

  it("the manual retry re-arms the loop and clears the give-up state", async () => {
    const { result } = renderHook(() => useHueBridgeReachability(config, false));
    await advance(HUE_BRIDGE_REACHABILITY_POLL_MS * 3);
    expect(result.current.gaveUp).toBe(true);

    validateHueCredentialsMock.mockResolvedValue(valid);
    await act(async () => {
      result.current.retry();
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(validateHueCredentialsMock).toHaveBeenCalledTimes(5);
    expect(result.current.gaveUp).toBe(false);
    expect(result.current.reachable).toBe(true);
  });

  it("a retry that fails keeps the give-up flag, so the button stays on screen", async () => {
    const { result } = renderHook(() => useHueBridgeReachability(config, false));
    await advance(HUE_BRIDGE_REACHABILITY_POLL_MS * 3);
    expect(result.current.gaveUp).toBe(true);

    // The bridge is still absent. Clearing `gaveUp` on retry is what made the
    // button delete itself mid-press and leave the user with no feedback.
    await act(async () => {
      result.current.retry();
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(validateHueCredentialsMock).toHaveBeenCalledTimes(5);
    expect(result.current.gaveUp).toBe(true);
  });

  it("reports a probe in flight so the retry can render pending", async () => {
    let release: ((value: unknown) => void) | undefined;
    validateHueCredentialsMock.mockImplementationOnce(
      () => new Promise((resolve) => { release = resolve; }),
    );

    const { result } = renderHook(() => useHueBridgeReachability(config, false));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(result.current.probing).toBe(true);

    await act(async () => {
      release?.(valid);
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.probing).toBe(false);
  });

  it("a retry requested from another surface re-arms this loop too", async () => {
    const { result } = renderHook(() => useHueBridgeReachability(config, false));
    await advance(HUE_BRIDGE_REACHABILITY_POLL_MS * 3);
    expect(result.current.gaveUp).toBe(true);

    await act(async () => {
      requestHuePollRestart();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(validateHueCredentialsMock).toHaveBeenCalledTimes(5);
  });

  it("a bridge that answers with rejected credentials is not a reachability failure", async () => {
    validateHueCredentialsMock.mockResolvedValue({
      status: { code: HUE_STATUS.CREDENTIAL_INVALID },
      valid: false,
    });
    const { result } = renderHook(() => useHueBridgeReachability(config, false));
    await advance(HUE_BRIDGE_REACHABILITY_POLL_MS * 5);

    // Re-pair is the recovery path for this one, not a retry button — so the
    // loop keeps running and never reports a give-up.
    expect(result.current.gaveUp).toBe(false);
    expect(validateHueCredentialsMock).toHaveBeenCalledTimes(6);
  });
});
