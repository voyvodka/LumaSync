import { DEVICE_ERROR_CODES, SERIAL_CONNECT_STATUS, type SerialPortsChangedEvent } from "@/shared/contracts/device";
import type { AutoReconnectOnInit } from "./autoReconnectOnInit";
import type { ConnectionStore } from "./connectionStore";
import { nextStatusForReadyState, toConnectionCard, toDevicePort } from "./connectionStateHelpers";
import { resolveSelectionAfterRefresh } from "../portSelection";
import type { DeviceConnectionControllerDeps } from "./connectionTypes";

/** A just-enumerated CH340 can refuse its first open; a second try usually lands. */
const TRANSIENT_CODES: ReadonlySet<string> = new Set([
  DEVICE_ERROR_CODES.PORT_NOT_FOUND,
  SERIAL_CONNECT_STATUS.TIMEOUT,
  SERIAL_CONNECT_STATUS.IO_ERROR,
  SERIAL_CONNECT_STATUS.FAILED,
]);

export interface SerialWatchTiming {
  replugDelayMs: number;
  replugRetryMs: number;
}

export interface SerialWatchFollower {
  subscribe(): void;
  unsubscribe(): void;
}

/**
 * Follows the Rust serial port watcher. Every controller keeps its port list and connection in step;
 * only the one that `reconnectOnReplug` brings the saved port back when it reappears — once, and once
 * more on a transient failure, never on `CONNECT_REPLUG_REQUIRED` (re-opening a wedged driver is what
 * wedges it). A lost port is applied here, not through a refresh, whose missing-port path would start
 * auto-recovery in every mount at once.
 */
export function createSerialWatchFollower(
  store: ConnectionStore,
  deps: DeviceConnectionControllerDeps,
  autoReconnect: AutoReconnectOnInit,
  timing: SerialWatchTiming,
): SerialWatchFollower {
  let unlisten: (() => void) | null = null;
  let disposed = false;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const later = (callback: () => void, ms: number) => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (!disposed) callback();
    }, ms);
    timers.add(timer);
  };

  const idle = () => !store.isDisposed() && store.getState().connectedPort === null;

  // Read at the attempt, not at mount: a strip moved to WLED this session has no saved port, and
  // reconnecting the old USB one would overwrite that choice.
  const readSavedPort = async (): Promise<string | undefined> => {
    if (!deps.readSavedSerialPort) return store.getState().lastSuccessfulPort;
    try {
      return await deps.readSavedSerialPort();
    } catch (error) {
      console.error("[LumaSync] reading the saved serial port for a replug failed:", error);
      return undefined;
    }
  };

  const attemptReconnect = async (appeared: readonly string[], attempt: 1 | 2) => {
    if (!idle()) return;
    const saved = await readSavedPort();
    if (!saved || !appeared.includes(saved) || !idle()) return;
    const code = await autoReconnect.tryAutoReconnect(saved, "replug");
    if (attempt === 1 && code !== null && TRANSIENT_CODES.has(code)) reconnect(appeared, 2);
  };
  const reconnect = (appeared: readonly string[], attempt: 1 | 2) => {
    later(() => void attemptReconnect(appeared, attempt), attempt === 1 ? timing.replugDelayMs : timing.replugRetryMs);
  };

  const apply = (event: SerialPortsChangedEvent) => {
    if (store.isDisposed()) return;
    const ports = event.ports.map(toDevicePort);
    const before = store.getState();
    // Rust keeps a connect that finished after its listing; the UI must not drop what Rust kept.
    const rustKept = event.connection.connected && event.connection.portName === before.connectedPort;
    const lostConnected = before.connectedPort !== null && event.lost.includes(before.connectedPort) && !rustKept;
    store.setState((prev) => ({
      ...prev,
      ports,
      connectedPort: lostConnected ? null : prev.connectedPort,
      status: lostConnected ? nextStatusForReadyState(ports) : prev.status,
      statusCard: lostConnected ? toConnectionCard(event.connection) : prev.statusCard,
      selectedPort: resolveSelectionAfterRefresh(ports, prev.selectedPort, prev.lastSuccessfulPort).selectedPort,
    }));
    if (deps.reconnectOnReplug && event.appeared.length > 0 && idle()) reconnect(event.appeared, 1);
  };

  return {
    subscribe() {
      if (!deps.listenSerialPortsChanged || unlisten) return;
      deps
        .listenSerialPortsChanged(apply)
        .then((stop) => {
          if (disposed) stop();
          else unlisten = stop;
        })
        // Without the listener the controller still works as it did before the watcher: an unplug
        // is noticed on a failed write or a Rescan.
        .catch((error: unknown) => {
          console.error("[LumaSync] listening for serial port changes failed:", error);
        });
    },
    unsubscribe() {
      disposed = true;
      unlisten?.();
      unlisten = null;
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
    },
  };
}
