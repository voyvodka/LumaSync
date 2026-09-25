// First contact and a bridge DHCP moved: which bridge a scan selects, what a
// fresh install calls its credential state, and where a known bridge is
// remembered after it answers at a new address.

import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { HUE_CREDENTIAL_STATUS } from "@/shared/contracts/hue";
import type { ShellState } from "@/shared/contracts/shell";
import { __resetHueHealthStoreForTests } from "../hueHealthStore";
import { useHueOnboardingCore } from "../useHueOnboardingCore";
import type * as hueOnboardingApiModule from "../../hueOnboardingApi";

const shellLoadMock = vi.fn<() => Promise<Partial<ShellState>>>();
const shellSaveMock = vi.fn<(partial: Partial<ShellState>) => Promise<void>>();
const discoverBridgesMock = vi.fn<typeof hueOnboardingApiModule.discoverHueBridges>();
const listAreasMock = vi.fn<typeof hueOnboardingApiModule.listHueEntertainmentAreas>();
const validateCredentialsMock = vi.fn<typeof hueOnboardingApiModule.validateHueCredentials>();
const verifyIpMock = vi.fn<typeof hueOnboardingApiModule.verifyHueBridgeIp>();

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
  pairHueBridge: vi.fn<typeof hueOnboardingApiModule.pairHueBridge>(),
  validateHueCredentials: (...args: Parameters<typeof validateCredentialsMock>) => validateCredentialsMock(...args),
  verifyHueBridgeIp: (...args: Parameters<typeof verifyIpMock>) => verifyIpMock(...args),
}));

const LIVING = { id: "001788fffe7e57b1", ip: "192.168.1.20", name: "Living room" };
const OFFICE = { id: "001788fffe000002", ip: "192.168.1.30", name: "Office" };
const discovered = (...bridges: Array<typeof LIVING>) => ({
  status: { code: "HUE_DISCOVERY_OK" as const, message: "ok", details: null },
  bridges,
});

async function mount() {
  const hook = renderHook(() => useHueOnboardingCore());
  await waitFor(() => expect(shellLoadMock).toHaveBeenCalled());
  return hook;
}

describe("useHueOnboardingCore — discovery", () => {
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

  describe("first contact (H-5)", () => {
    it("never calls an install with no stored key one that needs re-pairing", async () => {
      const { result } = await mount();
      await waitFor(() => expect(result.current.state.credentialState).toBe(HUE_CREDENTIAL_STATUS.UNKNOWN));
      expect(validateCredentialsMock).not.toHaveBeenCalled();
    });

    it("leaves the choice to the user when a scan finds several bridges", async () => {
      discoverBridgesMock.mockResolvedValue(discovered(LIVING, OFFICE));
      const { result } = await mount();
      await act(async () => {
        await result.current.discover();
      });
      expect(result.current.state.bridges).toHaveLength(2);
      expect(result.current.state.selectedBridgeId).toBeNull();
    });

    it("selects the only bridge a scan finds", async () => {
      discoverBridgesMock.mockResolvedValue(discovered(LIVING));
      const { result } = await mount();
      await act(async () => {
        await result.current.discover();
      });
      expect(result.current.state.selectedBridgeId).toBe(LIVING.id);
    });
  });

  describe("a paired bridge DHCP moved (H-4)", () => {
    const MOVED_IP = "192.168.1.77";

    beforeEach(() => {
      shellLoadMock.mockResolvedValue({ lastHueBridge: LIVING, hueAppKey: "app-key", hueClientKey: "AABB" });
      validateCredentialsMock.mockImplementation(async (ip) =>
        ip === MOVED_IP
          ? { status: { code: "HUE_CREDENTIAL_VALID", message: "ok", details: null }, valid: true }
          : { status: { code: "HUE_CREDENTIAL_CHECK_FAILED", message: "offline", details: null }, valid: false },
      );
    });

    async function offlineAtOldAddress() {
      const hook = await mount();
      await waitFor(() => expect(hook.result.current.state.bridgeUnreachable).toBe(true));
      return hook;
    }

    it("follows the bridge a rediscovery finds at a new address, under either id case", async () => {
      // Cloud discovery answers in lower case, /api/config in upper case.
      discoverBridgesMock.mockResolvedValue(
        discovered({ ...LIVING, id: LIVING.id.toUpperCase(), ip: MOVED_IP, name: "Hue Bridge" }),
      );
      const { result } = await offlineAtOldAddress();

      await act(async () => {
        await result.current.discover();
      });

      expect(result.current.state.bridges).toEqual([{ ...LIVING, ip: MOVED_IP }]);
      expect(result.current.state.selectedBridgeId).toBe(LIVING.id);
      expect(shellSaveMock).toHaveBeenCalledWith({ lastHueBridge: { ...LIVING, ip: MOVED_IP } });
      expect(validateCredentialsMock).toHaveBeenLastCalledWith(MOVED_IP, "app-key", "AABB");
      expect(result.current.state.bridgeUnreachable).toBe(false);
      expect(result.current.state.credentialState).toBe(HUE_CREDENTIAL_STATUS.VALID);
    });

    it("follows the bridge to an address typed on the offline card", async () => {
      verifyIpMock.mockResolvedValue({
        status: { code: "HUE_IP_VALID", message: "ok", details: null },
        bridge: { ...LIVING, ip: MOVED_IP, name: "Hue Bridge" },
      });
      const { result } = await offlineAtOldAddress();

      act(() => {
        result.current.setManualIp(MOVED_IP);
      });
      await act(async () => {
        await result.current.submitManualIp();
      });

      expect(result.current.state.bridges[0]).toEqual({ ...LIVING, ip: MOVED_IP });
      expect(shellSaveMock).toHaveBeenCalledWith({ lastHueBridge: { ...LIVING, ip: MOVED_IP } });
      expect(result.current.state.credentials).not.toBeNull();
      expect(result.current.state.bridgeUnreachable).toBe(false);
    });

    it("keeps the paired bridge when a rediscovery does not find it", async () => {
      discoverBridgesMock.mockResolvedValue(discovered(OFFICE));
      const { result } = await offlineAtOldAddress();

      await act(async () => {
        await result.current.discover();
      });

      expect(result.current.state.selectedBridgeId).toBe(LIVING.id);
      expect(shellSaveMock).not.toHaveBeenCalledWith(expect.objectContaining({ lastHueBridge: expect.anything() }));
    });
  });
});
