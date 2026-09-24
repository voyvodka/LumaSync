// A `Failed` runtime state the backend reported had no branch in the card
// derivation: a stream that had given up read as a Ready bridge, and a spent
// retry budget (TRANSIENT_RETRY_EXHAUSTED) as a reconnect still in progress.
// Real runtime hook, real health store, real modeApi and the real card; only
// `invoke` and the health API are fake.

import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  HUE_COMMANDS,
  HUE_RUNTIME_TRIGGER_SOURCE,
  type HueRuntimeActionHint,
  type HueRuntimeState,
  type HueRuntimeStatus,
} from "@/shared/contracts/hue";
import type { HueBridgeSummary, HuePairingCredentials } from "@/features/hue/hueOnboardingApi";
import { runtimeStatusRetryDelayMs } from "@/features/hue/model/pollingCadence";
import { __resetHueHealthStoreForTests } from "@/features/hue/state/hueHealthStore";
import {
  fakeHueHealthApi,
  publishHealth,
  resetHealth,
  setHealth,
  type HealthChange,
} from "@/features/hue/__tests__/fakeHueHealth";
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

vi.mock("@/features/hue/hueHealthApi", async () => (await import("@/features/hue/__tests__/fakeHueHealth")).fakeHueHealthApi);

vi.mock("../../HueChannelMapPanel", () => ({ HueChannelMapPanel: () => null }));

const bridge: HueBridgeSummary = { id: "bridge-1", ip: "192.168.1.10", name: "Test Bridge" };
const credentials: HuePairingCredentials = { username: "app-user", clientKey: "AABBCCDD" };
const area = { id: "area-1", name: "Living Room", readiness: { ready: true } } as UseHueOnboardingResult["selectedArea"];

interface BackendStatus {
  state: HueRuntimeState;
  code: string;
  actionHint?: HueRuntimeActionHint;
}

const RUNNING: BackendStatus = { state: "Running", code: "HUE_STREAM_RUNNING_DTLS" };
let restartRecovers = true;
let pairMock = vi.fn();

/** What the health monitor reports the runtime as. A code outside the wire
 * union is the point of one case, hence the cast. */
function backendIs(status: BackendStatus): HealthChange {
  const result = commandResult(status);
  return { stream: { active: result.active, status: result.status as unknown as HueRuntimeStatus } };
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
    pair: pairMock,
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

function commandResult(status: BackendStatus) {
  return {
    active: status.state === "Running",
    status: {
      state: status.state,
      code: status.code,
      message: "backend message",
      details: null,
      actionHint: status.actionHint ?? null,
      triggerSource: HUE_RUNTIME_TRIGGER_SOURCE.SYSTEM,
    },
  };
}

function expectStreamFailed(reasonKey: string) {
  expect(screen.getByTestId("hue-stream-failed")).toHaveTextContent(reasonKey);
  expect(screen.getAllByText("hue:page.pill.failed").length).toBeGreaterThan(0);
  expect(screen.queryByText("hue:page.pill.ready")).toBeNull();
  expect(screen.queryByText("hue:page.pill.streaming")).toBeNull();
  expect(screen.queryByText("hue:page.pill.reconnecting")).toBeNull();
  expect(screen.queryByTestId("hue-status-unavailable")).toBeNull();
}

describe("HueBridgesCategory — a Failed stream the backend reported", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    invokeMock.mockReset();
    __resetHueHealthStoreForTests();
    resetHealth(backendIs(RUNNING));
    restartRecovers = true;
    pairMock = vi.fn(async () => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    invokeMock.mockImplementation(async (command: string) => {
      if (command === HUE_COMMANDS.RESTART_STREAM) {
        if (!restartRecovers) return commandResult({ state: "Failed", code: "HUE_STREAM_START_ABORTED" });
        setHealth(backendIs(RUNNING));
        return commandResult(RUNNING);
      }
      return undefined;
    });
  });

  afterEach(() => {
    __resetHueHealthStoreForTests();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("says the stream stopped once retries run out, and Start Again brings it back", async () => {
    render(<Harness />);
    await flush(0);
    expect(screen.getByText("hue:page.pill.streaming")).toBeInTheDocument();

    act(() => {
      publishHealth(backendIs({ state: "Failed", code: "TRANSIENT_RETRY_EXHAUSTED", actionHint: "retry" }));
    });
    await flush(0);
    expectStreamFailed("hue:runtime.codes.TRANSIENT_RETRY_EXHAUSTED");
    expect(screen.getByText("TRANSIENT_RETRY_EXHAUSTED")).toBeInTheDocument();
    // Not a key problem, so no re-pair on offer.
    expect(screen.queryByText("hue:runtime.actions.repair")).toBeNull();

    fireEvent.click(screen.getByText("hue:page.startAgain"));
    await flush(0);
    expect(invokeMock).toHaveBeenCalledWith(
      HUE_COMMANDS.RESTART_STREAM,
      expect.objectContaining({
        request: expect.objectContaining({
          bridgeIp: bridge.ip,
          areaId: "area-1",
          triggerSource: HUE_RUNTIME_TRIGGER_SOURCE.DEVICE_SURFACE,
        }),
      }),
    );
    expect(screen.getByText("hue:page.pill.streaming")).toBeInTheDocument();
    expect(screen.queryByTestId("hue-stream-failed")).toBeNull();
  });

  it("names an aborted start on the first read", async () => {
    setHealth(backendIs({ state: "Failed", code: "HUE_STREAM_START_ABORTED", actionHint: "retry" }));
    render(<Harness />);
    await flush(0);
    expectStreamFailed("hue:runtime.codes.HUE_STREAM_START_ABORTED");
    expect(screen.getByText("hue:page.startAgain")).toBeInTheDocument();
  });

  it("offers a re-pair as well when the runtime says the key was refused", async () => {
    setHealth(backendIs({ state: "Failed", code: "AUTH_INVALID_CREDENTIALS", actionHint: "repair" }));
    render(<Harness />);
    await flush(0);
    expectStreamFailed("hue:runtime.codes.AUTH_INVALID_CREDENTIALS");

    fireEvent.click(screen.getByText("hue:runtime.actions.repair"));
    expect(pairMock).toHaveBeenCalledTimes(1);
    expect(screen.getByText("hue:page.startAgain")).toBeInTheDocument();
  });

  it("falls back to the generic line for a Failed code without its own text", async () => {
    setHealth(backendIs({ state: "Failed", code: "HUE_SOMETHING_NEW" }));
    render(<Harness />);
    await flush(0);
    expectStreamFailed("hue:runtime.failed.body");
  });

  // #434: a rejected read is not a runtime state. Holding a Failed status when
  // the next read rejects must say "checking", not repeat the stale failure.
  it("shows a rejected read over a held Failed as unknown, then the Failed again once a read lands", async () => {
    setHealth(backendIs({ state: "Failed", code: "TRANSIENT_RETRY_EXHAUSTED", actionHint: "retry" }));
    render(<Harness />);
    await flush(0);
    expectStreamFailed("hue:runtime.codes.TRANSIENT_RETRY_EXHAUSTED");

    // The fresh read after the card's own restart is what rejects here.
    restartRecovers = false;
    fakeHueHealthApi.getHueHealth.mockRejectedValueOnce(new Error("IPC channel closed"));
    fireEvent.click(screen.getByText("hue:page.startAgain"));
    await flush(0);
    expect(fakeHueHealthApi.getHueHealth).toHaveBeenCalledOnce();
    expect(screen.getByTestId("hue-status-unavailable")).toBeInTheDocument();
    expect(screen.queryByTestId("hue-stream-failed")).toBeNull();

    await flush(runtimeStatusRetryDelayMs(1));
    expectStreamFailed("hue:runtime.codes.TRANSIENT_RETRY_EXHAUSTED");
  });
});
