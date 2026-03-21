import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { HUE_RUNTIME_TRIGGER_SOURCE } from "../../../shared/contracts/hue";
import { DeviceSection } from "./DeviceSection";

const stopHueMock = vi.fn();
const useHueOnboardingMock = vi.fn();

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock("../../mode/modeApi", () => ({
  stopHue: (...args: unknown[]) => stopHueMock(...args),
}));

vi.mock("../../device/useDeviceConnection", () => ({
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

vi.mock("../../device/useHueOnboarding", () => ({
  useHueOnboarding: () => useHueOnboardingMock(),
}));

function createHueHookState(overrides: Record<string, unknown> = {}) {
  return {
    step: "ready",
    bridges: [],
    selectedBridgeId: null,
    selectedBridge: null,
    manualIp: "",
    manualIpError: null,
    credentialState: "valid",
    areaGroups: [],
    selectedAreaId: null,
    selectedArea: null,
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
    retryRuntimeTarget: vi.fn(),
    ...overrides,
  };
}

describe("DeviceSection hue runtime controls", () => {
  beforeEach(() => {
    stopHueMock.mockReset();
    useHueOnboardingMock.mockReturnValue(createHueHookState());
  });

  it("keeps Start disabled while credential validating/unknown and shows stale readiness checklist", () => {
    useHueOnboardingMock.mockReturnValue(
      createHueHookState({
        credentialState: "unknown",
        isValidatingCredential: true,
        isReadinessStale: true,
        canStartHue: true,
      }),
    );

    render(<DeviceSection />);

    expect(screen.getByRole("button", { name: "device.hue.actions.start" })).toBeDisabled();
    expect(screen.getByText("device.hue.runtime.checklist.revalidate")).toBeInTheDocument();
  });

  it("routes Device stop action to shared mode stop pipeline", async () => {
    const user = userEvent.setup();
    render(<DeviceSection />);

    await user.click(screen.getByRole("button", { name: "device.hue.actions.stop" }));

    expect(stopHueMock).toHaveBeenCalledWith(HUE_RUNTIME_TRIGGER_SOURCE.DEVICE_SURFACE);
  });

  it("routes Device start action to onboarding runtime start pipeline", async () => {
    const user = userEvent.setup();
    const startRuntime = vi.fn();
    useHueOnboardingMock.mockReturnValue(createHueHookState({ startRuntime }));

    render(<DeviceSection />);

    await user.click(screen.getByRole("button", { name: "device.hue.actions.start" }));

    expect(startRuntime).toHaveBeenCalledTimes(1);
  });

  it("keeps healthy target controls enabled while recovering target remains constrained", async () => {
    const user = userEvent.setup();
    const retryRuntimeTarget = vi.fn();

    useHueOnboardingMock.mockReturnValue(
      createHueHookState({
        runtimeTargets: [
          {
            target: "hue",
            state: "Reconnecting",
            code: "TRANSIENT_RETRY_SCHEDULED",
            message: "reconnecting",
            remainingAttempts: 2,
            nextAttemptMs: 1200,
          },
          { target: "usb", state: "Running", code: "USB_STREAM_RUNNING", message: "running" },
        ],
        retryRuntimeTarget,
      }),
    );

    render(<DeviceSection />);

    expect(screen.getByRole("button", { name: "device.hue.runtime.targets.hue.retry" })).toBeDisabled();
    expect(screen.getByText("device.hue.runtime.retryStatus")).toBeInTheDocument();

    const usbRetry = screen.getByRole("button", { name: "device.hue.runtime.targets.usb.retry" });
    expect(usbRetry).toBeEnabled();

    await user.click(usbRetry);
    expect(retryRuntimeTarget).toHaveBeenCalledWith("usb");
  });
});
