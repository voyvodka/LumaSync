import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HUE_CREDENTIAL_STATUS, type HuePairBridgeResponse } from "@/shared/contracts/hue";
import { deriveHueBridgeCardState } from "../../model/hueBridgeCardState";
import {
  HUE_PAIRING_POLL_INTERVAL_MS,
  HUE_PAIRING_POLL_WINDOW_MS,
} from "../../model/pollingCadence";
import { __resetHueHealthStoreForTests } from "../hueHealthStore";
import { useHueOnboardingCore } from "../useHueOnboardingCore";
import type * as hueOnboardingApiModule from "../../hueOnboardingApi";

const shellLoadMock = vi.fn();
const shellSaveMock = vi.fn();
const discoverBridgesMock = vi.fn<typeof hueOnboardingApiModule.discoverHueBridges>();
const pairBridgeMock = vi.fn<typeof hueOnboardingApiModule.pairHueBridge>();
const listAreasMock = vi.fn<typeof hueOnboardingApiModule.listHueEntertainmentAreas>();

vi.mock("@/features/persistence/shellStore", () => ({
  shellStore: {
    load: () => shellLoadMock(),
    save: (...args: Parameters<typeof shellSaveMock>) => shellSaveMock(...args),
  },
}));

vi.mock("../../hueOnboardingApi", () => ({
  checkHueStreamReadiness: vi.fn<typeof hueOnboardingApiModule.checkHueStreamReadiness>(),
  discoverHueBridges: (...args: Parameters<typeof discoverBridgesMock>) => discoverBridgesMock(...args),
  listHueEntertainmentAreas: (...args: Parameters<typeof listAreasMock>) => listAreasMock(...args),
  migrateHueCredentials: vi.fn<typeof hueOnboardingApiModule.migrateHueCredentials>(),
  pairHueBridge: (...args: Parameters<typeof pairBridgeMock>) => pairBridgeMock(...args),
  validateHueCredentials: vi.fn<typeof hueOnboardingApiModule.validateHueCredentials>(),
  verifyHueBridgeIp: vi.fn<typeof hueOnboardingApiModule.verifyHueBridgeIp>(),
}));

const BRIDGE = { id: "bridge-1", ip: "192.168.1.20", name: "Test Bridge" };
const OTHER_BRIDGE = { id: "bridge-2", ip: "192.168.1.21", name: "Other Bridge" };

const NOT_PRESSED: HuePairBridgeResponse = {
  status: { code: "HUE_PAIRING_LINK_BUTTON_NOT_PRESSED", message: "press it", details: null },
  credentials: null,
};
const PAIRED: HuePairBridgeResponse = {
  status: { code: "HUE_PAIRING_OK", message: "ok", details: null },
  credentials: { username: "app-user", clientKey: "AABBCCDD" },
  credentialStorageBackend: "keychain",
};

async function flush(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

async function mountWithBridges() {
  const hook = renderHook(() => useHueOnboardingCore());
  await flush();
  await act(async () => {
    await hook.result.current.discover();
  });
  return hook;
}

async function mountAndStartPairing() {
  const hook = await mountWithBridges();
  await act(async () => {
    await hook.result.current.pair(BRIDGE.id);
  });
  return hook;
}

function cardState(state: ReturnType<typeof useHueOnboardingCore>["state"]) {
  return deriveHueBridgeCardState({
    selectedBridgeId: state.selectedBridgeId,
    runtimeStatus: null,
    runtimeStatusUnavailable: false,
    hueStatus: state.status,
    credentialState: state.credentialState,
    hasCredentials: state.credentials !== null,
    bridgeUnreachable: state.bridgeUnreachable,
    isPairing: state.isPairing,
    selectedAreaId: state.selectedAreaId,
    isReadinessStale: false,
    areaHeldByAnotherApp: false,
  });
}

describe("useHueOnboardingCore — link-button polling (#337)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    __resetHueHealthStoreForTests();
    shellLoadMock.mockResolvedValue({});
    shellSaveMock.mockResolvedValue(undefined);
    discoverBridgesMock.mockResolvedValue({
      status: { code: "HUE_DISCOVERY_OK", message: "ok", details: null },
      bridges: [BRIDGE, OTHER_BRIDGE],
    });
    listAreasMock.mockResolvedValue({
      status: { code: "HUE_AREA_LIST_OK", message: "ok", details: null },
      areas: [],
    });
    pairBridgeMock.mockResolvedValue(NOT_PRESSED);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("pairs once the button is pressed, with no further click", async () => {
    pairBridgeMock
      .mockResolvedValueOnce(NOT_PRESSED)
      .mockResolvedValueOnce(NOT_PRESSED)
      .mockResolvedValueOnce(PAIRED);

    const { result } = await mountAndStartPairing();

    expect(pairBridgeMock).toHaveBeenCalledTimes(1);
    expect(result.current.state.status?.code).toBe("HUE_PAIRING_PENDING_LINK_BUTTON");
    expect(result.current.state.isPairing).toBe(true);
    expect(cardState(result.current.state)).toBe("pairingLinkButton");

    await flush(HUE_PAIRING_POLL_INTERVAL_MS);
    expect(pairBridgeMock).toHaveBeenCalledTimes(2);

    await flush(HUE_PAIRING_POLL_INTERVAL_MS);
    expect(pairBridgeMock).toHaveBeenCalledTimes(3);
    expect(result.current.state.credentialState).toBe(HUE_CREDENTIAL_STATUS.VALID);
    expect(result.current.state.isPairing).toBe(false);
    expect(listAreasMock).toHaveBeenCalledWith(BRIDGE.ip, "app-user");
    expect(shellSaveMock).toHaveBeenCalledWith(expect.objectContaining({ lastHueBridge: BRIDGE }));

    await flush(HUE_PAIRING_POLL_WINDOW_MS);
    expect(pairBridgeMock).toHaveBeenCalledTimes(3);
  });

  it("never has two requests in flight", async () => {
    let release: (value: typeof NOT_PRESSED) => void = () => {};
    pairBridgeMock.mockResolvedValueOnce(NOT_PRESSED).mockImplementationOnce(
      () => new Promise((resolve) => { release = resolve; }),
    );

    await mountAndStartPairing();
    await flush(HUE_PAIRING_POLL_INTERVAL_MS);
    expect(pairBridgeMock).toHaveBeenCalledTimes(2);

    await flush(HUE_PAIRING_POLL_INTERVAL_MS * 5);
    expect(pairBridgeMock).toHaveBeenCalledTimes(2);

    await act(async () => {
      release(NOT_PRESSED);
    });
    await flush(HUE_PAIRING_POLL_INTERVAL_MS);
    expect(pairBridgeMock).toHaveBeenCalledTimes(3);
  });

  it("stops at the deadline and shows the timed-out card", async () => {
    const { result } = await mountAndStartPairing();

    await flush(HUE_PAIRING_POLL_WINDOW_MS);
    const callsAtDeadline = pairBridgeMock.mock.calls.length;

    expect(result.current.state.isPairing).toBe(false);
    expect(result.current.state.status?.code).toBe("HUE_PAIRING_LINK_BUTTON_NOT_PRESSED");
    expect(cardState(result.current.state)).toBe("pairingTimedOut");
    expect(callsAtDeadline).toBeLessThanOrEqual(HUE_PAIRING_POLL_WINDOW_MS / HUE_PAIRING_POLL_INTERVAL_MS + 1);

    await flush(HUE_PAIRING_POLL_WINDOW_MS);
    expect(pairBridgeMock).toHaveBeenCalledTimes(callsAtDeadline);
  });

  it("restarts the window on Try again", async () => {
    const { result } = await mountAndStartPairing();
    await flush(HUE_PAIRING_POLL_WINDOW_MS);
    const callsAtDeadline = pairBridgeMock.mock.calls.length;

    pairBridgeMock.mockResolvedValueOnce(NOT_PRESSED).mockResolvedValueOnce(PAIRED);
    await act(async () => {
      await result.current.pair();
    });
    expect(result.current.state.status?.code).toBe("HUE_PAIRING_PENDING_LINK_BUTTON");
    expect(cardState(result.current.state)).toBe("pairingLinkButton");

    await flush(HUE_PAIRING_POLL_INTERVAL_MS);
    expect(pairBridgeMock).toHaveBeenCalledTimes(callsAtDeadline + 2);
    expect(result.current.state.credentialState).toBe(HUE_CREDENTIAL_STATUS.VALID);
  });

  it("stops polling on Cancel", async () => {
    const { result } = await mountAndStartPairing();

    act(() => {
      result.current.selectBridge(null);
    });
    await flush(HUE_PAIRING_POLL_WINDOW_MS);

    expect(pairBridgeMock).toHaveBeenCalledTimes(1);
    expect(result.current.state.isPairing).toBe(false);
    expect(result.current.state.status).toBeNull();
  });

  it("drops an answer that arrives after Cancel", async () => {
    let release: (value: typeof PAIRED) => void = () => {};
    pairBridgeMock.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));

    const { result } = await mountWithBridges();
    act(() => {
      void result.current.pair(BRIDGE.id);
    });
    act(() => {
      result.current.selectBridge(null);
    });
    await act(async () => {
      release(PAIRED);
    });
    await flush(HUE_PAIRING_POLL_WINDOW_MS);

    expect(result.current.state.credentials).toBeNull();
    expect(result.current.state.isPairing).toBe(false);
    expect(listAreasMock).not.toHaveBeenCalled();
  });

  it("stops polling when a different bridge is selected", async () => {
    const { result } = await mountAndStartPairing();

    act(() => {
      result.current.selectBridge(OTHER_BRIDGE.id);
    });
    await flush(HUE_PAIRING_POLL_WINDOW_MS);

    expect(pairBridgeMock).toHaveBeenCalledTimes(1);
    expect(result.current.state.isPairing).toBe(false);
    expect(result.current.state.status).toBeNull();
  });

  it("stops polling on any other status and surfaces it", async () => {
    pairBridgeMock.mockResolvedValueOnce(NOT_PRESSED).mockResolvedValueOnce({
      status: { code: "HUE_PAIRING_RATE_LIMITED", message: "slow down", details: null },
      credentials: null,
    });

    const { result } = await mountAndStartPairing();
    await flush(HUE_PAIRING_POLL_INTERVAL_MS);
    await flush(HUE_PAIRING_POLL_WINDOW_MS);

    expect(pairBridgeMock).toHaveBeenCalledTimes(2);
    expect(result.current.state.isPairing).toBe(false);
    expect(result.current.state.status?.code).toBe("HUE_PAIRING_RATE_LIMITED");
  });

  it("stops polling when the invoke itself rejects", async () => {
    pairBridgeMock.mockResolvedValueOnce(NOT_PRESSED).mockRejectedValueOnce(new Error("ipc died"));

    const { result } = await mountAndStartPairing();
    await flush(HUE_PAIRING_POLL_INTERVAL_MS);
    await flush(HUE_PAIRING_POLL_WINDOW_MS);

    expect(pairBridgeMock).toHaveBeenCalledTimes(2);
    expect(result.current.state.status?.code).toBe("HUE_PAIRING_FAILED");
  });

  it("clears its timer on unmount", async () => {
    const { unmount } = await mountAndStartPairing();
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    unmount();

    expect(vi.getTimerCount()).toBe(0);
    await flush(HUE_PAIRING_POLL_WINDOW_MS);
    expect(pairBridgeMock).toHaveBeenCalledTimes(1);
  });

  it("does not carry a timed-out pairing onto a reselected bridge", async () => {
    const { result } = await mountAndStartPairing();
    await flush(HUE_PAIRING_POLL_WINDOW_MS);
    expect(cardState(result.current.state)).toBe("pairingTimedOut");

    act(() => {
      result.current.selectBridge(null);
    });
    act(() => {
      result.current.selectBridge(BRIDGE.id);
    });

    expect(result.current.state.status).toBeNull();
    expect(cardState(result.current.state)).not.toBe("pairingTimedOut");
  });
});
