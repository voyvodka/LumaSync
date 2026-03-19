/**
 * Device connection contracts for frontend <-> backend command bridge.
 */

export const DEVICE_COMMANDS = {
  LIST_PORTS: "list_serial_ports",
  CONNECT_PORT: "connect_serial_port",
  DISCONNECT_PORT: "disconnect_serial_port",
  GET_CONNECTION_STATUS: "get_serial_connection_status",
  RUN_HEALTH_CHECK: "run_serial_health_check",
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
  "0403:6001", // FTDI
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
