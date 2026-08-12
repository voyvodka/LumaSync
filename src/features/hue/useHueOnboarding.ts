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

  const channels = useHueAreaChannels(core.selectedBridge, state.credentials, state.selectedAreaId);

  const runtime = useHueRuntimeStatus({
    bridge: core.selectedBridge,
    credentials: state.credentials,
    areaId: state.selectedAreaId,
    channelRegionOverrides: channels.channelRegionOverrides,
    onError: core.publishStatus,
  });

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
    runtimeTargets: runtime.runtimeTargets,
    isRuntimeMutating: runtime.isRuntimeMutating,
    areaChannels: channels.areaChannels,
    isLoadingChannels: channels.isLoadingChannels,
    channelRegionOverrides: channels.channelRegionOverrides,
    setChannelRegion: channels.setChannelRegion,
    discover: core.discover,
    selectBridge: core.selectBridge,
    setManualIp: core.setManualIp,
    submitManualIp: core.submitManualIp,
    pair: core.pair,
    refreshAreas: core.refreshAreas,
    selectArea: core.selectArea,
    revalidateArea: core.revalidateArea,
    startRuntime: runtime.startRuntime,
    retryRuntimeTarget: runtime.retryRuntimeTarget,
  };
}
