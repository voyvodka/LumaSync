import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { HUE_RUNTIME_TRIGGER_SOURCE } from "../../../../shared/contracts/hue";
import { DeviceSection } from "../DeviceSection";

const stopHueMock = vi.fn();
const useHueOnboardingMock = vi.fn();

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock("../../../mode/modeApi", () => ({
  stopHue: (...args: unknown[]) => stopHueMock(...args),
}));

vi.mock("../../../device/useDeviceConnection", () => ({
  useDeviceConnection: () => ({
    status: "idle",
    groupedPorts: { supported: [], other: [] },
    ports: [],
    selectedPort: null,
    connectedPort: null,
    isScanning: false,
    isConnecting: false,
    isReconnecting: false,
    isHealthChecking: false,
    canConnect: false,
    statusCard: null,
    latestHealthCheck: null,
    refreshPorts: vi.fn(),
    selectPort: vi.fn(),
    connectSelectedPort: vi.fn(),
    runHealthCheck: vi.fn(),
    connectButtonLabel: "connect",
  }),
}));

vi.mock("../../../device/useHueOnboarding", () => ({
  useHueOnboarding: () => useHueOnboardingMock(),
}));

vi.mock("../../../persistence/shellStore", () => ({
  shellStore: {
    load: vi.fn().mockResolvedValue({ roomMap: null }),
    save: vi.fn().mockResolvedValue(undefined),
  },
}));

function createHueHookState(overrides: Record<string, unknown> = {}) {
  return {
    step: "ready",
    bridges: [{ id: "test-bridge", name: "Test Bridge", ip: "192.168.1.100" }],
    selectedBridgeId: "test-bridge",
    selectedBridge: { id: "test-bridge", name: "Test Bridge", ip: "192.168.1.100" },
    manualIp: "",
    manualIpError: null,
    credentialState: "valid",
    areaGroups: [],
    selectedAreaId: "test-area",
    selectedArea: { id: "test-area", name: "Test Area", readiness: { ready: true } },
    canStartHue: true,
    isDiscovering: false,
    isPairing: false,
    isLoadingAreas: false,
    isCheckingReadiness: false,
    isValidatingCredential: false,
    isReadinessStale: false,
    status: null,
    runtimeStatus: null,
    runtimeTargets: [],
    isRuntimeMutating: false,
    discover: vi.fn(),
    selectBridge: vi.fn(),
    setManualIp: vi.fn(),
    submitManualIp: vi.fn(),
    pair: vi.fn(),
    refreshAreas: vi.fn(),
    selectArea: vi.fn(),
    revalidateArea: vi.fn(),
    startRuntime: vi.fn(),
    areaChannels: [],
    retryRuntimeTarget: vi.fn(),
    ...overrides,
  };
}

async function renderHueTab(state: ReturnType<typeof createHueHookState>) {
  const user = userEvent.setup();
  useHueOnboardingMock.mockReturnValue(state);
  render(<DeviceSection />);
  const hueTabBtn = screen.getByText("devicesPage.rail.hueBridges").closest("button")!;
  await user.click(hueTabBtn);
}

describe("HueReadySummaryCard", () => {
  beforeEach(() => {
    stopHueMock.mockReset();
    useHueOnboardingMock.mockReturnValue(createHueHookState());
  });

  it("renders idle state with area name and ready pill", async () => {
    await renderHueTab(createHueHookState({
      selectedArea: { id: "test-area", name: "Living Room", readiness: { ready: true } },
      selectedBridge: { id: "test-bridge", name: "Test Bridge", ip: "192.168.1.100" },
      runtimeStatus: null,
      isReadinessStale: false,
    }));

    await waitFor(() => {
      expect(screen.getByText("Living Room")).toBeInTheDocument();
      const pill = document.querySelector(".lm-dcard-pill.is-idle");
      expect(pill).toBeTruthy();
    });
  });

  it("disables start button when readiness is stale", async () => {
    await renderHueTab(createHueHookState({
      canStartHue: false,
      isReadinessStale: true,
      selectedArea: { id: "test-area", name: "Living Room", readiness: { ready: false } },
      selectedBridge: { id: "test-bridge", name: "Test Bridge", ip: "192.168.1.100" },
      runtimeStatus: null,
    }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "device.hue.actions.start" })).toBeDisabled();
    });
  });

  it("shows streaming pill when runtimeStatus state is Running", async () => {
    await renderHueTab(createHueHookState({
      selectedArea: { id: "test-area", name: "Test Zone", readiness: { ready: true } },
      selectedBridge: { id: "test-bridge", name: "Test Bridge", ip: "192.168.1.100" },
      runtimeStatus: {
        state: "Running",
        code: "HUE_STREAM_RUNNING",
        message: "Streaming",
        triggerSource: HUE_RUNTIME_TRIGGER_SOURCE.DEVICE_SURFACE,
      },
    }));

    await waitFor(() => {
      const pill = document.querySelector(".lm-dcard-pill.is-streaming");
      expect(pill).toBeTruthy();
    });
  });
});

describe("DeviceSection hue runtime controls", () => {
  beforeEach(() => {
    stopHueMock.mockReset();
    useHueOnboardingMock.mockReturnValue(createHueHookState());
  });

  it("keeps Start disabled in stale state and shows revalidate hint", async () => {
    await renderHueTab(createHueHookState({
      credentialState: "valid",
      isValidatingCredential: true,
      isReadinessStale: true,
      canStartHue: true,
    }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "device.hue.actions.start" })).toBeDisabled();
    });
    expect(screen.getAllByText("device.hue.runtime.checklist.revalidate")[0]).toBeInTheDocument();
  });

  it("routes stop action to stopHue when stream is reconnecting", async () => {
    const user = userEvent.setup();
    await renderHueTab(createHueHookState({
      runtimeStatus: {
        state: "Reconnecting",
        code: "TRANSIENT_RETRY_SCHEDULED",
        message: "reconnecting",
        triggerSource: HUE_RUNTIME_TRIGGER_SOURCE.DEVICE_SURFACE,
      },
    }));

    await waitFor(() => {
      expect(screen.getAllByRole("button", { name: "devicesPage.hue.stopRetrying" })[0]).toBeInTheDocument();
    });
    await user.click(screen.getAllByRole("button", { name: "devicesPage.hue.stopRetrying" })[0]);

    expect(stopHueMock).toHaveBeenCalledWith(HUE_RUNTIME_TRIGGER_SOURCE.DEVICE_SURFACE);
  });

  it("routes reconnect action to startRuntime when streaming", async () => {
    const user = userEvent.setup();
    const startRuntime = vi.fn();
    await renderHueTab(createHueHookState({
      startRuntime,
      runtimeStatus: {
        state: "Running",
        code: "HUE_STREAM_RUNNING",
        message: "Streaming",
        triggerSource: HUE_RUNTIME_TRIGGER_SOURCE.DEVICE_SURFACE,
      },
    }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "devicesPage.hue.reconnectNow" })).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "devicesPage.hue.reconnectNow" }));

    expect(startRuntime).toHaveBeenCalledTimes(1);
  });

  it("calls retryRuntimeTarget with first target when reconnecting", async () => {
    const user = userEvent.setup();
    const retryRuntimeTarget = vi.fn();

    await renderHueTab(createHueHookState({
      runtimeStatus: {
        state: "Reconnecting",
        code: "TRANSIENT_RETRY_SCHEDULED",
        message: "reconnecting",
        triggerSource: HUE_RUNTIME_TRIGGER_SOURCE.DEVICE_SURFACE,
      },
      runtimeTargets: [
        {
          target: "hue",
          state: "Reconnecting",
          code: "TRANSIENT_RETRY_SCHEDULED",
          message: "reconnecting",
          remainingAttempts: 2,
          nextAttemptMs: 1200,
        },
      ],
      retryRuntimeTarget,
    }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "devicesPage.hue.reconnectNow" })).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "devicesPage.hue.reconnectNow" }));

    expect(retryRuntimeTarget).toHaveBeenCalledWith("hue");
  });
});
