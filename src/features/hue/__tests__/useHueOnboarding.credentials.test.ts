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
  getHueAreaChannels: vi.fn().mockResolvedValue({
    status: { code: "HUE_AREA_CHANNELS_EMPTY", message: "", details: null },
    channels: [],
  }),
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

  it("writes neither secret in plaintext when the keychain owns them", async () => {
    const saved = await pairWith(HUE_CREDENTIAL_BACKENDS.KEYCHAIN);

    expect(saved.hueClientKey).toBeUndefined();
    expect(saved.hueAppKey).toBeUndefined();
    expect(saved.credentialStorageBackend).toBe(HUE_CREDENTIAL_BACKENDS.KEYCHAIN);
  });

  it("keeps both plaintext secrets when the keychain was unavailable", async () => {
    const saved = await pairWith(HUE_CREDENTIAL_BACKENDS.PLAINTEXT_LEGACY);

    expect(saved.hueClientKey).toBe("psk-deadbeef");
    expect(saved.hueAppKey).toBe("app-key-abc");
    expect(saved.credentialStorageBackend).toBe(HUE_CREDENTIAL_BACKENDS.PLAINTEXT_LEGACY);
  });

  it("treats an absent backend as legacy and keeps both plaintext secrets", async () => {
    const saved = await pairWith(undefined);

    expect(saved.hueClientKey).toBe("psk-deadbeef");
    expect(saved.hueAppKey).toBe("app-key-abc");
    expect(saved.credentialStorageBackend).toBe(HUE_CREDENTIAL_BACKENDS.PLAINTEXT_LEGACY);
  });

  it("treats an unrecognised backend as legacy and keeps both plaintext secrets", async () => {
    // Rust's CredentialBackend::as_str can emit "noop", which is outside the
    // TS union — it must never be read as permission to delete.
    const saved = await pairWith("noop");

    expect(saved.hueClientKey).toBe("psk-deadbeef");
    expect(saved.hueAppKey).toBe("app-key-abc");
    expect(saved.credentialStorageBackend).toBe(HUE_CREDENTIAL_BACKENDS.PLAINTEXT_LEGACY);
  });

  it("keeps both plaintext secrets when a debug build stored them in its dev file", async () => {
    // A dev-only file no release build can read is not permission to delete
    // the copy that release build would need.
    const saved = await pairWith(HUE_CREDENTIAL_BACKENDS.DEV_FILE);

    expect(saved.hueClientKey).toBe("psk-deadbeef");
    expect(saved.hueAppKey).toBe("app-key-abc");
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

  it("restores a keychain-backed pairing whose app key is no longer on disk", async () => {
    shellLoadMock.mockResolvedValue({
      lastHueBridge: BRIDGE,
      credentialStorageBackend: HUE_CREDENTIAL_BACKENDS.KEYCHAIN,
      hueCredentialStatus: HUE_CREDENTIAL_STATUS.VALID,
    });
    validateCredentialsMock.mockResolvedValue({
      status: { code: "HUE_CREDENTIAL_OK", message: "ok" },
      valid: true,
    });

    const { result } = renderHook(() => useHueOnboarding());

    // The empty username is the signal that Rust must resolve the key itself.
    await waitFor(() => expect(validateCredentialsMock).toHaveBeenCalledWith(BRIDGE.ip, "", ""));
    await waitFor(() => expect(listAreasMock).toHaveBeenCalledWith(BRIDGE.ip, ""));
    await waitFor(() =>
      expect(result.current.credentialState).not.toBe(HUE_CREDENTIAL_STATUS.NEEDS_REPAIR),
    );
    expect(result.current.credentials?.username).toBe("");
  });

  it("stays unpaired when neither an app key nor a keychain backend is stored", async () => {
    shellLoadMock.mockResolvedValue({ lastHueBridge: BRIDGE });

    const { result } = renderHook(() => useHueOnboarding());

    await waitFor(() => expect(shellLoadMock).toHaveBeenCalled());
    expect(validateCredentialsMock).not.toHaveBeenCalled();
    expect(result.current.credentials).toBeNull();
  });

  it("clears both stored secrets at boot only once the migration proves the keychain holds them", async () => {
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
        hueAppKey: undefined,
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
