import { render } from "@testing-library/react";

import type { HueRuntimeState, HueRuntimeWireStatusCode } from "@/shared/contracts/hue";
import type { HueBridgeSummary } from "@/features/hue/hueOnboardingApi";
import type { HueOnboardingStatus, HueRuntimeStatusView } from "@/features/hue/model/onboardingStatusCodes";
import type { UseHueOnboardingResult } from "@/features/hue/useHueOnboarding";

import { HuePage, type HuePageProps } from "../HuePage";

export const bridge: HueBridgeSummary = { id: "bridge-1", ip: "192.168.1.10", name: "Test Bridge" };

export const area = {
  id: "area-1",
  name: "Living Room",
  channelCount: 3,
  readiness: { ready: true },
} as UseHueOnboardingResult["selectedArea"];

export function runtime(
  state: HueRuntimeState,
  code: HueRuntimeWireStatusCode,
  extra: Partial<HueRuntimeStatusView> = {},
): HueRuntimeStatusView {
  return { state, code, message: "backend message", details: null, triggerSource: "system", ...extra };
}

export function onboarding(code: HueOnboardingStatus["code"]): HueOnboardingStatus {
  return { code, message: "English message from Rust", details: null };
}

/** A paired bridge, an area chosen, nothing running: the Ready state. */
export function hueState(overrides: Partial<UseHueOnboardingResult> = {}): UseHueOnboardingResult {
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
    runtimeStatus: null,
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
    recheckBridge: noop,
    pair: noop,
    refreshAreas: noop,
    selectArea: () => {},
    revalidateArea: noop,
    startRuntime: noop,
    retryRuntimeTarget: noop,
    forgetBridge: async () => null,
    lightNames: {},
    identifyLights: async () => ({ code: "HUE_IDENTIFY_OK" as const, message: "", details: null }),
    ...overrides,
  };
}

export const noBridge = { selectedBridgeId: null, selectedBridge: null, bridges: [], credentials: null };

export function renderPage(hue: UseHueOnboardingResult, props: Partial<HuePageProps> = {}) {
  return render(
    <HuePage
      isActive
      hue={hue}
      channelPlacements={[]}
      onPositionChange={async () => {}}
      persistError={false}
      zones={[]}
      onStopHue={async () => {}}
      {...props}
    />,
  );
}
