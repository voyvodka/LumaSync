import type { DeviceOperation, DeviceStatus } from "@/shared/contracts/device";
import type {
  HealthCheckResult,
  SerialConnectionStatus,
  SerialPortListResponse,
} from "../deviceConnectionApi";
import type { ConnectionEventBus } from "../connectionEvents";
import type { FirmwareProfileEventBus } from "../firmwareProfileEvents";
import type { DevicePort } from "../types";

export type Listener = (state: DeviceConnectionControllerState) => void;

export interface DeviceStatusCard {
  variant: "success" | "error" | "info";
  code: string;
  message: string;
  details?: string;
}

export interface DeviceConnectionControllerState {
  status: DeviceStatus;
  ports: DevicePort[];
  selectedPort: string | null;
  connectedPort: string | null;
  lastSuccessfulPort?: string;
  statusCard: DeviceStatusCard | null;
  canConnect: boolean;
  isScanning: boolean;
  isConnecting: boolean;
  isReconnecting: boolean;
  isHealthChecking: boolean;
  activeOperation: DeviceOperation;
  latestHealthCheck: HealthCheckResult | null;
}

export interface DeviceConnectionControllerDeps {
  listSerialPorts: () => Promise<SerialPortListResponse>;
  connectSerialPort: (portName: string) => Promise<SerialConnectionStatus>;
  getSerialConnectionStatus: () => Promise<SerialConnectionStatus>;
  runSerialHealthCheck?: (portName: string) => Promise<HealthCheckResult>;
  persistLastSuccessfulPort: (portName: string) => Promise<void>;
  initialLastSuccessfulPort?: string;
  refreshMinIntervalMs?: number;
  now?: () => number;
  scheduleTimeout?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearScheduledTimeout?: (timer: ReturnType<typeof setTimeout>) => void;
  recoveryFastDelayMs?: number;
  recoveryRetryDelayMs?: number;
  recoveryMaxAttempts?: number;
  refreshVisibleWaitMs?: number;
  /**
   * Bug 10A — when `true`, `initialize()` will attempt a one-shot
   * `connectSerialPort(initialLastSuccessfulPort)` if Rust reports
   * `connected: false` AND the persisted port is currently visible. A
   * failure (port missing, connect rejected) is swallowed so the user
   * still lands on the manual-pair screen rather than an error toast.
   *
   * Defaults to `true` from the live `useDeviceConnection()` hook so
   * day-to-day app launches auto-restore the previously paired strip.
   * Tests opt in explicitly when they want to exercise the path.
   */
  autoReconnectOnInit?: boolean;
  /**
   * Bug 10B — pub-sub bridge between sibling `useDeviceConnection`
   * instances (App-level vs DEVICES section). The controller emits on
   * a successful pair AND listens for emits coming from siblings, so a
   * pair done inside DEVICES propagates to LIGHTS without a WebView
   * reload. Tests provide a scoped bus to keep cross-test state clean.
   */
  connectionEvents?: ConnectionEventBus;
  /**
   * Broadcasts a completed health check's advertised firmware profile so
   * FirmwareProfilePicker can read it without mounting its own controller.
   */
  firmwareProfileEvents?: FirmwareProfileEventBus;
}

export interface DeviceConnectionController {
  getState: () => DeviceConnectionControllerState;
  subscribe: (listener: Listener) => () => void;
  initialize: () => Promise<void>;
  refreshPorts: () => Promise<void>;
  selectPort: (portName: string | null) => void;
  connectSelectedPort: () => Promise<void>;
  runHealthCheck: () => Promise<void>;
  /**
   * Detach from the connection-event bus. Called by the React hook
   * cleanup so dismounted controllers don't keep responding to
   * sibling-emitted events. Tests may call it manually for tear-down.
   */
  dispose: () => void;
}
