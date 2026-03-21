import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HUE_CREDENTIAL_STATUS, HUE_RUNTIME_TRIGGER_SOURCE } from "../../shared/contracts/hue";

const getHueStreamStatusMock = vi.fn();
const restartHueMock = vi.fn();
const shellLoadMock = vi.fn();
const shellSaveMock = vi.fn();
const listAreasMock = vi.fn();
const validateCredentialsMock = vi.fn();

vi.mock("../mode/modeApi", () => ({
  getHueStreamStatus: (...args: unknown[]) => getHueStreamStatusMock(...args),
  restartHue: (...args: unknown[]) => restartHueMock(...args),
  startHue: vi.fn(),
}));

vi.mock("../persistence/shellStore", () => ({
  shellStore: {
    load: () => shellLoadMock(),
    save: (...args: unknown[]) => shellSaveMock(...args),
  },
}));

vi.mock("./hueOnboardingApi", () => ({
  checkHueStreamReadiness: vi.fn(),
  discoverHueBridges: vi.fn(),
  listHueEntertainmentAreas: (...args: unknown[]) => listAreasMock(...args),
  pairHueBridge: vi.fn(),
  validateHueCredentials: (...args: unknown[]) => validateCredentialsMock(...args),
  verifyHueBridgeIp: vi.fn(),
}));

function runtimeStatusFixture() {
  return {
    state: "Reconnecting",
    code: "TRANSIENT_RETRY_SCHEDULED",
    message: "Retry scheduled",
    details: null,
    triggerSource: HUE_RUNTIME_TRIGGER_SOURCE.MODE_CONTROL,
    remainingAttempts: 2,
    nextAttemptMs: 1200,
    telemetry: {
      hue: {
        target: "hue",
        state: "Reconnecting",
        code: "TRANSIENT_RETRY_SCHEDULED",
        message: "Retry scheduled",
        remainingAttempts: 2,
        nextAttemptMs: 1200,
      },
      aggregate: {
        activeTargets: ["hue"],
        runningCount: 0,
        reconnectingCount: 1,
        failedCount: 0,
      },
    },
  };
}

describe("useHueOnboarding runtime wiring", () => {
  let useHueOnboardingHook: () => Record<string, unknown>;

  beforeEach(async () => {
    getHueStreamStatusMock.mockReset();
    restartHueMock.mockReset();
    shellLoadMock.mockReset();
    shellSaveMock.mockReset();
    listAreasMock.mockReset();
    validateCredentialsMock.mockReset();

    shellLoadMock.mockResolvedValue({});
    shellSaveMock.mockResolvedValue(undefined);
    getHueStreamStatusMock.mockResolvedValue(runtimeStatusFixture());
    listAreasMock.mockResolvedValue({
      status: { code: "HUE_AREA_LIST_OK", message: "ok", details: null },
      areas: [
        {
          id: "area-1",
          name: "Living Room",
          roomName: "Salon",
          channelCount: 3,
        },
      ],
    });
    validateCredentialsMock.mockResolvedValue({
      valid: true,
      status: { code: "HUE_CREDENTIAL_VALID", message: "valid", details: null },
    });

    const hookModule = await import("./useHueOnboarding");
    useHueOnboardingHook = hookModule.useHueOnboarding as unknown as () => Record<string, unknown>;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function mountProbe() {
    return renderHook(() => useHueOnboardingHook());
  }

  it("polls getHueStreamStatus and updates runtimeStatus", async () => {
    const setIntervalSpy = vi.spyOn(window, "setInterval");

    mountProbe();

    await waitFor(() => {
      expect(getHueStreamStatusMock).toHaveBeenCalledTimes(1);
    });

    expect(setIntervalSpy.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(setIntervalSpy.mock.calls.some(([, delay]) => delay === 3_000)).toBe(true);

    setIntervalSpy.mockRestore();
  });

  it("maps telemetry to runtimeTargets with retry metadata", async () => {
    const hookModule = await import("./useHueOnboarding");

    const rows = hookModule.deriveRuntimeTargets(runtimeStatusFixture() as never);

    expect(rows[0]).toMatchObject({
      target: "hue",
      code: "TRANSIENT_RETRY_SCHEDULED",
      remainingAttempts: 2,
      nextAttemptMs: 1200,
    });
  });

  it("routes retryRuntimeTarget('hue') through restart pipeline", async () => {
    shellLoadMock.mockResolvedValue({
      lastHueBridge: { id: "bridge-1", ip: "192.168.1.20", name: "Bridge" },
      hueAppKey: "app-user",
      hueClientKey: "client-key",
      hueCredentialStatus: HUE_CREDENTIAL_STATUS.VALID,
      lastHueAreaId: "area-1",
    });

    const { result } = mountProbe();

    await act(async () => {
      await (result.current.retryRuntimeTarget as ((target: string) => Promise<void>) | undefined)?.("hue");
    });

    expect(restartHueMock).toHaveBeenCalledWith({
      bridgeIp: "192.168.1.20",
      username: "app-user",
      areaId: "area-1",
      triggerSource: HUE_RUNTIME_TRIGGER_SOURCE.DEVICE_SURFACE,
    });
  });
});
