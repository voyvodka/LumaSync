// A rejected runtime-status read used to be minted into a `Failed` runtime
// state: the card mapped it to "Ready" and the Devices-tab loop, which polled
// only while streaming, went silent — so a blip left the card claiming Ready
// until something else invalidated the status. The health store keeps the
// last snapshot beside the rejection and re-asks on a backoff. Real runtime
// hook, real store and the real card; only the health API is fake.

import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { HueBridgeSummary, HuePairingCredentials } from "@/features/hue/hueOnboardingApi";
import { runtimeStatusRetryDelayMs } from "@/features/hue/model/pollingCadence";
import { __resetHueHealthStoreForTests } from "@/features/hue/state/hueHealthStore";
import { useHueRuntimeStatus } from "@/features/hue/state/useHueRuntimeStatus";
import type { UseHueOnboardingResult } from "@/features/hue/useHueOnboarding";
import {
  fakeHueHealthApi,
  resetHealth,
  runtimeStatus,
  setHealth,
} from "@/features/hue/__tests__/fakeHueHealth";
import { HueBridgesCategory } from "../HueBridgesCategory";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@/features/persistence/shellStore", () => ({
  shellStore: { load: vi.fn().mockResolvedValue({}), save: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock("@/features/hue/hueHealthApi", async () => (await import("@/features/hue/__tests__/fakeHueHealth")).fakeHueHealthApi);

vi.mock("../../HueChannelMapPanel", () => ({ HueChannelMapPanel: () => null }));

const bridge: HueBridgeSummary = { id: "bridge-1", ip: "192.168.1.10", name: "Test Bridge" };
const credentials: HuePairingCredentials = { username: "app-user", clientKey: "AABBCCDD" };
const area = { id: "area-1", name: "Living Room", readiness: { ready: true } } as UseHueOnboardingResult["selectedArea"];

const reads = () => fakeHueHealthApi.watchHueHealth.mock.calls.length;
const reject = () => fakeHueHealthApi.watchHueHealth.mockRejectedValueOnce(new Error("IPC channel closed"));

/** A paired bridge with a validated area; only the runtime half is live. */
function Harness() {
  const runtime = useHueRuntimeStatus({ bridge, credentials, areaId: "area-1", onError: () => {} });
  const noop = async () => {};
  const hue: UseHueOnboardingResult = {
    step: "ready",
    bridges: [bridge],
    selectedBridgeId: bridge.id,
    selectedBridge: bridge,
    manualIp: "",
    manualIpError: null,
    credentialState: "valid",
    bridgeUnreachable: false,
    credentials,
    areaGroups: [],
    selectedAreaId: "area-1",
    selectedArea: area,
    canStartHue: true,
    isReadinessStale: false,
    isDiscovering: false,
    isPairing: false,
    isLoadingAreas: false,
    isCheckingReadiness: false,
    isValidatingCredential: false,
    status: null,
    runtimeStatus: runtime.runtimeStatus,
    runtimeStatusReadFailure: runtime.runtimeStatusReadFailure,
    runtimeTargets: runtime.runtimeTargets,
    isRuntimeMutating: runtime.isRuntimeMutating,
    areaChannels: [],
    isLoadingChannels: false,
    channelsStatus: null,
    channelsFromBridge: false,
    refreshChannels: async () => null,
    discover: noop,
    selectBridge: () => {},
    setManualIp: () => {},
    submitManualIp: noop,
    pair: noop,
    refreshAreas: noop,
    selectArea: () => {},
    revalidateArea: noop,
    startRuntime: runtime.startRuntime,
    retryRuntimeTarget: runtime.retryRuntimeTarget,
  };
  return (
    <HueBridgesCategory
      isActive
      hue={hue}
      channelPlacements={[]}
      onPositionChange={async () => {}}
      persistError={false}
      zones={[]}
      onStopHue={async () => {}}
    />
  );
}

const flush = async (ms = 0) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

function expectNotReady() {
  expect(screen.queryByText("hue:page.pill.ready")).toBeNull();
  expect(screen.queryByText("hue:page.pill.streaming")).toBeNull();
  expect(screen.getByTestId("hue-status-unavailable")).toHaveTextContent("hue:runtime.statusUnavailable.body");
  expect(screen.getAllByText("hue:page.pill.checking").length).toBeGreaterThan(0);
}

describe("HueBridgesCategory — a rejected runtime-status read", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    __resetHueHealthStoreForTests();
    resetHealth({ stream: { active: true, status: runtimeStatus("Running", "HUE_STREAM_RUNNING") } });
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    __resetHueHealthStoreForTests();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("shows the status as unknown while reads fail, retries on a backoff, and recovers on its own", async () => {
    reject();
    reject();
    reject();
    render(<Harness />);
    await flush(0);
    expect(reads()).toBe(1);
    expectNotReady();

    // First retry after the base delay, the next one after double that.
    await flush(runtimeStatusRetryDelayMs(1));
    expect(reads()).toBe(2);
    expectNotReady();
    await flush(runtimeStatusRetryDelayMs(2) - 1);
    expect(reads()).toBe(2);
    await flush(1);
    expect(reads()).toBe(3);
    expectNotReady();

    await flush(runtimeStatusRetryDelayMs(3));
    expect(reads()).toBe(4);
    expect(screen.getByText("hue:page.pill.streaming")).toBeInTheDocument();
    expect(screen.queryByTestId("hue-status-unavailable")).toBeNull();

    // Nothing polls once a read has landed: Rust publishes what changes.
    await flush(60_000);
    expect(reads()).toBe(4);
  });

  it("does not show Ready when the very first read fails, and settles once a read lands", async () => {
    setHealth({ stream: { active: false, status: runtimeStatus("Idle") } });
    reject();
    render(<Harness />);
    await flush(0);
    expect(reads()).toBe(1);
    expectNotReady();

    await flush(runtimeStatusRetryDelayMs(1));
    expect(reads()).toBe(2);
    expect(screen.getAllByText("hue:page.pill.ready").length).toBeGreaterThan(0);
    expect(screen.queryByTestId("hue-status-unavailable")).toBeNull();
  });
});
