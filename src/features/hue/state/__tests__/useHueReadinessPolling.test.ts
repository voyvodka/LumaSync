import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HUE_STATUS } from "@/shared/contracts/hue";

import type { HueBridgeSummary, HuePairingCredentials } from "../../hueOnboardingApi";
import {
  READINESS_BACKGROUND_REFRESH_MS,
  READINESS_BLOCKED_REFRESH_MS,
} from "../../model/pollingCadence";
import { requestHuePollRestart } from "../huePollRestart";
import { useHueReadinessPolling } from "../useHueReadinessPolling";

const readHueStreamReadinessMock = vi.fn();

vi.mock("../../hueReadCache", () => ({
  readHueStreamReadiness: (...args: unknown[]) => readHueStreamReadinessMock(...args),
}));

const bridge = { id: "bridge-1", ip: "192.168.1.10" } as HueBridgeSummary;
const credentials = { username: "app-user", clientKey: "AABBCCDD" } as HuePairingCredentials;

const response = (code: string, ready = false) => ({
  status: { code },
  readiness: { ready, reasons: [] },
});

const mount = (blocked = false) =>
  renderHook(() =>
    useHueReadinessPolling({
      bridge,
      credentials,
      areaId: "area-1",
      blocked,
      isValidatingCredential: false,
      isLoadingAreas: false,
      onResult: () => {},
    }),
  );

const advance = async (ms: number) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

describe("useHueReadinessPolling — give up and retry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(0);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    readHueStreamReadinessMock.mockResolvedValue(
      response(HUE_STATUS.STREAM_READINESS_FAILED),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("stops polling once the failure budget is spent", async () => {
    mount();
    await advance(0);
    expect(readHueStreamReadinessMock).toHaveBeenCalledOnce();

    // 15 s cadence, so the 90 s time floor is what ends it: ticks at 0..90 s.
    await advance(READINESS_BACKGROUND_REFRESH_MS * 6);
    expect(readHueStreamReadinessMock).toHaveBeenCalledTimes(7);

    await advance(READINESS_BACKGROUND_REFRESH_MS * 20);
    expect(readHueStreamReadinessMock).toHaveBeenCalledTimes(7);
  });

  it("a rejected read counts as a failure too", async () => {
    readHueStreamReadinessMock.mockRejectedValue(new Error("invoke failed"));
    mount();
    await advance(READINESS_BACKGROUND_REFRESH_MS * 20);
    expect(readHueStreamReadinessMock).toHaveBeenCalledTimes(7);
  });

  it("does not give up while the bridge keeps answering 'not ready'", async () => {
    // A foreign active streamer polls at 3 s — 30 answers inside the time
    // budget. The bridge is reachable, so none of them is a failure.
    readHueStreamReadinessMock.mockResolvedValue(response(HUE_STATUS.STREAM_NOT_READY));
    mount(true);
    await advance(READINESS_BLOCKED_REFRESH_MS * 40);
    expect(readHueStreamReadinessMock).toHaveBeenCalledTimes(41);
  });

  it("a success in between resets the streak, so it keeps polling", async () => {
    readHueStreamReadinessMock
      .mockResolvedValueOnce(response(HUE_STATUS.STREAM_READINESS_FAILED))
      .mockResolvedValueOnce(response(HUE_STATUS.STREAM_READINESS_FAILED))
      .mockResolvedValueOnce(response(HUE_STATUS.STREAM_READY, true))
      .mockResolvedValue(response(HUE_STATUS.STREAM_READINESS_FAILED));

    mount();
    await advance(READINESS_BACKGROUND_REFRESH_MS * 8);
    // Without the reset the streak would have spanned 90 s by the 7th tick
    // and stopped there.
    expect(readHueStreamReadinessMock).toHaveBeenCalledTimes(9);
  });

  it("the shared manual retry re-arms the loop", async () => {
    mount();
    await advance(READINESS_BACKGROUND_REFRESH_MS * 6);
    expect(readHueStreamReadinessMock).toHaveBeenCalledTimes(7);

    await act(async () => {
      requestHuePollRestart();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(readHueStreamReadinessMock).toHaveBeenCalledTimes(8);
  });
});
