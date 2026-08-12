import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HUE_CREDENTIAL_STATUS } from "@/shared/contracts/hue";
import { __resetHueReadCacheForTests } from "../hueReadCache";
import { useHueOnboarding } from "../useHueOnboarding";

const shellLoadMock = vi.fn();
const shellSaveMock = vi.fn();
const discoverBridgesMock = vi.fn();
const pairBridgeMock = vi.fn();
const listAreasMock = vi.fn();
const validateCredentialsMock = vi.fn();
const migrateCredentialsMock = vi.fn();
const checkReadinessMock = vi.fn();

vi.mock("@/features/mode/modeApi", () => ({
  getHueStreamStatus: vi.fn().mockResolvedValue(null),
  restartHue: vi.fn(),
  startHue: vi.fn(),
}));

vi.mock("@/features/persistence/shellStore", () => ({
  shellStore: {
    load: () => shellLoadMock(),
    save: (...args: unknown[]) => shellSaveMock(...args),
  },
}));

vi.mock("../hueOnboardingApi", () => ({
  checkHueStreamReadiness: (...args: unknown[]) => checkReadinessMock(...args),
  discoverHueBridges: (...args: unknown[]) => discoverBridgesMock(...args),
  getHueAreaChannels: vi.fn().mockResolvedValue([]),
  listHueEntertainmentAreas: (...args: unknown[]) => listAreasMock(...args),
  migrateHueCredentials: (...args: unknown[]) => migrateCredentialsMock(...args),
  pairHueBridge: (...args: unknown[]) => pairBridgeMock(...args),
  validateHueCredentials: (...args: unknown[]) => validateCredentialsMock(...args),
  verifyHueBridgeIp: vi.fn(),
}));

const BRIDGE = { id: "bridge-1", ip: "192.168.1.20", name: "Test Bridge" };
const NEW_APP_KEY = "app-key-fresh";
const OLD_APP_KEY = "app-key-superseded";

describe("useHueOnboarding — pairing lists areas with the key it just received", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetHueReadCacheForTests();

    shellLoadMock.mockResolvedValue({});
    shellSaveMock.mockResolvedValue(undefined);
    discoverBridgesMock.mockResolvedValue({
      status: { code: "HUE_DISCOVERY_OK", message: "ok", details: null },
      bridges: [BRIDGE],
    });
    pairBridgeMock.mockResolvedValue({
      status: { code: "HUE_PAIRING_OK", message: "Paired.", details: null },
      credentials: { username: NEW_APP_KEY, clientKey: "psk-deadbeef" },
      credentialStorageBackend: "keychain",
    });
    listAreasMock.mockResolvedValue({
      status: { code: "HUE_AREA_LIST_OK", message: "ok", details: null },
      areas: [{ id: "area-1", name: "Living Room", roomName: "Salon", channelCount: 3 }],
    });
    migrateCredentialsMock.mockResolvedValue({
      status: { code: "HUE_CREDENTIAL_MIGRATION_FAILED", message: "no keychain" },
      backend: "plaintext-legacy",
    });
    checkReadinessMock.mockResolvedValue({
      status: { code: "HUE_STREAM_NOT_READY", message: "not ready", details: null },
      readiness: { ready: false, reasons: [] },
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("populates the area list on a first pairing, without a manual refresh", async () => {
    const { result } = renderHook(() => useHueOnboarding());
    await waitFor(() => expect(shellLoadMock).toHaveBeenCalled());

    await act(async () => {
      await result.current.discover();
    });
    act(() => {
      result.current.selectBridge(BRIDGE.id);
    });
    await act(async () => {
      await result.current.pair();
    });

    expect(listAreasMock).toHaveBeenCalledWith(BRIDGE.ip, NEW_APP_KEY);
    await waitFor(() => {
      expect(result.current.areaGroups[0]?.areas[0]?.id).toBe("area-1");
    });
    expect(result.current.selectedAreaId).toBe("area-1");
  });

  it("lists under the new app key when re-pairing over a rejected one", async () => {
    shellLoadMock.mockResolvedValue({
      lastHueBridge: BRIDGE,
      hueAppKey: OLD_APP_KEY,
      hueClientKey: "psk-stale",
      hueCredentialStatus: HUE_CREDENTIAL_STATUS.NEEDS_REPAIR,
    });
    validateCredentialsMock.mockResolvedValue({
      status: { code: "HUE_CREDENTIAL_INVALID", message: "rejected", details: null },
      valid: false,
    });

    const { result } = renderHook(() => useHueOnboarding());

    await waitFor(() => expect(validateCredentialsMock).toHaveBeenCalled());
    await waitFor(() =>
      expect(result.current.credentialState).toBe(HUE_CREDENTIAL_STATUS.NEEDS_REPAIR),
    );

    await act(async () => {
      await result.current.pair();
    });

    // The superseded key is exactly what the bridge just rejected — listing
    // under it returns AUTH_INVALID_RE_PAIR_REQUIRED and an empty area list.
    expect(listAreasMock).not.toHaveBeenCalledWith(BRIDGE.ip, OLD_APP_KEY);
    expect(listAreasMock).toHaveBeenCalledWith(BRIDGE.ip, NEW_APP_KEY);
    await waitFor(() => {
      expect(result.current.areaGroups[0]?.areas[0]?.id).toBe("area-1");
    });
  });
});
