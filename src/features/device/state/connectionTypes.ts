import type { TranslationKey } from "@/features/i18n/catalogue";
import type {
  DeviceOperation,
  DeviceStatus,
  DrivenOutputRef,
  HealthCheckView,
  SerialPortsChangedEvent,
} from "@/shared/contracts/device";
import type {
  HealthCheckResult,
  SerialConnectionStatus,
  SerialPortListResponse,
} from "../deviceConnectionApi";
import type { ConnectionEventBus } from "../connectionEvents";
import type { FirmwareProfileEventBus } from "../firmwareProfileEvents";
import type { LocalOutputs } from "./localOutputsStore";
import type { DevicePort } from "../types";

export type Listener = (state: DeviceConnectionControllerState) => void;

export interface DeviceStatusCard {
  variant: "success" | "error" | "info";
  code: string;
  message: string;
  /** Backend text (an OS error, a port name): shown verbatim, never translated. */
  details?: string;
  /** Advice this controller minted itself; rendered through i18n, and wins over `details`. */
  detailsKey?: TranslationKey;
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
  latestHealthCheck: HealthCheckView | null;
}

export interface DeviceConnectionControllerDeps {
  listSerialPorts: () => Promise<SerialPortListResponse>;
  connectSerialPort: (portName: string) => Promise<SerialConnectionStatus>;
  /** Rust's local-output registry: the only source of what is connected. */
  localOutputs: LocalOutputs;
  /**
   * After the user's own connect: let go of every other local output, so one is used at a time
   * while Rust could drive several. Not after a launch or replug reconnect — the user chose nothing.
   */
  releaseOtherOutputs?: (kept: DrivenOutputRef) => Promise<void>;
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
   * The live hook turns it on for the one mount that owns reconnects (App), so a
   * launch restores the paired strip once. Tests opt in explicitly.
   */
  autoReconnectOnInit?: boolean;
  /**
   * Tells the rest of the app what a connect did — the user's own pair (the LED Setup nudge), a boot
   * reconnect that found the saved port unusable. Siblings do not need it to stay in step: they
   * follow the registry. Tests provide a scoped bus to keep cross-test state clean.
   */
  connectionEvents?: ConnectionEventBus;
  /**
   * Broadcasts what the firmware reported — on every successful connect and
   * every health check — so the profile and chip-type pickers can read it
   * without mounting their own controller.
   */
  firmwareProfileEvents?: FirmwareProfileEventBus;
  /** The Rust serial port watcher's event; absent in tests that do not exercise it. */
  listenSerialPortsChanged?: (handler: (event: SerialPortsChangedEvent) => void) => Promise<() => void>;
  /**
   * Bring the saved port back when the watcher sees it reappear. One mount only (App): two
   * controllers reconnecting at once would race for the port.
   */
  reconnectOnReplug?: boolean;
  /** The saved strip's serial port as the store holds it now; `undefined` when it is WLED or unset. */
  readSavedSerialPort?: () => Promise<string | undefined>;
  replugDelayMs?: number;
  replugRetryMs?: number;
}

export interface DeviceConnectionController {
  getState: () => DeviceConnectionControllerState;
  subscribe: (listener: Listener) => () => void;
  initialize: () => Promise<void>;
  refreshPorts: () => Promise<void>;
  selectPort: (portName: string | null) => void;
  /** `true` only when this call left the port connected. */
  connectSelectedPort: () => Promise<boolean>;
  runHealthCheck: () => Promise<void>;
  /**
   * Stop following the registry and the port watcher. Called by the React hook cleanup so a
   * dismounted controller no longer applies what Rust announces. Tests may call it for tear-down.
   */
  dispose: () => void;
}
