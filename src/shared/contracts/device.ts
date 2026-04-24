/**
 * Device connection contracts for frontend <-> backend command bridge.
 */

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
   * Per-LED sampling frame pump (v1.4 anchor). The Rust handler computes
   * the next frame's RGB triples from the configured sampling strategy
   * and streams them through the active `LedSink`. Contract-first: the
   * command name is reserved here so the frontend can already wire the
   * sampling playground UI while the Rust handler lands in Wave 2.
   */
  SAMPLE_LED_FRAME: "sample_led_frame",
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

export const SUPPORTED_CONTROLLER_IDS = [
  "1A86:7523", // CH340
  "0403:6001", // FTDI FT232
  "10C4:EA60", // CP2102 (Silicon Labs)
  "2341:0043", // Arduino Uno R3
  "2341:0001", // Arduino Uno (original USB ID)
] as const;

export type SupportedControllerId = (typeof SUPPORTED_CONTROLLER_IDS)[number];

export const DEVICE_ERROR_CODES = {
  PORT_NOT_FOUND: "PORT_NOT_FOUND",
  PORT_BUSY: "PORT_BUSY",
  PERMISSION_DENIED: "PERMISSION_DENIED",
  UNSUPPORTED_PORT: "UNSUPPORTED_PORT",
  UNKNOWN: "UNKNOWN",
} as const;

export type DeviceErrorCode = (typeof DEVICE_ERROR_CODES)[keyof typeof DEVICE_ERROR_CODES];

export const DEVICE_OPERATION = {
  IDLE: "idle",
  RECOVERY: "recovery",
  MANUAL_CONNECT: "manual_connect",
  HEALTH_CHECK: "health_check",
} as const;

export type DeviceOperation = (typeof DEVICE_OPERATION)[keyof typeof DEVICE_OPERATION];

export const DEVICE_HEALTH_STEPS = {
  PORT_VISIBLE: "PORT_VISIBLE",
  PORT_SUPPORTED: "PORT_SUPPORTED",
  CONNECT_AND_VERIFY: "CONNECT_AND_VERIFY",
} as const;

export type DeviceHealthStep = (typeof DEVICE_HEALTH_STEPS)[keyof typeof DEVICE_HEALTH_STEPS];

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
} as const;

export type SerialHealthCode = (typeof SERIAL_HEALTH_CODES)[keyof typeof SERIAL_HEALTH_CODES];

/**
 * Report returned by `run_serial_health_check`. Exactly one report per
 * invocation; the `step` field records the last health-check stage that
 * produced a verdict so the UI can step through the health modal.
 */
export interface SerialHealthReport {
  step: DeviceHealthStep;
  code: SerialHealthCode;
  message: string;
  /** Firmware self-reported semantic version, e.g. `"1.4.0"`. Populated when the handshake returned a version frame. */
  firmwareVersion?: string;
  /** Firmware profile advertised by the device. Populated on successful handshake. */
  firmwareProfile?: FirmwareProfile;
  /** Wall-clock latency of the handshake round trip. Populated on `SERIAL_HEALTH_OK`. */
  roundTripMs?: number;
}
