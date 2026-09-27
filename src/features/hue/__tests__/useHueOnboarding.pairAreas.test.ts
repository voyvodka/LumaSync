import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HUE_CREDENTIAL_STATUS } from "@/shared/contracts/hue";
import { __resetHueHealthStoreForTests } from "../state/hueHealthStore";
import { resetHealth } from "./fakeHueHealth";
import { useHueOnboarding } from "../useHueOnboarding";
import type * as modeApiModule from "@/features/mode/modeApi";
import type * as hueOnboardingApiModule from "../hueOnboardingApi";

const shellLoadMock = vi.fn();
const shellSaveMock = vi.fn();
const discoverBridgesMock = vi.fn<typeof hueOnboardingApiModule.discoverHueBridges>();
const pairBridgeMock = vi.fn<typeof hueOnboardingApiModule.pairHueBridge>();
const listAreasMock = vi.fn<typeof hueOnboardingApiModule.listHueEntertainmentAreas>();
const validateCredentialsMock = vi.fn<typeof hueOnboardingApiModule.validateHueCredentials>();
const migrateCredentialsMock = vi.fn<typeof hueOnboardingApiModule.migrateHueCredentials>();
const checkReadinessMock = vi.fn<typeof hueOnboardingApiModule.checkHueStreamReadiness>();

vi.mock("../hueHealthApi", async () => (await import("./fakeHueHealth")).fakeHueHealthApi);

vi.mock("@/features/mode/modeApi", () => ({
  restartHue: vi.fn<typeof modeApiModule.restartHue>(),
  startHue: vi.fn<typeof modeApiModule.startHue>(),
}));

vi.mock("@/features/persistence/shellStore", () => ({
  shellStore: {
    load: () => shellLoadMock(),
    save: (...args: Parameters<typeof shellSaveMock>) => shellSaveMock(...args),
  },
}));

vi.mock("../hueOnboardingApi", () => ({
  checkHueStreamReadiness: (...args: Parameters<typeof checkReadinessMock>) => checkReadinessMock(...args),
  discoverHueBridges: (...args: Parameters<typeof discoverBridgesMock>) => discoverBridgesMock(...args),
  getHueAreaChannels: vi.fn<typeof hueOnboardingApiModule.getHueAreaChannels>().mockResolvedValue({
    status: { code: "HUE_AREA_CHANNELS_EMPTY", message: "", details: null },
    channels: [],
  }),
  listHueEntertainmentAreas: (...args: Parameters<typeof listAreasMock>) => listAreasMock(...args),
  migrateHueCredentials: (...args: Parameters<typeof migrateCredentialsMock>) => migrateCredentialsMock(...args),
  pairHueBridge: (...args: Parameters<typeof pairBridgeMock>) => pairBridgeMock(...args),
  validateHueCredentials: (...args: Parameters<typeof validateCredentialsMock>) => validateCredentialsMock(...args),
  verifyHueBridgeIp: vi.fn<typeof hueOnboardingApiModule.verifyHueBridgeIp>(),
}));

const BRIDGE = { id: "bridge-1", ip: "192.168.1.20", name: "Test Bridge" };
const NEW_APP_KEY = "app-key-fresh";
const OLD_APP_KEY = "app-key-superseded";

describe("useHueOnboarding — pairing lists areas with the key it just received", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetHueHealthStoreForTests();
    resetHealth();

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
      areas: [{ id: "area-1", name: "Living Room", roomName: "Salon", channelCount: 3, activeStreamer: false }],
    });
    migrateCredentialsMock.mockResolvedValue({
      status: { code: "HUE_CREDENTIAL_MIGRATION_FAILED", message: "no keychain", details: null },
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

  // Pairing a second bridge from the rail: the key in hand is the first one's and must not be
  // offered as this one's while the button is pressed.
  it("drops the paired bridge's key from memory while another bridge pairs", async () => {
    const OTHER = { id: "bridge-other", ip: "192.168.1.77", name: "Office" };
    shellLoadMock.mockResolvedValue({
      lastHueBridge: BRIDGE,
      hueAppKey: OLD_APP_KEY,
      hueClientKey: "psk-old",
      hueCredentialStatus: HUE_CREDENTIAL_STATUS.VALID,
    });
    validateCredentialsMock.mockResolvedValue({
      status: { code: "HUE_CREDENTIAL_VALID", message: "ok", details: null },
      valid: true,
    });
    discoverBridgesMock.mockResolvedValue({
      status: { code: "HUE_DISCOVERY_OK", message: "ok", details: null },
      bridges: [BRIDGE, OTHER],
    });
    let finishPairing: (value: Awaited<ReturnType<typeof hueOnboardingApiModule.pairHueBridge>>) => void = () => {};
    pairBridgeMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishPairing = resolve;
        }),
    );

    const { result } = renderHook(() => useHueOnboarding());
    await waitFor(() => expect(result.current.credentials?.username).toBe(OLD_APP_KEY));
    await act(async () => {
      await result.current.discover();
    });

    let pairing: Promise<void> = Promise.resolve();
    act(() => {
      pairing = result.current.pair(OTHER.id);
    });

    expect(result.current.selectedBridgeId).toBe(OTHER.id);
    expect(result.current.credentials).toBeNull();
    expect(result.current.credentialState).toBe(HUE_CREDENTIAL_STATUS.UNKNOWN);
    expect(result.current.isPairing).toBe(true);

    await act(async () => {
      finishPairing({
        status: { code: "HUE_PAIRING_OK", message: "Paired.", details: null },
        credentials: { username: NEW_APP_KEY, clientKey: "psk-new" },
        credentialStorageBackend: "keychain",
      });
      await pairing;
    });
    expect(result.current.credentials?.username).toBe(NEW_APP_KEY);
    expect(shellSaveMock).toHaveBeenCalledWith(expect.objectContaining({ lastHueBridge: OTHER }));
  });

  // Cancel mid-run, or after a refusal: the bridge set aside comes back with its key, instead of
  // reading as unpaired until a restart.
  it.each([
    ["mid-run", () => new Promise<never>(() => {})],
    [
      "after a refusal",
      async () => ({
        status: { code: "HUE_PAIRING_BRIDGE_BUSY" as const, message: "busy", details: null },
        credentials: null,
      }),
    ],
  ])("brings the paired bridge back when pairing another is cancelled %s", async (_when, answer) => {
    const OTHER = { id: "bridge-other", ip: "192.168.1.77", name: "Office" };
    shellLoadMock.mockResolvedValue({
      lastHueBridge: BRIDGE,
      hueAppKey: OLD_APP_KEY,
      hueClientKey: "psk-old",
      hueCredentialStatus: HUE_CREDENTIAL_STATUS.VALID,
    });
    validateCredentialsMock.mockResolvedValue({
      status: { code: "HUE_CREDENTIAL_VALID", message: "ok", details: null },
      valid: true,
    });
    discoverBridgesMock.mockResolvedValue({
      status: { code: "HUE_DISCOVERY_OK", message: "ok", details: null },
      bridges: [BRIDGE, OTHER],
    });
    pairBridgeMock.mockImplementation(answer as typeof hueOnboardingApiModule.pairHueBridge);

    const { result } = renderHook(() => useHueOnboarding());
    await waitFor(() => expect(result.current.credentialState).toBe(HUE_CREDENTIAL_STATUS.VALID));
    await act(async () => {
      await result.current.discover();
    });
    await act(async () => {
      void result.current.pair(OTHER.id);
      await Promise.resolve();
    });
    expect(result.current.credentials).toBeNull();

    act(() => {
      result.current.selectBridge(null);
    });

    expect(result.current.selectedBridgeId).toBe(BRIDGE.id);
    expect(result.current.credentials?.username).toBe(OLD_APP_KEY);
    expect(result.current.credentialState).toBe(HUE_CREDENTIAL_STATUS.VALID);
    expect(result.current.isPairing).toBe(false);
  });
});
