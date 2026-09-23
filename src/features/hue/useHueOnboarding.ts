import { useCallback, useEffect, useRef } from "react";

import { HUE_RUNTIME_STATES } from "@/shared/contracts/hue";

import type { UseHueOnboardingResult } from "./model/onboardingTypes";
import { deriveRuntimeTargets } from "./model/runtimeTargets";
import { useHueAreaChannels } from "./state/useHueAreaChannels";
import { useHueOnboardingCore } from "./state/useHueOnboardingCore";
import { useHueReadinessPolling } from "./state/useHueReadinessPolling";
import { useHueRuntimeStatus } from "./state/useHueRuntimeStatus";

export { deriveRuntimeTargets };
export type {
  HueAreaGroup,
  HueAreaReadiness,
  HueAreaRow,
  UseHueOnboardingResult,
} from "./model/onboardingTypes";

export function useHueOnboarding(): UseHueOnboardingResult {
  const core = useHueOnboardingCore();
  const { state } = core;

  const channels = useHueAreaChannels(
    core.selectedBridge,
    state.credentials,
    state.selectedAreaId,
    core.publishStatus,
  );

  const runtime = useHueRuntimeStatus({
    bridge: core.selectedBridge,
    credentials: state.credentials,
    areaId: state.selectedAreaId,
    onError: core.publishStatus,
  });

  // The channel list read while lighting was on is our own placements; once the
  // runtime is idle again, read the bridge's. See docs/architecture/hue.md.
  const { refreshChannels } = channels;
  const runtimeState = runtime.runtimeStatus?.state ?? null;
  const previousRuntimeStateRef = useRef(runtimeState);
  useEffect(() => {
    const previous = previousRuntimeStateRef.current;
    previousRuntimeStateRef.current = runtimeState;
    if (runtimeState !== HUE_RUNTIME_STATES.IDLE || previous === null) return;
    if (previous === HUE_RUNTIME_STATES.IDLE) return;
    void refreshChannels();
  }, [runtimeState, refreshChannels]);

  // "Validate again" is where a user goes after changing the area in the Hue
  // app, so it re-reads the channel positions along with the readiness.
  const { revalidateArea: revalidateReadiness } = core;
  const revalidateArea = useCallback(async () => {
    void refreshChannels();
    await revalidateReadiness();
  }, [refreshChannels, revalidateReadiness]);

  useHueReadinessPolling({
    bridge: core.selectedBridge,
    credentials: state.credentials,
    areaId: state.selectedAreaId,
    blocked: core.selectedAreaIsBlocked,
    isValidatingCredential: state.isValidatingCredential,
    isLoadingAreas: state.isLoadingAreas,
    onResult: core.applyBackgroundReadiness,
  });

  return {
    step: state.step,
    bridges: state.bridges,
    selectedBridgeId: state.selectedBridgeId,
    selectedBridge: core.selectedBridge,
    manualIp: state.manualIp,
    manualIpError: state.manualIpError,
    credentialState: state.credentialState,
    bridgeUnreachable: state.bridgeUnreachable,
    credentials: state.credentials,
    areaGroups: state.areaGroups,
    selectedAreaId: state.selectedAreaId,
    selectedArea: core.selectedArea,
    canStartHue: core.canStartHue,
    isReadinessStale: core.isReadinessStale,
    isDiscovering: state.isDiscovering,
    isPairing: state.isPairing,
    isLoadingAreas: state.isLoadingAreas,
    isCheckingReadiness: state.isCheckingReadiness,
    isValidatingCredential: state.isValidatingCredential,
    status: state.status,
    runtimeStatus: runtime.runtimeStatus,
    runtimeStatusReadFailure: runtime.runtimeStatusReadFailure,
    runtimeTargets: runtime.runtimeTargets,
    isRuntimeMutating: runtime.isRuntimeMutating,
    areaChannels: channels.areaChannels,
    isLoadingChannels: channels.isLoadingChannels,
    channelsStatus: channels.channelsStatus,
    channelsFromBridge: channels.channelsFromBridge,
    refreshChannels: channels.refreshChannels,
    discover: core.discover,
    selectBridge: core.selectBridge,
    setManualIp: core.setManualIp,
    submitManualIp: core.submitManualIp,
    pair: core.pair,
    refreshAreas: core.refreshAreas,
    selectArea: core.selectArea,
    revalidateArea,
    startRuntime: runtime.startRuntime,
    retryRuntimeTarget: runtime.retryRuntimeTarget,
  };
}
