import { DEVICE_OPERATION, DEVICE_STATUS, type DeviceOperation } from "@/shared/contracts/device";
import type { DeviceConnectionControllerState, Listener } from "./connectionTypes";
import { withDerivedFlags } from "./connectionStateHelpers";

// Shared gate: only one of {manual connect, health check, recovery, boot
// reconnect} may run at a time; `invalidateCurrentOperation` lets recovery
// cancel an in-flight operation from outside its own async flow.
export interface ConnectionStore {
  getState(): DeviceConnectionControllerState;
  subscribe(listener: Listener): () => void;
  setState(updater: (prev: DeviceConnectionControllerState) => DeviceConnectionControllerState): void;
  beginOperation(operation: DeviceOperation): number | null;
  finishOperation(token: number): void;
  isCurrentToken(token: number): boolean;
  invalidateCurrentOperation(): void;
  isDisposed(): boolean;
  dispose(): void;
}

export function createConnectionStore(initial: DeviceConnectionControllerState): ConnectionStore {
  const listeners = new Set<Listener>();
  let state: DeviceConnectionControllerState = initial;
  let operationToken = 0;
  let disposed = false;

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

  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setState,
    beginOperation,
    finishOperation,
    isCurrentToken: (token) => token === operationToken,
    invalidateCurrentOperation: () => {
      operationToken += 1;
    },
    isDisposed: () => disposed,
    dispose: () => {
      disposed = true;
      listeners.clear();
    },
  };
}
