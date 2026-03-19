import { invoke } from "@tauri-apps/api/core";
import { DEVICE_COMMANDS } from "../../shared/contracts/device";

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

export async function listSerialPorts(): Promise<SerialPortListResponse> {
  return invoke<SerialPortListResponse>(DEVICE_COMMANDS.LIST_PORTS);
}

export async function connectSerialPort(portName: string): Promise<SerialConnectionStatus> {
  return invoke<SerialConnectionStatus>(DEVICE_COMMANDS.CONNECT_PORT, { portName });
}

export async function getSerialConnectionStatus(): Promise<SerialConnectionStatus> {
  return invoke<SerialConnectionStatus>(DEVICE_COMMANDS.GET_CONNECTION_STATUS);
}
