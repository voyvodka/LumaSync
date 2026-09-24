import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { HUE_CREDENTIAL_STATUS, HUE_READINESS_REASON } from "@/shared/contracts/hue";
import type { HueAreaHealth } from "@/shared/contracts/hueHealth";

import { __resetHueHealthStoreForTests } from "../state/hueHealthStore";
import { publishHealth, resetHealth } from "./fakeHueHealth";

const shellLoadMock = vi.fn();
const listAreasMock = vi.fn<typeof hueOnboardingApiModule.listHueEntertainmentAreas>();
const checkReadinessMock = vi.fn<typeof hueOnboardingApiModule.checkHueStreamReadiness>();

vi.mock("../hueHealthApi", async () => (await import("./fakeHueHealth")).fakeHueHealthApi);

vi.mock("@/features/mode/modeApi", () => ({
  restartHue: vi.fn<typeof modeApiModule.restartHue>(),
  startHue: vi.fn<typeof modeApiModule.startHue>(),
}));

vi.mock("@/features/persistence/shellStore", () => ({
  shellStore: {
    load: () => shellLoadMock(),
    save: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("../hueOnboardingApi", () => ({
  checkHueStreamReadiness: (...args: Parameters<typeof checkReadinessMock>) => checkReadinessMock(...args),
  discoverHueBridges: vi.fn<typeof hueOnboardingApiModule.discoverHueBridges>(),
  getHueAreaChannels: vi.fn<typeof hueOnboardingApiModule.getHueAreaChannels>().mockResolvedValue({
    status: { code: "HUE_AREA_CHANNELS_EMPTY", message: "", details: null },
    channels: [],
  }),
  listHueEntertainmentAreas: (...args: Parameters<typeof listAreasMock>) => listAreasMock(...args),
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

import { useHueOnboarding } from "../useHueOnboarding";
import type * as modeApiModule from "@/features/mode/modeApi";
import type * as hueOnboardingApiModule from "../hueOnboardingApi";

function areaHealth(blocked: boolean, areaId = "area-1"): HueAreaHealth {
  return {
    areaId,
    status: blocked
      ? { code: "HUE_STREAM_NOT_READY", message: "blocked", details: null }
      : { code: "HUE_STREAM_READY", message: "ready", details: null },
    readiness: {
      ready: !blocked,
      reasons: blocked ? [HUE_READINESS_REASON.ACTIVE_STREAMER] : [],
    },
    checkedAtMs: Date.now(),
  };
}

type Row = { activeStreamer?: boolean; readiness: { ready: boolean } | null };
const firstRow = (current: ReturnType<typeof useHueOnboarding>) =>
  current.areaGroups[0]?.areas[0] as Row | undefined;

describe("useHueOnboarding — A3.1 active-streamer banner auto-clear", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetHueHealthStoreForTests();
    resetHealth();
    shellLoadMock.mockResolvedValue({
      lastHueBridge: { id: "bridge-1", ip: "192.168.1.20", name: "Bridge" },
      hueAppKey: "app-user",
      hueClientKey: "client-key",
      hueCredentialStatus: HUE_CREDENTIAL_STATUS.VALID,
      lastHueAreaId: "area-1",
    });
    // Initial area listing reports a foreign streamer attached.
    listAreasMock.mockResolvedValue({
      status: { code: "HUE_AREA_LIST_OK", message: "ok", details: null },
      areas: [{ id: "area-1", name: "Living Room", roomName: "Salon", channelCount: 3, activeStreamer: true }],
    });
  });

  // The monitor re-reads a held area every 3 s; each answer it publishes lands
  // on the row, so the banner clears without the user pressing revalidate.
  it("clears area.activeStreamer as soon as the monitor publishes the area free", async () => {
    const { result } = renderHook(() => useHueOnboarding());
    await waitFor(() => expect(firstRow(result.current)?.activeStreamer).toBe(true));

    act(() => {
      publishHealth({ area: areaHealth(true) });
    });
    await waitFor(() => expect(firstRow(result.current)?.readiness?.ready).toBe(false));
    expect(firstRow(result.current)?.activeStreamer).toBe(true);

    act(() => {
      publishHealth({ area: areaHealth(false) });
    });
    await waitFor(() => expect(firstRow(result.current)?.readiness?.ready).toBe(true));
    expect(firstRow(result.current)?.activeStreamer).toBe(false);
    // Nothing here asked the bridge itself.
    expect(checkReadinessMock).not.toHaveBeenCalled();
  });

  it("leaves the row alone when the published readiness is for another area", async () => {
    const { result } = renderHook(() => useHueOnboarding());
    await waitFor(() => expect(firstRow(result.current)?.activeStreamer).toBe(true));

    act(() => {
      publishHealth({ area: areaHealth(false, "area-2") });
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(firstRow(result.current)?.readiness).toBeNull();
    expect(firstRow(result.current)?.activeStreamer).toBe(true);
  });

  it("keeps the readiness fresh by the monitor's clock, not the time it arrived", async () => {
    const { result } = renderHook(() => useHueOnboarding());
    await waitFor(() => expect(firstRow(result.current)?.activeStreamer).toBe(true));

    act(() => {
      publishHealth({ area: { ...areaHealth(false), checkedAtMs: Date.now() - 60_000 } });
    });
    await waitFor(() => expect(firstRow(result.current)?.readiness?.ready).toBe(true));
    expect(result.current.isReadinessStale).toBe(true);
    expect(result.current.canStartHue).toBe(false);
  });
});
