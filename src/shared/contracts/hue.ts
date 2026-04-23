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
  RESTART_STREAM: "restart_hue_stream",
  SET_SOLID_COLOR: "set_hue_solid_color",
  GET_STREAM_STATUS: "get_hue_stream_status",
  GET_AREA_CHANNELS: "get_hue_area_channels",
  UPDATE_CHANNEL_POSITIONS: "update_hue_channel_positions",
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
  /**
   * Catch-all pairing failure. Kept for backwards compatibility with
   * frontends that shipped before v1.4 G7 split specific pairing
   * failure modes. New call sites should prefer the specific codes
   * below when the cause is known.
   */
  PAIRING_FAILED: "HUE_PAIRING_FAILED",
  /**
   * Bridge responded with CLIP error 101 (link button not pressed).
   * User needs to press the physical button and retry.
   */
  PAIRING_LINK_BUTTON_NOT_PRESSED: "HUE_PAIRING_LINK_BUTTON_NOT_PRESSED",
  /**
   * Bridge rejected our `devicetype` string (too long, malformed,
   * already used with a different client). Host must regenerate a
   * unique `devicetype` before retrying.
   */
  PAIRING_DEVICETYPE_INVALID: "HUE_PAIRING_DEVICETYPE_INVALID",
  /**
   * Bridge is pairing another client right now; only one pairing can
   * be in flight at a time. User should wait a few seconds and retry.
   */
  PAIRING_BRIDGE_BUSY: "HUE_PAIRING_BRIDGE_BUSY",
  /**
   * Bridge throttled our pairing attempts (too many retries in a short
   * window). Surface a cooldown message and an exponential-backoff
   * retry hint to the user.
   */
  PAIRING_RATE_LIMITED: "HUE_PAIRING_RATE_LIMITED",
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
  STREAM_RUNNING_DTLS: "HUE_STREAM_RUNNING_DTLS",
  STREAM_STOPPING: "HUE_STREAM_STOPPING",
  STREAM_STOPPED: "HUE_STREAM_STOPPED",
  TRANSIENT_RETRY_SCHEDULED: "TRANSIENT_RETRY_SCHEDULED",
  TRANSIENT_RETRY_EXHAUSTED: "TRANSIENT_RETRY_EXHAUSTED",
  AUTH_INVALID_CREDENTIALS: "AUTH_INVALID_CREDENTIALS",
  /**
   * Uniform 403 re-pair signal (v1.4 G2).
   *
   * Any Hue CLIP v2 endpoint that returns HTTP 403 — discovery, validate,
   * start_stream, list_entertainment_areas — collapses onto this single
   * runtime code so the UI offers a single "re-pair bridge" recovery
   * action. Distinct from `HUE_STREAM_NOT_READY_ACTIVE_STREAMER` (someone
   * else is streaming) and `AUTH_INVALID_CREDENTIALS` (credentials null
   * or malformed, no 403 contacted the bridge).
   */
  AUTH_INVALID_RE_PAIR_REQUIRED: "AUTH_INVALID_RE_PAIR_REQUIRED",
  CONFIG_NOT_READY_GATE_BLOCKED: "CONFIG_NOT_READY_GATE_BLOCKED",
  STOP_TIMEOUT_PARTIAL: "HUE_STOP_TIMEOUT_PARTIAL",
  CHANNEL_POSITIONS_UPDATED: "HUE_CHANNEL_POSITIONS_UPDATED",
  CHANNEL_POSITIONS_FAILED: "HUE_CHANNEL_POSITIONS_FAILED",
} as const;

export type HueRuntimeStatusCode =
  (typeof HUE_RUNTIME_STATUS)[keyof typeof HUE_RUNTIME_STATUS];

export const HUE_RUNTIME_STATUS_FAMILY = {
  TRANSIENT: "TRANSIENT_*",
  AUTH_INVALID: "AUTH_INVALID_*",
  CONFIG_NOT_READY: "CONFIG_NOT_READY_*",
} as const;

export const HUE_FAULT_CODES = {
  // Network/connection family (HUE-NET-xx)
  NET_BRIDGE_UNREACHABLE: "HUE-NET-01",
  NET_DTLS_HANDSHAKE_FAILED: "HUE-NET-02",
  NET_DTLS_SEND_TIMEOUT: "HUE-NET-03",
  NET_DTLS_UNEXPECTED_EXIT: "HUE-NET-04",
  // Auth family (HUE-AUTH-xx)
  AUTH_CREDENTIALS_INVALID: "HUE-AUTH-01",
  AUTH_PAIRING_BROKEN: "HUE-AUTH-02",
  AUTH_FORBIDDEN_403: "HUE-AUTH-03",
  // Stream runtime family (HUE-STR-xx)
  STR_AREA_NOT_FOUND: "HUE-STR-01",
  STR_THROTTLE_DETECTED: "HUE-STR-02",
  STR_PACKET_SEND_FAILED: "HUE-STR-03",
  STR_SENDER_EXIT: "HUE-STR-04",
  // Configuration family (HUE-CFG-xx)
  CFG_NO_AREA_SELECTED: "HUE-CFG-01",
  CFG_BRIDGE_IP_CHANGED: "HUE-CFG-02",
} as const;

export type HueFaultCode = (typeof HUE_FAULT_CODES)[keyof typeof HUE_FAULT_CODES];

// ---------------------------------------------------------------------------
// Hue room archetypes (v1.4 — CLIP v2 whitelist)
// ---------------------------------------------------------------------------

/**
 * Hue CLIP v2 room archetypes. The bridge stamps one of these on every
 * room so the frontend can pick a meaningful icon / copy ("living_room"
 * → sofa icon). Values below mirror the CLIP v2 spec; `other` is the
 * fallback any unrecognized archetype maps to so the UI never shows an
 * empty / raw identifier string.
 *
 * Archetype is returned separately from `roomName` because a user can
 * (and often does) override the display name while keeping the semantic
 * archetype — we want both signals.
 */
export const HUE_ROOM_ARCHETYPES = [
  "living_room",
  "kitchen",
  "dining",
  "bedroom",
  "kids_bedroom",
  "bathroom",
  "nursery",
  "recreation",
  "office",
  "gym",
  "hallway",
  "toilet",
  "front_door",
  "garage",
  "terrace",
  "garden",
  "driveway",
  "carport",
  "home",
  "downstairs",
  "upstairs",
  "top_floor",
  "attic",
  "guest_room",
  "staircase",
  "lounge",
  "man_cave",
  "computer",
  "studio",
  "music",
  "tv",
  "reading",
  "closet",
  "storage",
  "laundry_room",
  "balcony",
  "porch",
  "barbecue",
  "pool",
  "other",
] as const;

export type HueRoomArchetype = (typeof HUE_ROOM_ARCHETYPES)[number];

/** Sentinel returned when the bridge advertises an archetype the whitelist does not know. */
export const HUE_ARCHETYPE_FALLBACK: HueRoomArchetype = "other";

// ---------------------------------------------------------------------------
// Hue intensity presets (v1.4 — EWMA smoothing tiers)
// ---------------------------------------------------------------------------

/**
 * User-facing intensity presets for ambient Hue streaming. Each preset
 * maps to a single EWMA (exponentially-weighted moving average)
 * coefficient `alpha` applied to the per-channel RGB stream:
 *
 *   smoothed = alpha * newSample + (1 - alpha) * prevSmoothed
 *
 * Lower alpha ⇒ heavier smoothing ⇒ calmer lights. Higher alpha ⇒
 * snappier response ⇒ more intense.
 *
 * - `subtle` (0.15): slow, relaxed — ideal for bedroom / background.
 * - `moderate` (0.35): balanced — default for living rooms.
 * - `intense` (0.60): fast-reacting — gaming / action content.
 *
 * Stored under `ShellState.lightingIntensityPreset`.
 */
export type HueIntensityPreset = "subtle" | "moderate" | "intense";

export const HUE_INTENSITY_PRESET_COEFFICIENTS: Readonly<Record<HueIntensityPreset, number>> = {
  subtle: 0.15,
  moderate: 0.35,
  intense: 0.6,
};

/** Default preset applied when `ShellState.lightingIntensityPreset` is absent. */
export const DEFAULT_HUE_INTENSITY_PRESET: HueIntensityPreset = "moderate";

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
  /**
   * Bridge-reported archetype for the parent room, if any. Separate from
   * `roomName` because users often rename rooms but keep the archetype
   * (e.g. archetype "living_room" with name "Studio"). Falls back to
   * `HUE_ARCHETYPE_FALLBACK` when unrecognized.
   */
  archetype?: HueRoomArchetype;
  channelCount?: number;
  activeStreamer?: boolean;
}

export interface HueStreamReadiness {
  ready: boolean;
  reasons: string[];
}
