import { DEVICE_ERROR_CODES, DEVICE_OPERATION } from "@/shared/contracts/device";
import type { ConnectionEventBus, ConnectionRejectionCode } from "../connectionEvents";
import { applySuccessfulConnection } from "./connectionOutcomes";
import type { ConnectionStore } from "./connectionStore";
import { toConnectionCard } from "./connectionStateHelpers";
import type { DeviceConnectionControllerDeps } from "./connectionTypes";

export interface AutoReconnectOnInit {
  tryAutoReconnect(targetPort: string): Promise<void>;
}

export function createAutoReconnectOnInit(
  store: ConnectionStore,
  deps: DeviceConnectionControllerDeps,
  connectionEventsBus: ConnectionEventBus | null,
): AutoReconnectOnInit {
  /**
   * Bug 10A — auto-reconnect on app launch when the persisted port is
   * available but Rust hasn't restored the session (fresh process, empty
   * Mutex). Runs at most once per `initialize()` call. Quietly noops when
   * the port is gone or the connect rejects so the user lands on a clean
   * manual-pair screen instead of an error toast.
   */
  const tryAutoReconnect = async (targetPort: string) => {
    if (store.isDisposed()) return;
    // Don't fight an active operation (manual connect, recovery, health
    // check). The auto-reconnect call is best-effort housekeeping.
    if (store.getState().activeOperation !== DEVICE_OPERATION.IDLE) return;

    // Make sure the port is actually present right now. We already ran
    // the initial scan inside `initialize()`, so `state.ports` is fresh.
    const portStillVisible = store.getState().ports.some((port) => port.portName === targetPort);
    if (!portStillVisible) return;

    const token = store.beginOperation(DEVICE_OPERATION.MANUAL_CONNECT);
    if (!token) return;

    try {
      const connection = await deps.connectSerialPort(targetPort);
      if (!store.isCurrentToken(token) || store.isDisposed()) return;

      if (connection.connected && connection.portName) {
        store.finishOperation(token);
        await applySuccessfulConnection(store, deps, connectionEventsBus, {
          connectedPortName: connection.portName,
          statusCard: toConnectionCard(connection),
        });
        return;
      }

      // Connect rejected (port busy, handshake failed, etc.). Roll the
      // operation flag back but DON'T surface an error card — the user
      // didn't ask for this attempt and a noisy toast on every cold
      // launch would be worse than a silent fall-through to manual
      // pair. We do log so production debugging stays possible.
      store.finishOperation(token);
      const rejectionCode = connection.status?.code ?? "UNKNOWN";
      console.warn(
        "[LumaSync] auto-reconnect on init rejected:",
        rejectionCode,
        connection.status?.message ?? "",
      );
      // Bug 10D — surface "USB is structurally unavailable for this
      // session" so the App-level subscriber can drop "usb" from
      // selectedOutputTargets and avoid the silent backend
      // DEVICE_NOT_CONNECTED gate on every mode-change. Limited to
      // PORT_UNSUPPORTED / PORT_NOT_FOUND because transient codes
      // (CONNECT_BUSY, handshake timeout) shouldn't strip the user's
      // persisted output mix.
      if (
        connectionEventsBus &&
        (rejectionCode === DEVICE_ERROR_CODES.PORT_UNSUPPORTED ||
          rejectionCode === DEVICE_ERROR_CODES.PORT_NOT_FOUND)
      ) {
        connectionEventsBus.emit({
          portName: targetPort,
          connected: false,
          unsupportedReason: rejectionCode satisfies ConnectionRejectionCode,
        });
      }
    } catch (err) {
      if (!store.isCurrentToken(token) || store.isDisposed()) return;
      store.finishOperation(token);
      console.error("[LumaSync] auto-reconnect on init threw:", err);
    }
  };

  return { tryAutoReconnect };
}
