import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { HueStartConfig } from "../../model/hueStartConfig";
import { __resetHueHealthStoreForTests } from "../hueHealthStore";
import { useHueBridgeReachability } from "../useHueBridgeReachability";
import { fakeHueHealthApi, publishHealth, resetHealth, setHealth } from "../../__tests__/fakeHueHealth";

vi.mock("../../hueHealthApi", async () => (await import("../../__tests__/fakeHueHealth")).fakeHueHealthApi);

const config: HueStartConfig = {
  bridgeIp: "192.168.1.10",
  username: "app-user",
  clientKey: "AABBCCDD",
  areaId: "area-1",
};

const flush = async () => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
};

// The probe itself, its 30 s cadence, its give-up budget and the retry's
// re-arm are Rust's (`commands/hue/health.rs`, tested there). This hook only
// reads the verdict and keeps the frontend's own masking.
describe("useHueBridgeReachability (INV-30)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    __resetHueHealthStoreForTests();
    resetHealth();
  });

  afterEach(() => {
    __resetHueHealthStoreForTests();
    vi.useRealTimers();
  });

  it("reports nothing without a paired bridge, whatever the snapshot holds", async () => {
    setHealth({ bridge: { verdict: "reachable", gaveUp: true, probing: true } });
    const { result } = renderHook(() => useHueBridgeReachability(null, false));
    await flush();

    expect(result.current.reachable).toBe(false);
    expect(result.current.verdict).toBeNull();
    expect(result.current.gaveUp).toBe(false);
    expect(result.current.probing).toBe(false);
  });

  it("reports a valid credential as reachable", async () => {
    const { result } = renderHook(() => useHueBridgeReachability(config, false));
    await flush();

    expect(result.current.reachable).toBe(true);
    expect(result.current.verdict).toBe("reachable");
  });

  // The Lights dock read "Not configured" for a paired bridge whose key was
  // rejected; the verdict is what lets it say "re-pair" instead.
  it("tells a rejected key apart from a bridge that never answered", async () => {
    setHealth({ bridge: { verdict: null } });
    const { result } = renderHook(() => useHueBridgeReachability(config, false));
    await flush();
    expect(result.current.verdict).toBeNull();

    for (const verdict of ["credentialRejected", "unreachable", "reachable"] as const) {
      act(() => {
        publishHealth({ bridge: { verdict } });
      });
      await flush();
      expect(result.current.verdict).toBe(verdict);
      expect(result.current.reachable).toBe(verdict === "reachable");
    }
  });

  it("offers the retry once the probe gave up, and never while the stream is live", async () => {
    setHealth({ bridge: { verdict: "unreachable", gaveUp: true } });
    const idle = renderHook(() => useHueBridgeReachability(config, false));
    const streaming = renderHook(() => useHueBridgeReachability(config, true));
    await flush();

    expect(idle.result.current.gaveUp).toBe(true);
    expect(idle.result.current.reachable).toBe(false);
    // An active stream is proof enough on its own: nothing to retry.
    expect(streaming.result.current.gaveUp).toBe(false);
    expect(streaming.result.current.verdict).toBe("unreachable");
  });

  it("sends the retry to Rust, which re-arms the probe", async () => {
    setHealth({ bridge: { verdict: "unreachable", gaveUp: true } });
    const { result } = renderHook(() => useHueBridgeReachability(config, false));
    await flush();

    act(() => result.current.retry());
    await flush();
    expect(fakeHueHealthApi.retryHueHealth).toHaveBeenCalledOnce();

    act(() => {
      publishHealth({ bridge: { probing: true } });
    });
    await flush();
    expect(result.current.probing).toBe(true);
    expect(result.current.gaveUp).toBe(true);

    act(() => {
      publishHealth({ bridge: { probing: false, gaveUp: false, verdict: "reachable" } });
    });
    await flush();
    expect(result.current.gaveUp).toBe(false);
    expect(result.current.reachable).toBe(true);
  });

  it("keeps one retry identity across renders", async () => {
    const { result, rerender } = renderHook(() => useHueBridgeReachability(config, false));
    await flush();
    const first = result.current.retry;
    rerender();
    expect(result.current.retry).toBe(first);
  });
});
