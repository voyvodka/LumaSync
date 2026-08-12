import { DEVICE_OPERATION, DEVICE_STATUS, SERIAL_CONNECT_STATUS } from "@/shared/contracts/device";
import type { ConnectionEventBus } from "../connectionEvents";
import type { SerialConnectionStatus } from "../deviceConnectionApi";
import { applySuccessfulConnection } from "./connectionOutcomes";
import type { ConnectionStore } from "./connectionStore";
import { nextStatusForReadyState, toConnectionCard } from "./connectionStateHelpers";
import type { DeviceConnectionControllerDeps, DeviceStatusCard } from "./connectionTypes";

export interface ConnectionLifecycle {
  selectPort(portName: string | null): void;
  connectSelectedPort(): Promise<void>;
}

export function createConnectionLifecycle(
  store: ConnectionStore,
  deps: DeviceConnectionControllerDeps,
  connectionEventsBus: ConnectionEventBus | null,
  callbacks: { cancelRecovery: (reasonCard?: DeviceStatusCard) => void },
): ConnectionLifecycle {
  const selectPort = (portName: string | null) => {
    const state = store.getState();
    if (state.isReconnecting) {
      callbacks.cancelRecovery({
        variant: "info",
        code: "RECOVERY_CANCELLED_BY_USER",
        message: "Auto-recovery was cancelled by manual selection.",
        details: "Continue with manual connect when ready.",
      });
    }

    store.setState((prev) => ({
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
    const state = store.getState();
    if (!state.selectedPort || state.isScanning || state.isConnecting || state.isHealthChecking) {
      return;
    }

    if (state.isReconnecting) {
      callbacks.cancelRecovery();
    }

    const token = store.beginOperation(DEVICE_OPERATION.MANUAL_CONNECT);
    if (!token) {
      return;
    }

    const targetPort = state.selectedPort;
    store.setState((prev) => ({
      ...prev,
      statusCard: null,
    }));

    // Opening the port asserts DTR, which resets an AVR bootloader for
    // ~BOOTLOADER_SETTLE_DELAY_MS (device_connection.rs). This await must
    // stay unbounded on the client side — Rust owns that settle window.
    let connection: SerialConnectionStatus;
    try {
      connection = await deps.connectSerialPort(targetPort);
    } catch (error) {
      if (!store.isCurrentToken(token)) {
        return;
      }

      store.finishOperation(token);
      store.setState((prev) => ({
        ...prev,
        status: DEVICE_STATUS.ERROR,
        connectedPort: null,
        statusCard: {
          variant: "error",
          code: SERIAL_CONNECT_STATUS.FAILED,
          message: "Could not connect to the selected port.",
          details: error instanceof Error ? error.message : String(error),
        },
      }));
      return;
    }

    if (!store.isCurrentToken(token)) {
      return;
    }

    if (connection.connected && connection.portName) {
      const connectedPortName = connection.portName;
      store.finishOperation(token);
      await applySuccessfulConnection(store, deps, connectionEventsBus, {
        connectedPortName,
        statusCard: toConnectionCard(connection),
      });
      return;
    }

    store.finishOperation(token);
    store.setState((prev) => ({
      ...prev,
      status: DEVICE_STATUS.ERROR,
      connectedPort: null,
      statusCard: toConnectionCard(connection),
    }));
  };

  return { selectPort, connectSelectedPort };
}
