/**
 * Hue onboarding contracts for frontend <-> backend command bridge.
 */

import {
  DEFAULT_LIGHTING_SMOOTHING_PRESET,
  LIGHTING_SMOOTHING_PRESET_COEFFICIENTS,
  type LightingSmoothingPreset,
} from "./lighting";
import {
  HUE_ZONE_COMMANDS as ROOM_MAP_HUE_ZONE_COMMANDS,
  HUE_ZONE_STATUS_CODES as ROOM_MAP_HUE_ZONE_STATUS_CODES,
  type HueZone as RoomMapHueZone,
  type HueZoneCommandId as RoomMapHueZoneCommandId,
  type HueZoneStatusCode as RoomMapHueZoneStatusCode,
} from "./roomMap";

/** On every command carrying a `username`, `""` means "resolve from the OS
 * keychain" (same idiom as `clientKey`) and a non-empty value is the legacy
 * fallback. Resolving nothing ⇒ `AUTH_INVALID_RE_PAIR_REQUIRED`. */
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
  MIGRATE_CREDENTIALS: "migrate_hue_credentials",
} as const;

export type HueCommandId = (typeof HUE_COMMANDS)[keyof typeof HUE_COMMANDS];

// ---------------------------------------------------------------------------
// Hue zone authoring — canonical surface lives in `roomMap.ts` (v1.5 W4-F2)
// ---------------------------------------------------------------------------

/**
 * Re-export of the canonical Hue zone command map from `roomMap.ts`.
 *
 * v1.5 W4-F2 rolled the W4-F generic `ZONE_COMMANDS` map back to a
 * Hue-only `HUE_ZONE_COMMANDS` after the direction reversal.
 * The map is owned by `roomMap.ts` (zones are persisted on
 * `RoomMapConfig`); the alias here keeps existing imports
 * (`LightsSection`, `RoomMapEditor`) working without source churn.
 */
export const HUE_ZONE_COMMANDS = ROOM_MAP_HUE_ZONE_COMMANDS;

/** Re-export of the canonical Hue zone command id type. */
export type HueZoneCommandId = RoomMapHueZoneCommandId;

/**
 * Re-export of the canonical `HueZone` interface (single source of truth
 * in `roomMap.ts`). Hue-only after the W4-F2 reversal — no longer a
 * discriminated-union projection.
 */
export type HueZone = RoomMapHueZone;

/**
 * Re-export of the eight Hue zone authoring status codes. Surfaced here
 * so consumers that already import from `hue.ts` keep a single import
 * surface for Hue runtime + Hue zone authoring.
 */
export const HUE_ZONE_STATUS_CODES = ROOM_MAP_HUE_ZONE_STATUS_CODES;

/** Re-export of the canonical Hue zone status code union. */
export type HueZoneStatusCode = RoomMapHueZoneStatusCode;

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
  // -------------------------------------------------------------------------
  // OS keychain credential store (v1.5 W2-A1 / W2-A2)
  // -------------------------------------------------------------------------
  /**
   * Credential store call (set / get / delete) succeeded against the
   * platform-native keychain (macOS Keychain / Windows CredMan / Linux
   * Secret Service).
   */
  CREDENTIAL_STORE_OK: "HUE_CREDENTIAL_STORE_OK",
  /**
   * The OS keychain backend is genuinely unavailable on this platform
   * (no D-Bus / sandbox-blocked Keychain / locked CredMan). Caller
   * MUST fall back to the legacy plaintext shellStore fields so the
   * app keeps running for users who paired before v1.5.
   */
  CREDENTIAL_STORE_UNAVAILABLE: "HUE_CREDENTIAL_STORE_UNAVAILABLE",
  /**
   * Pairing succeeded AND the new credentials were written into the
   * OS keychain. Frontend can clear `shellStore.hueAppKey` /
   * `shellStore.hueClientKey` (the keychain is now source of truth).
   */
  CREDENTIAL_MIGRATION_OK: "HUE_CREDENTIAL_MIGRATION_OK",
  /**
   * Credentials already lived in the keychain and matched the values
   * we just received from the bridge — no write performed. Idempotent
   * happy path for re-pair flows.
   */
  CREDENTIAL_MIGRATION_SKIPPED: "HUE_CREDENTIAL_MIGRATION_SKIPPED",
  /**
   * Keychain write failed (or backend was unavailable). Frontend MUST
   * keep the plaintext fallback so the bridge stays usable; downgrade-
   * safe behaviour for users on platforms with broken keychain access.
   */
  CREDENTIAL_MIGRATION_FAILED: "HUE_CREDENTIAL_MIGRATION_FAILED",
  // -------------------------------------------------------------------------
  // mDNS LAN bridge discovery (v1.5 W2-A3)
  // -------------------------------------------------------------------------
  /**
   * `_hue._tcp.local.` browse returned at least one bridge OR the
   * cloud discovery returned bridges and the merged list is non-empty.
   * Same code as the cloud-only happy path so existing UIs continue
   * working without changes.
   */
  MDNS_DISCOVERY_OK: "HUE_MDNS_DISCOVERY_OK",
  /**
   * The mDNS browse window elapsed without resolving any bridges AND
   * the cloud discovery also produced no results. Distinct from
   * `HUE_DISCOVERY_EMPTY` because the timeout is mDNS-specific (no
   * multicast packets observed during the bounded window).
   */
  MDNS_DISCOVERY_TIMEOUT: "HUE_MDNS_DISCOVERY_TIMEOUT",
  /**
   * The mDNS responder could not be initialised on this platform
   * (sandbox-blocked multicast, no IPv4 stack, locked port 5353).
   * The merged response falls back to cloud-only discovery; this code
   * is reserved for the runtime-telemetry surface that will let users
   * see why LAN discovery is offline on their machine.
   */
  MDNS_UNSUPPORTED: "HUE_MDNS_UNSUPPORTED",
} as const;

export type HueStatusCode = (typeof HUE_STATUS)[keyof typeof HUE_STATUS];

/** Coarse pairing-credential health used to decide whether to prompt a re-pair. */
export const HUE_CREDENTIAL_STATUS = {
  VALID: "valid",
  NEEDS_REPAIR: "needs_repair",
  UNKNOWN: "unknown",
} as const;

export type HueCredentialStatus =
  (typeof HUE_CREDENTIAL_STATUS)[keyof typeof HUE_CREDENTIAL_STATUS];

/** Steps of the Hue onboarding wizard, in order. */
export const HUE_ONBOARDING_STEP = {
  DISCOVER: "discover",
  PAIR: "pair",
  AREA_SELECT: "area_select",
  READY: "ready",
} as const;

export type HueOnboardingStep =
  (typeof HUE_ONBOARDING_STEP)[keyof typeof HUE_ONBOARDING_STEP];

/** Coded result shape shared by every Hue command — never throws, always returns this. */
export interface HueCommandStatus {
  code: HueStatusCode | string;
  message: string;
  /** `null` on the wire (Rust `Option<String>`, no `skip_serializing_if`);
   * also optional because the type is constructed frontend-side too. */
  details?: string | null;
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

/** Suggested recovery action for a Hue runtime fault, shown as a UI hint. */
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

/** Fine-grained runtime status codes surfaced on `HueRuntimeStatus.code`. */
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
  /** `start_hue_stream` on an already-running stream: idempotent no-op, not an error. */
  START_NOOP_ALREADY_ACTIVE: "HUE_START_NOOP_ALREADY_ACTIVE",
  /** The store's initial value, before any start has been attempted. */
  STREAM_IDLE: "HUE_STREAM_IDLE",
  /** Started, but the area resolved to zero colour-addressable lights —
   * a success state that still lights nothing, so it carries `Revalidate`. */
  STREAM_RUNNING_NO_LIGHTS: "HUE_STREAM_RUNNING_NO_LIGHTS",
  /** The start path unwound before a stream context existed (drop guard). */
  STREAM_START_ABORTED: "HUE_STREAM_START_ABORTED",
  /** User cancelled a reconnect workflow — terminal, do not auto-retry. */
  STOPPED_BY_USER: "HUE_STOPPED_BY_USER",
} as const;

export type HueRuntimeStatusCode =
  (typeof HUE_RUNTIME_STATUS)[keyof typeof HUE_RUNTIME_STATUS];

/**
 * Sentinel inside `HueStreamReadiness.reasons`, which otherwise holds English
 * prose — compare against it, never display it. Not a `status.code`.
 */
export const HUE_READINESS_REASON = {
  ACTIVE_STREAMER: "HUE_STREAM_NOT_READY_ACTIVE_STREAMER",
} as const;

export type HueReadinessReason =
  (typeof HUE_READINESS_REASON)[keyof typeof HUE_READINESS_REASON];

/**
 * `set_hue_solid_color` codes. Only `APPLIED` reached a sender; the rest are
 * queued for replay by `flush_pending_solid_color` and must be surfaced.
 */
export const HUE_SOLID_COLOR_STATUS = {
  APPLIED: "HUE_COLOR_APPLIED",
  QUEUED_PENDING_STREAM: "HUE_COLOR_QUEUED_PENDING_STREAM",
  APPLY_SKIPPED: "HUE_COLOR_APPLY_SKIPPED",
  APPLY_SKIPPED_NO_LIGHTS: "HUE_COLOR_APPLY_SKIPPED_NO_LIGHTS",
} as const;

export type HueSolidColorStatusCode =
  (typeof HUE_SOLID_COLOR_STATUS)[keyof typeof HUE_SOLID_COLOR_STATUS];

/**
 * True when the bridge did NOT receive the colour — the picker swatch and the
 * bulbs disagree, so the caller must surface a notice.
 */
export function isHueSolidColorUnapplied(code: string): boolean {
  return (
    code === HUE_SOLID_COLOR_STATUS.APPLY_SKIPPED ||
    code === HUE_SOLID_COLOR_STATUS.APPLY_SKIPPED_NO_LIGHTS
  );
}

/** Prefix families the runtime status codes fall into, for coarse-grained UI branching. */
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

/** `simulate_hue_fault` is `#[cfg(debug_assertions)]`-gated; the release build
 * registers a stub that reports `SIMULATE_NOT_AVAILABLE_IN_RELEASE`. All three
 * arrive as the `code` of a `HueCommandStatus` — the command never throws, so
 * "no stream to fault" is a branch, not a rejected promise. */
export const HUE_DEBUG_COMMAND_CODES = {
  FAULT_SIMULATED: "HUE_FAULT_SIMULATED",
  NO_ACTIVE_DTLS_STREAM: "NO_ACTIVE_DTLS_STREAM",
  NOT_AVAILABLE_IN_RELEASE: "SIMULATE_NOT_AVAILABLE_IN_RELEASE",
} as const;

export type HueDebugCommandCode =
  (typeof HUE_DEBUG_COMMAND_CODES)[keyof typeof HUE_DEBUG_COMMAND_CODES];

/** Reasons riding `status.details` on a `HUE_STREAM_*` status, never codes of
 *  their own. Naming them keeps a log reader honest; do not branch on them —
 *  the status code is the discriminator. */
export const HUE_TRANSPORT_REASON = {
  DTLS_PSK_DECODE_FAILED: "DTLS_PSK_DECODE_FAILED",
  DTLS_CONNECTOR_BUILD_FAILED: "DTLS_CONNECTOR_BUILD_FAILED",
  DTLS_CIPHER_SET_FAILED: "DTLS_CIPHER_SET_FAILED",
  DTLS_SOCKET_BIND_FAILED: "DTLS_SOCKET_BIND_FAILED",
  DTLS_SOCKET_CONNECT_FAILED: "DTLS_SOCKET_CONNECT_FAILED",
  DTLS_SOCKET_TIMEOUT_FAILED: "DTLS_SOCKET_TIMEOUT_FAILED",
  DTLS_HANDSHAKE_FAILED: "DTLS_HANDSHAKE_FAILED",
  DTLS_HANDSHAKE_ABANDONED: "DTLS_HANDSHAKE_ABANDONED",
  ENTERTAINMENT_ACTIVATE_FAILED: "ENTERTAINMENT_ACTIVATE_FAILED",
  ENTERTAINMENT_ACTIVATE_SEND_FAILED: "ENTERTAINMENT_ACTIVATE_SEND_FAILED",
  ENTERTAINMENT_DEACTIVATE_FAILED: "ENTERTAINMENT_DEACTIVATE_FAILED",
  ENTERTAINMENT_DEACTIVATE_SEND_FAILED: "ENTERTAINMENT_DEACTIVATE_SEND_FAILED",
  HUE_SENDER_INIT_FAILED: "HUE_SENDER_INIT_FAILED",
} as const;

export type HueTransportReason =
  (typeof HUE_TRANSPORT_REASON)[keyof typeof HUE_TRANSPORT_REASON];

// ---------------------------------------------------------------------------
// Credential storage backend (v1.5 W2-A1 / W2-A2)
// ---------------------------------------------------------------------------

/**
 * Where the Hue credentials are currently persisted. Surfaced via the
 * optional `credentialStorageBackend` field on `ShellState` so the UI /
 * dev tools can show a "stored in keychain" badge and so future
 * migrations can detect the legacy fallback path.
 *
 * - `keychain` — OS-native keychain (macOS Keychain Services / Windows
 *   Credential Manager / Linux Secret Service via libsecret + D-Bus).
 *   This is the W2-A2 happy path.
 * - `plaintext-legacy` — `shellStore.hueAppKey` / `shellStore.hueClientKey`.
 *   Used by users who paired before v1.5 and as a downgrade-safe fallback
 *   when the OS keychain is unavailable. Migration to `keychain` happens
 *   silently on next successful keychain probe.
 */
export const HUE_CREDENTIAL_BACKENDS = {
  KEYCHAIN: "keychain",
  PLAINTEXT_LEGACY: "plaintext-legacy",
} as const;

export type HueCredentialBackend =
  (typeof HUE_CREDENTIAL_BACKENDS)[keyof typeof HUE_CREDENTIAL_BACKENDS];

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
// Hue intensity presets (v1.4 — deprecated aliases, unified in v1.4)
// ---------------------------------------------------------------------------

/**
 * @deprecated Use `LightingSmoothingPreset` from `./lighting.ts`. This
 * alias is kept so pre-v1.4 call sites keep compiling until the v1.5
 * clean-up removes them. The two types are structurally identical.
 */
export type HueIntensityPreset = LightingSmoothingPreset;

/**
 * @deprecated Use `LIGHTING_SMOOTHING_PRESET_COEFFICIENTS` from
 * `./lighting.ts`. Same coefficient table, re-exported under the old
 * name for backward compatibility.
 */
export const HUE_INTENSITY_PRESET_COEFFICIENTS: Readonly<
  Record<LightingSmoothingPreset, number>
> = LIGHTING_SMOOTHING_PRESET_COEFFICIENTS;

/**
 * @deprecated Use `DEFAULT_LIGHTING_SMOOTHING_PRESET` from `./lighting.ts`.
 */
export const DEFAULT_HUE_INTENSITY_PRESET: LightingSmoothingPreset =
  DEFAULT_LIGHTING_SMOOTHING_PRESET;

/** Which output surface a runtime telemetry row describes. */
export type HueRuntimeTarget = "hue" | "usb";

export interface HueRuntimeTargetTelemetryRow {
  target: HueRuntimeTarget;
  state: HueRuntimeState;
  code: HueRuntimeStatusCode | string;
  message: string;
  details?: string | null;
  remainingAttempts?: number | null;
  nextAttemptMs?: number | null;
  actionHint?: HueRuntimeActionHint | null;
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
  remainingAttempts?: number | null;
  nextAttemptMs?: number | null;
  actionHint?: HueRuntimeActionHint | null;
  telemetry?: HueRuntimeTelemetry;
}

/** One bridge returned by discovery, before pairing. */
export interface HueBridgeSummary {
  id: string;
  ip: string;
  name: string;
  modelId?: string | null;
  softwareVersion?: string | null;
}

export interface HuePairingCredentials {
  username: string;
  clientKey: string;
}

/** Result of `pair_hue_bridge`. */
export interface HuePairBridgeResponse {
  status: HueCommandStatus;
  credentials: HuePairingCredentials | null;
  /** Only the literal `"keychain"` licenses deleting the plaintext PSK; absent
   * and unrecognised read as legacy — see docs/architecture/hue.md. */
  credentialStorageBackend?: HueCredentialBackend;
}

/** `backend` reaches `keychain` only once the copy is written AND read back,
 * so the caller may clear the plaintext copy on that value alone. */
export interface HueCredentialMigrationResponse {
  status: HueCommandStatus;
  backend?: HueCredentialBackend;
}

export interface HueEntertainmentAreaSummary {
  id: string;
  name: string;
  roomName?: string | null;
  /**
   * Bridge-reported archetype for the parent room, if any. Separate from
   * `roomName` because users often rename rooms but keep the archetype
   * (e.g. archetype "living_room" with name "Studio"). Falls back to
   * `HUE_ARCHETYPE_FALLBACK` when unrecognized.
   */
  archetype?: HueRoomArchetype | null;
  /** Non-`Option` in Rust — always on the wire. */
  channelCount: number;
  /** Non-`Option` in Rust — always on the wire. */
  activeStreamer: boolean;
}

/** Result of `check_hue_stream_readiness` — whether starting the stream would succeed. */
export interface HueStreamReadiness {
  ready: boolean;
  reasons: string[];
}
