import type { TranslationKey } from "@/features/i18n/catalogue";

import {
  HUE_CREDENTIAL_STATUS,
  type HueCredentialStatus,
  type HueRuntimeStatus,
  type HueRuntimeTarget,
  type HueRuntimeTargetTelemetryRow,
} from "@/shared/contracts/hue";
import type {
  CommandStatus,
  HueAreaChannelInfo,
  HueBridgeSummary,
  HueEntertainmentAreaSummary,
  HuePairingCredentials,
} from "../hueOnboardingApi";

export type HueStep = "discover" | "pair" | "area" | "ready";

export interface HueAreaReadiness {
  ready: boolean;
  reasons: string[];
  code: string;
  message: string;
  details: string | null;
}

export interface HueAreaRow extends HueEntertainmentAreaSummary {
  roomLabel: string;
  sortRoomKey: string;
  sortNameKey: string;
  readiness: HueAreaReadiness | null;
}

export interface HueAreaGroup {
  roomName: string;
  areas: HueAreaRow[];
}

export interface UseHueOnboardingResult {
  step: HueStep;
  bridges: HueBridgeSummary[];
  selectedBridgeId: string | null;
  selectedBridge: HueBridgeSummary | null;
  manualIp: string;
  manualIpError: TranslationKey | null;
  credentialState: HueCredentialStatus;
  /** True when the bridge is registered but cannot be reached (network error, not auth error). */
  bridgeUnreachable: boolean;
  credentials: HuePairingCredentials | null;
  areaGroups: HueAreaGroup[];
  selectedAreaId: string | null;
  selectedArea: HueAreaRow | null;
  canStartHue: boolean;
  isReadinessStale: boolean;
  isDiscovering: boolean;
  isPairing: boolean;
  isLoadingAreas: boolean;
  isCheckingReadiness: boolean;
  isValidatingCredential: boolean;
  status: CommandStatus | null;
  runtimeStatus: HueRuntimeStatus | null;
  runtimeTargets: HueRuntimeTargetTelemetryRow[];
  isRuntimeMutating: boolean;
  /** Channels for the currently selected area (empty while loading or no area selected). */
  areaChannels: HueAreaChannelInfo[];
  isLoadingChannels: boolean;
  /** User overrides: channel index → region string. */
  channelRegionOverrides: Record<number, string>;
  setChannelRegion: (channelIndex: number, region: string | null) => void;
  discover: () => Promise<void>;
  selectBridge: (bridgeId: string | null) => void;
  setManualIp: (value: string) => void;
  submitManualIp: () => Promise<void>;
  pair: () => Promise<void>;
  refreshAreas: () => Promise<void>;
  selectArea: (areaId: string | null) => void;
  revalidateArea: () => Promise<void>;
  startRuntime: () => Promise<void>;
  retryRuntimeTarget: (target: HueRuntimeTarget) => Promise<void>;
}

/** `clientKey` is DTLS pre-shared key material: never put it in a status
 * `details` string, a log line, or any value that reaches the UI. */
export interface HueOnboardingState {
  step: HueStep;
  bridges: HueBridgeSummary[];
  selectedBridgeId: string | null;
  manualIp: string;
  manualIpError: TranslationKey | null;
  credentialState: HueCredentialStatus;
  /** Sticky flag: set true only on network-level credential check failure, cleared on successful validation or bridge removal. */
  bridgeUnreachable: boolean;
  credentials: HuePairingCredentials | null;
  areaGroups: HueAreaGroup[];
  selectedAreaId: string | null;
  isDiscovering: boolean;
  isPairing: boolean;
  isLoadingAreas: boolean;
  isCheckingReadiness: boolean;
  isValidatingCredential: boolean;
  status: CommandStatus | null;
}

export const DEFAULT_STATE: HueOnboardingState = {
  step: "discover",
  bridges: [],
  selectedBridgeId: null,
  manualIp: "",
  manualIpError: null,
  credentialState: HUE_CREDENTIAL_STATUS.UNKNOWN,
  bridgeUnreachable: false,
  credentials: null,
  areaGroups: [],
  selectedAreaId: null,
  isDiscovering: false,
  isPairing: false,
  isLoadingAreas: false,
  isCheckingReadiness: false,
  isValidatingCredential: false,
  status: null,
};
