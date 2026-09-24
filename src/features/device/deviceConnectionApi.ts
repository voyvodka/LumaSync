import {
  DEVICE_COMMANDS,
  type HealthCheckResult,
  type LedChipType,
  type SerialConnectionStatus,
  type SerialPortListResponse,
} from "@/shared/contracts/device";
import { invokeCommand } from "@/shared/ipcApi";

export type {
  HealthCheckResult,
  HealthStepResult,
  SerialCommandStatus,
  SerialConnectionStatus,
  SerialPortDescriptor,
  SerialPortListResponse,
  UsbPortMetadata,
} from "@/shared/contracts/device";

/** Enumerate serial ports, filtering out the macOS `tty.*` siblings of each `cu.*` USB device. */
export async function listSerialPorts(): Promise<SerialPortListResponse> {
  return invokeCommand(DEVICE_COMMANDS.LIST_PORTS);
}

/** Open the named serial port and hand it to the active LED sink. Never throws; check `status.code`. */
export async function connectSerialPort(
  portName: string,
  chipType?: LedChipType,
): Promise<SerialConnectionStatus> {
  return invokeCommand(DEVICE_COMMANDS.CONNECT_PORT, {
    portName,
    chipType: chipType ?? null,
  });
}

/** Read the last-known serial connection status without touching the port. */
export async function getSerialConnectionStatus(): Promise<SerialConnectionStatus> {
  return invokeCommand(DEVICE_COMMANDS.GET_CONNECTION_STATUS);
}

/** Run the handshake-and-back health check on the named port. Never throws; check `steps`/`pass`. */
export async function runSerialHealthCheck(portName: string): Promise<HealthCheckResult> {
  return invokeCommand(DEVICE_COMMANDS.RUN_HEALTH_CHECK, { portName });
}
