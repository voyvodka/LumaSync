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

const getAreaChannelsMock = vi.fn<typeof hueOnboardingApiModule.getHueAreaChannels>();

vi.mock("../hueHealthApi", async () => (await import("./fakeHueHealth")).fakeHueHealthApi);

vi.mock("@/features/mode/modeApi", async () => {
  const { runtimeResult } = await import("./fakeHueHealth");
  return {
    restartHue: vi.fn<typeof modeApiModule.restartHue>(),
    startHue: vi.fn<typeof modeApiModule.startHue>().mockResolvedValue(runtimeResult()),
  };
});

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
  checkHueStreamReadiness: vi.fn<typeof hueOnboardingApiModule.checkHueStreamReadiness>().mockResolvedValue({
    status: { code: "HUE_STREAM_READY", message: "ok", details: null },
    readiness: { ready: true, reasons: [] },
  }),
  discoverHueBridges: vi.fn<typeof hueOnboardingApiModule.discoverHueBridges>(),
  getHueAreaChannels: (...args: Parameters<typeof getAreaChannelsMock>) => getAreaChannelsMock(...args),
  listHueEntertainmentAreas: vi.fn<typeof hueOnboardingApiModule.listHueEntertainmentAreas>().mockResolvedValue({
    status: { code: "HUE_AREA_LIST_OK", message: "ok", details: null },
    areas: [{ id: "area-1", name: "Living Room", roomName: "Salon", channelCount: 1, activeStreamer: false }],
  }),
  migrateHueCredentials: vi.fn<typeof hueOnboardingApiModule.migrateHueCredentials>().mockResolvedValue({
    status: { code: "HUE_CREDENTIAL_MIGRATION_FAILED", message: "no keychain", details: null },
    backend: "plaintext-legacy",
  }),
  pairHueBridge: vi.fn<typeof hueOnboardingApiModule.pairHueBridge>(),
  validateHueCredentials: vi.fn<typeof hueOnboardingApiModule.validateHueCredentials>().mockResolvedValue({
    valid: true,
    status: { code: "HUE_CREDENTIAL_VALID", message: "valid", details: null },
  }),
  verifyHueBridgeIp: vi.fn<typeof hueOnboardingApiModule.verifyHueBridgeIp>(),
}));

function streamIs(state: "Idle" | "Running") {
  setHealth({ stream: { active: state !== "Idle", status: runtimeStatus(state) } });
}

import { useHueOnboarding } from "../useHueOnboarding";
import type * as modeApiModule from "@/features/mode/modeApi";
import type * as hueOnboardingApiModule from "../hueOnboardingApi";

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
