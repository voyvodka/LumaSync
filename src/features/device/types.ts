import type { DeviceErrorCode, DeviceStatus } from "../../shared/contracts/device";

export interface DevicePort {
  portName: string;
  isSupported: boolean;
  sortKey: string;
  vid?: number;
  pid?: number;
  manufacturer?: string;
  product?: string;
}

export interface DeviceConnectionResult {
  ok: boolean;
  status: DeviceStatus;
  code?: DeviceErrorCode;
  message?: string;
}

export interface DeviceConnectionState {
  status: DeviceStatus;
  selectedPort: string | null;
  ports: DevicePort[];
  lastSuccessfulPort?: string;
}
