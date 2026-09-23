// A rejected `get_hue_stream_status` read used to be minted into a `Failed`
// runtime state: the card mapped it to "Ready" and the Devices-tab loop, which
// polls only while streaming, went silent — so a blip mid-stream left the card
// claiming Ready until something else invalidated the status. Real runtime
// hook, real read cache, real modeApi and the real card; only `invoke` is fake.

import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HUE_COMMANDS, HUE_RUNTIME_TRIGGER_SOURCE } from "@/shared/contracts/hue";
import { __resetHueReadCacheForTests } from "@/features/hue/hueReadCache";
import type { HueBridgeSummary, HuePairingCredentials } from "@/features/hue/hueOnboardingApi";
import { RUNTIME_POLL_INTERVAL_MS, runtimeStatusRetryDelayMs } from "@/features/hue/model/pollingCadence";
import { useHueRuntimeStatus } from "@/features/hue/state/useHueRuntimeStatus";
import type { UseHueOnboardingResult } from "@/features/hue/useHueOnboarding";
import { HueBridgesCategory } from "../HueBridgesCategory";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@/features/persistence/shellStore", () => ({
  shellStore: { load: vi.fn().mockResolvedValue({}), save: vi.fn().mockResolvedValue(undefined) },
}));

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (command: string, payload?: Record<string, unknown>) => invokeMock(command, payload),
}));

vi.mock("../../HueChannelMapPanel", () => ({ HueChannelMapPanel: () => null }));

const bridge: HueBridgeSummary = { id: "bridge-1", ip: "192.168.1.10", name: "Test Bridge" };
const credentials: HuePairingCredentials = { username: "app-user", clientKey: "AABBCCDD" };
const area = { id: "area-1", name: "Living Room", readiness: { ready: true } } as UseHueOnboardingResult["selectedArea"];

type Backend = "Idle" | "Running" | "reject";
let backend: Backend = "Running";

function statusReads(): number {
  return invokeMock.mock.calls.filter(([command]) => command === HUE_COMMANDS.GET_STREAM_STATUS).length;
}

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
    invokeMock.mockReset();
    __resetHueReadCacheForTests();
    backend = "Running";
    invokeMock.mockImplementation(async (command: string) => {
      if (command !== HUE_COMMANDS.GET_STREAM_STATUS) return undefined;
      if (backend === "reject") throw new Error("IPC channel closed");
      return {
        active: backend === "Running",
        status: {
          state: backend,
          code: backend === "Running" ? "HUE_STREAM_RUNNING" : "HUE_STREAM_IDLE",
          message: "ok",
          details: null,
          triggerSource: HUE_RUNTIME_TRIGGER_SOURCE.MODE_CONTROL,
        },
      };
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows the status as unknown mid-stream, keeps polling on a backoff, and recovers on its own", async () => {
    render(<Harness />);
    await flush(0);
    expect(screen.getByText("hue:page.pill.streaming")).toBeInTheDocument();
    expect(statusReads()).toBe(1);

    backend = "reject";
    await flush(RUNTIME_POLL_INTERVAL_MS);
    expect(statusReads()).toBe(2);
    expectNotReady();

    // First retry after the base delay, the next one after double that.
    await flush(runtimeStatusRetryDelayMs(1));
    expect(statusReads()).toBe(3);
    expectNotReady();
    await flush(runtimeStatusRetryDelayMs(2) - 1);
    expect(statusReads()).toBe(3);
    await flush(1);
    expect(statusReads()).toBe(4);
    expectNotReady();

    backend = "Running";
    await flush(runtimeStatusRetryDelayMs(3));
    expect(statusReads()).toBe(5);
    expect(screen.getByText("hue:page.pill.streaming")).toBeInTheDocument();
    expect(screen.queryByTestId("hue-status-unavailable")).toBeNull();

    // Back on the streaming cadence, not the retry one.
    await flush(RUNTIME_POLL_INTERVAL_MS - 1);
    expect(statusReads()).toBe(5);
    await flush(1);
    expect(statusReads()).toBe(6);
  });

  it("does not show Ready when the very first read fails, and settles once a read lands", async () => {
    backend = "reject";
    render(<Harness />);
    await flush(0);
    expect(statusReads()).toBe(1);
    expectNotReady();

    backend = "Idle";
    await flush(runtimeStatusRetryDelayMs(1));
    expect(statusReads()).toBe(2);
    expect(screen.getAllByText("hue:page.pill.ready").length).toBeGreaterThan(0);
    expect(screen.queryByTestId("hue-status-unavailable")).toBeNull();

    // Idle goes quiet again once the read succeeds.
    await flush(RUNTIME_POLL_INTERVAL_MS * 3);
    expect(statusReads()).toBe(2);
  });
});
