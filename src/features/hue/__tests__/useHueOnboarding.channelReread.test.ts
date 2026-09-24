/**
 * useHueOnboarding — when the channel list is re-read from the bridge.
 *
 * The list is what the channel map's "does the bridge have this arrangement"
 * verdict compares against. Read once per area, it went stale the moment the
 * layout changed in the Hue app, and "Validate again" did not touch it.
 */

import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { HUE_CREDENTIAL_STATUS } from "@/shared/contracts/hue";
import { __resetHueHealthStoreForTests } from "../state/hueHealthStore";
import { resetHealth, runtimeStatus, setHealth } from "./fakeHueHealth";

const getAreaChannelsMock = vi.fn();

vi.mock("../hueHealthApi", async () => (await import("./fakeHueHealth")).fakeHueHealthApi);

vi.mock("@/features/mode/modeApi", () => ({
  restartHue: vi.fn(),
  startHue: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/features/persistence/shellStore", () => ({
  shellStore: {
    load: vi.fn().mockResolvedValue({
      lastHueBridge: { id: "bridge-1", ip: "192.168.1.20", name: "Bridge" },
      hueAppKey: "app-user",
      hueClientKey: "client-key",
      hueCredentialStatus: "valid",
      lastHueAreaId: "area-1",
    }),
    save: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("../hueOnboardingApi", () => ({
  checkHueStreamReadiness: vi.fn().mockResolvedValue({
    status: { code: "HUE_STREAM_READY", message: "ok", details: null },
    readiness: { ready: true, reasons: [] },
  }),
  discoverHueBridges: vi.fn(),
  getHueAreaChannels: (...args: unknown[]) => getAreaChannelsMock(...args),
  listHueEntertainmentAreas: vi.fn().mockResolvedValue({
    status: { code: "HUE_AREA_LIST_OK", message: "ok", details: null },
    areas: [{ id: "area-1", name: "Living Room", roomName: "Salon", channelCount: 1 }],
  }),
  migrateHueCredentials: vi.fn().mockResolvedValue({
    status: { code: "HUE_CREDENTIAL_MIGRATION_FAILED", message: "no keychain" },
    backend: "plaintext-legacy",
  }),
  pairHueBridge: vi.fn(),
  validateHueCredentials: vi.fn().mockResolvedValue({
    valid: true,
    status: { code: "HUE_CREDENTIAL_VALID", message: "valid", details: null },
  }),
  verifyHueBridgeIp: vi.fn(),
}));

function streamIs(state: "Idle" | "Running") {
  setHealth({ stream: { active: state !== "Idle", status: runtimeStatus(state) } });
}

import { useHueOnboarding } from "../useHueOnboarding";

async function mountWithArea() {
  const view = renderHook(() => useHueOnboarding());
  await waitFor(() => expect(view.result.current.credentialState).toBe(HUE_CREDENTIAL_STATUS.VALID));
  await waitFor(() => expect(getAreaChannelsMock).toHaveBeenCalled());
  await waitFor(() => expect(view.result.current.isLoadingChannels).toBe(false));
  return view;
}

describe("useHueOnboarding channel re-read", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetHueHealthStoreForTests();
    resetHealth();
    getAreaChannelsMock.mockResolvedValue({
      status: { code: "HUE_AREA_CHANNELS_EMPTY", message: "", details: null },
      channels: [],
    });
  });

  it("re-reads the channels when the user validates the area again", async () => {
    const { result } = await mountWithArea();
    const before = getAreaChannelsMock.mock.calls.length;

    await act(async () => {
      await result.current.revalidateArea();
    });

    await waitFor(() => expect(getAreaChannelsMock.mock.calls.length).toBe(before + 1));
  });

  it("re-reads the channels once lighting stops, replacing the list that echoed ours", async () => {
    streamIs("Running");
    const { result } = await mountWithArea();
    await waitFor(() => expect(result.current.runtimeStatus?.state).toBe("Running"));
    const before = getAreaChannelsMock.mock.calls.length;

    // `startRuntime` ends in a fresh status read, which is the transition a
    // stop is observed through.
    streamIs("Idle");
    await act(async () => {
      await result.current.startRuntime();
    });

    await waitFor(() => expect(result.current.runtimeStatus?.state).toBe("Idle"));
    await waitFor(() => expect(getAreaChannelsMock.mock.calls.length).toBe(before + 1));
    await waitFor(() => expect(result.current.channelsFromBridge).toBe(true));
  });
});
