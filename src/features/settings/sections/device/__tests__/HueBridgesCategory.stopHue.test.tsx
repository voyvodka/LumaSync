// Stop retrying and Stop Hue used to call `stopHue` straight from the card,
// so a running mode that named Hue kept its worker holding the stream's sender
// through the stop. Both now go through `onStopHue`, which App wires to the mode
// orchestrator; `stopHue` itself must never be reached from the card.

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { HUE_RUNTIME_TRIGGER_SOURCE, type HueRuntimeState, type HueRuntimeWireStatusCode } from "@/shared/contracts/hue";
import type { HueRuntimeStatusView } from "@/features/hue/model/onboardingStatusCodes";
import type { UseHueOnboardingResult } from "@/features/hue/useHueOnboarding";
import { HueBridgesCategory } from "../HueBridgesCategory";

const stopHueMock = vi.fn();

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@/features/mode/modeApi", () => ({ stopHue: (...args: unknown[]) => stopHueMock(...args) }));
vi.mock("../../HueChannelMapPanel", () => ({ HueChannelMapPanel: () => null }));

const bridge = { id: "bridge-1", ip: "192.168.1.10", name: "Test Bridge" };
const area = { id: "area-1", name: "Living Room", readiness: { ready: true } } as UseHueOnboardingResult["selectedArea"];

function runtime(state: HueRuntimeState, code: HueRuntimeWireStatusCode): HueRuntimeStatusView {
  return { state, code, message: "backend message", details: null, triggerSource: "system" };
}

function hueState(runtimeStatus: HueRuntimeStatusView): UseHueOnboardingResult {
  const noop = async () => {};
  return {
    step: "ready",
    bridges: [bridge],
    selectedBridgeId: bridge.id,
    selectedBridge: bridge,
    manualIp: "",
    manualIpError: null,
    credentialState: "valid",
    bridgeUnreachable: false,
    credentials: { username: "app-user", clientKey: "AABBCCDD" },
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
    runtimeStatus,
    runtimeStatusReadFailure: null,
    runtimeTargets: [],
    isRuntimeMutating: false,
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
    startRuntime: noop,
    retryRuntimeTarget: noop,
  };
}

describe("HueBridgesCategory — the card's Hue stops go through onStopHue", () => {
  it.each([
    { name: "Stop retrying", label: "hue:page.stopRetrying", status: runtime("Reconnecting", "TRANSIENT_RETRY_SCHEDULED") },
    { name: "Stop Hue", label: "hue:actions.stop", status: runtime("Idle", "HUE_STOP_TIMEOUT_PARTIAL") },
  ])("$name", ({ label, status }) => {
    stopHueMock.mockClear();
    const onStopHue = vi.fn(async () => {});
    render(
      <HueBridgesCategory
        isActive
        hue={hueState(status)}
        channelPlacements={[]}
        onPositionChange={async () => {}}
        persistError={false}
        zones={[]}
        onStopHue={onStopHue}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: label }));

    expect(onStopHue).toHaveBeenCalledTimes(1);
    expect(onStopHue).toHaveBeenCalledWith(HUE_RUNTIME_TRIGGER_SOURCE.DEVICE_SURFACE);
    expect(stopHueMock).not.toHaveBeenCalled();
  });
});
