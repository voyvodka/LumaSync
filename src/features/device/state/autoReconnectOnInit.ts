import { DEVICE_ERROR_CODES, DEVICE_OPERATION, DEVICE_STATUS, SERIAL_CONNECT_STATUS } from "@/shared/contracts/device";
import type { ConnectionEventBus, ConnectionRejectionCode } from "../connectionEvents";
import { applySuccessfulConnection } from "./connectionOutcomes";
import type { ConnectionStore } from "./connectionStore";
import { nextStatusForReadyState, toConnectionCard } from "./connectionStateHelpers";
import type { DeviceConnectionControllerDeps } from "./connectionTypes";

/** `boot` is the launch's one attempt; `replug` is the serial watcher seeing the saved port return. */
export type ReconnectOrigin = "boot" | "replug";

export interface AutoReconnectOnInit {
  /** Resolves with the rejection code, or `null` when it connected or did not try. */
  tryAutoReconnect(targetPort: string, origin?: ReconnectOrigin): Promise<string | null>;
}

export function createAutoReconnectOnInit(
  store: ConnectionStore,
  deps: DeviceConnectionControllerDeps,
  connectionEventsBus: ConnectionEventBus | null,
  sync: () => Promise<void>,
): AutoReconnectOnInit {
  /**
   * Bug 10A — auto-reconnect on app launch when the persisted port is
   * available but Rust hasn't restored the session (fresh process, empty
   * Mutex). Runs at most once per `initialize()` call. Quietly noops when
   * the port is gone or the connect rejects so the user lands on a clean
   * manual-pair screen instead of an error toast.
   */
  // `beginOperation` said Connecting; a refusal nobody asked for leaves the status the ports give.
  const giveUp = (token: number) => {
    store.finishOperation(token);
    store.setState((prev) =>
      prev.status === DEVICE_STATUS.CONNECTING ? { ...prev, status: nextStatusForReadyState(prev.ports) } : prev,
    );
  };

  const tryAutoReconnect = async (targetPort: string, origin: ReconnectOrigin = "boot"): Promise<string | null> => {
    if (store.isDisposed()) return null;
    // Don't fight an active operation (manual connect, recovery, health
    // check). The auto-reconnect call is best-effort housekeeping.
    if (store.getState().activeOperation !== DEVICE_OPERATION.IDLE) return null;

    // Make sure the port is actually present right now. We already ran
    // the initial scan inside `initialize()`, so `state.ports` is fresh.
    const portStillVisible = store.getState().ports.some((port) => port.portName === targetPort);
    if (!portStillVisible) return null;

    const token = store.beginOperation(DEVICE_OPERATION.MANUAL_CONNECT);
    if (!token) return null;

    try {
      const connection = await deps.connectSerialPort(targetPort);
      if (!store.isCurrentToken(token) || store.isDisposed()) return null;

      if (connection.connected && connection.portName) {
        store.finishOperation(token);
        await applySuccessfulConnection(store, deps, connectionEventsBus, sync, {
          connectedPortName: connection.portName,
          statusCard: toConnectionCard(connection),
        });
        return null;
      }

      // Connect rejected (port busy, handshake failed, etc.). Roll the
      // operation flag back but DON'T surface an error card — the user
      // didn't ask for this attempt and a noisy toast on every cold
      // launch would be worse than a silent fall-through to manual
      // pair. We do log so production debugging stays possible.
      giveUp(token);
      const rejectionCode = connection.status?.code ?? "UNKNOWN";
      console.warn(
        `[LumaSync] auto-reconnect (${origin}) rejected:`,
        rejectionCode,
        connection.status?.message ?? "",
        connection.status?.details ?? "",
      );
      // Bug 10D — surface "USB is structurally unavailable for this
      // session" so the App-level subscriber can drop "usb" from
      // selectedOutputTargets and avoid the silent backend
      // DEVICE_NOT_CONNECTED gate on every mode-change. Limited to
      // PORT_UNSUPPORTED / PORT_NOT_FOUND because transient codes
      // (CONNECT_TIMEOUT, CONNECT_IO_ERROR, CONNECT_FAILED) shouldn't strip the user's
      // persisted output mix.
      // Boot only: at a replug a busy port also reads PORT_NOT_FOUND, and one refusal there must not
      // strip the strip from the saved selection.
      if (
        origin === "boot" &&
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
      // The one refusal the user can act on — typically after a crash or force-quit mid-stream — so
      // it is shown; the other mounts read it from the port's registry entry.
      if (rejectionCode === SERIAL_CONNECT_STATUS.REPLUG_REQUIRED) {
        store.setState((prev) => ({ ...prev, statusCard: toConnectionCard(connection) }));
      }
      return rejectionCode;
    } catch (err) {
      if (!store.isCurrentToken(token) || store.isDisposed()) return null;
      giveUp(token);
      console.error(`[LumaSync] auto-reconnect (${origin}) threw:`, err);
      return null;
    }
  };

  return { tryAutoReconnect };
}
