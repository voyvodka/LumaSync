import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HUE_CREDENTIAL_BACKENDS, HUE_CREDENTIAL_STATUS } from "@/shared/contracts/hue";
import { __resetHueReadCacheForTests } from "../hueReadCache";
import { useHueOnboarding } from "../useHueOnboarding";

const shellLoadMock = vi.fn();
const shellSaveMock = vi.fn();
const discoverBridgesMock = vi.fn();
const pairBridgeMock = vi.fn();
const listAreasMock = vi.fn();
const validateCredentialsMock = vi.fn();
const migrateCredentialsMock = vi.fn();

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
  checkHueStreamReadiness: vi.fn(),
  discoverHueBridges: (...args: unknown[]) => discoverBridgesMock(...args),
  getHueAreaChannels: vi.fn().mockResolvedValue([]),
  listHueEntertainmentAreas: (...args: unknown[]) => listAreasMock(...args),
  migrateHueCredentials: (...args: unknown[]) => migrateCredentialsMock(...args),
  pairHueBridge: (...args: unknown[]) => pairBridgeMock(...args),
  validateHueCredentials: (...args: unknown[]) => validateCredentialsMock(...args),
  verifyHueBridgeIp: vi.fn(),
}));

const BRIDGE = { id: "bridge-1", ip: "192.168.1.20", name: "Test Bridge" };
const OK_STATUS = { code: "HUE_PAIRING_OK", message: "Paired." };

function pairResponse(credentialStorageBackend?: string) {
  return {
    status: OK_STATUS,
    credentials: { username: "app-key-abc", clientKey: "psk-deadbeef" },
    ...(credentialStorageBackend === undefined ? {} : { credentialStorageBackend }),
  };
}

/** Drive the hook through discover → selectBridge → pair. */
async function pairWith(credentialStorageBackend?: string) {
  discoverBridgesMock.mockResolvedValue({
    status: { code: "HUE_DISCOVERY_OK", message: "ok" },
    bridges: [BRIDGE],
  });
  pairBridgeMock.mockResolvedValue(pairResponse(credentialStorageBackend));

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

  const saved = shellSaveMock.mock.calls
    .map(([payload]) => payload as Record<string, unknown>)
    .find((payload) => "hueAppKey" in payload);
  expect(saved).toBeDefined();
  return saved as Record<string, unknown>;
}

describe("useHueOnboarding credential persistence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetHueReadCacheForTests();
    shellLoadMock.mockResolvedValue({});
    shellSaveMock.mockResolvedValue(undefined);
    listAreasMock.mockResolvedValue({
      status: { code: "HUE_AREA_LIST_OK", message: "ok" },
      areas: [],
    });
    migrateCredentialsMock.mockResolvedValue({
      status: { code: "HUE_CREDENTIAL_MIGRATION_FAILED", message: "no keychain" },
      backend: HUE_CREDENTIAL_BACKENDS.PLAINTEXT_LEGACY,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("never writes the plaintext PSK when the keychain owns it", async () => {
    const saved = await pairWith(HUE_CREDENTIAL_BACKENDS.KEYCHAIN);

    expect(saved.hueClientKey).toBeUndefined();
    expect(saved.hueAppKey).toBe("app-key-abc");
    expect(saved.credentialStorageBackend).toBe(HUE_CREDENTIAL_BACKENDS.KEYCHAIN);
  });

  it("keeps the plaintext PSK when the keychain was unavailable", async () => {
    const saved = await pairWith(HUE_CREDENTIAL_BACKENDS.PLAINTEXT_LEGACY);

    expect(saved.hueClientKey).toBe("psk-deadbeef");
    expect(saved.hueAppKey).toBe("app-key-abc");
    expect(saved.credentialStorageBackend).toBe(HUE_CREDENTIAL_BACKENDS.PLAINTEXT_LEGACY);
  });

  it("treats an absent backend as legacy and keeps the plaintext PSK", async () => {
    const saved = await pairWith(undefined);

    expect(saved.hueClientKey).toBe("psk-deadbeef");
    expect(saved.credentialStorageBackend).toBe(HUE_CREDENTIAL_BACKENDS.PLAINTEXT_LEGACY);
  });

  it("treats an unrecognised backend as legacy and keeps the plaintext PSK", async () => {
    // Rust's CredentialBackend::as_str can emit "noop", which is outside the
    // TS union — it must never be read as permission to delete.
    const saved = await pairWith("noop");

    expect(saved.hueClientKey).toBe("psk-deadbeef");
    expect(saved.credentialStorageBackend).toBe(HUE_CREDENTIAL_BACKENDS.PLAINTEXT_LEGACY);
  });

  it("restores a keychain-backed pairing on boot without a stored client key", async () => {
    shellLoadMock.mockResolvedValue({
      lastHueBridge: BRIDGE,
      hueAppKey: "app-key-abc",
      credentialStorageBackend: HUE_CREDENTIAL_BACKENDS.KEYCHAIN,
      hueCredentialStatus: HUE_CREDENTIAL_STATUS.VALID,
    });
    validateCredentialsMock.mockResolvedValue({
      status: { code: "HUE_CREDENTIAL_OK", message: "ok" },
      valid: true,
    });

    const { result } = renderHook(() => useHueOnboarding());

    await waitFor(() => expect(validateCredentialsMock).toHaveBeenCalled());
    expect(validateCredentialsMock).toHaveBeenCalledWith(BRIDGE.ip, "app-key-abc", "");

    await waitFor(() =>
      expect(result.current.credentialState).not.toBe(HUE_CREDENTIAL_STATUS.NEEDS_REPAIR),
    );
    expect(result.current.credentials).not.toBeNull();
    expect(result.current.credentials?.username).toBe("app-key-abc");
  });

  it("does not re-run the keychain migration once the store reports keychain", async () => {
    shellLoadMock.mockResolvedValue({
      lastHueBridge: BRIDGE,
      hueAppKey: "app-key-abc",
      credentialStorageBackend: HUE_CREDENTIAL_BACKENDS.KEYCHAIN,
    });
    validateCredentialsMock.mockResolvedValue({
      status: { code: "HUE_CREDENTIAL_OK", message: "ok" },
      valid: true,
    });

    renderHook(() => useHueOnboarding());

    await waitFor(() => expect(validateCredentialsMock).toHaveBeenCalled());
    expect(migrateCredentialsMock).not.toHaveBeenCalled();
  });

  it("clears the stored PSK at boot only once the migration proves the keychain holds it", async () => {
    shellLoadMock.mockResolvedValue({
      lastHueBridge: BRIDGE,
      hueAppKey: "app-key-abc",
      hueClientKey: "psk-deadbeef",
    });
    validateCredentialsMock.mockResolvedValue({
      status: { code: "HUE_CREDENTIAL_OK", message: "ok" },
      valid: true,
    });
    migrateCredentialsMock.mockResolvedValue({
      status: { code: "HUE_CREDENTIAL_MIGRATION_OK", message: "ok" },
      backend: HUE_CREDENTIAL_BACKENDS.KEYCHAIN,
    });

    renderHook(() => useHueOnboarding());

    await waitFor(() => expect(migrateCredentialsMock).toHaveBeenCalledWith("app-key-abc", "psk-deadbeef"));
    await waitFor(() =>
      expect(shellSaveMock).toHaveBeenCalledWith({
        hueClientKey: undefined,
        credentialStorageBackend: HUE_CREDENTIAL_BACKENDS.KEYCHAIN,
      }),
    );
  });

  it("leaves the stored PSK untouched when the boot migration fails", async () => {
    shellLoadMock.mockResolvedValue({
      lastHueBridge: BRIDGE,
      hueAppKey: "app-key-abc",
      hueClientKey: "psk-deadbeef",
    });
    validateCredentialsMock.mockResolvedValue({
      status: { code: "HUE_CREDENTIAL_OK", message: "ok" },
      valid: true,
    });

    renderHook(() => useHueOnboarding());

    await waitFor(() => expect(migrateCredentialsMock).toHaveBeenCalled());
    const clearedPsk = shellSaveMock.mock.calls.some(
      ([payload]) => (payload as Record<string, unknown>).credentialStorageBackend === HUE_CREDENTIAL_BACKENDS.KEYCHAIN,
    );
    expect(clearedPsk).toBe(false);
  });

  it("survives a migration command that rejects", async () => {
    shellLoadMock.mockResolvedValue({
      lastHueBridge: BRIDGE,
      hueAppKey: "app-key-abc",
      hueClientKey: "psk-deadbeef",
    });
    validateCredentialsMock.mockResolvedValue({
      status: { code: "HUE_CREDENTIAL_OK", message: "ok" },
      valid: true,
    });
    migrateCredentialsMock.mockRejectedValue(new Error("command not found"));

    renderHook(() => useHueOnboarding());

    await waitFor(() => expect(validateCredentialsMock).toHaveBeenCalled());
    const clearedPsk = shellSaveMock.mock.calls.some(
      ([payload]) => (payload as Record<string, unknown>).credentialStorageBackend === HUE_CREDENTIAL_BACKENDS.KEYCHAIN,
    );
    expect(clearedPsk).toBe(false);
  });
});
