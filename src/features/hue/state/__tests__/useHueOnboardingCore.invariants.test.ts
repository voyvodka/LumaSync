import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HUE_CREDENTIAL_STATUS, type HueStreamReadinessStatusCode } from "@/shared/contracts/hue";
import { hueCredentialEvents } from "../../hueCredentialEvents";
import { __resetHueHealthStoreForTests } from "../hueHealthStore";
import { useHueOnboardingCore } from "../useHueOnboardingCore";
import type * as hueOnboardingApiModule from "../../hueOnboardingApi";

const shellLoadMock = vi.fn();
const shellSaveMock = vi.fn();
const discoverBridgesMock = vi.fn<typeof hueOnboardingApiModule.discoverHueBridges>();
const pairBridgeMock = vi.fn<typeof hueOnboardingApiModule.pairHueBridge>();
const listAreasMock = vi.fn<typeof hueOnboardingApiModule.listHueEntertainmentAreas>();
const validateCredentialsMock = vi.fn<typeof hueOnboardingApiModule.validateHueCredentials>();

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
  migrateHueCredentials: vi.fn<typeof hueOnboardingApiModule.migrateHueCredentials>().mockResolvedValue({
    status: { code: "HUE_CREDENTIAL_MIGRATION_FAILED", message: "no keychain", details: null },
    backend: "plaintext-legacy",
  }),
  pairHueBridge: (...args: Parameters<typeof pairBridgeMock>) => pairBridgeMock(...args),
  validateHueCredentials: (...args: Parameters<typeof validateCredentialsMock>) => validateCredentialsMock(...args),
  verifyHueBridgeIp: vi.fn<typeof hueOnboardingApiModule.verifyHueBridgeIp>(),
}));

const BRIDGE = { id: "bridge-1", ip: "192.168.1.20", name: "Test Bridge" };

async function selectBridgeAndPair() {
  discoverBridgesMock.mockResolvedValue({
    status: { code: "HUE_DISCOVERY_OK", message: "ok", details: null },
    bridges: [BRIDGE],
  });

  const { result } = renderHook(() => useHueOnboardingCore());
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

  return result;
}

describe("useHueOnboardingCore — credential invariants", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetHueHealthStoreForTests();
    shellLoadMock.mockResolvedValue({});
    shellSaveMock.mockResolvedValue(undefined);
    listAreasMock.mockResolvedValue({
      status: { code: "HUE_AREA_LIST_OK", message: "ok", details: null },
      areas: [],
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("I1 — credentialState and bridgeUnreachable move together", () => {
    it("marks the bridge unreachable alongside NEEDS_REPAIR when the check fails at the network level", async () => {
      shellLoadMock.mockResolvedValue({ lastHueBridge: BRIDGE, hueAppKey: "app-key" });
      validateCredentialsMock.mockResolvedValue({
        status: { code: "HUE_CREDENTIAL_CHECK_FAILED", message: "offline", details: null },
        valid: false,
      });

      const { result } = renderHook(() => useHueOnboardingCore());

      await waitFor(() =>
        expect(result.current.state.credentialState).toBe(HUE_CREDENTIAL_STATUS.NEEDS_REPAIR),
      );
      expect(result.current.state.bridgeUnreachable).toBe(true);
    });

    it("keeps the bridge reachable when the bridge answers and rejects the key", async () => {
      shellLoadMock.mockResolvedValue({ lastHueBridge: BRIDGE, hueAppKey: "app-key" });
      validateCredentialsMock.mockResolvedValue({
        status: { code: "HUE_CREDENTIAL_INVALID", message: "rejected", details: null },
        valid: false,
      });

      const { result } = renderHook(() => useHueOnboardingCore());

      await waitFor(() =>
        expect(result.current.state.credentialState).toBe(HUE_CREDENTIAL_STATUS.NEEDS_REPAIR),
      );
      // A 403 is an auth problem, not an offline bridge — the card must show
      // the re-pair prompt rather than "offline".
      expect(result.current.state.bridgeUnreachable).toBe(false);
    });

    it("sets both fields together when the validate call itself rejects", async () => {
      shellLoadMock.mockResolvedValue({ lastHueBridge: BRIDGE, hueAppKey: "app-key" });
      validateCredentialsMock.mockRejectedValue(new Error("ipc transport died"));

      const { result } = renderHook(() => useHueOnboardingCore());

      await waitFor(() =>
        expect(result.current.state.credentialState).toBe(HUE_CREDENTIAL_STATUS.NEEDS_REPAIR),
      );
      // A thrown IPC error is not a 403; rendering "credentials expired" here
      // would send the user to re-pair a bridge that is merely unreachable.
      expect(result.current.state.bridgeUnreachable).toBe(true);
      expect(result.current.state.status?.code).toBe("HUE_CREDENTIAL_CHECK_FAILED");
    });
  });

  describe("a key refused mid-session", () => {
    const readiness = (code: HueStreamReadinessStatusCode) => ({
      status: { code, message: code, details: null },
      readiness: { ready: false, reasons: [] as string[] },
    });

    async function validatedCore() {
      shellLoadMock.mockResolvedValue({ lastHueBridge: BRIDGE, hueAppKey: "app-key" });
      validateCredentialsMock.mockResolvedValue({
        status: { code: "HUE_CREDENTIAL_VALID", message: "ok", details: null },
        valid: true,
      });
      const { result } = renderHook(() => useHueOnboardingCore());
      await waitFor(() =>
        expect(result.current.state.credentialState).toBe(HUE_CREDENTIAL_STATUS.VALID),
      );
      return result;
    }

    it("moves the card to re-pair when a readiness poll comes back AUTH_INVALID_RE_PAIR_REQUIRED", async () => {
      const result = await validatedCore();

      act(() => {
        result.current.applyBackgroundReadiness("area-1", readiness("AUTH_INVALID_RE_PAIR_REQUIRED"), Date.now());
      });

      expect(result.current.state.credentialState).toBe(HUE_CREDENTIAL_STATUS.NEEDS_REPAIR);
    });

    it("leaves a valid key alone when readiness fails for any other reason", async () => {
      const result = await validatedCore();

      act(() => {
        result.current.applyBackgroundReadiness("area-1", readiness("HUE_STREAM_READINESS_FAILED"), Date.now());
        result.current.applyBackgroundReadiness("area-1", readiness("HUE_STREAM_NOT_READY"), Date.now());
      });

      expect(result.current.state.credentialState).toBe(HUE_CREDENTIAL_STATUS.VALID);
    });
  });

  describe("I3 — bridgeUnreachable is sticky on HUE_PAIRING_FAILED", () => {
    it("preserves an existing unreachable flag when pairing fails ambiguously", async () => {
      shellLoadMock.mockResolvedValue({ lastHueBridge: BRIDGE, hueAppKey: "app-key" });
      validateCredentialsMock.mockResolvedValue({
        status: { code: "HUE_CREDENTIAL_CHECK_FAILED", message: "offline", details: null },
        valid: false,
      });
      pairBridgeMock.mockResolvedValue({
        status: { code: "HUE_PAIRING_FAILED", message: "failed", details: null },
        credentials: null,
      });

      const { result } = renderHook(() => useHueOnboardingCore());
      await waitFor(() => expect(result.current.state.bridgeUnreachable).toBe(true));

      await act(async () => {
        await result.current.pair();
      });

      expect(result.current.state.bridgeUnreachable).toBe(true);
    });

    it("clears the flag when the bridge answers the pairing request", async () => {
      shellLoadMock.mockResolvedValue({ lastHueBridge: BRIDGE, hueAppKey: "app-key" });
      validateCredentialsMock.mockResolvedValue({
        status: { code: "HUE_CREDENTIAL_CHECK_FAILED", message: "offline", details: null },
        valid: false,
      });
      pairBridgeMock.mockResolvedValue({
        status: { code: "HUE_PAIRING_LINK_BUTTON_NOT_PRESSED", message: "press it", details: null },
        credentials: null,
      });

      const { result } = renderHook(() => useHueOnboardingCore());
      await waitFor(() => expect(result.current.state.bridgeUnreachable).toBe(true));

      await act(async () => {
        await result.current.pair();
      });

      expect(result.current.state.bridgeUnreachable).toBe(false);
    });

    it("does not invent an unreachable bridge when pairing fails from a clean slate", async () => {
      pairBridgeMock.mockResolvedValue({
        status: { code: "HUE_PAIRING_FAILED", message: "failed", details: null },
        credentials: null,
      });

      const result = await selectBridgeAndPair();

      expect(result.current.state.bridgeUnreachable).toBe(false);
      expect(result.current.state.credentialState).toBe(HUE_CREDENTIAL_STATUS.NEEDS_REPAIR);
    });
  });
});

describe("useHueOnboardingCore — pairing announces itself", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetHueHealthStoreForTests();
    shellLoadMock.mockResolvedValue({});
    shellSaveMock.mockResolvedValue(undefined);
    listAreasMock.mockResolvedValue({
      status: { code: "HUE_AREA_LIST_OK", message: "ok", details: null },
      areas: [],
    });
  });

  // Nothing else tells App a bridge was paired, so a missed emit leaves the
  // start-config mirror on null until the user happens to switch mode.
  it("emits once the credentials are persisted", async () => {
    pairBridgeMock.mockResolvedValue({
      status: { code: "HUE_PAIRING_OK", message: "ok", details: null },
      credentials: { username: "app-user", clientKey: "AABBCCDD" },
      credentialStorageBackend: "keychain",
    });
    const seen: string[] = [];
    const unsubscribe = hueCredentialEvents.subscribe((event) => seen.push(event.reason));

    await selectBridgeAndPair();

    expect(seen).toContain("paired");
    unsubscribe();
  });

  it("stays silent when the bridge refuses to pair", async () => {
    pairBridgeMock.mockResolvedValue({
      status: { code: "HUE_PAIRING_LINK_BUTTON_NOT_PRESSED", message: "press it", details: null },
      credentials: null,
    });
    const seen: string[] = [];
    const unsubscribe = hueCredentialEvents.subscribe((event) => seen.push(event.reason));

    await selectBridgeAndPair();

    expect(seen).not.toContain("paired");
    unsubscribe();
  });
});
