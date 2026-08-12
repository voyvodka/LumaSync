export interface DevicePort {
  portName: string;
  isSupported: boolean;
  sortKey: string;
  vid?: number;
  pid?: number;
  manufacturer?: string;
  product?: string;
}
