import { useEffect, useMemo, useState } from "react";
import { DEVICE_STATUS, type DeviceStatus } from "../../shared/contracts/device";
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
}

export interface DeviceConnectionControllerDeps {
  listSerialPorts: () => Promise<SerialPortListResponse>;
  connectSerialPort: (portName: string) => Promise<SerialConnectionStatus>;
  getSerialConnectionStatus: () => Promise<SerialConnectionStatus>;
  persistLastSuccessfulPort: (portName: string) => Promise<void>;
  initialLastSuccessfulPort?: string;
}

export interface DeviceConnectionController {
  getState: () => DeviceConnectionControllerState;
  subscribe: (listener: Listener) => () => void;
  initialize: () => Promise<void>;
  refreshPorts: () => Promise<void>;
  selectPort: (portName: string | null) => void;
  connectSelectedPort: () => Promise<void>;
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

export function createDeviceConnectionController(
  deps: DeviceConnectionControllerDeps,
): DeviceConnectionController {
  const listeners = new Set<Listener>();

  let state: DeviceConnectionControllerState = withDerivedFlags({
    ...DEFAULT_STATE,
    lastSuccessfulPort: deps.initialLastSuccessfulPort,
  });

  let initialized = false;
  let refreshToken = 0;

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

  const refreshPorts = async () => {
    const currentToken = ++refreshToken;
    const isInitialScan = !initialized;

    setState((prev) => ({
      ...prev,
      status: DEVICE_STATUS.SCANNING,
      isScanning: true,
      statusCard: isInitialScan ? null : prev.statusCard,
    }));

    try {
      const response = await deps.listSerialPorts();
      if (currentToken !== refreshToken) {
        return;
      }

      const mappedPorts = response.ports.map(toDevicePort);
      const selectionResult = applyPortRefresh(mappedPorts, isInitialScan);

      setState((prev) => ({
        ...prev,
        status: nextStatusForReadyState(mappedPorts),
        ports: mappedPorts,
        selectedPort: selectionResult.selectedPort,
        isScanning: false,
        statusCard: selectionResult.missingSelection
          ? {
              variant: "info",
              code: "SELECTED_PORT_MISSING",
              message: "Previously selected port is no longer available.",
              details: "Pick another port and try Connect again.",
            }
          : null,
      }));
      initialized = true;
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

  const initialize = async () => {
    await refreshPorts();

    try {
      const status = await deps.getSerialConnectionStatus();
      if (status.connected && status.portName) {
        setState((prev) => ({
          ...prev,
          status: DEVICE_STATUS.CONNECTED,
          connectedPort: status.portName,
          selectedPort: prev.selectedPort ?? status.portName,
          statusCard: toConnectionCard(status),
        }));
      }
    } catch {
      // Connection status hydration is best-effort only.
    }
  };

  const selectPort = (portName: string | null) => {
    setState((prev) => ({
      ...prev,
      selectedPort: portName,
      status:
        prev.status === DEVICE_STATUS.CONNECTED && prev.connectedPort === portName
          ? DEVICE_STATUS.CONNECTED
          : nextStatusForReadyState(prev.ports),
      statusCard:
        prev.statusCard?.code === "SELECTED_PORT_MISSING" ? null : prev.statusCard,
    }));
  };

  const connectSelectedPort = async () => {
    if (!state.selectedPort || state.isScanning || state.isConnecting) {
      return;
    }

    const targetPort = state.selectedPort;

    setState((prev) => ({
      ...prev,
      status: DEVICE_STATUS.CONNECTING,
      isConnecting: true,
      statusCard: null,
    }));

    const connection = await deps.connectSerialPort(targetPort);

    if (connection.connected && connection.portName) {
      const connectedPortName = connection.portName;

      setState((prev) => ({
        ...prev,
        status: DEVICE_STATUS.CONNECTED,
        connectedPort: connectedPortName,
        selectedPort: connectedPortName,
        isConnecting: false,
        lastSuccessfulPort: connectedPortName,
        statusCard: toConnectionCard(connection),
      }));

      try {
        await deps.persistLastSuccessfulPort(connectedPortName);
      } catch {
        // Persistence failures should not break the active connection flow.
      }

      return;
    }

    setState((prev) => ({
      ...prev,
      status: DEVICE_STATUS.ERROR,
      connectedPort: null,
      isConnecting: false,
      statusCard: toConnectionCard(connection),
    }));
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
  };
}

export interface UseDeviceConnectionResult extends DeviceConnectionControllerState {
  groupedPorts: ReturnType<typeof groupAndSortPorts>;
  refreshPorts: () => Promise<void>;
  selectPort: (portName: string | null) => void;
  connectSelectedPort: () => Promise<void>;
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
    refreshPorts: controller.refreshPorts,
    selectPort: controller.selectPort,
    connectSelectedPort: controller.connectSelectedPort,
    connectButtonLabel,
  };
}
