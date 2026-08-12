import { DEVICE_OPERATION, DEVICE_STATUS } from "@/shared/contracts/device";
import type { ConnectionEventBus } from "../connectionEvents";
import { applySuccessfulConnection } from "./connectionOutcomes";
import type { ConnectionStore } from "./connectionStore";
import { nextStatusForReadyState } from "./connectionStateHelpers";
import type { DeviceConnectionControllerDeps, DeviceStatusCard } from "./connectionTypes";

export interface AutoRecovery {
  startAutoRecovery(targetPort: string): void;
  cancelRecovery(reasonCard?: DeviceStatusCard): void;
  /** Called from the composition root's `dispose()` to stop a pending retry timer. */
  clearRecoveryTimer(): void;
}

export function createAutoRecovery(
  store: ConnectionStore,
  deps: DeviceConnectionControllerDeps,
  timing: { recoveryFastDelayMs: number; recoveryRetryDelayMs: number; recoveryMaxAttempts: number },
  connectionEventsBus: ConnectionEventBus | null,
): AutoRecovery {
  const scheduleTimeout =
    deps.scheduleTimeout ?? ((callback: () => void, delayMs: number) => setTimeout(callback, delayMs));
  const clearScheduledTimeout =
    deps.clearScheduledTimeout ?? ((timer: ReturnType<typeof setTimeout>) => clearTimeout(timer));

  let recoveryTimer: ReturnType<typeof setTimeout> | null = null;

  const clearRecoveryTimer = () => {
    if (!recoveryTimer) {
      return;
    }

    clearScheduledTimeout(recoveryTimer);
    recoveryTimer = null;
  };

  const cancelRecovery = (reasonCard?: DeviceStatusCard) => {
    store.invalidateCurrentOperation();
    clearRecoveryTimer();
    store.setState((prev) => ({
      ...prev,
      isReconnecting: false,
      // Only resets `activeOperation` when it was ours — a manual connect
      // or health check racing in must not be clobbered by this call.
      activeOperation: prev.activeOperation === DEVICE_OPERATION.RECOVERY ? DEVICE_OPERATION.IDLE : prev.activeOperation,
      status:
        prev.status === DEVICE_STATUS.RECONNECTING
          ? nextStatusForReadyState(prev.ports)
          : prev.status,
      statusCard: reasonCard ?? prev.statusCard,
    }));
  };

  const startAutoRecovery = (targetPort: string) => {
    clearRecoveryTimer();
    const token = store.beginOperation(DEVICE_OPERATION.RECOVERY);
    if (!token) {
      return;
    }

    store.setState((prev) => ({
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
      if (!store.isCurrentToken(token)) {
        return;
      }

      attempt += 1;
      try {
        const portsResponse = await deps.listSerialPorts();
        if (!store.isCurrentToken(token)) {
          return;
        }

        const hasTargetPort = portsResponse.ports.some((port) => port.name === targetPort);
        if (!hasTargetPort) {
          if (attempt >= timing.recoveryMaxAttempts) {
            store.finishOperation(token);
            store.setState((prev) => ({
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
          }, timing.recoveryRetryDelayMs);
          return;
        }

        const connected = await deps.connectSerialPort(targetPort);
        if (!store.isCurrentToken(token)) {
          return;
        }

        if (connected.connected && connected.portName) {
          clearRecoveryTimer();
          store.finishOperation(token);
          await applySuccessfulConnection(store, deps, connectionEventsBus, {
            connectedPortName: connected.portName,
            statusCard: {
              variant: "success",
              code: "RECOVERY_CONNECTED",
              message: "Connection recovered successfully.",
              details: connected.status.details ?? undefined,
            },
          });
          return;
        }

        if (attempt >= timing.recoveryMaxAttempts) {
          store.finishOperation(token);
          store.setState((prev) => ({
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
        }, timing.recoveryRetryDelayMs);
      } catch (error) {
        if (!store.isCurrentToken(token)) {
          return;
        }

        if (attempt >= timing.recoveryMaxAttempts) {
          store.finishOperation(token);
          store.setState((prev) => ({
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
        }, timing.recoveryRetryDelayMs);
      }
    };

    recoveryTimer = scheduleTimeout(() => {
      void tryReconnect();
    }, timing.recoveryFastDelayMs);
  };

  return { startAutoRecovery, cancelRecovery, clearRecoveryTimer };
}
