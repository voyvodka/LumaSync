import { useEffect, useMemo, useState } from "react";
import {
  DEVICE_OPERATION,
  DEVICE_STATUS,
  type DeviceOperation,
  type DeviceStatus,
} from "../../shared/contracts/device";
import { shellStore } from "../persistence/shellStore";
import {
  canConnectSelectedPort,
  groupAndSortPorts,
  resolveInitialSelection,
  resolveSelectionAfterRefresh,
} from "./portSelection";
import type { DevicePort } from "./types";
import {
  connectSerialPort,
  getSerialConnectionStatus,
  listSerialPorts,
  runSerialHealthCheck,
  type HealthCheckResult,
  type SerialConnectionStatus,
  type SerialPortListResponse,
} from "./deviceConnectionApi";

type Listener = (state: DeviceConnectionControllerState) => void;

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
}

export interface DeviceConnectionController {
  getState: () => DeviceConnectionControllerState;
  subscribe: (listener: Listener) => () => void;
  initialize: () => Promise<void>;
  refreshPorts: () => Promise<void>;
  selectPort: (portName: string | null) => void;
  connectSelectedPort: () => Promise<void>;
  runHealthCheck: () => Promise<void>;
}

const DEFAULT_STATE: DeviceConnectionControllerState = {
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

function toSortKey(port: SerialPortListResponse["ports"][number]): string {
  const hint = [port.usb?.product, port.usb?.manufacturer, port.name].filter(Boolean).join("-");
  return hint.toLowerCase();
}

function toDevicePort(port: SerialPortListResponse["ports"][number]): DevicePort {
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

function nextStatusForReadyState(ports: DevicePort[]): DeviceStatus {
  if (ports.length === 0) {
    return DEVICE_STATUS.IDLE;
  }

  return DEVICE_STATUS.READY;
}

function toConnectionCard(status: SerialConnectionStatus): DeviceStatusCard {
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

function withDerivedFlags(state: DeviceConnectionControllerState): DeviceConnectionControllerState {
  return {
    ...state,
    canConnect: canConnectSelectedPort(state.selectedPort, state.isScanning) && !state.isConnecting,
  };
}

export function createDeviceConnectionController(deps: DeviceConnectionControllerDeps): DeviceConnectionController {
  const listeners = new Set<Listener>();
  const now = deps.now ?? (() => Date.now());
  const refreshMinIntervalMs = deps.refreshMinIntervalMs ?? 250;
  const scheduleTimeout = deps.scheduleTimeout ?? ((callback: () => void, delayMs: number) => setTimeout(callback, delayMs));
  const clearScheduledTimeout = deps.clearScheduledTimeout ?? ((timer: ReturnType<typeof setTimeout>) => clearTimeout(timer));
  const recoveryFastDelayMs = deps.recoveryFastDelayMs ?? 150;
  const recoveryRetryDelayMs = deps.recoveryRetryDelayMs ?? 600;
  const recoveryMaxAttempts = deps.recoveryMaxAttempts ?? 4;
  const runHealthCheckRequest =
    deps.runSerialHealthCheck ??
    (async () => ({
      pass: false,
      checkedAtUnixMs: now(),
      steps: [
        {
          step: "PORT_VISIBLE",
          pass: false,
          code: "HEALTH_CHECK_NOT_AVAILABLE",
          message: "Health check bridge is not configured.",
          details: "Missing runSerialHealthCheck dependency.",
        },
      ],
    }));

  let state: DeviceConnectionControllerState = withDerivedFlags({
    ...DEFAULT_STATE,
    lastSuccessfulPort: deps.initialLastSuccessfulPort,
  });

  let initialized = false;
  let refreshToken = 0;
  let operationToken = 0;
  let lastRefreshAt = 0;
  let recoveryTimer: ReturnType<typeof setTimeout> | null = null;

  const notify = () => {
    const snapshot = withDerivedFlags(state);
    state = snapshot;
    listeners.forEach((listener) => {
      listener(snapshot);
    });
  };

  const setState = (updater: (prev: DeviceConnectionControllerState) => DeviceConnectionControllerState) => {
    state = updater(state);
    notify();
  };

  const clearRecoveryTimer = () => {
    if (!recoveryTimer) {
      return;
    }

    clearScheduledTimeout(recoveryTimer);
    recoveryTimer = null;
  };

  const cancelRecovery = (reasonCard?: DeviceStatusCard) => {
    operationToken += 1;
    clearRecoveryTimer();
    setState((prev) => ({
      ...prev,
      isReconnecting: false,
      activeOperation: prev.activeOperation === DEVICE_OPERATION.RECOVERY ? DEVICE_OPERATION.IDLE : prev.activeOperation,
      status:
        prev.status === DEVICE_STATUS.RECONNECTING
          ? nextStatusForReadyState(prev.ports)
          : prev.status,
      statusCard: reasonCard ?? prev.statusCard,
    }));
  };

  const persistSuccessfulPort = async (portName: string) => {
    try {
      await deps.persistLastSuccessfulPort(portName);
    } catch {
      // Persistence failures should not break an active connection.
    }
  };

  const beginOperation = (operation: DeviceOperation): number | null => {
    if (state.activeOperation !== DEVICE_OPERATION.IDLE) {
      return null;
    }

    operationToken += 1;
    const token = operationToken;

    setState((prev) => ({
      ...prev,
      activeOperation: operation,
      isConnecting: operation === DEVICE_OPERATION.MANUAL_CONNECT,
      isReconnecting: operation === DEVICE_OPERATION.RECOVERY,
      isHealthChecking: operation === DEVICE_OPERATION.HEALTH_CHECK,
      status:
        operation === DEVICE_OPERATION.MANUAL_CONNECT
          ? DEVICE_STATUS.CONNECTING
          : operation === DEVICE_OPERATION.RECOVERY
            ? DEVICE_STATUS.RECONNECTING
            : operation === DEVICE_OPERATION.HEALTH_CHECK
              ? DEVICE_STATUS.HEALTH_CHECKING
              : prev.status,
    }));

    return token;
  };

  const finishOperation = (token: number) => {
    if (token !== operationToken) {
      return;
    }

    setState((prev) => ({
      ...prev,
      activeOperation: DEVICE_OPERATION.IDLE,
      isConnecting: false,
      isReconnecting: false,
      isHealthChecking: false,
    }));
  };

  const applyPortRefresh = (
    ports: DevicePort[],
    isInitialScan: boolean,
  ): { selectedPort: string | null; missingSelection: boolean } => {
    if (isInitialScan) {
      return {
        selectedPort: resolveInitialSelection(ports, state.lastSuccessfulPort),
        missingSelection: false,
      };
    }

    return resolveSelectionAfterRefresh(ports, state.selectedPort, state.lastSuccessfulPort);
  };

  const REFRESH_MIN_VISIBLE_MS = 600;

  const startAutoRecovery = (targetPort: string) => {
    clearRecoveryTimer();
    const token = beginOperation(DEVICE_OPERATION.RECOVERY);
    if (!token) {
      return;
    }

    setState((prev) => ({
      ...prev,
      statusCard: {
        variant: "info",
        code: "RECOVERY_IN_PROGRESS",
        message: "Connection interrupted. Reconnecting with bounded retries.",
        details: "You can pick a port and connect manually at any time.",
      },
    }));

    let attempt = 0;
    const tryReconnect = async () => {
      if (token !== operationToken) {
        return;
      }

      attempt += 1;
      try {
        const portsResponse = await deps.listSerialPorts();
        if (token !== operationToken) {
          return;
        }

        const hasTargetPort = portsResponse.ports.some((port) => port.name === targetPort);
        if (!hasTargetPort) {
          if (attempt >= recoveryMaxAttempts) {
            finishOperation(token);
            setState((prev) => ({
              ...prev,
              status: DEVICE_STATUS.MANUAL_REQUIRED,
              statusCard: {
                variant: "error",
                code: "RECOVERY_MANUAL_REQUIRED",
                message: "Auto-recovery timed out.",
                details: "Refresh ports, choose the active cable port, then connect manually.",
              },
            }));
            return;
          }

          recoveryTimer = scheduleTimeout(() => {
            void tryReconnect();
          }, recoveryRetryDelayMs);
          return;
        }

        const connected = await deps.connectSerialPort(targetPort);
        if (token !== operationToken) {
          return;
        }

        if (connected.connected && connected.portName) {
          clearRecoveryTimer();
          finishOperation(token);
          const connectedPortName = connected.portName;
          setState((prev) => ({
            ...prev,
            status: DEVICE_STATUS.CONNECTED,
            connectedPort: connectedPortName,
            selectedPort: connectedPortName,
            lastSuccessfulPort: connectedPortName,
            statusCard: {
              variant: "success",
              code: "RECOVERY_CONNECTED",
              message: "Connection recovered successfully.",
              details: connected.status.details ?? undefined,
            },
          }));
          await persistSuccessfulPort(connectedPortName);
          return;
        }

        if (attempt >= recoveryMaxAttempts) {
          finishOperation(token);
          setState((prev) => ({
            ...prev,
            status: DEVICE_STATUS.MANUAL_REQUIRED,
            statusCard: {
              variant: "error",
              code: "RECOVERY_MANUAL_REQUIRED",
              message: "Auto-recovery timed out.",
              details: "Refresh ports, choose the active cable port, then connect manually.",
            },
          }));
          return;
        }

        recoveryTimer = scheduleTimeout(() => {
          void tryReconnect();
        }, recoveryRetryDelayMs);
      } catch (error) {
        if (token !== operationToken) {
          return;
        }

        if (attempt >= recoveryMaxAttempts) {
          finishOperation(token);
          setState((prev) => ({
            ...prev,
            status: DEVICE_STATUS.MANUAL_REQUIRED,
            statusCard: {
              variant: "error",
              code: "RECOVERY_MANUAL_REQUIRED",
              message: "Auto-recovery timed out.",
              details: error instanceof Error ? error.message : String(error),
            },
          }));
          return;
        }

        recoveryTimer = scheduleTimeout(() => {
          void tryReconnect();
        }, recoveryRetryDelayMs);
      }
    };

    recoveryTimer = scheduleTimeout(() => {
      void tryReconnect();
    }, recoveryFastDelayMs);
  };

  const runRefresh = async (isInitialScan: boolean) => {
    const currentToken = ++refreshToken;

    setState((prev) => ({
      ...prev,
      status:
        prev.isReconnecting || prev.isHealthChecking
          ? prev.status
          : DEVICE_STATUS.SCANNING,
      isScanning: true,
      statusCard: isInitialScan ? null : prev.statusCard,
    }));

    try {
      const minWait = isInitialScan
        ? Promise.resolve()
        : new Promise<void>((resolve) => setTimeout(resolve, REFRESH_MIN_VISIBLE_MS));

      const [response] = await Promise.all([deps.listSerialPorts(), minWait]);
      if (currentToken !== refreshToken) {
        return;
      }

      const mappedPorts = response.ports.map(toDevicePort);
      const selectionResult = applyPortRefresh(mappedPorts, isInitialScan);
      const connectedPortMissing =
        state.connectedPort !== null && !mappedPorts.some((port) => port.portName === state.connectedPort);

      setState((prev) => ({
        ...prev,
        status: prev.isReconnecting ? DEVICE_STATUS.RECONNECTING : nextStatusForReadyState(mappedPorts),
        ports: mappedPorts,
        selectedPort: selectionResult.selectedPort,
        connectedPort: connectedPortMissing ? null : prev.connectedPort,
        isScanning: false,
        statusCard: selectionResult.missingSelection
          ? {
              variant: "info",
              code: "SELECTED_PORT_MISSING",
              message: "Previously selected port is no longer available.",
              details: "Pick another port and try Connect again.",
            }
          : prev.statusCard,
      }));

      if (connectedPortMissing && state.lastSuccessfulPort) {
        startAutoRecovery(state.lastSuccessfulPort);
      }

      initialized = true;
      lastRefreshAt = now();
    } catch (error) {
      if (currentToken !== refreshToken) {
        return;
      }

      setState((prev) => ({
        ...prev,
        status: DEVICE_STATUS.ERROR,
        isScanning: false,
        statusCard: {
          variant: "error",
          code: "LIST_PORTS_FAILED",
          message: "Could not scan serial ports.",
          details: error instanceof Error ? error.message : String(error),
        },
      }));
    }
  };

  const refreshPorts = async () => {
    if (!initialized) {
      await runRefresh(true);
      return;
    }

    if (now() - lastRefreshAt < refreshMinIntervalMs) {
      setState((prev) => ({
        ...prev,
        statusCard: {
          variant: "info",
          code: "REFRESH_RATE_LIMITED",
          message: "Refresh is temporarily limited.",
          details: "Please wait a moment and try again.",
        },
      }));
      return;
    }

    await runRefresh(false);
  };

  const initialize = async () => {
    await runRefresh(true);

    try {
      const status = await deps.getSerialConnectionStatus();
      if (status.connected && status.portName) {
        setState((prev) => ({
          ...prev,
          status: DEVICE_STATUS.CONNECTED,
          connectedPort: status.portName,
          selectedPort: prev.selectedPort ?? status.portName,
          statusCard: toConnectionCard(status),
          lastSuccessfulPort: status.portName ?? undefined,
        }));
      }
    } catch {
      // Connection status hydration is best-effort only.
    }
  };

  const selectPort = (portName: string | null) => {
    if (state.isReconnecting) {
      cancelRecovery({
        variant: "info",
        code: "RECOVERY_CANCELLED_BY_USER",
        message: "Auto-recovery was cancelled by manual selection.",
        details: "Continue with manual connect when ready.",
      });
    }

    setState((prev) => ({
      ...prev,
      selectedPort: portName,
      status:
        prev.status === DEVICE_STATUS.CONNECTED && prev.connectedPort === portName
          ? DEVICE_STATUS.CONNECTED
          : nextStatusForReadyState(prev.ports),
      statusCard: prev.statusCard?.code === "SELECTED_PORT_MISSING" ? null : prev.statusCard,
    }));
  };

  const connectSelectedPort = async () => {
    if (!state.selectedPort || state.isScanning || state.isConnecting || state.isHealthChecking) {
      return;
    }

    if (state.isReconnecting) {
      cancelRecovery();
    }

    const token = beginOperation(DEVICE_OPERATION.MANUAL_CONNECT);
    if (!token) {
      return;
    }

    const targetPort = state.selectedPort;
    setState((prev) => ({
      ...prev,
      statusCard: null,
    }));

    const connection = await deps.connectSerialPort(targetPort);
    if (token !== operationToken) {
      return;
    }

    if (connection.connected && connection.portName) {
      const connectedPortName = connection.portName;
      finishOperation(token);

      setState((prev) => ({
        ...prev,
        status: DEVICE_STATUS.CONNECTED,
        connectedPort: connectedPortName,
        selectedPort: connectedPortName,
        lastSuccessfulPort: connectedPortName,
        statusCard: toConnectionCard(connection),
      }));

      await persistSuccessfulPort(connectedPortName);
      return;
    }

    finishOperation(token);
    setState((prev) => ({
      ...prev,
      status: DEVICE_STATUS.ERROR,
      connectedPort: null,
      statusCard: toConnectionCard(connection),
    }));
  };

  const runHealthCheck = async () => {
    if (!state.selectedPort || state.isScanning || state.isConnecting || state.isReconnecting) {
      return;
    }

    const token = beginOperation(DEVICE_OPERATION.HEALTH_CHECK);
    if (!token) {
      return;
    }

    const targetPort = state.selectedPort;
    setState((prev) => ({
      ...prev,
      statusCard: {
        variant: "info",
        code: "HEALTH_CHECK_IN_PROGRESS",
        message: "Running health check...",
        details: "This validates visibility, support, and connection status.",
      },
    }));

    try {
      const result = await runHealthCheckRequest(targetPort);
      if (token !== operationToken) {
        return;
      }

      finishOperation(token);
      const firstFailedStep = result.steps.find((step) => !step.pass);
      setState((prev) => ({
        ...prev,
        status: result.pass ? prev.status : DEVICE_STATUS.ERROR,
        latestHealthCheck: result,
        statusCard: result.pass
          ? {
              variant: "success",
              code: "HEALTH_CHECK_PASS",
              message: "Health check passed.",
              details: "All validation steps completed successfully.",
            }
          : {
              variant: "error",
              code: "HEALTH_CHECK_FAIL",
              message: "Health check failed.",
              details: firstFailedStep?.message ?? "Try refresh, select another port, then retry.",
            },
      }));
    } catch (error) {
      if (token !== operationToken) {
        return;
      }

      finishOperation(token);
      setState((prev) => ({
        ...prev,
        status: DEVICE_STATUS.ERROR,
        statusCard: {
          variant: "error",
          code: "HEALTH_CHECK_FAILED",
          message: "Health check could not be completed.",
          details: error instanceof Error ? error.message : String(error),
        },
      }));
    }
  };

  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    initialize,
    refreshPorts,
    selectPort,
    connectSelectedPort,
    runHealthCheck,
  };
}

export interface UseDeviceConnectionResult extends DeviceConnectionControllerState {
  groupedPorts: ReturnType<typeof groupAndSortPorts>;
  isConnected: boolean;
  refreshPorts: () => Promise<void>;
  selectPort: (portName: string | null) => void;
  connectSelectedPort: () => Promise<void>;
  runHealthCheck: () => Promise<void>;
  connectButtonLabel: "connect" | "reconnect" | "connected";
}

export function useDeviceConnection(): UseDeviceConnectionResult {
  const [initialLastSuccessfulPort, setInitialLastSuccessfulPort] = useState<string | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;

    const loadInitialStoreState = async () => {
      try {
        const stored = await shellStore.load();
        if (!cancelled) {
          setInitialLastSuccessfulPort(stored.lastSuccessfulPort);
        }
      } catch {
        if (!cancelled) {
          setInitialLastSuccessfulPort(undefined);
        }
      }
    };

    void loadInitialStoreState();

    return () => {
      cancelled = true;
    };
  }, []);

  const controller = useMemo(
    () =>
      createDeviceConnectionController({
        listSerialPorts,
        connectSerialPort,
        getSerialConnectionStatus,
        runSerialHealthCheck,
        persistLastSuccessfulPort: async (portName: string) => {
          await shellStore.save({ lastSuccessfulPort: portName });
        },
        initialLastSuccessfulPort,
      }),
    [initialLastSuccessfulPort],
  );

  const [state, setState] = useState<DeviceConnectionControllerState>(controller.getState());

  useEffect(() => {
    const unsubscribe = controller.subscribe((next) => {
      setState(next);
    });

    void controller.initialize();

    return () => {
      unsubscribe();
    };
  }, [controller]);

  const groupedPorts = useMemo(() => groupAndSortPorts(state.ports), [state.ports]);

  const connectButtonLabel: "connect" | "reconnect" | "connected" = useMemo(() => {
    if (state.connectedPort && state.connectedPort === state.selectedPort) {
      return "connected";
    }

    if (state.connectedPort && state.connectedPort !== state.selectedPort) {
      return "reconnect";
    }

    return "connect";
  }, [state.connectedPort, state.selectedPort]);

  return {
    ...state,
    groupedPorts,
    isConnected: Boolean(state.connectedPort),
    refreshPorts: controller.refreshPorts,
    selectPort: controller.selectPort,
    connectSelectedPort: controller.connectSelectedPort,
    runHealthCheck: controller.runHealthCheck,
    connectButtonLabel,
  };
}
