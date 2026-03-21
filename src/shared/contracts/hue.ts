/**
 * Hue onboarding contracts for frontend <-> backend command bridge.
 */

export const HUE_COMMANDS = {
  DISCOVER_BRIDGES: "discover_hue_bridges",
  VERIFY_BRIDGE_IP: "verify_hue_bridge_ip",
  PAIR_BRIDGE: "pair_hue_bridge",
  VALIDATE_CREDENTIALS: "validate_hue_credentials",
  LIST_ENTERTAINMENT_AREAS: "list_hue_entertainment_areas",
  CHECK_STREAM_READINESS: "check_hue_stream_readiness",
} as const;

export type HueCommandId = (typeof HUE_COMMANDS)[keyof typeof HUE_COMMANDS];

export const HUE_STATUS = {
  DISCOVERY_OK: "HUE_DISCOVERY_OK",
  DISCOVERY_EMPTY: "HUE_DISCOVERY_EMPTY",
  DISCOVERY_FAILED: "HUE_DISCOVERY_FAILED",
  IP_VALID: "HUE_IP_VALID",
  IP_INVALID: "HUE_IP_INVALID",
  IP_UNREACHABLE: "HUE_IP_UNREACHABLE",
  PAIRING_OK: "HUE_PAIRING_OK",
  PAIRING_PENDING_LINK_BUTTON: "HUE_PAIRING_PENDING_LINK_BUTTON",
  PAIRING_FAILED: "HUE_PAIRING_FAILED",
  CREDENTIAL_VALID: "HUE_CREDENTIAL_VALID",
  CREDENTIAL_INVALID: "HUE_CREDENTIAL_INVALID",
  CREDENTIAL_CHECK_FAILED: "HUE_CREDENTIAL_CHECK_FAILED",
  AREA_LIST_OK: "HUE_AREA_LIST_OK",
  AREA_LIST_EMPTY: "HUE_AREA_LIST_EMPTY",
  AREA_LIST_FAILED: "HUE_AREA_LIST_FAILED",
  STREAM_READY: "HUE_STREAM_READY",
  STREAM_NOT_READY: "HUE_STREAM_NOT_READY",
  STREAM_READINESS_FAILED: "HUE_STREAM_READINESS_FAILED",
} as const;

export type HueStatusCode = (typeof HUE_STATUS)[keyof typeof HUE_STATUS];

export const HUE_CREDENTIAL_STATUS = {
  VALID: "valid",
  NEEDS_REPAIR: "needs_repair",
} as const;

export type HueCredentialStatus =
  (typeof HUE_CREDENTIAL_STATUS)[keyof typeof HUE_CREDENTIAL_STATUS];

export const HUE_ONBOARDING_STEP = {
  DISCOVER: "discover",
  PAIR: "pair",
  AREA_SELECT: "area_select",
  READY: "ready",
} as const;

export type HueOnboardingStep =
  (typeof HUE_ONBOARDING_STEP)[keyof typeof HUE_ONBOARDING_STEP];

export interface HueCommandStatus {
  code: HueStatusCode | string;
  message: string;
  details?: string;
}

export interface HueBridgeSummary {
  id: string;
  ip: string;
  name: string;
  modelId?: string;
  softwareVersion?: string;
}

export interface HuePairingCredentials {
  username: string;
  clientKey: string;
}

export interface HueEntertainmentAreaSummary {
  id: string;
  name: string;
  roomName?: string;
  channelCount?: number;
  activeStreamer?: boolean;
}

export interface HueStreamReadiness {
  ready: boolean;
  reasons: string[];
}
