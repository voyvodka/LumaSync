/**
 * Device connection contracts for frontend <-> backend command bridge.
 */

import type { CommandStatusOf } from "./status";

export const DEVICE_COMMANDS = {
  LIST_PORTS: "list_serial_ports",
  CONNECT_PORT: "connect_serial_port",
  GET_CONNECTION_STATUS: "get_serial_connection_status",
  RUN_HEALTH_CHECK: "run_serial_health_check",
  START_CALIBRATION_TEST_PATTERN: "start_calibration_test_pattern",
  STOP_CALIBRATION_TEST_PATTERN: "stop_calibration_test_pattern",
  SET_LIGHTING_MODE: "set_lighting_mode",
  STOP_LIGHTING: "stop_lighting",
  GET_LIGHTING_MODE_STATUS: "get_lighting_mode_status",
  GET_RUNTIME_TELEMETRY: "get_runtime_telemetry",
  /**
   * v1.5 W1-B1 — probe a single user-supplied IP's `/json/info` endpoint.
   * Manual-IP only; not a LAN scan. Returns `WledDeviceInfo[]` (0 or 1).
   */
  DISCOVER_WLED_DEVICES: "discover_wled_devices",
  /**
   * v1.5 W1-B1 — promote a discovered WLED instance to the active sink.
   * Mirrors `connect_serial_port` semantics: idempotent, replaces the
   * current sink, no implicit stream start.
   */
  CONNECT_WLED_SINK: "connect_wled_sink",
  /**
   * v1.5 W1-B1 — round-trip a single test packet to verify reachability,
   * negotiated protocol, and reported LED count match the user's config.
   * Surfaces `WLED_BRIDGE_UNREACHABLE` / `WLED_PROTOCOL_MISMATCH` /
   * `WLED_LED_COUNT_MISMATCH` instead of generic transport errors.
   */
  TEST_WLED_BRIDGE: "test_wled_bridge",
  /** Registry snapshot of the bound WLED sink. `lastWledSink` is intent; this is what Rust holds — they diverge when a boot restore fails or serial evicts WLED. */
  GET_WLED_SINK_STATUS: "get_wled_sink_status",
} as const;

export const DEVICE_STATUS = {
  IDLE: "idle",
  SCANNING: "scanning",
  READY: "ready",
  CONNECTING: "connecting",
  CONNECTED: "connected",
  DISCONNECTED: "disconnected",
  RECONNECTING: "reconnecting",
  HEALTH_CHECKING: "health_checking",
  MANUAL_REQUIRED: "manual_required",
  ERROR: "error",
} as const;

export type DeviceStatus = (typeof DEVICE_STATUS)[keyof typeof DEVICE_STATUS];

/** VID:PID pairs of the supported USB-serial controller chips (allowlist). */
export const SUPPORTED_CONTROLLER_IDS = [
  "1A86:7523", // CH340
  "0403:6001", // FTDI FT232
  "10C4:EA60", // CP2102 (Silicon Labs)
  "2341:0043", // Arduino Uno R3
  "2341:0001", // Arduino Uno (original USB ID)
  "067B:2303", // PL2303 (Prolific)
  "1A86:5523", // CH341 (WinChipHead)
  "10C4:EA70", // CP2104 (Silicon Labs)
  "0403:6014", // FT232H (FTDI Hi-Speed)
] as const;

export type SupportedControllerId = (typeof SUPPORTED_CONTROLLER_IDS)[number];

export const DEVICE_ERROR_CODES = {
  PORT_NOT_FOUND: "PORT_NOT_FOUND",
  /** Port is outside `SUPPORTED_USB_DEVICE_ALLOWLIST`. Was long declared here
   * transposed as `UNSUPPORTED_PORT`, a spelling no producer ever emitted. */
  PORT_UNSUPPORTED: "PORT_UNSUPPORTED",
  /** Frontend fallback minted by `mapModeApiError` — the one member with a TS producer. */
  UNKNOWN: "UNKNOWN",
} as const;

export type DeviceErrorCode = (typeof DEVICE_ERROR_CODES)[keyof typeof DEVICE_ERROR_CODES];

/** `list_serial_ports` outcome. Separate from {@link DEVICE_ERROR_CODES} because
 * the success arm is not an error and the pair must stay complete. */
export const SERIAL_PORT_LIST_STATUS = {
  OK: "LIST_PORTS_OK",
  FAILED: "LIST_PORTS_FAILED",
} as const;

export type SerialPortListStatusCode =
  (typeof SERIAL_PORT_LIST_STATUS)[keyof typeof SERIAL_PORT_LIST_STATUS];

/** Serial port open outcome, shared by `connect_serial_port` and the
 * `CONNECT_AND_VERIFY` health step. `FAILED` is the catch-all — Rust's
 * `connect_error_code` narrows to the others first, plus `PORT_NOT_FOUND`
 * from {@link DEVICE_ERROR_CODES}. All land on one `status.code`. */
export const SERIAL_CONNECT_STATUS = {
  OK: "CONNECT_OK",
  FAILED: "CONNECT_FAILED",
  /** No connect has been attempted yet — the value `SerialConnectionStatus`
   * carries from first launch until the first `connect_serial_port`. */
  IDLE: "NOT_CONNECTED",
  INVALID_INPUT: "CONNECT_INVALID_INPUT",
  /** Typically a udev/dialout permission gap on Linux, not a user denial. */
  PERMISSION_DENIED: "CONNECT_PERMISSION_DENIED",
  TIMEOUT: "CONNECT_TIMEOUT",
  IO_ERROR: "CONNECT_IO_ERROR",
} as const;

export type SerialConnectStatusCode =
  (typeof SERIAL_CONNECT_STATUS)[keyof typeof SERIAL_CONNECT_STATUS];

/** Thrown by `get_serial_connection_status` as `Err(String)`, formatted
 * `"CODE: detail"`. A `catch` sees these; a `switch (status.code)` never will. */
export const SERIAL_COMMAND_ERRORS = {
  STATUS_READ_FAILED: "STATUS_READ_FAILED",
} as const;

export type SerialCommandErrorCode =
  (typeof SERIAL_COMMAND_ERRORS)[keyof typeof SERIAL_COMMAND_ERRORS];

/** Exactly what `device_connection.rs` puts on `SerialPortListResponse.status`
 * and `SerialConnectionStatus.status`. `UNKNOWN` is out — it is minted by
 * `mapModeApiError` and never crosses this wire. */
export type SerialCommandStatusCode =
  | SerialPortListStatusCode
  | SerialConnectStatusCode
  | typeof DEVICE_ERROR_CODES.PORT_NOT_FOUND
  | typeof DEVICE_ERROR_CODES.PORT_UNSUPPORTED;

export type SerialCommandStatus = CommandStatusOf<SerialCommandStatusCode>;

/** In-flight device operation kind, used to gate concurrent UI actions. */
export const DEVICE_OPERATION = {
  IDLE: "idle",
  RECOVERY: "recovery",
  MANUAL_CONNECT: "manual_connect",
  HEALTH_CHECK: "health_check",
} as const;

export type DeviceOperation = (typeof DEVICE_OPERATION)[keyof typeof DEVICE_OPERATION];

/** Ordered stages of the serial health-check flow. `HANDSHAKE` has no
 * underscore, so the verifier's code harvest cannot see it — the pinned
 * `step:` harvest is the only thing keeping it declared. */
export const DEVICE_HEALTH_STEPS = {
  PORT_VISIBLE: "PORT_VISIBLE",
  PORT_SUPPORTED: "PORT_SUPPORTED",
  CONNECT_AND_VERIFY: "CONNECT_AND_VERIFY",
  HANDSHAKE: "HANDSHAKE",
  /** Not a stage: the sole step reported when the blocking worker panics. */
  HEALTH_CHECK_WORKER: "HEALTH_CHECK_WORKER",
} as const;

export type DeviceHealthStep = (typeof DEVICE_HEALTH_STEPS)[keyof typeof DEVICE_HEALTH_STEPS];

/** Persisted shellStore keys owned by the device feature. */
export const DEVICE_STORE_KEYS = {
  LAST_SUCCESSFUL_PORT: "lastSuccessfulPort",
} as const;

// ---------------------------------------------------------------------------
// Firmware profile (v1.4 G11 — Adalight encoder toggle)
// ---------------------------------------------------------------------------

/**
 * Firmware profile selector for the USB `LedSink`.
 *
 * - `adalight`: widely used "Ada" magic-byte stream, compatible with Prismatik,
 *   Hyperion, Boblight, and most DIY Arduino firmware sketches. This is the
 *   interoperability fallback for users who cannot flash our own firmware.
 * - `lumasync-v1`: LumaSync's native protocol (handshake + framed payload)
 *   that unlocks health-check round-trip metrics and per-frame telemetry.
 *
 * Stored under `ShellState.firmwareProfile`. Absent ⇒ treat as
 * `LUMASYNC_V1` when the handshake succeeds; fall back to `ADALIGHT`
 * when the handshake fails so plain Adalight sketches still light up.
 */
export const FIRMWARE_PROFILE = {
  ADALIGHT: "adalight",
  LUMASYNC_V1: "lumasync-v1",
} as const;

export type FirmwareProfile = (typeof FIRMWARE_PROFILE)[keyof typeof FIRMWARE_PROFILE];

// ---------------------------------------------------------------------------
// LED chip type (v1.5 G3 — SK6812 RGBW host-side encoder)
// ---------------------------------------------------------------------------

/**
 * LED chip type — controls the per-pixel byte layout in the encoded payload.
 *
 * This is an orthogonal axis to `FirmwareProfile`: the profile selects the
 * wire framing family (LumaSync v1 vs Adalight); the chip type selects the
 * per-pixel byte width within the payload.
 *
 * - `ws2812b-grb`: 3-byte RGB pixels (default). Backward-compatible with all
 *   v1.x firmware.
 * - `sk6812-rgbw`: 4-byte RGBW pixels. White channel `W = min(R, G, B)` is
 *   extracted on the host after colour corrections are applied to R/G/B; the
 *   W channel bypasses the LUT so that the firmware's native white
 *   temperature is preserved.
 *
 * APA102 is deferred to v2.0 (firmware companion repo decision pending).
 *
 * Stored under `ShellState.selectedChipType`. Absent ⇒ `WS2812B_GRB`.
 */
export const LED_CHIP_TYPE = {
  WS2812B_GRB: "ws2812b-grb",
  SK6812_RGBW: "sk6812-rgbw",
} as const;

export type LedChipType = (typeof LED_CHIP_TYPE)[keyof typeof LED_CHIP_TYPE];

// ---------------------------------------------------------------------------
// Color correction (v1.4 G4 — per-channel gamma, Kelvin, saturation)
// ---------------------------------------------------------------------------

/**
 * Per-channel color correction applied to the LED pixel buffer before
 * hand-off to a `LedSink`. Identical shape is used for both USB and Hue
 * surfaces so a single UI surface edits one persisted struct.
 *
 * Fields live under `ShellState.colorCorrection`. Absent ⇒
 * `DEFAULT_COLOR_CORRECTION` (identity-ish correction for a 6500K white
 * point and no saturation bump).
 */
export interface ColorCorrectionConfig {
  /** Gamma curve exponent for the red channel. */
  gammaR: number;
  /** Gamma curve exponent for the green channel. */
  gammaG: number;
  /** Gamma curve exponent for the blue channel. */
  gammaB: number;
  /**
   * White-point temperature in Kelvin. Lower = warmer, higher = cooler.
   * Applied as a per-channel multiplier on top of gamma.
   */
  kelvin: number;
  /**
   * Saturation multiplier. `1.0` leaves colors untouched, `0.0` produces
   * grayscale, `>1.0` boosts chroma (clipped per-channel at the sink).
   */
  saturation: number;
}

/** Inclusive min/max for each gamma channel. Outside this range firmware clipping is unpredictable. */
export const GAMMA_RANGE = { min: 1.0, max: 3.0 } as const;

/**
 * Inclusive min/max for the Kelvin white-point slider. 2000K ≈ candlelight,
 * 8000K ≈ overcast daylight; the bridge + most panels behave well in this band.
 */
export const KELVIN_RANGE_K = { min: 2000, max: 8000 } as const;

/** Inclusive min/max for saturation. */
export const SATURATION_RANGE = { min: 0.0, max: 2.0 } as const;

/** Identity-ish baseline used when the user has never opened the correction panel. */
export const DEFAULT_COLOR_CORRECTION: ColorCorrectionConfig = {
  gammaR: 2.2,
  gammaG: 2.2,
  gammaB: 2.2,
  kelvin: 6500,
  saturation: 1.0,
};

// ---------------------------------------------------------------------------
// Serial health check report (v1.4 G12 — real handshake round-trip)
// ---------------------------------------------------------------------------

/**
 * Machine-readable status code returned by `run_serial_health_check`.
 *
 * These codes discriminate handshake outcomes so the UI can surface a
 * localized explanation + action hint without parsing a human string:
 *
 * - `SERIAL_HEALTH_OK` — handshake completed; `firmwareVersion` +
 *   `roundTripMs` are populated.
 * - `SERIAL_HEALTH_HANDSHAKE_TIMEOUT` — no reply within the handshake
 *   window; usually a wrong baud rate or a port that is not a LumaSync
 *   controller at all.
 * - `SERIAL_HEALTH_VERSION_MISMATCH` — firmware responded with a
 *   protocol version the host does not understand. User must upgrade
 *   one of the two sides.
 * - `SERIAL_HEALTH_FIRMWARE_MISMATCH` — handshake replied, but the
 *   firmware profile advertised by the device does not match the
 *   user-selected `FirmwareProfile` (distinct from `UNSUPPORTED_PORT`).
 * - `SERIAL_HEALTH_PROTOCOL_ERROR` — handshake parser failed mid-frame
 *   (checksum, malformed length, unexpected byte). Usually a cable or
 *   interference issue.
 */
export const SERIAL_HEALTH_CODES = {
  OK: "SERIAL_HEALTH_OK",
  HANDSHAKE_TIMEOUT: "SERIAL_HEALTH_HANDSHAKE_TIMEOUT",
  VERSION_MISMATCH: "SERIAL_HEALTH_VERSION_MISMATCH",
  FIRMWARE_MISMATCH: "SERIAL_HEALTH_FIRMWARE_MISMATCH",
  PROTOCOL_ERROR: "SERIAL_HEALTH_PROTOCOL_ERROR",
  /** `spawn_blocking` join failure — reported on the `HEALTH_CHECK_WORKER`
   * step, which replaces the whole step list rather than joining it. */
  WORKER_PANIC: "SERIAL_HEALTH_WORKER_PANIC",
} as const;

export type SerialHealthCode = (typeof SERIAL_HEALTH_CODES)[keyof typeof SERIAL_HEALTH_CODES];

/** Exactly what `run_serial_health_check` puts on `HealthStepResult.code`.
 * `DeviceHealthStep` is in it because a passing step reports its own name as
 * its code — `PORT_VISIBLE` passes with code `PORT_VISIBLE`. */
export type SerialHealthStepWireCode =
  | SerialHealthCode
  | SerialConnectStatusCode
  | SerialPortListStatusCode
  | DeviceErrorCode
  | DeviceHealthStep;

/** Frontend-synthesised: the health-check bridge was never injected, so no
 * command ran. Out of the wire union for the {@link OVERLAY_NO_DISPLAY} reason. */
export const HEALTH_CHECK_NOT_AVAILABLE = "HEALTH_CHECK_NOT_AVAILABLE" as const;

export type SerialHealthStepCode =
  | SerialHealthStepWireCode
  | typeof HEALTH_CHECK_NOT_AVAILABLE;

/**
 * Report returned by `run_serial_health_check`. Exactly one report per
 * invocation; the `step` field records the last health-check stage that
 * produced a verdict so the UI can step through the health modal.
 *
 * NOTE: the live runtime surface is `HealthCheckResult` in
 * `src/features/device/deviceConnectionApi.ts` — this declaration is the
 * forward-looking shape kept in sync with the same Rust struct so that
 * future re-platforming onto a single per-step report is non-breaking.
 */
export interface SerialHealthReport {
  step: DeviceHealthStep;
  code: SerialHealthCode;
  message: string;
  /** Firmware self-reported semantic version, e.g. `"1.4.0"`. Populated when the handshake returned a version frame. */
  firmwareVersion?: string;
  /**
   * Firmware profile **advertised by the device** in the PONG profile byte.
   *
   * Distinct from `ShellState.firmwareProfile`, which is the user-selected
   * encoder. The UI compares the two to detect Bug H4 — the user chose
   * Adalight in Settings but the connected firmware advertised LumaSyncV1
   * (or vice versa), causing the USB sink to silently no-op while Hue
   * keeps streaming. (v1.5 H4)
   *
   * Absence semantics: undefined whenever Step 4 (HANDSHAKE) did not
   * complete with `SERIAL_HEALTH_OK`, including timeout, protocol error,
   * unknown profile byte, or legacy firmware that ships no profile byte.
   * The UI MUST treat undefined as "unknown — do not gate the dropdown".
   */
  advertisedFirmwareProfile?: FirmwareProfile;
  /** Wall-clock latency of the handshake round trip. Populated on `SERIAL_HEALTH_OK`. */
  roundTripMs?: number;
}

// ---------------------------------------------------------------------------
// Sink reference (v1.5 W1-B1 — TS mirror of the Rust `LedSink` trait)
// ---------------------------------------------------------------------------

/**
 * Discriminated union identifying the active LED output sink.
 *
 * This is the frontend mirror of the Rust `LedSink` trait (v1.4 G11).
 * Every command that targets "the active sink" — health check, sampling
 * playground, lighting mode start — accepts a `SinkRef` so the UI no
 * longer special-cases serial vs. WLED. The Rust handler dispatches on
 * `type` and routes to the matching trait implementation.
 *
 * Variants:
 * - `serial` — USB / serial controller identified by its OS-reported
 *   port name (the existing surface; v1.4 contract).
 * - `wled-udp` — WLED instance reached over UDP on the LAN (v1.5 G1).
 *
 * Future variants (v2.0): `openrgb`, `tpm2`, `sacn`, `art-net`,
 * `hyperion-rpc-output`. Keep the discriminant string in lower-kebab so
 * Rust-side `serde(tag = "type")` round-trips unchanged.
 */
export type SinkRef =
  | { type: "serial"; portName: string }
  | { type: "wled-udp"; ip: string; port: number; ledCount: number };

// ---------------------------------------------------------------------------
// WLED UDP sink (v1.5 G1)
// ---------------------------------------------------------------------------

/**
 * Persisted configuration for a WLED UDP sink.
 *
 * `port` defaults to 4048 (DDP) when the user has not customised it; the
 * other DDP-compatible WLED ports (21324 for WARLS) live behind the
 * `protocol` discriminant. `ledCount` mirrors the bridge-reported value
 * at connect time and is checked at every reconnect — a mismatch surfaces
 * `WLED_LED_COUNT_MISMATCH` so the user can re-trim their virtual strip
 * before frames go out.
 */
export interface WledUdpSinkConfig {
  /** WLED instance IP (IPv4 or IPv6 textual form). */
  ip: string;
  /** UDP port. Default 4048 for DDP, 21324 for WARLS. */
  port: number;
  /** Number of LEDs reported by the WLED instance. */
  ledCount: number;
  /**
   * Wire protocol the host should speak.
   *
   * - `ddp`: Distributed Display Protocol — preferred, supports >490 LEDs
   *   in a single frame, header carries an offset for chunked sends.
   * - `warls`: WLED's native sync protocol — older, limited to one
   *   datagram per packet, but compatible with every WLED build since
   *   0.9.0. Fallback when the user pins compatibility.
   */
  protocol: "ddp" | "warls";
}

/** Default UDP port for the DDP wire protocol used by WLED. */
export const WLED_DEFAULT_DDP_PORT = 4048 as const;

/** Default UDP port for the WARLS wire protocol used by WLED. */
export const WLED_DEFAULT_WARLS_PORT = 21324 as const;

/**
 * Snapshot of a WLED instance returned by `discover_wled_devices`.
 *
 * Mirrors the shape of the bridge's `/json/info` HTTP endpoint so the
 * frontend can render a meaningful card in the device picker without a
 * second round-trip. `mac` / `name` / `version` are best-effort — older
 * WLED builds may omit them.
 */
export interface WledDeviceInfo {
  ip: string;
  mac?: string | null;
  ledCount: number;
  name?: string | null;
  version?: string | null;
}

/** Snapshot from `get_wled_sink_status`. `sink` is `null` once a serial connect has evicted WLED, even while `lastWledSink` stays populated. */
export interface WledSinkStatus {
  connected: boolean;
  sink: WledUdpSinkConfig | null;
}

/**
 * Status codes returned by the WLED command surface. Same coded-status
 * pattern as the rest of the device contract: never throw, always a
 * `status.code` discriminator.
 */
export const WLED_STATUS = {
  /** `discover_wled_devices` succeeded; payload contains the one probed `WledDeviceInfo`. */
  DISCOVERY_OK: "WLED_DISCOVERY_OK",
  /** The probed IP did not respond to `/json/info` within the 2s HTTP timeout. */
  DISCOVERY_TIMEOUT: "WLED_DISCOVERY_TIMEOUT",
  /** `connect_wled_sink` / `test_wled_bridge` could not reach the configured IP. */
  BRIDGE_UNREACHABLE: "WLED_BRIDGE_UNREACHABLE",
  /**
   * The bridge replied but rejected our wire protocol (e.g. user picked
   * DDP against a 0.8.x WLED build that only speaks WARLS). User must
   * pick the alternate protocol on the same port.
   */
  PROTOCOL_MISMATCH: "WLED_PROTOCOL_MISMATCH",
  /**
   * The bridge advertised a `ledCount` different from the persisted
   * `WledUdpSinkConfig.ledCount`. Surfaces both numbers so the UI can
   * offer a one-click "trust the bridge" re-sync.
   */
  LED_COUNT_MISMATCH: "WLED_LED_COUNT_MISMATCH",
  /**
   * The supplied IP address failed SSRF hardening (PR #31 + A2.1 widening).
   * Triggered for non-parseable strings AND for parseable-but-rejected
   * ranges: loopback (127.x), unspecified (0.0.0.0), multicast (224.x/4),
   * broadcast (255.255.255.255). Distinct from `BRIDGE_UNREACHABLE` which
   * means the address parsed fine but no WLED device responded.
   */
  INVALID_IP: "WLED_INVALID_IP",
  /**
   * `connect_wled_sink` received a `led_count` of 0, which is not a
   * valid strip configuration. The user must enter a positive LED count
   * before connecting.
   */
  INVALID_LED_COUNT: "WLED_INVALID_LED_COUNT",
  /** `connect_wled_sink` promoted the instance to the active sink. */
  CONNECT_OK: "WLED_CONNECT_OK",
  /** `test_wled_bridge` round-tripped a packet successfully. */
  TEST_OK: "WLED_TEST_OK",
  /** The test packet could not be written to the socket. */
  TEST_SEND_FAILED: "WLED_TEST_SEND_FAILED",
  /** Connection refused / network-level error probing the configured IP. */
  DISCOVERY_UNREACHABLE: "WLED_DISCOVERY_UNREACHABLE",
  /** The HTTP client could not be constructed — a local fault, not a bridge one. */
  CLIENT_BUILD_FAILED: "WLED_CLIENT_BUILD_FAILED",
  /** A send was attempted before `connect_wled_sink` established the sink. */
  SINK_NOT_STARTED: "WLED_SINK_NOT_STARTED",
} as const;

export type WledStatusCode = (typeof WLED_STATUS)[keyof typeof WLED_STATUS];

/** Exactly what `wled_discovery.rs` puts on a WLED command `status`.
 * `WLED_SINK_NOT_STARTED` is excluded: `wled_sink.rs` returns it as an
 * `Err(String)` prefix, so a `switch (status.code)` can never see it. */
export type WledWireStatusCode = Exclude<WledStatusCode, typeof WLED_STATUS.SINK_NOT_STARTED>;

export type WledCommandStatus = CommandStatusOf<WledWireStatusCode>;
