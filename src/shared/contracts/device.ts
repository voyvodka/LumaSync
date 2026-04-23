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
