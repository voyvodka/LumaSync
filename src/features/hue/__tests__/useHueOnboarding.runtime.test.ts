import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  HUE_CREDENTIAL_STATUS,
  HUE_RUNTIME_TRIGGER_SOURCE,
  type HueRuntimeStatus,
} from "@/shared/contracts/hue";
import { __resetHueHealthStoreForTests } from "../state/hueHealthStore";
import { fakeHueHealthApi, resetHealth } from "./fakeHueHealth";

const restartHueMock = vi.fn();
const shellLoadMock = vi.fn();
const shellSaveMock = vi.fn();
const listAreasMock = vi.fn();
const validateCredentialsMock = vi.fn();

vi.mock("../hueHealthApi", async () => (await import("./fakeHueHealth")).fakeHueHealthApi);

vi.mock("@/features/mode/modeApi", () => ({
  restartHue: (...args: unknown[]) => restartHueMock(...args),
  startHue: vi.fn(),
}));

vi.mock("@/features/persistence/shellStore", () => ({
  shellStore: {
    load: () => shellLoadMock(),
    save: (...args: unknown[]) => shellSaveMock(...args),
  },
}));

vi.mock("../hueOnboardingApi", () => ({
  // The readiness poller chains .then() onto this; a bare vi.fn() resolves to
  // undefined and the chain throws into the poller's own catch instead.
  checkHueStreamReadiness: vi.fn().mockResolvedValue({
    status: { code: "HUE_STREAM_READY", message: "ok", details: null },
    readiness: { ready: true, reasons: [] },
  }),
  discoverHueBridges: vi.fn(),
  getHueAreaChannels: vi.fn().mockResolvedValue({
    status: { code: "HUE_AREA_CHANNELS_EMPTY", message: "", details: null },
    channels: [],
  }),
  listHueEntertainmentAreas: (...args: unknown[]) => listAreasMock(...args),
  migrateHueCredentials: vi.fn().mockResolvedValue({
    status: { code: "HUE_CREDENTIAL_MIGRATION_FAILED", message: "no keychain" },
    backend: "plaintext-legacy",
  }),
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
  };
}

describe("useHueOnboarding runtime wiring", () => {
  let useHueOnboardingHook: () => Record<string, unknown>;

  beforeEach(async () => {
    restartHueMock.mockReset();
    shellLoadMock.mockReset();
    shellSaveMock.mockReset();
    listAreasMock.mockReset();
    validateCredentialsMock.mockReset();
    // The hook reads status through the shared store, which outlives a test.
    __resetHueHealthStoreForTests();
    resetHealth({ stream: { active: true, status: runtimeStatusFixture() as HueRuntimeStatus } });

    shellLoadMock.mockResolvedValue({});
    shellSaveMock.mockResolvedValue(undefined);
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

    const hookModule = await import("../useHueOnboarding");
    useHueOnboardingHook = hookModule.useHueOnboarding as unknown as () => Record<string, unknown>;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function mountProbe() {
    return renderHook(() => useHueOnboardingHook());
  }

  // The Devices tab used to poll the runtime every 10 s while streaming. The
  // health monitor publishes it instead; the tab only declares that it wants
  // the area's readiness while it is mounted.
  it("reads the runtime status the monitor publishes and declares its interest, without a poll", async () => {
    const { result, unmount } = mountProbe();

    await waitFor(() => {
      expect((result.current.runtimeStatus as { code?: string } | null)?.code).toBe(
        "TRANSIENT_RETRY_SCHEDULED",
      );
    });
    expect(fakeHueHealthApi.getHueHealth).not.toHaveBeenCalled();
    expect(fakeHueHealthApi.watchHueHealth).toHaveBeenLastCalledWith({
      visible: true,
      areaReadiness: true,
    });

    unmount();
    expect(fakeHueHealthApi.watchHueHealth).toHaveBeenLastCalledWith({
      visible: false,
      areaReadiness: false,
    });
  });

  it("maps runtime status to runtimeTargets with retry metadata", async () => {
    const hookModule = await import("../useHueOnboarding");

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

    // Wait for hook initialization to load bridge/credentials from shell store
    await waitFor(() => {
      expect(result.current.credentials).toBeTruthy();
    });

    await act(async () => {
      await (result.current.retryRuntimeTarget as ((target: string) => Promise<void>) | undefined)?.("hue");
    });

    expect(restartHueMock).toHaveBeenCalledWith({
      bridgeIp: "192.168.1.20",
      username: "app-user",
      clientKey: "client-key",
      areaId: "area-1",
      triggerSource: HUE_RUNTIME_TRIGGER_SOURCE.DEVICE_SURFACE,
    });
  });
});
