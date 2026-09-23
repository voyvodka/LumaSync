// A `Failed` runtime state the backend reported had no branch in the card
// derivation: a stream that had given up read as a Ready bridge, and a spent
// retry budget (TRANSIENT_RETRY_EXHAUSTED) as a reconnect still in progress.
// Real runtime hook, real read cache, real modeApi and the real card; only
// `invoke` is fake.

import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  HUE_COMMANDS,
  HUE_RUNTIME_TRIGGER_SOURCE,
  type HueRuntimeActionHint,
  type HueRuntimeState,
} from "@/shared/contracts/hue";
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

interface BackendStatus {
  state: HueRuntimeState;
  code: string;
  actionHint?: HueRuntimeActionHint;
}

const RUNNING: BackendStatus = { state: "Running", code: "HUE_STREAM_RUNNING_DTLS" };
let backend: BackendStatus | "reject" = RUNNING;
let restartRecovers = true;
let pairMock = vi.fn();

function reads(command: string): number {
  return invokeMock.mock.calls.filter(([name]) => name === command).length;
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
    __resetHueReadCacheForTests();
    backend = RUNNING;
    restartRecovers = true;
    pairMock = vi.fn(async () => {});
    invokeMock.mockImplementation(async (command: string) => {
      if (command === HUE_COMMANDS.RESTART_STREAM) {
        if (!restartRecovers) return commandResult({ state: "Failed", code: "HUE_STREAM_START_ABORTED" });
        backend = RUNNING;
        return commandResult(RUNNING);
      }
      if (command !== HUE_COMMANDS.GET_STREAM_STATUS) return undefined;
      if (backend === "reject") throw new Error("IPC channel closed");
      return commandResult(backend);
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("says the stream stopped once retries run out, and Start Again brings it back", async () => {
    render(<Harness />);
    await flush(0);
    expect(screen.getByText("hue:page.pill.streaming")).toBeInTheDocument();

    backend = { state: "Failed", code: "TRANSIENT_RETRY_EXHAUSTED", actionHint: "retry" };
    await flush(RUNTIME_POLL_INTERVAL_MS);
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
    backend = { state: "Failed", code: "HUE_STREAM_START_ABORTED", actionHint: "retry" };
    render(<Harness />);
    await flush(0);
    expectStreamFailed("hue:runtime.codes.HUE_STREAM_START_ABORTED");
    expect(screen.getByText("hue:page.startAgain")).toBeInTheDocument();
  });

  it("offers a re-pair as well when the runtime says the key was refused", async () => {
    backend = { state: "Failed", code: "AUTH_INVALID_CREDENTIALS", actionHint: "repair" };
    render(<Harness />);
    await flush(0);
    expectStreamFailed("hue:runtime.codes.AUTH_INVALID_CREDENTIALS");

    fireEvent.click(screen.getByText("hue:runtime.actions.repair"));
    expect(pairMock).toHaveBeenCalledTimes(1);
    expect(screen.getByText("hue:page.startAgain")).toBeInTheDocument();
  });

  it("falls back to the generic line for a Failed code without its own text", async () => {
    backend = { state: "Failed", code: "HUE_SOMETHING_NEW" };
    render(<Harness />);
    await flush(0);
    expectStreamFailed("hue:runtime.failed.body");
  });

  // #434: a rejected read is not a runtime state. Holding a Failed status when
  // the next read rejects must say "checking", not repeat the stale failure.
  it("shows a rejected read over a held Failed as unknown, then the Failed again once a read lands", async () => {
    backend = { state: "Failed", code: "TRANSIENT_RETRY_EXHAUSTED", actionHint: "retry" };
    render(<Harness />);
    await flush(0);
    expectStreamFailed("hue:runtime.codes.TRANSIENT_RETRY_EXHAUSTED");
    const readsBefore = reads(HUE_COMMANDS.GET_STREAM_STATUS);

    // Failed is terminal and not polled; the forced read after a restart is
    // what reaches the backend again here.
    restartRecovers = false;
    backend = "reject";
    fireEvent.click(screen.getByText("hue:page.startAgain"));
    await flush(0);
    expect(reads(HUE_COMMANDS.GET_STREAM_STATUS)).toBeGreaterThan(readsBefore);
    expect(screen.getByTestId("hue-status-unavailable")).toBeInTheDocument();
    expect(screen.queryByTestId("hue-stream-failed")).toBeNull();

    backend = { state: "Failed", code: "TRANSIENT_RETRY_EXHAUSTED", actionHint: "retry" };
    await flush(runtimeStatusRetryDelayMs(1));
    expectStreamFailed("hue:runtime.codes.TRANSIENT_RETRY_EXHAUSTED");
  });
});
