import { DEVICE_OPERATION, DEVICE_STATUS, type DeviceStatus } from "@/shared/contracts/device";
import { canConnectSelectedPort } from "../portSelection";
import type { SerialConnectionStatus, SerialPortListResponse } from "../deviceConnectionApi";
import type { DevicePort } from "../types";
import type { DeviceConnectionControllerState, DeviceStatusCard } from "./connectionTypes";

export const DEFAULT_STATE: DeviceConnectionControllerState = {
  status: DEVICE_STATUS.IDLE,
  ports: [],
  selectedPort: null,
  connectedPort: null,
  statusCard: null,
  canConnect: false,
  isScanning: false,
  isConnecting: false,
  isReconnecting: false,
  isHealthChecking: false,
  activeOperation: DEVICE_OPERATION.IDLE,
  latestHealthCheck: null,
};

export function toSortKey(port: SerialPortListResponse["ports"][number]): string {
  const hint = [port.usb?.product, port.usb?.manufacturer, port.name].filter(Boolean).join("-");
  return hint.toLowerCase();
}

// `isSupported`/`vid`/`pid` pass through as-is — VID/PID allowlisting is Rust-owned.
export function toDevicePort(port: SerialPortListResponse["ports"][number]): DevicePort {
  return {
    portName: port.name,
    isSupported: port.isSupported,
    sortKey: toSortKey(port),
    vid: port.usb?.vid,
    pid: port.usb?.pid,
    manufacturer: port.usb?.manufacturer ?? undefined,
    product: port.usb?.product ?? undefined,
  };
}

export function nextStatusForReadyState(ports: DevicePort[]): DeviceStatus {
  if (ports.length === 0) {
    return DEVICE_STATUS.IDLE;
  }

  return DEVICE_STATUS.READY;
}

export function toConnectionCard(status: SerialConnectionStatus): DeviceStatusCard {
  if (status.connected) {
    return {
      variant: "success",
      code: status.status.code,
      message: status.status.message,
      details: status.status.details ?? undefined,
    };
  }

  return {
    variant: "error",
    code: status.status.code,
    message: status.status.message,
    details: status.status.details ?? undefined,
  };
}

export function withDerivedFlags(state: DeviceConnectionControllerState): DeviceConnectionControllerState {
  return {
    ...state,
    canConnect: canConnectSelectedPort(state.selectedPort, state.isScanning) && !state.isConnecting,
  };
}
