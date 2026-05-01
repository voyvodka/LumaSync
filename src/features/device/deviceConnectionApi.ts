import { invoke } from "@tauri-apps/api/core";
import {
  DEVICE_COMMANDS,
  type DeviceHealthStep,
  type FirmwareProfile,
  type LedChipType,
} from "../../shared/contracts/device";

export interface CommandStatus {
  code: string;
  message: string;
  details: string | null;
}

export interface UsbPortMetadata {
  vid: number;
  pid: number;
  manufacturer: string | null;
  product: string | null;
  serialNumber: string | null;
}

export interface SerialPortDescriptor {
  name: string;
  kind: string;
  isSupported: boolean;
  supportReason: string;
  usb: UsbPortMetadata | null;
}

export interface SerialPortListResponse {
  status: CommandStatus;
  ports: SerialPortDescriptor[];
}

export interface SerialConnectionStatus {
  portName: string | null;
  connected: boolean;
  status: CommandStatus;
  updatedAtUnixMs: number;
}

export interface HealthStepResult {
  step: DeviceHealthStep;
  pass: boolean;
  code: string;
  message: string;
  details: string | null;
}

/**
 * Live runtime mirror of the Rust `HealthCheckResult` struct in
 * `src-tauri/src/commands/device_connection.rs`.
 *
 * The forward-looking single-step shape lives in
 * `src/shared/contracts/device.ts` as `SerialHealthReport`. Until the two
 * surfaces are merged, every additive field added to the Rust struct must
 * be mirrored here.
 */
export interface HealthCheckResult {
  pass: boolean;
  steps: HealthStepResult[];
  checkedAtUnixMs: number;
  /**
   * Wall-clock latency of the handshake round trip in milliseconds.
   * Populated only when Step 4 (HANDSHAKE) completes with
   * `SERIAL_HEALTH_OK`.
   */
  roundTripMs?: number;
  /**
   * Firmware self-reported semantic version, e.g. `"1.4"`.
   * Populated only on a successful handshake.
   */
  firmwareVersion?: string;
  /**
   * Firmware profile **advertised by the device** in the PONG profile byte.
   *
   * Distinct from `ShellState.firmwareProfile`, which is the user-selected
   * encoder. The Settings UI compares the two so the dropdown can disable
   * the incompatible option (Bug H4 fix — Adalight silently no-ops on USB
   * while Hue keeps streaming).
   *
   * Absence semantics: `undefined` whenever Step 4 (HANDSHAKE) did not
   * complete with `SERIAL_HEALTH_OK`. This includes:
   *   - handshake hasn't run yet on this port
   *   - `SERIAL_HEALTH_HANDSHAKE_TIMEOUT` (no PONG within 2 s)
   *   - `SERIAL_HEALTH_PROTOCOL_ERROR` (bad magic / opcode / checksum /
   *     unknown profile byte)
   *   - legacy LumaSync firmware that ships no profile byte
   *
   * Consumers MUST treat `undefined` as "unknown — do not gate the
   * profile dropdown". Only a concrete `FirmwareProfile` value carries
   * authority for disabling the mismatched option. (v1.5 H4)
   */
  advertisedFirmwareProfile?: FirmwareProfile;
}

export async function listSerialPorts(): Promise<SerialPortListResponse> {
  return invoke<SerialPortListResponse>(DEVICE_COMMANDS.LIST_PORTS);
}

export async function connectSerialPort(
  portName: string,
  chipType?: LedChipType,
): Promise<SerialConnectionStatus> {
  return invoke<SerialConnectionStatus>(DEVICE_COMMANDS.CONNECT_PORT, {
    portName,
    chipType: chipType ?? null,
  });
}

export async function getSerialConnectionStatus(): Promise<SerialConnectionStatus> {
  return invoke<SerialConnectionStatus>(DEVICE_COMMANDS.GET_CONNECTION_STATUS);
}

export async function runSerialHealthCheck(portName: string): Promise<HealthCheckResult> {
  return invoke<HealthCheckResult>(DEVICE_COMMANDS.RUN_HEALTH_CHECK, { portName });
}
