import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HUE_CREDENTIAL_STATUS } from "../../../shared/contracts/hue";

const getHueStreamStatusMock = vi.fn();
const restartHueMock = vi.fn();
const shellLoadMock = vi.fn();
const shellSaveMock = vi.fn();
const listAreasMock = vi.fn();
const validateCredentialsMock = vi.fn();
const checkReadinessMock = vi.fn();
const getAreaChannelsMock = vi.fn();

vi.mock("../../mode/modeApi", () => ({
  getHueStreamStatus: (...args: unknown[]) => getHueStreamStatusMock(...args),
  restartHue: (...args: unknown[]) => restartHueMock(...args),
  startHue: vi.fn(),
}));

vi.mock("../../persistence/shellStore", () => ({
  shellStore: {
    load: () => shellLoadMock(),
    save: (...args: unknown[]) => shellSaveMock(...args),
  },
}));

vi.mock("../hueOnboardingApi", () => ({
  checkHueStreamReadiness: (...args: unknown[]) => checkReadinessMock(...args),
  discoverHueBridges: vi.fn(),
  getHueAreaChannels: (...args: unknown[]) => getAreaChannelsMock(...args),
  listHueEntertainmentAreas: (...args: unknown[]) => listAreasMock(...args),
  pairHueBridge: vi.fn(),
  validateHueCredentials: (...args: unknown[]) => validateCredentialsMock(...args),
  verifyHueBridgeIp: vi.fn(),
}));

const ACTIVE_STREAMER_REASON = "HUE_STREAM_NOT_READY_ACTIVE_STREAMER";

describe("useHueOnboarding — A3.1 active-streamer banner auto-clear", () => {
  let useHueOnboardingHook: () => Record<string, unknown>;

  beforeEach(async () => {
    vi.resetModules();
    getHueStreamStatusMock.mockReset();
    restartHueMock.mockReset();
    shellLoadMock.mockReset();
    shellSaveMock.mockReset();
    listAreasMock.mockReset();
    validateCredentialsMock.mockReset();
    checkReadinessMock.mockReset();
    getAreaChannelsMock.mockReset();

    shellSaveMock.mockResolvedValue(undefined);
    shellLoadMock.mockResolvedValue({
      lastHueBridge: { id: "bridge-1", ip: "192.168.1.20", name: "Bridge" },
      hueAppKey: "app-user",
      hueClientKey: "client-key",
      hueCredentialStatus: HUE_CREDENTIAL_STATUS.VALID,
      lastHueAreaId: "area-1",
    });

    getHueStreamStatusMock.mockResolvedValue({
      active: false,
      status: { state: "Idle", code: "HUE_RUNTIME_IDLE", message: "idle", details: null, triggerSource: "user" },
      lastSolidColor: null,
    });

    validateCredentialsMock.mockResolvedValue({
      valid: true,
      status: { code: "HUE_CREDENTIAL_VALID", message: "valid", details: null },
    });

    // Initial area listing reports a foreign streamer attached.
    listAreasMock.mockResolvedValue({
      status: { code: "HUE_AREA_LIST_OK", message: "ok", details: null },
      areas: [
        {
          id: "area-1",
          name: "Living Room",
          roomName: "Salon",
          channelCount: 3,
          activeStreamer: true,
        },
      ],
    });

    getAreaChannelsMock.mockResolvedValue([]);

    const hookModule = await import("../useHueOnboarding");
    useHueOnboardingHook = hookModule.useHueOnboarding as unknown as () => Record<string, unknown>;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("clears area.activeStreamer on the first background readiness tick after the foreign streamer disconnects", async () => {
    // First readiness probe — foreign streamer still attached.
    // Subsequent probes — foreign streamer gone.
    checkReadinessMock
      .mockResolvedValueOnce({
        status: { code: "HUE_STREAM_NOT_READY", message: "blocked", details: null },
        readiness: { ready: false, reasons: [ACTIVE_STREAMER_REASON] },
      })
      .mockResolvedValue({
        status: { code: "HUE_STREAM_READY", message: "ready", details: null },
        readiness: { ready: true, reasons: [] },
      });

    const { result } = renderHook(() => useHueOnboardingHook());

    // Wait for hook initialization to load credentials and area list.
    await waitFor(() => {
      const groups = result.current.areaGroups as Array<{ areas: Array<{ activeStreamer?: boolean }> }>;
      expect(groups[0]?.areas[0]?.activeStreamer).toBe(true);
    });

    // First background readiness tick fires immediately on mount and reports
    // the area is still blocked. The activeStreamer flag must remain true.
    await waitFor(() => {
      expect(checkReadinessMock).toHaveBeenCalled();
    });

    await waitFor(() => {
      const groups = result.current.areaGroups as Array<{ areas: Array<{ activeStreamer?: boolean; readiness: { ready: boolean } | null }> }>;
      const area = groups[0]?.areas[0];
      expect(area?.readiness?.ready).toBe(false);
      expect(area?.activeStreamer).toBe(true);
    });

    const callsAfterFirstTick = checkReadinessMock.mock.calls.length;

    // Now the foreign streamer disconnects: subsequent readiness calls return
    // ready=true with no reasons. The 3 s blocked-cadence timer should fire
    // the next tick, the snapshot updates, and activeStreamer flips to false.
    await act(async () => {
      // Allow the recursive setTimeout to fire — vitest fake timers would
      // be ideal, but the hook uses real `window.setTimeout` from the JSDOM
      // env, so we wait for the cadence wall-clock instead. The blocked
      // cadence is 3 s, so allow a small buffer.
      await new Promise((resolve) => setTimeout(resolve, 3500));
    });

    expect(checkReadinessMock.mock.calls.length).toBeGreaterThan(callsAfterFirstTick);

    await waitFor(() => {
      const groups = result.current.areaGroups as Array<{ areas: Array<{ activeStreamer?: boolean; readiness: { ready: boolean } | null }> }>;
      const area = groups[0]?.areas[0];
      expect(area?.readiness?.ready).toBe(true);
      expect(area?.activeStreamer).toBe(false);
    });
  }, 10_000);
});
