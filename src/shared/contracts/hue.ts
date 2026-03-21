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
  START_STREAM: "start_hue_stream",
  STOP_STREAM: "stop_hue_stream",
  GET_STREAM_STATUS: "get_hue_stream_status",
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
  UNKNOWN: "unknown",
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

export const HUE_RUNTIME_STATES = {
  IDLE: "Idle",
  STARTING: "Starting",
  RUNNING: "Running",
  RECONNECTING: "Reconnecting",
  STOPPING: "Stopping",
  FAILED: "Failed",
} as const;

export type HueRuntimeState =
  (typeof HUE_RUNTIME_STATES)[keyof typeof HUE_RUNTIME_STATES];

export const HUE_RUNTIME_ACTION_HINT = {
  RETRY: "retry",
  RECONNECT: "reconnect",
  REPAIR: "repair",
  REVALIDATE: "revalidate",
  ADJUST_AREA: "adjust_area",
} as const;

export type HueRuntimeActionHint =
  (typeof HUE_RUNTIME_ACTION_HINT)[keyof typeof HUE_RUNTIME_ACTION_HINT];

export const HUE_RUNTIME_TRIGGER_SOURCE = {
  MODE_CONTROL: "mode_control",
  DEVICE_SURFACE: "device_surface",
  SYSTEM: "system",
} as const;

export type HueRuntimeTriggerSource =
  (typeof HUE_RUNTIME_TRIGGER_SOURCE)[keyof typeof HUE_RUNTIME_TRIGGER_SOURCE];

export const HUE_RUNTIME_STATUS = {
  STREAM_STARTING: "HUE_STREAM_STARTING",
  STREAM_RUNNING: "HUE_STREAM_RUNNING",
  STREAM_STOPPING: "HUE_STREAM_STOPPING",
  STREAM_STOPPED: "HUE_STREAM_STOPPED",
  TRANSIENT_RETRY_SCHEDULED: "TRANSIENT_RETRY_SCHEDULED",
  TRANSIENT_RETRY_EXHAUSTED: "TRANSIENT_RETRY_EXHAUSTED",
  AUTH_INVALID_CREDENTIALS: "AUTH_INVALID_CREDENTIALS",
  CONFIG_NOT_READY_GATE_BLOCKED: "CONFIG_NOT_READY_GATE_BLOCKED",
  STOP_TIMEOUT_PARTIAL: "HUE_STOP_TIMEOUT_PARTIAL",
} as const;

export type HueRuntimeStatusCode =
  (typeof HUE_RUNTIME_STATUS)[keyof typeof HUE_RUNTIME_STATUS];

export const HUE_RUNTIME_STATUS_FAMILY = {
  TRANSIENT: "TRANSIENT_*",
  AUTH_INVALID: "AUTH_INVALID_*",
  CONFIG_NOT_READY: "CONFIG_NOT_READY_*",
} as const;

export type HueRuntimeTarget = "hue" | "usb";

export interface HueRuntimeTargetTelemetryRow {
  target: HueRuntimeTarget;
  state: HueRuntimeState;
  code: HueRuntimeStatusCode | string;
  message: string;
  details?: string;
  remainingAttempts?: number;
  nextAttemptMs?: number;
  actionHint?: HueRuntimeActionHint;
}

export interface HueRuntimeAggregateTelemetry {
  activeTargets: HueRuntimeTarget[];
  runningCount: number;
  reconnectingCount: number;
  failedCount: number;
}

export interface HueRuntimeTelemetry {
  hue: HueRuntimeTargetTelemetryRow;
  aggregate: HueRuntimeAggregateTelemetry;
}

export interface HueRuntimeStatus extends HueCommandStatus {
  state: HueRuntimeState;
  triggerSource: HueRuntimeTriggerSource;
  remainingAttempts?: number;
  nextAttemptMs?: number;
  actionHint?: HueRuntimeActionHint;
  telemetry?: HueRuntimeTelemetry;
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
