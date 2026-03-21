import { render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";

import { HUE_CREDENTIAL_STATUS, HUE_RUNTIME_TRIGGER_SOURCE } from "../../shared/contracts/hue";
import type { UseHueOnboardingResult } from "./useHueOnboarding";
import { useHueOnboarding } from "./useHueOnboarding";

const getHueStreamStatusMock = vi.fn();
const startHueMock = vi.fn();
const stopHueMock = vi.fn();
const shellLoadMock = vi.fn();
const shellSaveMock = vi.fn();
const listAreasMock = vi.fn();
const validateCredentialsMock = vi.fn();

vi.mock("../mode/modeApi", () => ({
  getHueStreamStatus: (...args: unknown[]) => getHueStreamStatusMock(...args),
  startHue: (...args: unknown[]) => startHueMock(...args),
  stopHue: (...args: unknown[]) => stopHueMock(...args),
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
  let snapshot: UseHueOnboardingResult | null;

  beforeEach(() => {
    snapshot = null;
    vi.useFakeTimers();
    getHueStreamStatusMock.mockReset();
    startHueMock.mockReset();
    stopHueMock.mockReset();
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
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function mountProbe() {
    function Probe() {
      snapshot = useHueOnboarding();
      return null;
    }

    render(createElement(Probe));
  }

  it("polls getHueStreamStatus and updates runtimeStatus", async () => {
    mountProbe();

    await waitFor(() => {
      expect(getHueStreamStatusMock).toHaveBeenCalledTimes(1);
      expect(snapshot?.runtimeStatus?.code).toBe("TRANSIENT_RETRY_SCHEDULED");
    });

    await vi.advanceTimersByTimeAsync(3_000);

    await waitFor(() => {
      expect(getHueStreamStatusMock).toHaveBeenCalledTimes(2);
    });
  });

  it("maps telemetry to runtimeTargets with retry metadata", async () => {
    mountProbe();

    await waitFor(() => {
      expect(snapshot?.runtimeTargets).toHaveLength(1);
    });

    expect(snapshot?.runtimeTargets[0]).toMatchObject({
      target: "hue",
      code: "TRANSIENT_RETRY_SCHEDULED",
      remainingAttempts: 2,
      nextAttemptMs: 1200,
    });
  });

  it("routes retryRuntimeTarget('hue') through stop+start pipeline", async () => {
    shellLoadMock.mockResolvedValue({
      lastHueBridge: { id: "bridge-1", ip: "192.168.1.20", name: "Bridge" },
      hueAppKey: "app-user",
      hueClientKey: "client-key",
      hueCredentialStatus: HUE_CREDENTIAL_STATUS.VALID,
      lastHueAreaId: "area-1",
    });

    mountProbe();

    await waitFor(() => {
      expect(snapshot?.selectedBridge?.ip).toBe("192.168.1.20");
      expect(snapshot?.selectedAreaId).toBe("area-1");
    });

    await snapshot?.retryRuntimeTarget("hue");

    expect(stopHueMock).toHaveBeenCalledWith(HUE_RUNTIME_TRIGGER_SOURCE.DEVICE_SURFACE);
    expect(startHueMock).toHaveBeenCalledWith({
      bridgeIp: "192.168.1.20",
      username: "app-user",
      areaId: "area-1",
      triggerSource: HUE_RUNTIME_TRIGGER_SOURCE.DEVICE_SURFACE,
    });
  });
});
