/** A serial port as enumerated by the Rust backend, with allowlist match info. */
export interface DevicePort {
  portName: string;
  isSupported: boolean;
  sortKey: string;
  vid?: number;
  pid?: number;
  manufacturer?: string;
  product?: string;
}
